import { requestPanelReload } from '../lib/host-adapt'
import { askConfirm } from './AskDialog'
import { useRef, useState } from 'react'
import Modal from './Modal'
import { toast } from './Toast'

/**
 * 连接云数据目录。
 *
 * 「羽毛笔」用户版**只支持用 key 连接**：云数据目录由管理员创建并把 key 发给你，
 * 粘贴 key 即可连上（key 可随时复制，粘到别的设备就能连上同一个目录）。
 * 本版本没有"新建云数据目录"的能力 —— 软件里既无创建入口，也无创建所需凭据。
 */
export default function CloudCreateDialog({ onClose, onDone }: {
  onClose: () => void
  onDone: () => void
}): React.ReactElement {
  const [keyText, setKeyText] = useState('')
  const [busy, setBusy] = useState(false)
  /**
   * 测试结果：**成功/失败都用这一个形状**。
   *
   * 注意别写成 CloudTestResult —— 那是宿主成功返回的类型（name/id/host/user/files/devices），
   * 既没有 ok 也没有 error；失败时桥是 throw。之前的 bug 就是混用了它：
   * 渲染读 test.ok / test.reason / test.bytes 全是 undefined，界面上显示 "undefined"。
   */
  const [test, setTest] = useState<{ ok: boolean; files?: number; name?: string; error?: string } | null>(null)
  const [testedKey, setTestedKey] = useState('')
  /** 防连点：入口同步上锁（state 更新是异步的，挡不住同一事件循环里的重入） */
  const connectingRef = useRef(false)

  const doTest = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.cloudTestKey(keyText.trim())
      // 注意：cloudTestKey 成功时返回 CloudTestResult（name/id/host/user/files/devices），
      // **没有 ok / reason / bytes 字段**；失败时桥是 throw（见 bridge.ts 的 call()）。
      // 之前这里按 {ok,reason,bytes} 渲染，字段根本不存在 → 界面上显示 "undefined"（已修）。
      setTest({ ok: true, files: r.files, name: r.name })
      setTestedKey(keyText.trim())
      toast('连接成功', 'success')
    } catch (e) {
      // 失败时把**真实错误**留在界面上（不再只弹 toast），并保留在界面上让用户能看清
      setTest({ ok: false, error: (e as Error).message || '未知错误' })
    } finally { setBusy(false) }
  }

  const useIt = async (): Promise<void> => {
    const k = (keyText.trim()).trim()
    if (!k) { toast('请先粘贴 key', 'error'); return }
    // 入口**立刻上锁**：下面还有几个 await（查当前库、测 key），那段窗口里按钮仍可点，
    // 用户连点会并发进入 → 同一个云目录被连接多次（宿主的串行化是第二道防线，这里先挡住）。
    if (connectingRef.current) return
    connectingRef.current = true
    setBusy(true)
    // 每台设备同时只能连一个云目录：如果现在连着别的云目录，先确认要离开它
    try {
      const cur = await window.api.librariesList()
      const active = cur.items.find((i) => i.isActive)
      const target = await window.api.cloudTestKey(k).catch(() => null)
      if (active?.kind === 'cloud' && target && active.cloud?.cloudId !== target.id) {
        // 先查（只看不注销），确认后才真正断开
        const { devices, selfId } = await window.api.cloudDevices2(active.id)
        const others = devices.filter((d) => d.id !== selfId)
        if (others.length === 0) {
          const ok = (await askConfirm(
            '你要离开当前的云数据目录「' + active.name + '」。\n\n' +
            '你是最后一个连接它的设备 —— 12×24 小时内没有设备再连接的话，\n' +
            '服务器上的内容会被【全部删除】。\n\n' +
            '（本机副本不受影响，随时可以再连回来）\n\n确定切换到新的云目录？'
          ))
          if (!ok) { setBusy(false); return }
        }
      }
    } catch { /* 检查失败不阻塞连接 */ }
    try {
      const r = await window.api.cloudConnectKey(k, test && test.files > 0 ? 'download' : '')
      toast('已连接「' + r.name + '」，正在加载…', 'success')
      onDone()
      window.setTimeout(() => requestPanelReload(), 500)
    } catch (e) {
      toast('连接失败：' + (e as Error).message, 'error')
    } finally { setBusy(false); connectingRef.current = false }
  }

  const copy = async (text: string): Promise<void> => {
    try {
      await window.api.copyText(text)
      toast('key 已复制，粘到别的设备即可连接', 'success')
    } catch (e) {
      toast('复制失败：' + (e as Error).message + '（可直接选中输入框里的 key 手动复制）', 'error')
    }
  }

  const currentKey = keyText.trim()

  /**
   * 实时检查粘贴进来的 key（**不过服务器**，纯本地判断）。
   *
   * 背景：长 key 有 700 多字符，从聊天窗口复制极易漏字符 —— 用户之前多次失败都出在这里。
   *
   * 设计原则（踩过坑）：**这里只做"能不能试着连"的判断，不做"完整不完整"的判定**。
   * 上一版我按长度断言"应为 N 字符"，公式写错了（固定开销写成 16，实际是 12），
   * 结果**正确的 key 被误判成"少了字符"，还把「测试 key / 连接」按钮禁用了** ——
   * 抗错反而把用户挡在门外。所以现在：
   *   · 只有"明显不是 key"（前缀不对/段数不对/太短）才报错；
   *   · 长度只做提示，**不禁用按钮**；
   *   · 真正的完整性由宿主的 decodeCloudKey 用校验位判定（它才是权威）。
   */
  const keyCheck = (() => {
    const cleaned = keyText.replace(/[\u201c\u201d\u2018\u2019"'`]/g, '').replace(/[\s\u00a0\u3000]+/g, '').trim()
    if (cleaned === '') return null
    const parts = cleaned.split('-')
    if (!/^Q[CS]\d$/.test(parts[0] ?? '')) {
      return { level: 'error' as const, text: `看起来不是 key：应以 QC1- 或 QS2- 开头（当前 ${cleaned.length} 字符）` }
    }
    if (parts.length < 4) {
      return { level: 'error' as const, text: `key 不完整：应有 4 段（当前 ${parts.length} 段、${cleaned.length} 字符）—— 请整串重新复制` }
    }
    // 长度参考值：前缀 + 3 个连字符 + 校验位就是全部固定开销
    const fixed = parts[0].length + 3 + parts[3].length
    const expect = parts[1].length + parts[2].length + fixed
    if (parts[0] === 'QS2') {
      return { level: 'ok' as const, text: `短 key，格式正确（${cleaned.length} 字符${cleaned.length === expect ? '' : `，参考长度 ${expect}`}）` }
    }
    return { level: 'warn' as const, text: `长 key（${cleaned.length} 字符）—— 点「测试 key」确认；若失败请整串重新复制` }
  })()

  return (
    <Modal title="连接云数据目录" onClose={onClose}>
      <div className="col" style={{ gap: 10 }}>
        <div className="small muted">
          把管理员给你的 key 粘贴到下面。key 里含这个云目录的访问凭据，<b>请勿公开分享</b>；
          换设备时把同一串 key 粘过去即可连上同一个目录。
        </div>
        <textarea
          className="textarea"
          rows={5}
          placeholder="QS2-…（短 key，约 63 字符）"
          value={keyText}
          onChange={(e) => { setKeyText(e.target.value); setTest(null) }}
          onPaste={(e) => {
            // 从聊天窗口复制常带换行/引号：粘贴时直接清洗，省得用户手动删
            const raw = e.clipboardData.getData('text')
            if (raw !== '') {
              e.preventDefault()
              setKeyText(raw.replace(/[\u201c\u201d\u2018\u2019"'`]/g, '').replace(/[\s\u00a0\u3000]+/g, ''))
              setTest(null)
            }
          }}
          style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}
        />
        {keyCheck !== null && (
          <div className="small" style={{
            color: keyCheck.level === 'error' ? 'var(--danger)' : (keyCheck.level === 'ok' ? 'var(--ok)' : 'var(--muted)')
          }}>
            {keyCheck.text}
          </div>
        )}
        {test !== null && (
          <div className="small" style={{ color: test.ok ? 'var(--ok)' : 'var(--danger)' }}>
            {test.ok
              ? `key 有效：云端已有 ${test.files} 个文件${test.name ? `（目录「${test.name}」）` : ''}`
              : '这个 key 暂时用不了：' + test.error}
          </div>
        )}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn" onClick={() => void doTest()} disabled={busy || keyCheck?.level === 'error' || keyText.trim() === ''}>测试 key</button>
          <button className="btn primary" onClick={() => void useIt()} disabled={busy || keyCheck?.level === 'error' || testedKey === ''}>连接</button>
        </div>
      </div>
    </Modal>
  )
}
