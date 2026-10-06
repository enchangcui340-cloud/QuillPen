import type { ReactNode } from 'react'
import { CloseIcon } from './Icons'

export default function Modal(props: {
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  width?: number
}): React.ReactElement {
  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose() }}>
      <div className="modal" style={props.width ? { width: props.width } : undefined}>
        <div className="modal-head">
          <span className="grow">{props.title}</span>
          <button className="btn ghost small" onClick={props.onClose} title="关闭"><CloseIcon size={14} /></button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  )
}
