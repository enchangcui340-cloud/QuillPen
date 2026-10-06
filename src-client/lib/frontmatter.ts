/**
 * 笔记文件头部的 YAML（frontmatter）保存 id/title 等元数据。
 * 这部分不应该出现在编辑区里：既影响观感，也容易被误当成正文格式化（例如被误加粗）。
 * 因此界面只显示正文，保存时再把原始头部原样接回去。
 */

export interface SplitContent {
  /** 原始头部（含首尾的 --- 行）；没有头部时为空串 */
  head: string
  /** 正文 */
  body: string
}

export function splitFrontmatter(content: string): SplitContent {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content)
  if (!m) return { head: '', body: content }
  return { head: m[0], body: content.slice(m[0].length) }
}

export function joinFrontmatter(head: string, body: string): string {
  if (!head) return body
  const h = head.endsWith('\n') ? head : head + '\n'
  return h + body
}
