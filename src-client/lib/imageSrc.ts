/**
 * 图片引用的解析规则。
 *
 * 附件文件名里经常有空格和括号（比如 "COFFEE.png (2).png"），
 * 直接写成 ![](路径) 会让 Markdown 解析不出来，所以：
 *   - 插入时把路径按 URL 规则转义（空格 -> %20，括号 -> %28 %29）
 *   - 解析时统一还原（去尖括号、解码）再查映射 / 拼协议地址
 */
import { attachmentUrl } from './attachments'

/** 去掉 Markdown 允许的 <...> 包裹，并去掉后面的标题部分 */
export function normalizeImageRef(raw: string): string {
  let s = (raw || '').trim()
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim()
  // 去掉 Markdown 的标题部分：![alt](url "标题")。
  // 注意只能认引号，不能把 "a b (2).png" 里的空格加括号当成标题截掉。
  s = s.replace(/\s+["'][^"']*["']\s*$/, '')
  return s
}

export function safeDecode(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

/** 插入到笔记里的写法：逐段转义 */
export function encodePath(rel: string): string {
  // encodeURIComponent 不会转义括号，而括号会破坏 Markdown 的 (...) 定界，这里补上
  return rel.split('/').map((seg) => encodeURIComponent(seg).replace(/\(/g, '%28').replace(/\)/g, '%29')).join('/')
}

/** 远端图片（http/data）不需要走附件协议 */
export function isRemoteImage(ref: string): boolean {
  return /^(https?:|data:)/i.test(ref)
}

/** 在"路径 -> data URL"映射里找图片，原文与解码后都试一遍 */
export function lookupImage(ref: string, images?: Record<string, string>): string | null {
  const raw = normalizeImageRef(ref)
  if (!images) return null
  return images[raw] ?? images[safeDecode(raw)] ?? null
}

/** 最终给 <img> 用的地址 */
export function resolveImageSrc(ref: string, images?: Record<string, string>): string {
  const raw = normalizeImageRef(ref)
  const hit = lookupImage(raw, images)
  if (hit) return hit
  if (isRemoteImage(raw)) return raw
  return attachmentUrl(safeDecode(raw))
}
