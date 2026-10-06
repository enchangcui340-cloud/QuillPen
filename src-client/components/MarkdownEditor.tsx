import { useEffect, useRef } from 'react'
import { EditorView, keymap, drawSelection } from '@codemirror/view'
import { Compartment, EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { livePreview } from '../lib/livePreview'

interface Props {
  value: string
  readonly: boolean
  /** 图片相对路径 -> data URL，用于在编辑区直接显示图片 */
  images?: Record<string, string>
  onChange: (value: string) => void
  onSave: () => void
  onContextMenu: (e: React.MouseEvent) => void
  /** 粘贴/拖入图片时回调，由上层存进附件目录并插入引用 */
  onPasteImage?: (files: File[]) => void
  onReady?: (view: EditorView) => void
}

/** CodeMirror 版 Markdown 编辑器：带实时预览（隐藏标记、直接显示效果）。 */
/** 从剪贴板或拖拽数据里挑出图片文件（截图、复制的图、拖进来的图） */
function imagesFrom(data: DataTransfer | null): File[] {
  if (!data) return []
  const out: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile()
      if (f) out.push(f)
    }
  }
  if (!out.length) {
    for (const f of Array.from(data.files ?? [])) if (f.type.startsWith('image/')) out.push(f)
  }
  return out
}

export default function MarkdownEditor({ value, readonly, images, onChange, onSave, onContextMenu, onReady, onPasteImage }: Props): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const readonlyCompartment = useRef(new Compartment())
  const handlers = useRef({ onChange, onSave, onReady, onPasteImage })
  handlers.current = { onChange, onSave, onReady, onPasteImage }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          markdown(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          livePreview({ images }),
          readonlyCompartment.current.of(EditorState.readOnly.of(readonly)),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { handlers.current.onSave(); return true } },
            { key: 'Mod-b', preventDefault: true, run: (v) => { void import('../lib/mdCommands').then((m) => m.toggleWrap(v, '**')); return true } },
            { key: 'Mod-i', preventDefault: true, run: (v) => { void import('../lib/mdCommands').then((m) => m.toggleWrap(v, '*')); return true } },
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab
          ]),
          EditorView.updateListener.of((u) => { if (u.docChanged) handlers.current.onChange(u.state.doc.toString()) }),
          EditorView.domEventHandlers({
            contextmenu: (event) => { event.preventDefault() },
            // 支持直接粘贴图片（截图、复制的图）和把图片文件拖进来
            paste: (event) => {
              const files = imagesFrom(event.clipboardData)
              if (!files.length) return false      // 普通文字粘贴走默认行为
              event.preventDefault()
              handlers.current.onPasteImage?.(files)
              return true
            },
            drop: (event) => {
              const files = imagesFrom(event.dataTransfer)
              if (!files.length) return false
              event.preventDefault()
              handlers.current.onPasteImage?.(files)
              return true
            }
          })
        ]
      })
    })
    viewRef.current = view
    handlers.current.onReady?.(view)
    return () => { view.destroy(); viewRef.current = null }
    // 只在挂载时创建一次；切换笔记由父组件用 key 强制重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: readonlyCompartment.current.reconfigure(EditorState.readOnly.of(readonly)) })
    // 从只读切回编辑时，编辑器刚从 display:none 恢复，需要重新测量
    const raf = requestAnimationFrame(() => { try { view.requestMeasure() } catch { /* 忽略 */ } })
    return () => cancelAnimationFrame(raf)
  }, [readonly])

  return <div className="cm-host" ref={hostRef} onContextMenu={onContextMenu} />
}
