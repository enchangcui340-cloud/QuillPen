/**
 * 白板「绘制图形」的纯函数层。
 *
 * 这里**不碰 React、不碰 DOM**，只有坐标与路径计算 —— 于是可以单测（见 tools/check-shapes.mjs）。
 * 界面（Whiteboard.tsx）只负责把这里算出来的结果画到 SVG 上。
 *
 * ## 设计要点
 *
 * 1. **曲线经过所有控制点**：用 Catmull-Rom 样条转三次贝塞尔。
 *    （若用普通贝塞尔，曲线只会"靠近"控制点，拖动手感会变得很怪。）
 * 2. **2 个点自然退化成直线**：所以"曲线"工具在只点两下时看起来就是直线 —— 与 Adobe 一致。
 * 3. 颜色只存**色板键**，深浅主题换色完全交给 CSS，这里不掺和。
 */
import type { ShapeKind, ShapePt, WhiteboardShape } from '@shared/types'

/* ============================ 常量 ============================ */

/** 线类图形的最小长度（小于视为误操作） */
export const SHAPE_MIN_LEN = 6
/** 几何图形的最小边长（小于则用默认尺寸） */
export const SHAPE_MIN_SIZE = 8
/** 点一下（没拖动）时几何图形的默认尺寸 */
export const SHAPE_DEFAULT_W = 120
export const SHAPE_DEFAULT_H = 80
/** 自由绘制的采样间隔（世界单位）：距上一个已记录点超过它才记 */
export const FREE_SAMPLE_DIST = 2.5
/** 自由绘制的点数上限（防异常大的路径） */
export const FREE_MAX_POINTS = 2000

/** 8 种图形 */
export const SHAPE_KINDS: ShapeKind[] = [
  'rect', 'ellipse', 'triangle', 'diamond',
  'line', 'arrow', 'curve', 'free'
]

/** 是否是"线类"（用 points 描述，而不是 x/y/w/h） */
export function isLineKind(kind: ShapeKind): boolean {
  return kind === 'line' || kind === 'arrow' || kind === 'curve' || kind === 'free'
}

/** 中文/英文别名 → kind（给 AI 与人类输入用） */
const KIND_ALIASES: Record<string, ShapeKind> = {
  矩形: 'rect', 长方形: 'rect', 方框: 'rect', 方块: 'rect', 方形: 'rect', rect: 'rect', rectangle: 'rect',
  椭圆: 'ellipse', 圆: 'ellipse', 圆形: 'ellipse', 圆圈: 'ellipse', ellipse: 'ellipse', circle: 'ellipse', oval: 'ellipse',
  三角: 'triangle', 三角形: 'triangle', triangle: 'triangle',
  菱形: 'diamond', 钻石: 'diamond', 棱形: 'diamond', diamond: 'diamond', rhombus: 'diamond',
  直线: 'line', 线: 'line', 线段: 'line', 横线: 'line', 竖线: 'line', line: 'line',
  箭头: 'arrow', 指向: 'arrow', 箭: 'arrow', arrow: 'arrow',
  曲线: 'curve', 弧线: 'curve', 光滑线: 'curve', 弯线: 'curve', curve: 'curve', bezier: 'curve',
  自由: 'free', 涂鸦: 'free', 手绘: 'free', 随手画: 'free', free: 'free', freehand: 'free', pencil: 'free'
}

/** 把任意输入规整成 kind；不认识返回 null（调用方据此报错） */
export function resolveShapeKind(input: unknown): ShapeKind | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (raw === '') return null
  if ((SHAPE_KINDS as string[]).includes(raw)) return raw as ShapeKind
  const lower = raw.toLowerCase()
  if ((SHAPE_KINDS as string[]).includes(lower)) return lower as ShapeKind
  return KIND_ALIASES[raw] ?? KIND_ALIASES[lower] ?? null
}

/* ============================ 几何 ============================ */

/** 两点距离 */
export function dist(a: ShapePt, b: ShapePt): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** 点到线段的距离（用于命中判断） */
export function distToSegment(p: ShapePt, a: ShapePt, b: ShapePt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return dist(p, a)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** 点在线段上的投影参数 t（0=起点，1=终点） */
export function projectT(p: ShapePt, a: ShapePt, b: ShapePt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return 0
  return Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
}

/* ============================ 路径 ============================ */

/**
 * 点串 → SVG 折线路径（`M x y L x y …`）。
 * 用于直线、箭头（自由绘制也先走它，再由调用方决定要不要平滑）。
 */
export function polylinePath(points: ShapePt[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  return 'M ' + points.map((p) => `${p.x} ${p.y}`).join(' L ')
}

/**
 * 点串 → **平滑经过所有点**的 SVG 路径（Catmull-Rom 样条转三次贝塞尔）。
 *
 * 为什么自己算而不用现成库：
 *   · 只需这一件事，引库不划算；
 *   · 点数多时要控制输出长度（自由绘制可能上千点）。
 *
 * 端点处理：首尾各虚拟一个"镜像点"，让曲线从第一个点平滑出发、到最后一个点平滑收尾，
 * 否则端点附近会出现明显的不自然折角。
 */
export function smoothPath(points: ShapePt[], tension = 1): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  if (points.length === 2) return polylinePath(points)

  const p = points
  let d = `M ${p[0].x} ${p[0].y}`
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i]
    const p1 = p[i]
    const p2 = p[i + 1]
    const p3 = p[i + 2] ?? p2
    // Catmull-Rom → 三次贝塞尔控制点
    const c1x = p1.x + ((p2.x - p0.x) / 6) * tension
    const c1y = p1.y + ((p2.y - p0.y) / 6) * tension
    const c2x = p2.x - ((p3.x - p1.x) / 6) * tension
    const c2y = p2.y - ((p3.y - p1.y) / 6) * tension
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`
  }
  return d
}

/** 按 kind 选路径：线类用平滑（curve/free）或折线（line/arrow） */
export function shapePathOf(shape: WhiteboardShape): string {
  const pts = shape.points ?? []
  if (shape.kind === 'curve' || shape.kind === 'free') return smoothPath(pts)
  return polylinePath(pts)
}

/* ============================ 包围盒 ============================ */

export interface ShapeBox { x: number; y: number; w: number; h: number }

/** 图形的包围盒（几何图形用 x/y/w/h；线类用点的极值） */
export function shapeBox(s: WhiteboardShape): ShapeBox {
  if (isLineKind(s.kind)) {
    const pts = s.points ?? []
    if (pts.length === 0) return { x: s.x ?? 0, y: s.y ?? 0, w: 0, h: 0 }
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }
  const w = s.w ?? 0
  const h = s.h ?? 0
  return { x: s.x ?? 0, y: s.y ?? 0, w: Math.abs(w), h: Math.abs(h) }
}

/** 一组图形的合并包围盒（框选、复制粘贴时用） */
export function shapesBounds(list: WhiteboardShape[]): ShapeBox | null {
  if (list.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of list) {
    const b = shapeBox(s)
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** 两个盒子是否相交（框选用；只要碰上就算选中，与卡片的 rectsIntersect 行为一致） */
export function boxesIntersect(a: ShapeBox, b: ShapeBox): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)
}

/* ============================ 变换 ============================ */

/** 平移一个图形（几何图形移 x/y；线类移所有点） */
export function moveShape(s: WhiteboardShape, dx: number, dy: number): WhiteboardShape {
  if (isLineKind(s.kind)) {
    return { ...s, points: (s.points ?? []).map((p) => ({ x: p.x + dx, y: p.y + dy })) }
  }
  return { ...s, x: (s.x ?? 0) + dx, y: (s.y ?? 0) + dy }
}

/** 整体平移一组图形 */
export function moveShapes(list: WhiteboardShape[], dx: number, dy: number): WhiteboardShape[] {
  return list.map((s) => moveShape(s, dx, dy))
}

/* ============================ 自由绘制采样 ============================ */

/**
 * 是否该记录这个新点：距上一个已记录点 ≥ 采样间隔才记。
 * 目的：① 防手抖产生海量点 ② 控制文件体积。
 */
export function shouldSample(last: ShapePt | undefined, next: ShapePt, minDist = FREE_SAMPLE_DIST): boolean {
  if (last === undefined) return true
  return dist(last, next) >= minDist
}

/** 采样过滤一整串点（保留首尾） */
export function samplePoints(raw: ShapePt[], minDist = FREE_SAMPLE_DIST, maxPoints = FREE_MAX_POINTS): ShapePt[] {
  if (raw.length === 0) return []
  const out: ShapePt[] = [raw[0]]
  for (let i = 1; i < raw.length; i++) {
    if (out.length >= maxPoints) break
    if (shouldSample(out[out.length - 1], raw[i], minDist)) out.push(raw[i])
  }
  // 至少保留最后一个点（松手位置），除非已经记过
  const last = raw[raw.length - 1]
  if (out.length < maxPoints && dist(out[out.length - 1], last) > 0) out.push(last)
  return out.slice(0, maxPoints)
}

/* ============================ 曲线控制点 ============================ */

/**
 * 在曲线的一段上插入控制点。
 *
 * 按用户定的规则（Adobe 手感）：**插入落在"点击位置在线段上的投影处"**，而不是线段正中。
 * 这样用户想往哪边弯就往哪边点。
 *
 * @returns 新的点数组；`segIndex` 越界时原样返回
 */
export function insertPointOnSegment(points: ShapePt[], segIndex: number, click: ShapePt): ShapePt[] {
  if (segIndex < 0 || segIndex >= points.length - 1) return points
  const a = points[segIndex]
  const b = points[segIndex + 1]
  const t = projectT(click, a, b)
  const at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  return [...points.slice(0, segIndex + 1), at, ...points.slice(segIndex + 1)]
}

/**
 * 命中某一段：返回段索引与距离。
 * 用于"点击线段中部插点"与"拖动已有控制点"。
 *
 * 注意：对**曲线**判断时用**折线近似**（把相邻控制点连起来），
 * 足够准且快 —— 精确求贝塞尔最近点对手感没有可见差别。
 */
export function hitSegment(points: ShapePt[], p: ShapePt, tolerance: number): { index: number; distance: number } | null {
  if (points.length < 2) return null
  let best: { index: number; distance: number } | null = null
  for (let i = 0; i < points.length - 1; i++) {
    const d = distToSegment(p, points[i], points[i + 1])
    if (d <= tolerance && (best === null || d < best.distance)) best = { index: i, distance: d }
  }
  return best
}

/** 命中某个控制点（拖动用） */
export function hitControlPoint(points: ShapePt[], p: ShapePt, tolerance: number): number | null {
  for (let i = 0; i < points.length; i++) {
    if (dist(points[i], p) <= tolerance) return i
  }
  return null
}

/* ============================ 命中整个图形 ============================ */

/**
 * 点是否命中某个图形（选择/删除用）。
 *   · 几何图形：包围盒内即算中（与卡片一样的"方块命中"，简单直观）
 *   · 线类：到任意线段距离 ≤ tolerance
 */
export function hitShape(s: WhiteboardShape, p: ShapePt, lineTolerance = 6): boolean {
  if (isLineKind(s.kind)) {
    const pts = s.points ?? []
    if (pts.length === 0) return false
    if (pts.length === 1) return dist(pts[0], p) <= lineTolerance
    return hitSegment(pts, p, lineTolerance) !== null
  }
  const b = shapeBox(s)
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h
}

/* ============================ 构造 ============================ */

/**
 * 由"拖拽起止点"造一个几何图形。
 *
 * 处理两件琐事：
 *   · 反向拖动（终点在起点左/上）时把 x/y 归一到左上角；
 *   · 尺寸过小（等于只是点了一下）时给默认尺寸，并以点击处为中心。
 */
export function makeBoxShape(
  id: string, kind: ShapeKind, color: string, start: ShapePt, end: ShapePt, keepRatio = false
): WhiteboardShape {
  let x = Math.min(start.x, end.x)
  let y = Math.min(start.y, end.y)
  let w = Math.abs(end.x - start.x)
  let h = Math.abs(end.y - start.y)

  if (keepRatio) {
    const side = Math.max(w, h)
    w = side
    h = side
    if (end.x < start.x) x = start.x - side
    if (end.y < start.y) y = start.y - side
  }

  if (w < SHAPE_MIN_SIZE || h < SHAPE_MIN_SIZE) {
    w = SHAPE_DEFAULT_W
    h = SHAPE_DEFAULT_H
    x = start.x - w / 2
    y = start.y - h / 2
  }
  return { id, kind, color, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

/**
 * 由"拖拽起止点"造一条线（直线/箭头）。
 * @returns null 表示长度太小（视为误操作）
 */
export function makeLineShape(
  id: string, kind: ShapeKind, color: string, start: ShapePt, end: ShapePt, snap45 = false
): WhiteboardShape | null {
  let to = end
  if (snap45) to = snapTo45(start, end)
  if (dist(start, to) < SHAPE_MIN_LEN) return null
  return { id, kind, color, points: [{ x: Math.round(start.x), y: Math.round(start.y) }, { x: Math.round(to.x), y: Math.round(to.y) }] }
}

/** 吸附到 0° / 45° / 90°（按住 Shift 时用） */
export function snapTo45(from: ShapePt, to: ShapePt): ShapePt {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return to
  const step = Math.PI / 4
  const angle = Math.round(Math.atan2(dy, dx) / step) * step
  return { x: Math.round(from.x + Math.cos(angle) * len), y: Math.round(from.y + Math.sin(angle) * len) }
}

/** 由采样点造一个自由绘制图形 */
export function makeFreeShape(id: string, color: string, rawPoints: ShapePt[]): WhiteboardShape | null {
  const pts = samplePoints(rawPoints)
  if (pts.length < 2) return null
  const total = pts.reduce((acc, p, i) => (i === 0 ? 0 : acc + dist(pts[i - 1], p)), 0)
  if (total < SHAPE_MIN_LEN) return null
  return { id, kind: 'free', color, points: pts.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })) }
}

/* ============================ 归一化（读文件时用） ============================ */

/**
 * 把文件里读到的图形规整成合法值。
 * 用于：① 挡住 AI 写坏的数据 ② 兼容早期手写文件。
 *
 * @returns 合法则返回规整后的对象；不合法返回 null（调用方丢弃该条）
 */
export function normalizeShape(input: unknown, fallbackId: () => string): WhiteboardShape | null {
  if (input === null || typeof input !== 'object') return null
  const o = input as Partial<WhiteboardShape>
  const kind = resolveShapeKind(o.kind)
  if (kind === null) return null
  const id = typeof o.id === 'string' && o.id !== '' ? o.id : fallbackId()
  const color = typeof o.color === 'string' && o.color.trim() !== '' ? o.color.trim() : 'default'

  if (isLineKind(kind)) {
    const raw = Array.isArray(o.points) ? o.points : []
    const pts: ShapePt[] = []
    for (const p of raw.slice(0, FREE_MAX_POINTS)) {
      const x = Number((p as ShapePt)?.x)
      const y = Number((p as ShapePt)?.y)
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y })
    }
    if (pts.length < 2) return null
    return { id, kind, color, points: pts }
  }

  const num = (v: unknown, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d)
  const x = num(o.x, 0)
  const y = num(o.y, 0)
  const w = Math.max(SHAPE_MIN_SIZE, Math.abs(num(o.w, SHAPE_DEFAULT_W)))
  const h = Math.max(SHAPE_MIN_SIZE, Math.abs(num(o.h, SHAPE_DEFAULT_H)))
  return { id, kind, color, x, y, w, h }
}

/** 批量规整 */
export function normalizeShapes(input: unknown, fallbackId: () => string): WhiteboardShape[] {
  if (!Array.isArray(input)) return []
  const out: WhiteboardShape[] = []
  for (const item of input) {
    const s = normalizeShape(item, fallbackId)
    if (s !== null) out.push(s)
  }
  return out
}
