/**
 * 应用内输入/确认对话框（替代 window.prompt 与 window.confirm）。
 *
 * 为什么必须替换：
 *   DSH 页面与 Quill 一样跑在 Electron 渲染进程里，**window.prompt 在那里不可用**
 *   （Quill 的使用说明里记着这条："点了没反应，是因为用了 Electron 不支持的浏览器弹窗"）。
 *   window.confirm 虽然能弹，但样式与整站不一致、且会阻塞渲染线程，一并换掉。
 *
 * 用法（照 Toast 的模块级 store + Host 组件模式）：
 *   const name = await askText('新的名称', '旧名字')      // 取消返回 null
 *   if (!(await askConfirm('确定删除？', '会进回收站'))) return
 */
import { useEffect, useState } from 'react'
import Modal from './Modal'

interface AskTextRequest {
  kind: 'text'
  title: string
  placeholder?: string
  defaultValue: string
  resolve: (value: string | null) => void
}
interface AskConfirmRequest {
  kind: 'confirm'
  title: string
  detail?: string
  confirmLabel: string
  resolve: (value: boolean) => void
}
export type AskRequest = AskTextRequest | AskConfirmRequest

let current: AskRequest | null = null
let listeners: ((ask: AskRequest | null) => void)[] = []

function publish(): void {
  for (const listener of listeners) listener(current)
}

/** 弹一个输入框；确定返回文本，取消返回 null */
export function askText(title: string, defaultValue = '', placeholder?: string): Promise<string | null> {
  return new Promise((resolve) => {
    current = { kind: 'text', title, defaultValue, placeholder, resolve }
    publish()
  })
}

/** 弹一个确认框；确定 true、取消 false */
export function askConfirm(title: string, detail?: string, confirmLabel = '确定'): Promise<boolean> {
  return new Promise((resolve) => {
    current = { kind: 'confirm', title, detail, confirmLabel, resolve }
    publish()
  })
}

/** 宿主：挂在 App 里（与 ToastHost 同级） */
export function AskHost(): React.ReactElement | null {
  const [ask, setAsk] = useState<AskRequest | null>(current)

  useEffect(() => {
    listeners.push(setAsk)
    setAsk(current)
    return () => { listeners = listeners.filter((l) => l !== setAsk) }
  }, [])

  if (ask === null) return null

  const finishText = (value: string | null): void => {
    const request = ask
    current = null
    publish()
    if (request.kind === 'text') request.resolve(value)
  }
  const finishConfirm = (value: boolean): void => {
    const request = ask
    current = null
    publish()
    if (request.kind === 'confirm') request.resolve(value)
  }

  if (ask.kind === 'text') {
    return <TextField title={ask.title} defaultValue={ask.defaultValue} placeholder={ask.placeholder} onDone={finishText} />
  }
  return (
    <Modal
      title={ask.title}
      onClose={() => finishConfirm(false)}
      footer={
        <>
          <button className="btn" onClick={() => finishConfirm(false)}>取消</button>
          <button className="btn primary" onClick={() => finishConfirm(true)}>{ask.confirmLabel}</button>
        </>
      }
    >
      {ask.detail !== undefined && <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{ask.detail}</div>}
    </Modal>
  )
}

/** 输入框本体：单独一个组件，保证每次请求的初值都被正确初始化 */
function TextField(props: {
  title: string
  defaultValue: string
  placeholder?: string
  onDone: (value: string | null) => void
}): React.ReactElement {
  const [value, setValue] = useState(props.defaultValue)
  useEffect(() => { setValue(props.defaultValue) }, [props.defaultValue])

  return (
    <Modal
      title={props.title}
      onClose={() => props.onDone(null)}
      footer={
        <>
          <button className="btn" onClick={() => props.onDone(null)}>取消</button>
          <button className="btn primary" onClick={() => props.onDone(value)}>确定</button>
        </>
      }
    >
      <input
        className="input"
        autoFocus
        value={value}
        placeholder={props.placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); props.onDone(value) }
          if (e.key === 'Escape') { e.preventDefault(); props.onDone(null) }
        }}
      />
    </Modal>
  )
}
