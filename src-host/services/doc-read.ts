/**
 * 文档保真读取（DSH 版新增）。
 *
 * 为什么要它：「羽毛笔」要用很多文件 —— 尤其是**纯图片/扫描件 PDF**，那种文件没有文本层，
 * 只能把页面**渲染成真实像素图**再让模型用读图能力看，否则什么都读不出来。
 *
 * 分工：
 *   · PDF  → 逐页渲染成 PNG（pdfjs-dist + @napi-rs/canvas），存进库内 `_attachments/`，
 *            同时尽力抽取文本层（有文本层时顺手给模型）；
 *   · Office/HTML/CSV/文本 → 交给 `services/extract`（原 Quill 的实现，纯 Node：zip + XML + turndown）；
 *   · 图片 → 直接可用（必要时拷进库内）。
 *
 * 依赖都是**插件自己的 dependencies**（见 packages/dsh-quill/package.json），
 * 而且都是**懒加载**：不读文档就不会加载 pdfjs/原生 canvas，不拖慢宿主启动。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { createRequire } from 'node:module'

/** 本模块自己的 require：@napi-rs/canvas 是 CJS + 原生二进制，只能这样加载 */
const nativeRequire = createRequire(import.meta.url)

/** 渲染出来的单页 */
export interface DocPage {
  /** 第几页（从 1 开始） */
  page: number
  /** 库内相对路径（`_attachments/...png`） */
  rel: string
  /** PNG 字节数 */
  bytes: number
  /** 这一页的文本层字数（扫描件为 0） */
  chars: number
}

export interface DocReadResult {
  kind: 'pdf' | 'text' | 'image'
  /** 原始文件路径 */
  path: string
  /** 文件名 */
  name: string
  /** 文件字节数 */
  size: number
  /** PDF：总页数 */
  totalPages?: number
  /** PDF：本次真正渲染出来的页 */
  pages?: DocPage[]
  /** 文本类：抽取到的文本（已截断） */
  text?: string
  /** 抽取器给的说明（例如"扫描件已渲染成图片"） */
  note?: string
  /** 图片类：可用的库内相对路径（在库外时会先拷进来） */
  rel?: string
  /** 警告（例如页数超上限被截断） */
  warning?: string
}

/** 文本类扩展名（交给 extract 服务） */
const TEXT_EXT = new Set(['.docx', '.pptx', '.xlsx', '.xls', '.html', '.htm', '.csv', '.txt', '.md', '.json', '.log'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tif', '.tiff'])

export const isPdfPath = (p: string): boolean => extname(p).toLowerCase() === '.pdf'
export const isImagePath = (p: string): boolean => IMAGE_EXT.has(extname(p).toLowerCase())
export const isTextDocPath = (p: string): boolean => TEXT_EXT.has(extname(p).toLowerCase())

/** 渲染 PDF 页面用的懒加载依赖（只在真的要渲染时才加载） */
async function loadPdfRuntime(): Promise<{ pdfjs: any; createCanvas: (w: number, h: number) => any }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // @napi-rs/canvas 是 CJS + 原生模块：必须用 require 拿。
  // 注意：不能用"函数内的裸 require"（ESM 产物会运行时报错，构建护栏也会拦），
  // 这里用本模块自己的 createRequire —— 它按 host.js 的位置解析，能找到插件自己的 node_modules。
  const { createCanvas } = nativeRequire('@napi-rs/canvas') as { createCanvas: (w: number, h: number) => any }
  return { pdfjs, createCanvas }
}

/**
 * 逐页渲染 PDF。
 * @param absPath PDF 绝对路径
 * @param options scale（默认 2 ≈ 200%）、pages（只渲染这几页）、maxPages（上限，默认 100）
 */
export async function renderPdfPages(
  absPath: string,
  options: { scale?: number; pages?: number[]; maxPages?: number } = {}
): Promise<{ totalPages: number; rendered: Array<{ page: number; png: Buffer; text: string }>; warning?: string }> {
  const scale = Math.min(3, Math.max(1, Number(options.scale ?? 2)))
  const maxPages = Math.min(500, Math.max(1, Number(options.maxPages ?? 100)))
  const { pdfjs, createCanvas } = await loadPdfRuntime()

  const data = new Uint8Array(readFileSync(absPath))
  const doc = await pdfjs.getDocument({ data, useSystemFonts: false, isEvalSupported: false }).promise
  const totalPages: number = doc.numPages

  let wanted = Array.isArray(options.pages) && options.pages.length > 0
    ? options.pages.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1 && n <= totalPages)
    : Array.from({ length: totalPages }, (_, i) => i + 1)

  let warning: string | undefined
  if (wanted.length > maxPages) {
    warning = `这份 PDF 共 ${totalPages} 页，本次只渲染了前 ${maxPages} 页（可用 pages 参数指定要哪几页）`
    wanted = wanted.slice(0, maxPages)
  }

  const rendered: Array<{ page: number; png: Buffer; text: string }> = []
  for (const pageNumber of wanted) {
    const page = await doc.getPage(pageNumber)
    const viewport = page.getViewport({ scale })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport, canvas }).promise
    const png: Buffer = canvas.toBuffer('image/png')

    // 文本层：有就顺手给模型（扫描件这里会是空串）
    let text = ''
    try {
      const content = await page.getTextContent()
      text = content.items.map((item: { str?: string }) => item.str ?? '').join(' ')
    } catch { /* 取不到文本层不影响看图 */ }

    rendered.push({ page: pageNumber, png, text })
  }
  try { await doc.destroy?.() } catch { /* 忽略 */ }
  return { totalPages, rendered, warning }
}

/** 渲染页图的稳定文件名：同一份 PDF（内容+页+缩放）永远映射到同一个附件名，重复读不会堆垃圾 */
export function pageAttachmentName(absPath: string, pageNumber: number, scale: number): string {
  const hash = createHash('sha1')
  hash.update(readFileSync(absPath))
  hash.update(`|p${pageNumber}|s${scale}`)
  return `pdf-${hash.digest('hex').slice(0, 12)}-p${pageNumber}.png`
}

/** 文件基本信息 */
export function statOf(absPath: string): { size: number } {
  const st = statSync(absPath)
  if (!st.isFile()) throw new Error('这不是一个文件：' + absPath)
  return { size: st.size }
}
export const fileExists = (p: string): boolean => existsSync(p)
