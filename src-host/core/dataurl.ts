/**
 * 解析 data URL（粘贴/拖拽进来的图片就是这种形式）。
 * 纯函数，方便单独测试。
 */
export interface ParsedDataUrl { mime: string; buffer: Buffer }

export function parseDataUrl(dataUrl: string): ParsedDataUrl {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec((dataUrl || '').trim())
  if (!m) throw new Error('无法识别的图片数据')
  const mime = m[1] || 'application/octet-stream'
  const isBase64 = !!m[2]
  const payload = m[3]
  const buffer = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8')
  if (!buffer.length) throw new Error('图片数据是空的')
  return { mime, buffer }
}

/** 根据 MIME 猜一个扩展名，给粘贴进来的图片起名用 */
export function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg'
  }
  return map[mime.toLowerCase()] ?? '.png'
}
