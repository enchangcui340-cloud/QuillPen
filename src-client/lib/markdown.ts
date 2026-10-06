/**
 * 极简 Markdown 渲染：只覆盖需求规定的功能。
 * 支持标题、粗体、斜体、有序/无序列表、任务列表、链接、图片、分割线、三色高亮。
 * 所有输入先做 HTML 转义，避免笔记内容注入界面。
 */

import { normalizeImageRef, resolveImageSrc } from './imageSrc'

export interface RenderOptions {
  /** 图片相对路径 -> data URL */
  images?: Record<string, string>
  /** 链接是否交给系统浏览器打开 */
  onLinkClick?: (url: string) => void
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const HIGHLIGHT: Record<string, string> = {
  '==y==': 'hl-yellow',
  '==g==': 'hl-green',
  '==p==': 'hl-pink'
}

/** 行内语法：转义 -> 代码 -> 图片 -> 链接 -> 加粗/斜体 -> 高亮 */
function inline(text: string, options: RenderOptions, baseDir: string): string {
  let out = escapeHtml(text)
  const codes: string[] = []
  out = out.replace(/\x60([^\x60]+)\x60/g, (_m, code: string) => {
    codes.push(code)
    return '\u0000CODE' + (codes.length - 1) + '\u0000'
  })
  out = out.replace(/!\[([^\]]*)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (_m, alt: string, src: string) => {
    // 与编辑器用同一套解析：映射查不到就走附件协议按需读取，不再直接报"图片缺失"
    const url = resolveImageSrc(src, options.images)
    const label = alt || normalizeImageRef(src)
    return '<img src="' + url + '" alt="' + label + '" title="' + label + '" />'
  })
  out = out.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_m, label: string, href: string) => {
    const raw = href.trim()
    // 网页 / 本地文件 / 库内相对路径都保留；只有真正的危险协议才废掉
    const winPath = /^[a-zA-Z]:[\\/]/.test(raw)
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw)
    const safe = winPath || /^(https?:|mailto:|file:)/i.test(raw) || !hasScheme ? raw : '#'
    return '<a href="' + safe + '" data-href="' + safe + '">' + (label || raw) + '</a>'
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/==y==([\s\S]+?)==y==/g, '<mark class="hl-yellow">$1</mark>')
  out = out.replace(/==g==([\s\S]+?)==g==/g, '<mark class="hl-green">$1</mark>')
  out = out.replace(/==p==([\s\S]+?)==p==/g, '<mark class="hl-pink">$1</mark>')
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => '<code>' + codes[Number(i)] + '</code>')
  return out
}

export function renderMarkdown(source: string, options: RenderOptions = {}): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let inCode = false
  const closeList = (): void => { if (listType) { html.push('</' + listType + '>'); listType = null } }

  for (const raw of lines) {
    const line = raw
    if (/^\x60\x60\x60/.test(line.trim())) {
      closeList()
      if (inCode) { html.push('</code></pre>'); inCode = false } else { html.push('<pre><code>'); inCode = true }
      continue
    }
    if (inCode) { html.push(escapeHtml(line)); continue }
    if (/^\s*$/.test(line)) { closeList(); continue }

    // 分割线（必须在列表规则之前判断，否则 --- 会被当成列表项）
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { closeList(); html.push('<hr />'); continue }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      html.push('<h' + heading[1].length + '>' + inline(heading[2], options, '') + '</h' + heading[1].length + '>')
      continue
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (ul) {
      if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul' }
      html.push('<li>' + inline(ul[1], options, '') + '</li>')
      continue
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ol) {
      if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol' }
      html.push('<li>' + inline(ol[1], options, '') + '</li>')
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) { closeList(); html.push('<blockquote>' + inline(quote[1], options, '') + '</blockquote>'); continue }
    closeList()
    html.push('<p>' + inline(line, options, '') + '</p>')
  }
  closeList()
  if (inCode) html.push('</code></pre>')
  return html.join('\n')
}

/** 编辑工具栏用：在选中的文字前后插入标记。 */
export function wrapSelection(text: string, start: number, end: number, before: string, after = before): { text: string; selStart: number; selEnd: number } {
  const selected = text.slice(start, end)
  const next = text.slice(0, start) + before + selected + after + text.slice(end)
  return { text: next, selStart: start + before.length, selEnd: start + before.length + selected.length }
}

export function prefixLines(text: string, start: number, end: number, prefix: string): { text: string; selStart: number; selEnd: number } {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const nlAfter = text.indexOf('\n', Math.max(end, start))
  const lineEnd = nlAfter === -1 ? text.length : nlAfter
  const block = text.slice(lineStart, lineEnd)
  const next = block.split('\n').map((l) => (l.startsWith(prefix) ? l : prefix + l)).join('\n')
  return { text: text.slice(0, lineStart) + next + text.slice(lineEnd), selStart: lineStart, selEnd: lineStart + next.length }
}

export { HIGHLIGHT }
