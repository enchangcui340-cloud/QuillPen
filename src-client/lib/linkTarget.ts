/**
 * 链接目标的处理逻辑（纯函数，便于测试）。
 *
 * 支持三类：网页链接、本地文件、本地文件夹（以及笔记库内的相对路径）。
 */

export type TargetKind = 'web' | 'file' | 'relative'

/** Windows 绝对路径：C:\... 或 \\server\share */
export function isWindowsPath(raw: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw)
}

export function classifyTarget(raw: string): TargetKind {
  const t = (raw || '').trim()
  if (/^(https?:|mailto:)/i.test(t)) return 'web'
  if (/^file:\/\//i.test(t) || isWindowsPath(t)) return 'file'
  return 'relative'
}

/** 取个默认显示名：网址用域名+末段，路径用文件名 */
export function defaultLabel(raw: string): string {
  const t = (raw || '').trim()
  if (!t) return '链接'
  if (/^(https?:|mailto:)/i.test(t)) {
    try {
      const u = new URL(t)
      const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '')
      return seg || u.hostname || t
    } catch {
      return t
    }
  }
  const clean = t.replace(/^file:\/\//i, '').replace(/[\\/]+$/, '')
  const name = clean.split(/[\\/]/).pop() ?? clean
  return decodeURIComponent(name.replace(/\.[^.]+$/, '')) || name || '链接'
}

/** 写进 Markdown 的形式：绝对路径统一用 file:///，其余原样 */
export function toMarkdownTarget(raw: string): string {
  const t = (raw || '').trim()
  if (isWindowsPath(t)) return 'file:///' + t.replace(/\\/g, '/').split('/').map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/')
  return t
}
