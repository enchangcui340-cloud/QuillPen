/** HTML → Markdown（turndown），保留标题/列表/表格/链接 */
import TurndownService from 'turndown'
import type { ExtractResult } from './types'
import { clipText, countTables } from './types'

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })

export function extractHtml(html: string): ExtractResult {
  // 去掉脚本和样式（否则会变成一堆乱码文字进上下文）
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  const md = td.turndown(clean).replace(/\n{3,}/g, '\n\n').trim()
  return {
    text: clipText(md),
    pages: [],
    mode: 'text',
    note: '按文字解析（网页结构已转为 Markdown）',
    issues: [],
    stats: { chars: md.length, tables: countTables(md), pages: 0 }
  }
}
