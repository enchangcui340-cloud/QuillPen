/**
 * 格式开关（toggle）的纯逻辑。
 *
 * 规则（与用户预期一致）：
 * - 选中的内容「全都是」该格式 → 再点一次取消格式；
 * - 选中内容里只要有没加格式的 → 整个选区都加上格式（不会出现 ****粗体**** 这种嵌套）。
 *
 * 做成纯函数是为了能直接跑测试：界面点不了，但逻辑可以验。
 */

export interface Change { from: number; to: number; insert: string }

export interface InlinePlan {
  from: number
  to: number
  insert: string
  selFrom: number
  selTo: number
}

interface Region { start: number; innerStart: number; innerEnd: number; end: number }

/**
 * 找出文档里成对的标记区间。
 * 单星号（斜体）要避开 ** 里的星号，否则 **粗体** 会被当成斜体标记。
 */
export function findRegions(doc: string, before: string, after: string): Region[] {
  const singleStar = before === '*' && after === '*'
  const out: Region[] = []
  let i = 0
  while (i <= doc.length) {
    const s = doc.indexOf(before, i)
    if (s < 0) break
    if (singleStar && (doc[s - 1] === '*' || doc[s + 1] === '*')) { i = s + 1; continue }
    const e = doc.indexOf(after, s + before.length)
    if (e < 0) break
    if (singleStar && (doc[e - 1] === '*' || doc[e + 1] === '*')) { i = s + before.length; continue }
    out.push({ start: s, innerStart: s + before.length, innerEnd: e, end: e + after.length })
    i = e + after.length
  }
  return out
}

const ESCAPE_RE = /[.*+?^$()|[\]\\]/g

function escapeRe(s: string): string {
  return s.replace(ESCAPE_RE, '\\$&')
}

/** 行首标记（标题 / 列表）统一在这里剥离，保证不会叠加 */
const HEADING = /^(\s*)#{1,6}\s+/
const LIST = /^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/

function stripBlockPrefix(line: string): { indent: string; text: string } {
  const h = HEADING.exec(line)
  if (h) return { indent: h[1], text: line.slice(h[0].length) }
  const l = LIST.exec(line)
  if (l) return { indent: l[1], text: line.slice(l[0].length) }
  const plain = /^(\s*)/.exec(line) as RegExpExecArray
  return { indent: plain[1], text: line.slice(plain[1].length) }
}

export type MarkerPair = [string, string]

/**
 * 行内格式开关。
 * siblings 用于"同族"的其它标记：例如三种高亮颜色互为同族，
 * 点另一种颜色时应该替换掉旧颜色，而不是把两种颜色套在一起。
 */
export function planInlineToggle(
  doc: string, selFrom: number, selTo: number,
  before: string, after: string = before,
  siblings: MarkerPair[] = []
): InlinePlan {
  // 没有选中内容：插入一对标记，光标停在中间
  if (selFrom === selTo) {
    return { from: selFrom, to: selTo, insert: before + after, selFrom: selFrom + before.length, selTo: selFrom + before.length }
  }

  // 目标格式自己的区间（决定"是否已经全部是这个格式"）
  const own = findRegions(doc, before, after).filter((r) => r.start < selTo && r.end > selFrom)
  // 连同同族的其它标记一起（决定"加格式时要清掉哪些旧标记"）
  const all: Region[] = [...own]
  for (const [b, a] of siblings) {
    for (const r of findRegions(doc, b, a)) if (r.start < selTo && r.end > selFrom) all.push(r)
  }

  const ownMarker = new Uint8Array(doc.length)
  const ownInner = new Uint8Array(doc.length)
  for (const r of own) {
    for (let p = r.start; p < r.innerStart; p++) ownMarker[p] = 1
    for (let p = r.innerStart; p < r.innerEnd; p++) ownInner[p] = 1
    for (let p = r.innerEnd; p < r.end; p++) ownMarker[p] = 1
  }

  // 选区内是否每个字符都已经带着"这个格式"
  let allFormatted = own.length > 0
  for (let p = selFrom; p < selTo; p++) {
    if (!ownMarker[p] && !ownInner[p]) { allFormatted = false; break }
  }

  // 取消时只动自己的标记；加格式时把同族的旧标记一并清掉
  const scope = allFormatted ? own : all
  const kill = new Uint8Array(doc.length)
  for (const r of scope) {
    for (let p = r.start; p < r.innerStart; p++) kill[p] = 1
    for (let p = r.innerEnd; p < r.end; p++) kill[p] = 1
  }
  const spanFrom = Math.min(selFrom, ...scope.map((r) => r.start))
  const spanTo = Math.max(selTo, ...scope.map((r) => r.end))

  if (allFormatted) {
    // 取消格式：只删标记，文字原样
    let out = ''
    const map = new Array<number>(spanTo - spanFrom + 1)
    let pos = 0
    for (let p = spanFrom; p < spanTo; p++) {
      map[p - spanFrom] = pos
      if (kill[p]) continue
      out += doc[p]
      pos++
    }
    map[spanTo - spanFrom] = pos
    return { from: spanFrom, to: spanTo, insert: out, selFrom: map[selFrom - spanFrom], selTo: map[selTo - spanFrom] }
  }

  // 加上格式：先清掉选区里（以及被选区切到的）已有标记，再整体包一层
  let clean = ''
  for (let p = spanFrom; p < spanTo; p++) if (!kill[p]) clean += doc[p]
  return {
    from: spanFrom, to: spanTo, insert: before + clean + after,
    selFrom: spanFrom + before.length,
    selTo: spanFrom + before.length + clean.length
  }
}

/** 行首格式（标题 / 列表）：整体切换，且不会与已有标记叠加 */
export function planLineToggle(doc: string, selFrom: number, selTo: number, prefix: string): Change[] {
  const starts = [0]
  for (let i = 0; i < doc.length; i++) if (doc[i] === '\n') starts.push(i + 1)
  const lineOf = (pos: number): number => {
    let lo = 0
    for (let i = 0; i < starts.length; i++) if (starts[i] <= pos) lo = i
    return lo
  }
  const endPos = selTo > selFrom ? selTo - 1 : selTo
  const first = lineOf(selFrom)
  const last = lineOf(endPos)

  const targets: { start: number; text: string }[] = []
  for (let n = first; n <= last; n++) {
    const start = starts[n]
    const end = n + 1 < starts.length ? starts[n + 1] - 1 : doc.length
    targets.push({ start, text: doc.slice(start, end) })
  }

  const prefixRe = new RegExp('^\\s*' + escapeRe(prefix))
  const all = targets.length > 0 && targets.every((t) => prefixRe.test(t.text))

  const changes: Change[] = []
  for (const t of targets) {
    const { indent, text } = stripBlockPrefix(t.text)
    if (all) {
      // 全部已有该格式 → 取消这一层，内容保持
      changes.push({ from: t.start, to: t.start + t.text.length, insert: indent + text })
    } else {
      changes.push({ from: t.start, to: t.start + t.text.length, insert: indent + prefix + text })
    }
  }
  return changes
}

/** 选区是否整段都已经带着这个行内格式（菜单用来显示 ✓） */
export function isFormatted(doc: string, selFrom: number, selTo: number, before: string, after: string = before): boolean {
  if (selFrom >= selTo) return false
  const regions = findRegions(doc, before, after).filter((r) => r.start < selTo && r.end > selFrom)
  if (!regions.length) return false
  const inside = new Uint8Array(doc.length)
  for (const r of regions) {
    for (let p = r.start; p < r.end; p++) inside[p] = 1
  }
  for (let p = selFrom; p < selTo; p++) if (!inside[p]) return false
  return true
}

/** 选中的每一行是否都已经带了这个行首格式（菜单用来显示 ✓） */
export function linesHavePrefix(doc: string, selFrom: number, selTo: number, prefix: string): boolean {
  const starts = [0]
  for (let i = 0; i < doc.length; i++) if (doc[i] === '\n') starts.push(i + 1)
  const lineOf = (pos: number): number => {
    let lo = 0
    for (let i = 0; i < starts.length; i++) if (starts[i] <= pos) lo = i
    return lo
  }
  const endPos = selTo > selFrom ? selTo - 1 : selTo
  const re = new RegExp('^\\s*' + escapeRe(prefix))
  for (let n = lineOf(selFrom); n <= lineOf(endPos); n++) {
    const start = starts[n]
    const end = n + 1 < starts.length ? starts[n + 1] - 1 : doc.length
    if (!re.test(doc.slice(start, end))) return false
  }
  return true
}
