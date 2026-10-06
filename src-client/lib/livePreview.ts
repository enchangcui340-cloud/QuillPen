import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { resolveImageSrc } from './imageSrc'
import type { Extension, Range } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

/**
 * Markdown 实时预览：让「编辑模式」和「只读模式」看到的排版尽量一致。
 *
 * - 隐藏标记符号（**、*、#、-、>、[..](..)、![..](..)、---）
 * - 直接把效果画出来：加粗、斜体、标题、列表圆点、任务框、链接、图片、分割线、引用
 * - 只有当光标/选区真的落在某个标记内部时才临时显示该标记，方便精确修改；
 *   平时（包括光标停在行尾）与只读模式一致
 */

const RE_HIGHLIGHT = /==([ygp])==([\s\S]*?)==\1==/g
// 路径里可能有空格和括号（附件名常见），所以不能限制得太死
const RE_IMAGE = /^!\[([^\]]*)\]\((.+)\)$/
const RE_LINK = /^\[([^\]]*)\]\(([^)]+)\)$/
const RE_TASK = /^\[([ xX])\]/

export interface LivePreviewOptions {
  /** 图片相对路径 -> 可直接显示的 data URL */
  images?: Record<string, string>
}

/* ---------------- 小组件 ---------------- */

class BulletWidget extends WidgetType {
  eq(): boolean { return true }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-bullet'
    span.textContent = '•'
    return span
  }
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) { super() }
  eq(other: TaskWidget): boolean { return other.checked === this.checked }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-task' + (this.checked ? ' checked' : '')
    span.textContent = this.checked ? '☑' : '☐'
    return span
  }
}

class RuleWidget extends WidgetType {
  eq(): boolean { return true }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-rule'
    return span
  }
}

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly label = '') { super() }
  eq(other: ImageWidget): boolean { return other.src === this.src }
  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-image'
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.title = this.alt
    // 真读不到时再提示缺失，而不是一上来就说缺失
    img.addEventListener('error', () => {
      wrap.className = 'cm-image-missing'
      wrap.textContent = '图片缺失：' + (this.label || this.alt)
    })
    wrap.appendChild(img)
    return wrap
  }
}

class MissingImageWidget extends WidgetType {
  constructor(readonly label: string) { super() }
  eq(other: MissingImageWidget): boolean { return other.label === this.label }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-image-missing'
    span.textContent = '图片缺失：' + this.label
    return span
  }
}

/* ---------------- 装饰构建 ---------------- */

type RangeList = { marks: Range<Decoration>[]; replaces: Range<Decoration>[] }

function buildRanges(view: EditorView, options: LivePreviewOptions): RangeList {
  const marks: Range<Decoration>[] = []
  const replaces: Range<Decoration>[] = []
  const doc = view.state.doc
  const selections = view.state.selection.ranges.map((r) => ({ from: r.from, to: r.to }))

  /** 光标/选区是否真的落在这一段里；是则临时显示原文，否则隐藏 */
  const touched = (from: number, to: number): boolean =>
    selections.some((s) => s.from < to && s.to > from)

  const mark = (from: number, to: number, cls: string, attrs?: Record<string, string>): void => {
    if (to > from) marks.push(Decoration.mark({ class: cls, attributes: attrs }).range(from, to))
  }
  const hide = (from: number, to: number): void => {
    if (to > from && !touched(from, to)) replaces.push(Decoration.replace({}).range(from, to))
  }
  const replaceWith = (from: number, to: number, widget: WidgetType): void => {
    if (to > from) replaces.push(Decoration.replace({ widget }).range(from, to))
  }
  const addLine = (pos: number, cls: string): void => {
    marks.push(Decoration.line({ class: cls }).range(pos))
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const text = doc.sliceString(node.from, node.to)
        const lineStart = doc.lineAt(node.from).from

        switch (node.name) {
          case 'StrongEmphasis': {
            const m = /^(\*\*|__)([\s\S]+)(\*\*|__)$/.exec(text)
            if (!m) return
            const open = m[1].length
            hide(node.from, node.from + open)
            hide(node.to - open, node.to)
            mark(node.from + open, node.to - open, 'cm-strong')
            return
          }
          case 'Emphasis': {
            const m = /^(\*|_)([\s\S]+)(\*|_)$/.exec(text)
            if (!m) return
            hide(node.from, node.from + 1)
            hide(node.to - 1, node.to)
            mark(node.from + 1, node.to - 1, 'cm-em')
            return
          }
          case 'InlineCode': {
            mark(node.from, node.to, 'cm-code')
            return
          }
          case 'Link': {
            const m = RE_LINK.exec(text)
            if (m) {
              const [whole, label, url] = m
              const labelStart = node.from + 1
              const labelEnd = labelStart + label.length
              hide(node.from, labelStart)
              hide(labelEnd, node.to)
              // 把真实地址挂在元素上，点击时直接读出来打开（编辑态原来点不动就是缺这个）
              mark(labelStart, labelEnd, 'cm-link', { 'data-href': url, title: url })
              void whole
            } else {
              mark(node.from, node.to, 'cm-link')
            }
            return
          }
          case 'Image': {
            const m = RE_IMAGE.exec(text)
            if (!m) return
            // 统一解析：先查映射，查不到就走附件协议按需读取（新插入的图片也能立刻显示）
            const src = resolveImageSrc(m[2], options.images)
            replaceWith(node.from, node.to, new ImageWidget(src, m[1], m[1] || m[2]))
            return
          }
          case 'ListMark': {
            // 无序列表圆点；有序列表保留编号
            if (/^[-*+]$/.test(text.trim())) replaceWith(node.from, node.to, new BulletWidget())
            return
          }
          // 任务列表功能已移除：- [ ] 按普通列表显示，内容保留不丢
          case 'Blockquote': {
            addLine(lineStart, 'cm-quote')
            return
          }
          case 'HorizontalRule': {
            addLine(lineStart, 'cm-hr')
            replaceWith(node.from, node.to, new RuleWidget())
            return
          }
          default:
            break
        }

        if (/^ATXHeading[1-6]$/.test(node.name)) {
          const level = node.name.slice(-1)
          const m = /^(#{1,6})\s+/.exec(text)
          if (m) hide(node.from, node.from + m[0].length)
          addLine(lineStart, 'cm-h' + level)
        }
      }
    })
  }

  // 引用行的 > 标记（语法树外层是 Blockquote，这里按行补一次）
  for (const { from, to } of view.visibleRanges) {
    const startLine = doc.lineAt(from).number
    const endLine = doc.lineAt(to).number
    for (let n = startLine; n <= endLine; n++) {
      const line = doc.line(n)
      const m = /^(\s*)(>+\s?)/.exec(line.text)
      if (m) hide(line.from + m[1].length, line.from + m[0].length)
    }
  }

  // 三色高亮是自定义语法，语法树不认识，用正则单独处理
  for (const { from, to } of view.visibleRanges) {
    const startLine = doc.lineAt(from).number
    const endLine = doc.lineAt(to).number
    for (let n = startLine; n <= endLine; n++) {
      const line = doc.line(n)
      RE_HIGHLIGHT.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = RE_HIGHLIGHT.exec(line.text))) {
        const base = line.from + m.index
        const innerFrom = base + 5
        const innerTo = base + m[0].length - 5
        if (innerTo <= innerFrom) continue
        const cls = m[1] === 'y' ? 'cm-hl-yellow' : m[1] === 'g' ? 'cm-hl-green' : 'cm-hl-pink'
        mark(innerFrom, innerTo, cls)
        hide(base, innerFrom)
        hide(innerTo, base + m[0].length)
      }
    }
  }

  return { marks, replaces }
}

/** 去掉互相重叠的 replace 区间（靠前者优先）。 */
function dedupe(ranges: Range<Decoration>[]): Range<Decoration>[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to)
  const out: Range<Decoration>[] = []
  let lastTo = -1
  for (const r of sorted) {
    if (r.from < lastTo) continue
    out.push(r)
    lastTo = r.to
  }
  return out
}

function build(view: EditorView, options: LivePreviewOptions): { decorations: DecorationSet; atomic: DecorationSet } {
  const { marks, replaces } = buildRanges(view, options)
  const hidden = dedupe(replaces)
  let decorations: DecorationSet
  try {
    decorations = Decoration.set([...marks, ...hidden], true)
  } catch {
    try { decorations = Decoration.set(marks, true) } catch { decorations = Decoration.none }
  }
  // 只有「被隐藏的标记」才是原子区间，正文（加粗文字等）必须仍可自由放置光标
  let atomic: DecorationSet
  try { atomic = Decoration.set(hidden, true) } catch { atomic = Decoration.none }
  return { decorations, atomic }
}

export function livePreview(options: LivePreviewOptions = {}): Extension {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet
    atomic: DecorationSet
    options: LivePreviewOptions

    constructor(view: EditorView) {
      this.options = options
      const built = build(view, this.options)
      this.decorations = built.decorations
      this.atomic = built.atomic
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        const built = build(update.view, this.options)
        this.decorations = built.decorations
        this.atomic = built.atomic
      }
    }
  }, {
    decorations: (v) => v.decorations,
    // 光标跳过被隐藏的标记符号，但不影响正文编辑
    provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none)
  })
}
