import { requestPanelReload } from '../lib/host-adapt'
import { useState } from 'react'
import Modal from './Modal'
import { toast } from './Toast'
import CloudCreateDialog from './CloudCreateDialog'

/**
 * 新建数据目录：选一个本地文件夹，自动在里面生成可用的库结构。
 * 如果那个文件夹已经是一个库，就直接登记进来（不覆盖任何文件）。
 */
export default function LibraryCreateDialog({ onClose, onDone }: {
  onClose: () => void
  onDone: () => void
}): React.ReactElement {
  const [dir, setDir] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [showCloud, setShowCloud] = useState(false)

  const pick = async (): Promise<void> => {
    try {
      const p = await window.api.libraryPickFolder()
      if (!p) return
      setDir(p)
      if (!name.trim()) setName(p.split(/[\\/]/).filter(Boolean).pop() ?? '')
    } catch (e) {
      toast('选择文件夹失败：' + (e as Error).message, 'error')
    }
  }

  const create = async (): Promise<void> => {
    const d = dir.trim()
    if (!d) { toast('请选择或填写一个文件夹', 'error'); return }
    setBusy(true)
    try {
      const r = await window.api.libraryCreate(d, name.trim())
      toast(r.created ? '已创建数据目录，正在切换…' : '已登记已有数据目录，正在切换…', 'success')
      onDone()
      window.setTimeout(() => requestPanelReload(), 400)
    } catch (e) {
      toast('创建失败：' + (e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="新建数据目录"
      width={620}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy} onClick={() => void create()}>创建并切换</button>
        </>
      }
    >
      {showCloud && <CloudCreateDialog onClose={() => setShowCloud(false)} onDone={() => { setShowCloud(false); onDone() }} />}
      <div className="row" style={{ gap: 6, marginBottom: 10 }}>
        <button className="btn small primary">本机目录</button>
        <button className="btn small" onClick={() => setShowCloud(true)}>☁ 云数据目录…</button>
        <span className="small muted">（云端需要服务器，点右侧创建或粘贴 key）</span>
      </div>
      <div className="col" style={{ gap: 10 }}>
        <div className="small muted">选一个文件夹，程序会在里面自动生成 notes/、data/ 等结构；如果那里已经有笔记库，会直接登记（不会覆盖任何东西）。</div>
        <div className="row" style={{ gap: 6 }}>
          <input
            className="input grow"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="C:\我的笔记  或  D:\Quill\工作区"
            onKeyDown={(e) => { if (e.key === 'Enter') void create() }}
          />
          <button className="btn" onClick={() => void pick()}>选择文件夹…</button>
        </div>
        <div className="small muted">显示名称（留空则用文件夹名）</div>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：课程笔记" />
        <div className="small muted" style={{ lineHeight: 1.7 }}>
          · 数据目录之间**互相独立**，切换时界面会重新加载<br />
          · 可以放在任何可写的位置（桌面、文档、D 盘…）<br />
          · 便携版软件文件夹内部的目录会存成相对路径，整个文件夹拷走也能用
        </div>
      </div>
    </Modal>
  )
}
