import { useState } from 'react'
import Modal from './Modal'
import { toast } from './Toast'
import { defaultLabel } from '../lib/linkTarget'

/** 插入链接：网页地址和本地文件都支持，本地文件可以直接用系统选择框挑。 */
export default function LinkDialog({ onClose, onConfirm }: {
  onClose: () => void
  onConfirm: (label: string, target: string) => void
}): React.ReactElement {
  const [target, setTarget] = useState('')
  const [label, setLabel] = useState('')

  const pick = async (): Promise<void> => {
    try {
      const p = await window.api.pickFile()
      if (!p) return
      setTarget(p)
      if (!label.trim()) setLabel(defaultLabel(p))
    } catch (e) {
      toast('选择文件失败：' + (e as Error).message, 'error')
    }
  }

  const confirm = (): void => {
    const t = target.trim()
    if (!t) { toast('请填写链接地址或选择文件', 'error'); return }
    onConfirm(label.trim() || defaultLabel(t), t)
  }

  return (
    <Modal
      title="插入链接 / 本地文件"
      width={580}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={confirm}>插入</button>
        </>
      }
    >
      <div className="col" style={{ gap: 10 }}>
        <div className="small muted">链接地址或本地文件路径</div>
        <div className="row" style={{ gap: 6 }}>
          <input
            className="input grow"
            autoFocus
            value={target}
            onChange={(e) => { setTarget(e.target.value); if (!label.trim()) setLabel('') }}
            onKeyDown={(e) => { if (e.key === 'Enter') confirm() }}
            placeholder="https://example.com  或  C:\资料\课程手册.pdf"
          />
          <button className="btn" onClick={() => void pick()}>选择文件…</button>
        </div>
        <div className="small muted">显示文字（留空则自动用文件名 / 网址末段）</div>
        <input
          className="input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') confirm() }}
          placeholder={target ? defaultLabel(target) : '例如：课程手册'}
        />
        <div className="small muted" style={{ lineHeight: 1.7 }}>
          · 网页链接（http/https）用默认浏览器打开<br />
          · 本地文件用系统默认程序打开（PDF 用阅读器、图片用看图工具…）<br />
          · 笔记库里的附件可以直接写相对路径，例如 <code>_attachments/图.png</code>
        </div>
      </div>
    </Modal>
  )
}
