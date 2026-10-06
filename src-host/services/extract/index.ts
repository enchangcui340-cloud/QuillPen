/**
 * 文件提取统一入口。
 *
 * 支持：docx / pptx / xlsx / xls(尽力) / pdf / html / htm / csv / txt / md / json / log / 图片
 *
 * 双通道设计：
 *   文字通道——能解析出结构就解析（省 token、可精确引用）
 *   图片通道——扫描件、版式重要、自检失败时，渲染成图片走多模态
 * 返回的 note 会显示在界面上，让用户知道"AI 到底看到了什么"。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
// DSH 版：原来在函数里 `require('node:zlib')`，ESM 产物会运行时报错，改成顶层 import
import { inflateRawSync } from 'node:zlib'
import type { ExtractResult } from './types'
import { clipText, countTables } from './types'
import { extractDocx } from './docx'
import { extractPptx } from './pptx'
import { extractXlsx } from './xlsx'
import { extractHtml } from './html'
import { extractPdf } from './pdf'
import { selfCheck } from './selfcheck'

export type { ExtractResult } from './types'

/**
 * 极简 ZIP 读取器（只读目录 + 解压单个条目，支持 stored 与 deflate）。
 * pptx/xlsx/docx 都是 zip，自己读可以省掉一个依赖。
 */
export function makeZipReader(buf: Buffer): { read: (p: string) => Buffer | null; list: () => string[] } {
  const files = new Map<string, { offset: number; compSize: number; size: number; method: number }>()
  // 从尾部找 End of Central Directory
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd >= 0) {
    const count = buf.readUInt16LE(eocd + 10)
    let p = buf.readUInt32LE(eocd + 16)
    for (let i = 0; i < count && p + 46 <= buf.length; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break
      const method = buf.readUInt16LE(p + 10)
      const compSize = buf.readUInt32LE(p + 20)
      const size = buf.readUInt32LE(p + 24)
      const nameLen = buf.readUInt16LE(p + 28)
      const extraLen = buf.readUInt16LE(p + 30)
      const commentLen = buf.readUInt16LE(p + 32)
      const localOffset = buf.readUInt32LE(p + 42)
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
      files.set(name, { offset: localOffset, compSize, size, method })
      p += 46 + nameLen + extraLen + commentLen
    }
  }
  return {
    list: () => [...files.keys()],
    read: (name: string): Buffer | null => {
      const f = files.get(name)
      if (!f) return null
      // 本地文件头长度不固定，按它的 name/extra 长度算数据起点
      const nameLen = buf.readUInt16LE(f.offset + 26)
      const extraLen = buf.readUInt16LE(f.offset + 28)
      const start = f.offset + 30 + nameLen + extraLen
      const raw = buf.subarray(start, start + f.compSize)
      if (f.method === 0) return Buffer.from(raw)
      try { return inflateRawSync(raw) } catch { return null }
    }
  }
}

export interface ExtractOptions {
  /** 把内嵌图片存到附件目录，返回相对路径 */
  saveAttachment?: (bytes: Buffer, ext: string) => string
  /** PDF 渲染某页为图片 */
  renderPdfPage?: (buf: Buffer, pageNumber: number, maxEdge: number) => Promise<string>
  maxPdfPages?: number
}

const TEXT_EXT = ['.txt', '.md', '.markdown', '.csv', '.tsv', '.log', '.json', '.yaml', '.yml', '.xml', '.ini', '.toml', '.srt', '.vtt']

/** 主入口 */
export async function extractFile(filePath: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const name = basename(filePath)
  const ext = extname(filePath).toLowerCase()
  const buf = readFileSync(filePath)

  if (TEXT_EXT.includes(ext)) {
    const text = buf.toString('utf8')
    // CSV 转成 Markdown 表格（模型读起来更清楚）
    if (ext === '.csv' || ext === '.tsv') {
      const sep = ext === '.tsv' ? '\t' : ','
      const rows = text.split(/\r?\n/).filter(Boolean).slice(0, 500).map((l) => l.split(sep).map((c) => c.trim().replace(/\|/g, '\\|')))
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length))
        for (const r of rows) while (r.length < width) r.push('')
        const md = ['| ' + rows[0].join(' | ') + ' |', '| ' + rows[0].map(() => '---').join(' | ') + ' |', ...rows.slice(1).map((r) => '| ' + r.join(' | ') + ' |')].join('\n')
        return { text: clipText(md), pages: [], mode: 'text', note: '按文字解析（表格已转为 Markdown）', issues: [], stats: { chars: md.length, tables: 1, pages: 0 } }
      }
    }
    return { text: clipText(text), pages: [], mode: 'text', note: '按文字解析', issues: [], stats: { chars: text.length, tables: countTables(text), pages: 0 } }
  }

  if (ext === '.docx') {
    return extractDocx(buf, opts.saveAttachment ? { saveImage: (bytes, ct) => opts.saveAttachment!(bytes, ct.includes('png') ? '.png' : '.jpg') } : {})
  }
  if (ext === '.pptx') {
    const zip = makeZipReader(buf)
    return extractPptx(filePath, zip.read)
  }
  if (ext === '.xlsx' || ext === '.xlsm') {
    const zip = makeZipReader(buf)
    return extractXlsx(zip.read, zip.list)
  }
  if (ext === '.html' || ext === '.htm') return extractHtml(buf.toString('utf8'))

  if (ext === '.pdf') {
    const result = await extractPdf(buf, {
      maxPages: opts.maxPdfPages ?? 40,
      renderPage: opts.renderPdfPage ? (n, edge) => opts.renderPdfPage!(buf, n, edge) : undefined
    })
    return result
  }

  if (/\.(png|jpe?g|gif|webp|bmp)$/.test(ext)) {
    const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return { text: '', pages: ['data:' + mime + ';base64,' + buf.toString('base64')], mode: 'image', note: '图片：直接给模型查看', issues: [], stats: { chars: 0, tables: 0, pages: 1 } }
  }

  if (ext === '.doc' || ext === '.xls' || ext === '.ppt') {
    return {
      text: '（这是 Office 97-2003 老格式，无法直接解析。请用 Office 另存为 .docx / .xlsx / .pptx 后再发，或直接复制内容粘贴）',
      pages: [], mode: 'text', note: '老格式不支持', issues: ['老式 Office 格式'], stats: { chars: 0, tables: 0, pages: 0 }
    }
  }

  // 其它格式：尽力当文本读
  const guess = buf.toString('utf8')
  const printable = (guess.match(/[\u4e00-\u9fa5a-zA-Z0-9\s，。、；：（）]/g) ?? []).length
  if (guess.length && printable / guess.length > 0.8) {
    return { text: clipText(guess), pages: [], mode: 'text', note: '按纯文本尽力解析', issues: [], stats: { chars: guess.length, tables: 0, pages: 0 } }
  }
  void name
  void selfCheck
  return { text: '（无法解析这个格式，请把内容粘贴到消息里）', pages: [], mode: 'text', note: '不支持的格式', issues: ['无法解析'], stats: { chars: 0, tables: 0, pages: 0 } }
}

void existsSync
void mkdirSync
void writeFileSync
void join
