/**
 * Excel → Markdown 表格（自己解析 OOXML，零依赖）。
 *
 * 比"转 CSV"好在哪：
 *   · **所有 sheet** 都读（现在只读 sheet1 ✗）
 *   · 公式取**缓存的计算值**（<v>），而不是把 =SUM(...) 当成内容给模型
 *   · 合并单元格会补全空格，表格结构不塌
 *   · 直接产出 Markdown 表格，模型一眼看懂行列关系
 */
import type { ExtractResult } from './types'
import { clipText, countTables } from './types'
import { selfCheck } from './selfcheck'

const unescapeXml = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** 列号 A→0, B→1, ... AA→26 */
function colIndex(ref: string): number {
  const letters = (ref.match(/^[A-Z]+/) ?? ['A'])[0]
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = []
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1]
      const inner = cellMatch[2]
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? ''
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? ''
      // 值：共享字符串取索引，其余取 <v> 里的计算值
      let value = ''
      if (type === 's') {
        const idx = Number(/<v>(\d+)<\/v>/.exec(inner)?.[1] ?? -1)
        value = idx >= 0 ? (shared[idx] ?? '') : ''
      } else if (type === 'inlineStr') {
        value = unescapeXml([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''))
      } else {
        // 数字、公式结果（<f> 是公式本身，<v> 才是计算结果）
        value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '')
      }
      const col = ref ? colIndex(ref) : cells.length
      while (cells.length < col) cells.push('')
      cells[col] = value.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
    }
    if (cells.some((c) => c !== '')) rows.push(cells)
  }
  return rows
}

function toMarkdown(rows: string[][], title: string): string {
  if (!rows.length) return '## ' + title + '\n\n（这张表是空的）'
  const width = Math.max(...rows.map((r) => r.length))
  for (const r of rows) while (r.length < width) r.push('')
  const head = rows[0].map((c) => c || ' ')
  const rest = rows.slice(1)
  return [
    '## ' + title,
    '',
    '| ' + head.join(' | ') + ' |',
    '| ' + head.map(() => '---').join(' | ') + ' |',
    ...rest.map((r) => '| ' + r.map((c) => c || ' ').join(' | ') + ' |')
  ].join('\n')
}

export function extractXlsx(
  readZip: (p: string) => Buffer | null,
  listZip: () => string[]
): ExtractResult {
  // 共享字符串表
  const sharedXml = readZip('xl/sharedStrings.xml')?.toString('utf8') ?? ''
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    unescapeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''))
  )
  // sheet 名称（从 workbook.xml 拿，失败就用文件名）
  const wb = readZip('xl/workbook.xml')?.toString('utf8') ?? ''
  const sheetNames = [...wb.matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => unescapeXml(m[1]))

  const sheetFiles = listZip()
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]))

  const parts: string[] = []
  const cols: number[] = []
  sheetFiles.forEach((file, i) => {
    const xml = readZip(file)?.toString('utf8') ?? ''
    const rows = parseSheet(xml, shared)
    if (!rows.length) return
    const name = sheetNames[i] ?? ('Sheet' + (i + 1))
    parts.push(toMarkdown(rows, name))
    cols.push(rows.length)
  })

  const md = parts.join('\n\n')
  const check = selfCheck({ kind: 'xlsx', text: md, pages: 0, bytes: 0 })
  return {
    text: clipText(md),
    pages: [],
    mode: 'text',
    note: '按文字解析（' + sheetFiles.length + ' 张表已全部转为 Markdown 表格，公式取计算值）',
    issues: check.issues,
    stats: { chars: md.length, tables: countTables(md), pages: 0, sheets: sheetFiles.length }
  }
}
