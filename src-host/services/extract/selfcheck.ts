/**
 * 转换结果自检。
 *
 * 目的：**不让"解析失败但看起来成功"蒙混过关**。
 * 典型场景：扫描件 PDF 能解析出对象结构，但一个字都提不出来 ——
 * 这时必须自动回退到"渲染成图片给多模态模型看"，而不是给模型一段空白。
 */
import type { ExtractResult } from './types'
import { countTables } from './types'

export interface CheckInput {
  kind: 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'html' | 'text'
  text: string
  pages: number
  /** 文件字节数，用于判断"是不是扫描件" */
  bytes: number
}

export interface CheckOutput {
  issues: string[]
  /** 是否应该回退到图片通道 */
  needImages: boolean
}

export function selfCheck(input: CheckInput): CheckOutput {
  const issues: string[] = []
  const chars = input.text.trim().length
  let needImages = false

  // 1) 一个字都没提出来，但文件不小 → 基本是扫描件/纯图
  if (chars < 20 && input.bytes > 20 * 1024) {
    issues.push('没有提取到文字（很可能是扫描件或纯图片）')
    needImages = true
  }

  // 2) PDF：平均每页字数太少 → 可能是扫描件或排版是图片
  if (input.kind === 'pdf' && input.pages > 0) {
    const perPage = chars / input.pages
    if (chars > 0 && perPage < 40) {
      issues.push('平均每页只有 ' + Math.round(perPage) + ' 字，可能是扫描件')
      needImages = true
    }
  }

  // 3) 出现大量控制字符/乱码 → 编码或压缩流没解对
  const weird = (input.text.match(/[\u0000-\u0008\u000e-\u001f\ufffd]/g) ?? []).length
  if (weird > 30) {
    issues.push('文字里有大量乱码字符（' + weird + ' 个），可能解析有误')
    if (chars < 200) needImages = true
  }

  // 4) docx/pptx/xlsx 解析出的字数离谱地少
  if ((input.kind === 'docx' || input.kind === 'pptx' || input.kind === 'xlsx') && chars < 10 && input.bytes > 5 * 1024) {
    issues.push('解析结果几乎是空的')
    needImages = true
  }

  return { issues, needImages }
}

export function summarize(input: CheckInput, text: string, pages: number, mode: ExtractResult['mode']): ExtractResult['stats'] {
  return { chars: text.trim().length, tables: countTables(text), pages }
}
