/**
 * PDF 提取（pdfjs）。
 *
 * 现在主进程那个 extractPdf 是用正则硬抠原始 stream 的（只能处理最简单的未压缩 PDF ✗），
 * 这里换成 pdfjs 的 getTextContent()：
 *   · **带坐标**，可以按 y 分组还原"行"和"段"，而不是一堆乱序词块
 *   · 文字层读完顺手判断：是不是扫描件（字数太少）
 *   · 是扫描件就渲染页面图片，走多模态（对模型来说比 OCR 更准）
 */
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { ExtractResult } from './types'
import { clipText, countTables, MAX_TEXT } from './types'
import { selfCheck } from './selfcheck'

/** 一行文字的 y 容差（PDF 单位），用来把同一行的碎片拼起来 */
const LINE_TOLERANCE = 2.5

export interface PdfOptions {
  /** 渲染第 n 页（1 起）为 JPEG dataURL；不提供就不渲染 */
  renderPage?: (pageNumber: number, maxEdge: number) => Promise<string>
  /** 最多读多少页（防止超大 PDF 卡住） */
  maxPages?: number
  /** 最多渲染几页图片 */
  maxImagePages?: number
}

export async function extractPdf(buf: Buffer, opts: PdfOptions = {}): Promise<ExtractResult> {
  const pdfjs = pdfjsModule
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    // 主进程里不需要 worker；也别用系统的字体/标准字体下载
    useWorkerFetch: false,
    useSystemFonts: false
  } as never).promise

  const maxPages = Math.min(opts.maxPages ?? 40, doc.numPages)
  const pageTexts: string[] = []

  for (let p = 1; p <= maxPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    // 把碎片按 y 分行
    interface Frag { x: number; y: number; s: string }
    const frags: Frag[] = []
    for (const item of content.items as Array<{ str?: string; transform?: number[] }>) {
      const s = item.str
      if (!s || !item.transform) continue
      frags.push({ x: item.transform[4], y: item.transform[5], s })
    }
    frags.sort((a, b) => (Math.abs(a.y - b.y) > LINE_TOLERANCE ? b.y - a.y : a.x - b.x))
    const lines: string[] = []
    let current: Frag[] = []
    const flush = (): void => {
      if (!current.length) return
      let line = ''
      for (let i = 0; i < current.length; i++) {
        if (i > 0 && current[i].x - (current[i - 1].x + current[i - 1].s.length * 5) > 18) line += ' '
        line += current[i].s
      }
      const t = line.trim()
      if (t) lines.push(t)
      current = []
    }
    for (const f of frags) {
      if (current.length && Math.abs(f.y - current[0].y) > LINE_TOLERANCE) flush()
      current.push(f)
    }
    flush()
    const pageText = lines.join('\n')
    pageTexts.push('## 第 ' + p + ' 页\n\n' + pageText)
  }

  const md = pageTexts.join('\n\n')
  const check = selfCheck({ kind: 'pdf', text: md, pages: maxPages, bytes: buf.length })

  // 需要图片时（扫描件 / 每页字太少），渲染页面
  let pages: string[] = []
  if (check.needImages && opts.renderPage) {
    const n = Math.min(maxPages, opts.maxImagePages ?? 8)
    for (let p = 1; p <= n; p++) {
      try { pages.push(await opts.renderPage(p, 1400)) } catch { /* 单页失败不影响其它页 */ }
    }
  }

  const mode: ExtractResult['mode'] = pages.length && md.trim() ? 'both' : pages.length ? 'image' : 'text'
  const note = pages.length
    ? (md.trim()
        ? '文字 + 图片双通道（共 ' + maxPages + ' 页，图片 ' + pages.length + ' 页）'
        : '扫描件：已转为图片给模型直接查看（' + pages.length + ' 页）')
    : '按文字解析（共 ' + maxPages + ' 页' + (doc.numPages > maxPages ? '，只读了前 ' + maxPages + ' 页' : '') + '）'

  return {
    text: clipText(md, MAX_TEXT),
    pages,
    mode,
    note,
    issues: check.issues,
    stats: { chars: md.trim().length, tables: countTables(md), pages: maxPages }
  }
}

