import { requestPanelReload } from '../lib/host-adapt'
import { askConfirm } from './AskDialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LibraryListItem } from '@shared/api'
import { toast } from './Toast'
import LibraryCreateDialog from './LibraryCreateDialog'
import { CloudIcon, LibraryIcon, PlusIcon, RailSettingsIcon } from './Icons'

/** 时间和体积的小字格式：和笔记树/待办里的说明文字同一套写法 */
function when(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

/**
 * 右上角：当前数据目录 + 一键切换。
 *
 * 排版刻意对齐左侧「笔记树」的规范：
 *   图标（14px 线性 SVG）+ 名称 + 次要说明（12px 灰字）+ 右对齐状态
 *   行高/圆角/悬停底色与 .tree-node 完全一致，当前项用同样的高亮色
 */
export default function LibrarySwitcher({ onManage }: { onManage: () => void }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<LibraryListItem[]>([])
  const [activeId, setActiveId] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await window.api.librariesList()
      setItems(r.items)
      setActiveId(r.activeId)
    } catch (e) {
      toast('读取数据目录列表失败：' + (e as Error).message, 'error')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const active = items.find((i) => i.id === activeId) ?? items.find((i) => i.isActive)

  /**
   * 离开云目录的检查。
   *
   * 重要：**切到本地数据目录不算离开云目录** —— 云连接继续保持，
   * 否则每次去本地库写点东西，云端就开始 12 天倒计时了。
   * 只有"切换到另一个云数据目录"或明确断开时才算离开。
   */
  const leaveCloudDir = async (cur: LibraryListItem | undefined): Promise<boolean> => {
    if (!cur || cur.kind !== 'cloud') return true
    try {
      const { devices, selfId } = await window.api.cloudDevices2(cur.id)
      const others = devices.filter((d) => d.id !== selfId)
      if (others.length > 0) {
        await window.api.cloudLeave(cur.id)
        return true
      }
      const ok = (await askConfirm(
        '你是最后一个连接这个云数据目录的设备。\n\n' +
        '离开后如果 12×24 小时内没有设备再连接它，\n服务器上的内容会被【全部删除】。\n\n' +
        '（本机已有的数据目录不受影响，云端删除不会动你本机的内容）\n\n确定离开？'
      ))
      if (!ok) return false
      await window.api.cloudLeave(cur.id)
      return true
    } catch {
      return true
    }
  }

  const activate = async (item: LibraryListItem): Promise<void> => {
    if (item.isActive) { setOpen(false); return }
    const leaving = items.find((i) => i.isActive)
    if (leaving?.kind === 'cloud' && item.kind === 'cloud' && !(await leaveCloudDir(leaving))) return
    if (!item.exists) { toast('这个数据目录不存在了：' + item.dir, 'error'); return }
    try {
      await window.api.libraryActivate(item.id)
      toast('已切换到「' + item.name + '」，正在重新加载…', 'success')
      window.setTimeout(() => requestPanelReload(), 400)
    } catch (e) {
      toast('切换失败：' + (e as Error).message, 'error')
    }
  }

  return (
    <div className="lib-switch" ref={boxRef}>
      <button className="lib-switch-btn" onClick={() => { setOpen(!open); void load() }} title={active?.dir ?? ''}>
        <span className="lib-switch-icon">{active?.kind === 'cloud' ? <CloudIcon /> : <LibraryIcon />}</span>
        <span className="nowrap">{active?.name ?? '数据目录'}</span>
        <span className="lib-caret">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="lib-menu">
          {items.map((it) => (
            <div
              key={it.id}
              className={'lib-item' + (it.isActive ? ' active' : '') + (it.exists ? '' : ' missing')}
              onClick={() => void activate(it)}
              title={it.dir}
            >
              <span className="lib-item-icon">
                {it.kind === 'cloud' ? <CloudIcon /> : <LibraryIcon />}
              </span>
              <span className="lib-item-name nowrap">{it.name}</span>
              <span className="lib-item-meta nowrap">
                {it.kind === 'cloud' ? '云端' : '本机'} · {it.notes} 篇 · {sizeText(it.sizeBytes)}
              </span>
              <span className="lib-item-time nowrap">{when(it.lastUsedAt)}</span>
            </div>
          ))}

          <div className="lib-sep" />

          <div className="lib-item" onClick={() => { setOpen(false); setShowCreate(true) }}>
            <span className="lib-item-icon"><PlusIcon size={14} /></span>
            <span className="lib-item-name">新建数据目录…</span>
          </div>
          <div className="lib-item" onClick={() => { setOpen(false); onManage() }}>
            <span className="lib-item-icon"><RailSettingsIcon /></span>
            <span className="lib-item-name">管理数据目录</span>
          </div>
        </div>
      )}

      {showCreate && (
        <LibraryCreateDialog
          onClose={() => setShowCreate(false)}
          onDone={() => { setShowCreate(false); void load() }}
        />
      )}
    </div>
  )
}
