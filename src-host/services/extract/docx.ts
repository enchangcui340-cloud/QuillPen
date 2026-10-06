/**
 * Word 文档 → Markdown（mammoth + turndown）。
 *
 * 为什么不用 LibreOffice / markitdown：
 *   它们要么 +182 MB（LibreOffice），要么要 Python + onnxruntime（约 200 MB）。
 *   mammoth 解析的是同一份 OOXML，**内容保真度是同一层原理**，体积只有 1.6 MB。
 *
 * 保真要点：标题、粗斜体、嵌套列表、**表格**、链接 —— 都保留；
 * 图片不是丢掉，而是抽出来存进 _attachments 并在正文里留引用。
 */
import TurndownService from 'turndown'
import type { ExtractResult } from './types'
import { clipText, countTables } from './types'
import { selfCheck } from './selfcheck'

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*'
})

// mammoth 产出的 HTML 里，表格要留住（turndown 默认规则不支持表格）
turndown.addRule('table', {
  filter: ['table'],
  replacement: (_content, node) => {
    // turndown 传进来的是 DOM 节点；这里只需要 querySelectorAll 的能力
    const el = node as unknown as { querySelectorAll: (sel: string) => ArrayLike<unknown> }
    const toArr = (list: ArrayLike<unknown>): unknown[] => Array.from(list)
    const rows = toArr(el.querySelectorAll('tr')) as Array<{ querySelectorAll: (s: string) => ArrayLike<unknown> }>
    if (!rows.length) return ''
    const grid: string[][] = []
    for (const tr of rows) {
      const cells = toArr(tr.querySelectorAll('th,td')) as Array<{ textContent?: string | null }>
      grid.push(cells.map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')))
    }
    const width = Math.max(...grid.map((r) => r.length))
    for (const r of grid) while (r.length < width) r.push('')
    const head = grid[0]
    const body = grid.slice(1)
    const lines = [
      '| ' + head.join(' | ') + ' |',
      '| ' + head.map(() => '---').join(' | ') + ' |',
      ...body.map((r) => '| ' + r.join(' | ') + ' |')
    ]
    return '\n\n' + lines.join('\n') + '\n\n'
  }
})

export interface DocxOptions {
  /** 把内嵌图片存起来，返回可引用的相对路径（例如 _attachments/xxx.png） */
  saveImage?: (bytes: Buffer, contentType: string) => string
}

export async function extractDocx(buf: Buffer, opts: DocxOptions = {}): Promise<ExtractResult> {
  const mammoth = (await import('mammoth')) as unknown as {
    convertToHtml: (
      input: { buffer: Buffer },
      options?: { convertImage?: unknown }
    ) => Promise<{ value: string; messages: { type: string; message: string }[] }>
  }

  const images: string[] = []
  const result = await mammoth.convertToHtml(
    { buffer: buf },
    opts.saveImage
      ? {
          convertImage: {
            // mammoth 的 image converter：把图片交给我们的回调
            imgElement: (image: { read: (enc: string) => Promise<Buffer>; contentType: string }) => async () => {
              const bytes = await image.read('base64')
              const rel = opts.saveImage!(Buffer.from(bytes.toString(), 'base64'), image.contentType)
              images.push(rel)
              return [{ type: 'image', contentType: image.contentType, src: rel }]
            }
          }
        }
      : undefined
  )

  const md = turndown.turndown(result.value).trim()
  const check = selfCheck({ kind: 'docx', text: md, pages: 0, bytes: buf.length })
  return {
    text: clipText(md),
    pages: [],
    mode: 'text',
    note: '按文字解析（标题/列表/表格已保留' + (images.length ? '，' + images.length + ' 张图片已存为附件' : '') + '）',
    issues: check.issues,
    stats: { chars: md.length, tables: countTables(md), pages: 0 }
  }
}
