/**
 * PPT → Markdown（自己解析 OOXML，约 80 行，零依赖）。
 *
 * 保真要点：
 *   · **按页输出**（## 第 N 页），页序不能乱
 *   · 每页里文本框**按 y 再按 x 排序**还原阅读顺序（PPT 的 XML 顺序不等于视觉顺序）
 *   · 标题（占位符 title）单独标出来
 *   · 备注也读出来
 * 丢弃的是位置/动画/主题色 —— 那些对"给 AI 读"没有意义。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtractResult } from './types'
import { clipText, countTables } from './types'
import { selfCheck } from './selfcheck'

/** 从 <a:t> 里抠出文字 */
function texts(xml: string): string {
  return [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
    .map((m) => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'))
    .join('')
    .trim()
}

/** 把每个 <p:sp>（形状/文本框）拆出来，带它的位置，用于排序 */
interface Shape { x: number; y: number; isTitle: boolean; body: string }

function shapesOf(slideXml: string): Shape[] {
  const out: Shape[] = []
  for (const sp of slideXml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
    const body = sp[1]
    const text = texts(body)
    if (!text) continue
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"/.exec(body)
    const ph = /<p:ph[^>]*type="([^"]+)"/.exec(body)
    out.push({
      x: off ? Number(off[1]) : 0,
      y: off ? Number(off[2]) : 0,
      isTitle: !!ph && /title|ctrTitle/.test(ph[1]),
      body: text
    })
  }
  return out
}

export function extractPptx(filePath: string, readZip: (p: string) => Buffer | null): ExtractResult {
  const slides: string[] = []
  // slide1.xml ... slideN.xml，按数字顺序（不能按字符串，否则 10 会排在 2 前面）
  const names: number[] = []
  for (let i = 1; i <= 300; i++) {
    const p = 'ppt/slides/slide' + i + '.xml'
    if (readZip(p)) names.push(i)
  }
  if (!names.length) {
    // 有的文件把 slide 放在别处，退一步：扫一遍目录列表拿不到就只能报空
  }

  for (const n of names) {
    const xml = readZip('ppt/slides/slide' + n + '.xml')
    if (!xml) continue
    const shapes = shapesOf(xml.toString('utf8'))
    // 阅读顺序：先按 y（上下），同一行再按 x（左右）
    shapes.sort((a, b) => (Math.abs(a.y - b.y) > 200000 ? a.y - b.y : a.x - b.x))
    const title = shapes.find((s) => s.isTitle)
    const rest = shapes.filter((s) => s !== title)
    const lines: string[] = ['## 第 ' + n + ' 页']
    if (title) lines.push('### ' + title.body)
    for (const s of rest) lines.push(s.body.split(/\n+/).filter(Boolean).map((l) => '- ' + l).join('\n'))
    // 备注
    const notes = readZip('ppt/notesSlides/notesSlide' + n + '.xml')
    if (notes) {
      const t = texts(notes.toString('utf8'))
      if (t && !/^\d+$/.test(t)) lines.push('> 备注：' + t.replace(/\n/g, ' '))
    }
    slides.push(lines.join('\n'))
  }

  const md = slides.join('\n\n')
  const check = selfCheck({ kind: 'pptx', text: md, pages: names.length, bytes: 0 })
  return {
    text: clipText(md),
    pages: [],
    mode: 'text',
    note: '按文字解析（共 ' + names.length + ' 页，页内按视觉顺序排列）',
    issues: check.issues,
    stats: { chars: md.length, tables: countTables(md), pages: names.length, slides: names.length }
  }
}

void readFileSync
void existsSync
void join
