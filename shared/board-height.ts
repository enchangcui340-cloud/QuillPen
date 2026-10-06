/**
 * 文字卡片的高度估算。
 *
 * 放在 shared 是因为**主进程（AI 加卡片）和渲染层（用户手动输入）都要用同一套算法**，
 * 两边算得不一样就会出现"AI 加的卡片压字"。
 */

export interface TextMetricsInput {
  text: string
  w: number
  fontSize: number
  /** 左右内边距之和 */
  padX?: number
  /** 上下内边距之和 */
  padY?: number
  lineHeight?: number
}

/** 单个字符占多少个"字宽" */
export function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  // CJK / 全角标点 / 中文扩展
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)) return 1
  return 0.55
}

export function estimateTextHeight(input: TextMetricsInput): number {
  const padX = input.padX ?? 24
  const padY = input.padY ?? 24
  const lh = input.lineHeight ?? 1.5
  const fontSize = Math.max(8, input.fontSize)
  const avail = Math.max(fontSize, input.w - padX)
  const lineH = fontSize * lh
  let lines = 0
  for (const raw of (input.text || '').split('\n')) {
    if (!raw.length) { lines += 1; continue }
    let used = 0
    let n = 1
    for (const ch of raw) {
      const cw = charWidth(ch) * fontSize
      if (used + cw > avail) { n += 1; used = cw } else { used += cw }
    }
    lines += n
  }
  return Math.ceil(lines * lineH + padY)
}
