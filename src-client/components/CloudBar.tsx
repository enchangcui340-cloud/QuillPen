import { requestPanelReload } from '../lib/host-adapt'
import { askConfirm } from './AskDialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CloudStatus } from '@shared/api'
import { toast } from './Toast'
import CloudDevicesDialog from './CloudDevicesDialog'
import {
  ChevronIcon,
  CloudIcon,
  DotIcon,
  CopyIcon,
  DeviceIcon,
  DownloadIcon,
  RevertIcon,
  SaveIcon,
  UnlinkIcon,
  WarnIcon,
  UploadIcon
} from './Icons'

function timeText(iso: string | null): string {
  if (!iso) return '从未'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '从未'
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? '今天 ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function sizeText(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

/** 空置倒计时：还剩几天 */
function daysLeft(emptySince: string | null): number | null {
  if (!emptySince) return null
  const t = new Date(emptySince).getTime()
  if (Number.isNaN(t)) return null
  return Math.max(0, 12 - Math.floor((Date.now() - t) / 86400000))
}

const STORE_KEY = 'quill.cloudBar.expanded'

/**
 * 云数据目录的状态栏。
 *
 * 设计要点：
 * - **默认收起**成一行，不挡内容；点右侧「详情」展开
 * - 展开状态记在本机，下次打开保持你上次的选择
 * - 视觉沿用应用现有语言：appbar 高度、--panel/--border/--accent、.btn small
 * - 上传/下载完全手动；下载前会自动在本机留一份可恢复的备份
 */
export default function CloudBar({ libraryId }: { libraryId: string }): React.ReactElement {
  const [st, setSt] = useState<CloudStatus | null>(null)
  const [busy, setBusy] = useState<'up' | 'down' | null>(null)
  const [showDevices, setShowDevices] = useState(false)
  const [keyText, setKeyText] = useState('')
  const [expanded, setExpanded] = useState<boolean>(() => {
    try { return localStorage.getItem(STORE_KEY) !== '0' } catch { return true }
  })
  const timerRef = useRef<number | null>(null)

  const toggle = (): void => {
    setExpanded((v) => {
      const next = !v
      try { localStorage.setItem(STORE_KEY, next ? '1' : '0') } catch { /* 忽略 */ }
      return next
    })
  }

  const load = useCallback(async (): Promise<void> => {
    try { setSt(await window.api.cloudStatus2(libraryId)) } catch { /* 网络问题不打扰 */ }
  }, [libraryId])

  useEffect(() => {
    void load()
    // 主进程在打开云库时会异步登记"本机在用"，稍后补刷一次，让倒计时提示及时消失
    const t1 = window.setTimeout(() => void load(), 3000)
    timerRef.current = window.setInterval(() => void load(), 60000)
    return () => {
      window.clearTimeout(t1)
      if (timerRef.current) window.clearInterval(timerRef.current)
    }
  }, [load])

  useEffect(() => {
    void window.api.librariesList().then((r) => {
      const cur = r.items.find((i) => i.id === libraryId)
      setKeyText(cur?.cloud?.key ?? '')
    }).catch(() => undefined)
  }, [libraryId])

  const upload = async (): Promise<void> => {
    const fresh = await window.api.cloudStatus2(libraryId).catch(() => null)
    const peers = fresh && fresh.stamp && fresh.stamp.version !== fresh.knownStampVersion && fresh.knownStampVersion > 0
    const msg = (peers ? '云端在「' + timeText(fresh!.stamp!.updatedAt) + '」被「' + fresh!.stamp!.updatedBy + '」更新过。\n\n' : '') +
      '上传：用本机内容覆盖云端。\n\n云端多出来的文件会被删除。确定继续？'
    if (!(await askConfirm(msg))) return
    setBusy('up')
    try {
      const r = await window.api.cloudUpload2(libraryId)
      toast('已上传 ' + r.uploaded + ' 个文件（' + sizeText(r.bytes) + '）' + (r.removed ? '，删除云端 ' + r.removed + ' 个' : ''), 'success')
      await load()
    } catch (e) { toast('上传失败：' + (e as Error).message, 'error') } finally { setBusy(null) }
  }

  const download = async (): Promise<void> => {
    const fresh = await window.api.cloudStatus2(libraryId).catch(() => null)
    const warn = fresh && fresh.stamp && fresh.stamp.version !== fresh.knownStampVersion
    const msg = (warn ? '云端有更新（' + timeText(fresh!.stamp!.updatedAt) + ' 由「' + fresh!.stamp!.updatedBy + '」上传）。\n\n' : '') +
      '下载：用云端内容覆盖本机。\n\n本机多出来的文件会被删除（下载前会自动备份一份，可随时「恢复」）。确定继续？'
    if (!(await askConfirm(msg))) return
    setBusy('down')
    try {
      const r = await window.api.cloudDownload2(libraryId)
      toast('已下载 ' + r.files + ' 个文件（' + sizeText(r.bytes) + '）', 'success')
      await load()
      window.setTimeout(() => requestPanelReload(), 700)
    } catch (e) { toast('下载失败：' + (e as Error).message, 'error') } finally { setBusy(null) }
  }

  const restore = async (): Promise<void> => {
    if (!(await askConfirm('恢复到「上一次下载之前」的版本？\n\n当前内容会被替换掉。'))) return
    try {
      await window.api.cloudRestore2(libraryId)
      toast('已恢复', 'success')
      window.setTimeout(() => requestPanelReload(), 600)
    } catch (e) { toast((e as Error).message, 'error') }
  }

  const copyKey = async (): Promise<void> => {
    if (!keyText) { toast('还没读到这个云目录的 key', 'error'); return }
    try {
      await window.api.copyText(keyText)
      toast('key 已复制，粘到别的设备即可连接', 'success')
    } catch (e) {
      toast('复制失败：' + (e as Error).message, 'error')
    }
  }

  /**
   * 断开云目录（真正的"断链"）。
   * 如果本机是最后一个设备，必须先警告"12 天后云端内容会被删除"，用户二次确认才继续。
   */
  const disconnect = async (): Promise<void> => {
    // 先查有没有别的设备在用（只看，不注销）—— 取消时不能已经断开
    let lastMsg = ''
    try {
      const { devices, selfId } = await window.api.cloudDevices2(libraryId)
      const others = devices.filter((d) => d.id !== selfId)
      if (others.length === 0) {
        lastMsg =
          '你是最后一个连接这个云数据目录的设备。\n\n' +
          '断开后如果 12×24 小时内没有设备再连接它，\n服务器上的内容会被【全部删除】。\n\n'
      } else {
        lastMsg = '还有 ' + others.length + ' 台设备连接着它，断开不影响它们。\n\n'
      }
    } catch {
      lastMsg = '（查询其他设备失败，可能是离线）\n\n'
    }
    const ok = (await askConfirm(
      '断开云数据目录「云端库」？\n\n' + lastMsg +
      '本机副本会保留在磁盘上，随时可以用 key 再连回来。\n\n确定断开？'
    ))
    if (!ok) return
    try {
      const r = await window.api.cloudDisconnect(libraryId)
      toast('已断开云数据目录' + (r.next ? '，已切回「' + r.next + '」' : ''), 'success')
      window.setTimeout(() => requestPanelReload(), 600)
    } catch (e) {
      toast('断开失败：' + (e as Error).message, 'error')
    }
  }

  const saveAsLocal = async (): Promise<void> => {
    const dir = await window.api.libraryPickFolder()
    if (!dir) return
    try {
      await window.api.librarySaveAsLocal(libraryId, dir)
      toast('已保存为本机数据目录', 'success')
    } catch (e) { toast('保存失败：' + (e as Error).message, 'error') }
  }

  if (!st) {
    return (
      <div className="cloudbar collapsed">
        <div className="cloudbar-row">
          <span className="cloudbar-name"><span className="cloudbar-icon"><CloudIcon /></span>云端库</span>
          <span className="cloudbar-meta">读取中…</span>
        </div>
      </div>
    )
  }

  const usedRatio = Math.min(1, st.usage.bytes / st.quota)
  const cloudNewer = !!st.stamp && st.stamp.version !== st.knownStampVersion
  const left = daysLeft(st.emptySince)
  return (
    <div className={'cloudbar' + (expanded ? '' : ' collapsed')}>
      {/* 第一行：始终显示 */}
      <div className="cloudbar-row">
        <span className="cloudbar-name">
          <span className="cloudbar-icon"><CloudIcon /></span>云端库
        </span>

        <button className="btn small cloudbar-act" disabled={busy !== null} onClick={() => void upload()}>
          <UploadIcon />{busy === 'up' ? '上传中…' : '上传'}
        </button>
        <button className="btn small cloudbar-act" disabled={busy !== null} onClick={() => void download()}>
          <DownloadIcon />{busy === 'down' ? '下载中…' : '下载'}
        </button>

        {cloudNewer && (
          <span className="cloudbar-flag" title={'由「' + st.stamp!.updatedBy + '」于 ' + timeText(st.stamp!.updatedAt) + ' 上传'}>
            <DotIcon filled /> 云数据目录已更新
          </span>
        )}
        {!cloudNewer && left !== null && (
          <span className="cloudbar-warn" title="没有设备连接时，12 天后云端内容会被删除">
            <WarnIcon /> 无设备连接 · {left} 天后云端内容会被删除
          </span>
        )}

        {!expanded && (
          <span className="cloudbar-meta nowrap">
            本机 {st.usage.files} 个文件 · {st.stamp ? '云端 ' + st.stamp.files + ' 个' : '云端暂无内容'}
          </span>
        )}

        <div className="spacer" />

        {/* 收起时也显示容量小条，一眼看到余量 */}
        <span className="cloudbar-mini" title={sizeText(st.usage.bytes) + ' / ' + sizeText(st.quota)}>
          <span className="cloudbar-mini-fill" style={{ width: (usedRatio * 100).toFixed(1) + '%' }} />
        </span>

        <button className="cloudbar-toggle" onClick={toggle} title={expanded ? '收起详情' : '展开详情'}>
          <ChevronIcon open={expanded} />{expanded ? '收起' : '详情'}
        </button>
      </div>

      {/* 第二行起：展开后显示 */}
      {expanded && (
        <>
          <div className="cloudbar-row cloudbar-detail">
            <span className="cloudbar-chip">本机 {st.usage.files} 个文件 · {sizeText(st.usage.bytes)}</span>
            <span className="cloudbar-chip">容量 {sizeText(st.usage.bytes)} / 1.5 GB · 剩余 {sizeText(Math.max(0, st.quota - st.usage.bytes))}</span>
            <span className="cloudbar-chip">
              云端 {st.stamp ? st.stamp.files + ' 个文件 · ' + timeText(st.stamp.updatedAt) + '（' + st.stamp.updatedBy + '）' : '暂无内容'}
            </span>
            <span className="cloudbar-chip">上次上传 {timeText(st.lastUploadAt)}</span>
            <span className="cloudbar-chip">上次下载 {timeText(st.lastDownloadAt)}</span>
            <span className="cloudbar-chip">
              设备 {st.devices.length}{st.devices.length ? '：' + st.devices.map((d) => d.name).join('、') : ''}
            </span>
          </div>
          <div className="cloudbar-row cloudbar-detail">
            <button className="btn small cloudbar-act" onClick={() => void copyKey()}><CopyIcon />复制 key</button>
            <button className="btn small cloudbar-act" onClick={() => void saveAsLocal()}><SaveIcon />存为本机库</button>
            <button className="btn small cloudbar-act" onClick={() => setShowDevices(true)}><DeviceIcon />管理设备…</button>
            {st.hasBackup && (
              <button className="btn small cloudbar-act" onClick={() => void restore()} title="恢复到上一次下载之前的版本">
                <RevertIcon />恢复到下载前
              </button>
            )}
            <div className="spacer" />
            <span className="cloudbar-chip">上传/下载完全手动，程序不会自动同步</span>
            <button className="btn small cloudbar-act danger" onClick={() => void disconnect()}><UnlinkIcon />断开云目录</button>
          </div>
        </>
      )}

      {showDevices && (
        <CloudDevicesDialog libraryId={libraryId} onClose={() => { setShowDevices(false); void load() }} />
      )}
    </div>
  )
}
