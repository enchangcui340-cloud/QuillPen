import type { EditorView } from '@codemirror/view'
import { planInlineToggle, planLineToggle } from './mdToggle'

/** 在光标/选区两侧插入标记（如 ** 加粗）。 */
export function wrapSelection(view: EditorView, before: string, after: string = before): void {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)
  view.dispatch({
    changes: { from, to, insert: before + selected + after },
    selection: { anchor: from + before.length, head: from + before.length + selected.length }
  })
  view.focus()
}

/** 给选中的每一行加前缀（如列表、标题）。 */
export function prefixLines(view: EditorView, prefix: string): void {
  const doc = view.state.doc
  const { from, to } = view.state.selection.main
  const startLine = doc.lineAt(from).number
  const endLine = doc.lineAt(to).number
  const changes: { from: number; insert: string }[] = []
  for (let n = startLine; n <= endLine; n++) changes.push({ from: doc.line(n).from, insert: prefix })
  const delta = prefix.length * (endLine - startLine + 1)
  view.dispatch({ changes, selection: { anchor: from + prefix.length, head: to + delta } })
  view.focus()
}

/** 在光标处插入一段文本。 */
export function insertText(view: EditorView, text: string): void {
  const { from, to } = view.state.selection.main
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
  view.focus()
}

/** 用链接形式包裹选中文字：[文字](https://)。 */
export function insertLink(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to) || '链接文字'
  const insert = '[' + selected + '](https://)'
  const anchor = from + 1 + selected.length + 3
  view.dispatch({ changes: { from, to, insert }, selection: { anchor } })
  view.focus()
}

/** 去掉选区内的高亮标记。 */
export function clearHighlight(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const text = view.state.sliceDoc(from, to)
  const next = text.replace(/==[ygp]==/g, '')
  view.dispatch({ changes: { from, to, insert: next }, selection: { anchor: from, head: from + next.length } })
  view.focus()
}

/**
 * 格式开关：选中已加格式的内容再点一次 = 取消；有未加格式的内容 = 全部加上。
 * （旧版 wrapSelection 只会不断包标记，点两次会变成 ****粗体****。）
 */
export function toggleWrap(view: EditorView, before: string, after: string = before, siblings: [string, string][] = []): void {
  const { from, to } = view.state.selection.main
  const plan = planInlineToggle(view.state.doc.toString(), from, to, before, after, siblings)
  if (plan.from === plan.to && plan.insert === '') return
  view.dispatch({
    changes: { from: plan.from, to: plan.to, insert: plan.insert },
    selection: { anchor: plan.selFrom, head: plan.selTo },
    scrollIntoView: true
  })
  view.focus()
}

/** 行首格式开关：标题 / 各种列表 */
export function togglePrefixLines(view: EditorView, prefix: string): void {
  const { from, to } = view.state.selection.main
  const changes = planLineToggle(view.state.doc.toString(), from, to, prefix)
  if (!changes.length) return
  view.dispatch({ changes, scrollIntoView: true })
  view.focus()
}

/** 插入 [显示文字](目标)。显示文字为空时直接用目标。 */
export function insertMarkdownLink(view: EditorView, label: string, target: string): void {
  const text = label.trim() || target
  const insert = '[' + text + '](' + target + ')'
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)
  view.dispatch({
    changes: { from, to, insert: selected ? '[' + selected + '](' + target + ')' : insert },
    selection: { anchor: from + (selected ? selected.length + 3 + target.length : insert.length) },
    scrollIntoView: true
  })
  view.focus()
}
