/**
 * 文件提取的统一结果。
 *
 * 关键：**双通道**
 *   text  —— 文字通道（省 token、可精确引用）
 *   pages —— 图片通道（扫描件 / 版式重要 / 自检失败时用）
 * 两者可以同时有：文字给结构，图片给"真相"。
 */
export interface ExtractResult {
  /** 提取出的 Markdown 文字（可能为空，例如纯扫描件） */
  text: string
  /** 页面图片的 dataURL（按页顺序） */
  pages: string[]
  /** 用了哪种通道 */
  mode: 'text' | 'image' | 'both'
  /** 面向用户的一句话说明（界面上标注"AI 到底看到了什么"） */
  note: string
  /** 自检发现的问题（有值时会被上面覆盖） */
  issues: string[]
  /** 统计，用于自检与界面显示 */
  stats: { chars: number; tables: number; pages: number; sheets?: number; slides?: number }
}

export const MAX_TEXT = 60000

/** 把过长的正文裁掉，但保留结尾（结尾常常有结论） */
export function clipText(s: string, max = MAX_TEXT): string {
  if (s.length <= max) return s
  const head = s.slice(0, Math.floor(max * 0.75))
  const tail = s.slice(-Math.floor(max * 0.15))
  return head + '\n\n…（中间 ' + (s.length - head.length - tail.length) + ' 字已省略）…\n\n' + tail
}

/** 数一数 Markdown 里有几张表 */
export function countTables(md: string): number {
  const lines = md.split('\n')
  let n = 0
  for (let i = 1; i < lines.length; i++) {
    if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i]) && lines[i].includes('-') && lines[i - 1].includes('|')) n++
  }
  return n
}
