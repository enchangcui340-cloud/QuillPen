import type { WhiteboardEdge, WhiteboardNode, WhiteboardShape, WhiteboardSide } from '@shared/types'
// 图形的包围盒与平移（复制粘贴要把图形和卡片用同一个位移量搬走）
import { moveShape, shapeBox } from './shapes'

export type Side = WhiteboardSide
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** 卡片最小尺寸 */
export const MIN_NODE_W = 96
export const MIN_NODE_H = 60
/**
 * 导入图片时的尺寸上限。
 * 图片按原始比例缩放到不超过这个框；超过就按比例缩小。
 * 只约束"导入瞬间"，之后手动拖拽放大不受限制。
 */
export const IMPORT_MAX_W = 420
export const IMPORT_MAX_H = 320
/** 连线的可见粗细与点击热区 */
export const EDGE_STROKE = 2.4
export const EDGE_STROKE_SELECTED = 3.4
export const EDGE_HIT = 18
/** 卡片四边中间的连线圆点直径 */
export const LINK_DOT = 11
export const RESIZE_HANDLE = 9

export const SIDES: Side[] = ['top', 'right', 'bottom', 'left']

/**
 * 白板世界尺寸（面积约为上一版的 3 倍）。
 * 世界坐标以原点为中心：x/y 都可以是负数，
 * 所以往左上方向也能放卡片，而不是只有右下能放。
 */
export const WORLD_W = 21000
export const WORLD_H = 14000
/** 世界坐标 -> 画布内层坐标（内层左上角 = 世界 (-ORIGIN_X, -ORIGIN_Y)） */
export const ORIGIN_X = WORLD_W / 2
export const ORIGIN_Y = WORLD_H / 2
export function toLocalX(x: number): number { return x + ORIGIN_X }
export function toLocalY(y: number): number { return y + ORIGIN_Y }

export interface Viewport { x: number; y: number; z: number }

/** 世界坐标 -> 屏幕坐标 */
export function worldToScreen(v: Viewport, p: Pt): Pt {
  return { x: p.x * v.z + v.x, y: p.y * v.z + v.y }
}

/** 屏幕坐标 -> 世界坐标（worldToScreen 的逆运算） */
export function screenToWorld(v: Viewport, p: Pt): Pt {
  return { x: (p.x - v.x) / v.z, y: (p.y - v.y) / v.z }
}

/**
 * 画布内层的 CSS transform 平移量。
 * 内层子元素用的是"世界坐标 + ORIGIN"的局部坐标，
 * 而 view 是世界坐标下的平移量，所以这里必须减掉 ORIGIN * z。
 * 少了这一步，所有卡片会整体偏移 ORIGIN 那么多像素（曾经真的发生过）。
 */
export function containerOffset(v: Viewport): Pt {
  return { x: v.x - ORIGIN_X * v.z, y: v.y - ORIGIN_Y * v.z }
}

/** 局部坐标 -> 屏幕坐标（必须与 worldToScreen 对同一张卡片给出相同结果） */
export function localToScreen(v: Viewport, local: Pt): Pt {
  const o = containerOffset(v)
  return { x: local.x * v.z + o.x, y: local.y * v.z + o.y }
}

/** 把卡片位置限制在画布范围内（含负数区域），保证连线也画得出来 */
export function clampX(x: number, w: number): number {
  return Math.min(Math.max(x, -ORIGIN_X), ORIGIN_X - w)
}
export function clampY(y: number, h: number): number {
  return Math.min(Math.max(y, -ORIGIN_Y), ORIGIN_Y - h)
}
/** 缩放范围 */
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 3

/** 两个矩形是否相交（框选用） */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)
}

/** 由两个对角点得到规范矩形 */
export function rectFromPoints(p1: Pt, p2: Pt): Rect {
  return {
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    w: Math.abs(p2.x - p1.x),
    h: Math.abs(p2.y - p1.y)
  }
}

/** 一组卡片的包围盒 */
export function boundsOf(rects: Rect[]): Rect | null {
  if (!rects.length) return null
  const x1 = Math.min(...rects.map((r) => r.x))
  const y1 = Math.min(...rects.map((r) => r.y))
  const x2 = Math.max(...rects.map((r) => r.x + r.w))
  const y2 = Math.max(...rects.map((r) => r.y + r.h))
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

export function anchorOf(r: Rect, side: Side): Pt {
  switch (side) {
    case 'top': return { x: r.x + r.w / 2, y: r.y }
    case 'bottom': return { x: r.x + r.w / 2, y: r.y + r.h }
    case 'left': return { x: r.x, y: r.y + r.h / 2 }
    default: return { x: r.x + r.w, y: r.y + r.h / 2 }
  }
}

/** 沿所在边向外偏移 k 个像素（用于贝塞尔控制点） */
export function offsetOut(p: Pt, side: Side, k: number): Pt {
  switch (side) {
    case 'top': return { x: p.x, y: p.y - k }
    case 'bottom': return { x: p.x, y: p.y + k }
    case 'left': return { x: p.x - k, y: p.y }
    default: return { x: p.x + k, y: p.y }
  }
}

/** 点落在卡片哪一边：按归一化距离比较，靠近哪边就算哪边 */
export function nearestSide(r: Rect, p: Pt): Side {
  const dx = (p.x - (r.x + r.w / 2)) / Math.max(1, r.w / 2)
  const dy = (p.y - (r.y + r.h / 2)) / Math.max(1, r.h / 2)
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'top' : 'bottom'
}

/** 看板上的 4 条边（顺序固定，便于两处实现比对） */
export const EDGE_SIDES: Side[] = ['top', 'right', 'bottom', 'left']

/** 边 → 是否合法取值（AI 传进来的 side 要过这一关） */
export function isEdgeSide(v: unknown): v is Side {
  return v === 'top' || v === 'right' || v === 'bottom' || v === 'left'
}

/**
 * **连线取边规范**：取"朝对方中心"的那条边。
 *
 * 这是白板连线的唯一取边算法，界面与 AI 工具层各有一份（TS / 纯 JS 两个模块，无法共用源码），
 * 靠 `tools/check-edge-side-parity.mjs` 保证两边结果一致。
 *
 * 为什么是"朝对方中心"，而不是其它方案（都是用真实函数实测比过的）：
 *   · **不再乱连**：修正前的老实现把两个矩形传反了，并排两卡会连成 `left → right`（绕两卡一圈，
 *     锚点距离 480；正确解是 60）。12 个常见方位实测 **0/12 正确**。
 *   · **可预测**：AI 能照着 SKILL.md 的对照表自己算出会连成什么样，不用试。
 *   · **简单**：没有枚举、没有平局、没有退化分支（"取最短锚点"方案有 16 次枚举与近似平局）。
 *   · **永不选同侧**：不会出现 `right → right` 这种横穿卡片的连法。
 *
 * @param a 起点卡片矩形
 * @param b 终点卡片矩形
 * @returns 起点用哪条边、终点用哪条边
 */
export function resolveEdgeSides(a: Rect, b: Rect): { from: Side; to: Side } {
  return { from: sideFacingCenter(a, b), to: sideFacingCenter(b, a) }
}

/** 在矩形 self 上，取"朝 other 中心"的那条边 */
export function sideFacingCenter(self: Rect, other: Rect): Side {
  return nearestSide(self, {
    x: other.x + other.w / 2,
    y: other.y + other.h / 2
  })
}

/** 连线路径：两端各沿自己的边向外伸出后，用三次贝塞尔相连 */
export function edgePath(a: Pt, aSide: Side, b: Pt, bSide: Side): string {
  const d = Math.hypot(b.x - a.x, b.y - a.y)
  const k = Math.min(Math.max(d * 0.42, 28), 150)
  const c1 = offsetOut(a, aSide, k)
  const c2 = offsetOut(b, bSide, k)
  return 'M ' + a.x + ' ' + a.y + ' C ' + c1.x + ' ' + c1.y + ', ' + c2.x + ' ' + c2.y + ', ' + b.x + ' ' + b.y
}

/** 三次贝塞尔在 t 处的点（用于把线上文字放在正中） */
export function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
  }
}

/** 连线中点：与 edgePath 使用同一组控制点，保证文字正好落在线上 */
export function edgeMidpoint(a: Pt, aSide: Side, b: Pt, bSide: Side): Pt {
  const d = Math.hypot(b.x - a.x, b.y - a.y)
  const k = Math.min(Math.max(d * 0.42, 28), 150)
  return cubicAt(a, offsetOut(a, aSide, k), offsetOut(b, bSide, k), b, 0.5)
}

/** 导入图片时按上限等比缩放 */
export function fitSize(w: number, h: number, maxW = IMPORT_MAX_W, maxH = IMPORT_MAX_H): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w: MIN_NODE_W, h: MIN_NODE_H }
  const scale = Math.min(1, maxW / w, maxH / h)
  return { w: Math.max(64, Math.round(w * scale)), h: Math.max(48, Math.round(h * scale)) }
}

/**
 * 拖拽边角改变大小。
 * keepRatio 用于图片：保持原始比例，拖任意一边都等比缩放。
 */
export function resizeRect(start: Rect, handle: Handle, dx: number, dy: number, keepRatio = false): Rect {
  const ratio = start.h > 0 ? start.w / start.h : 1
  const west = handle.includes('w')
  const east = handle.includes('e')
  const north = handle.includes('n')
  const south = handle.includes('s')

  let x1 = start.x, y1 = start.y
  let x2 = start.x + start.w, y2 = start.y + start.h
  if (west) x1 += dx
  if (east) x2 += dx
  if (north) y1 += dy
  if (south) y2 += dy

  let w = x2 - x1
  let h = y2 - y1

  const applyRatio = (): void => {
    if (handle === 'n' || handle === 's') {
      w = h * ratio
      if (west) x1 = x2 - w; else x2 = x1 + w
    } else if (handle === 'w' || handle === 'e') {
      h = w / ratio
      if (north) y1 = y2 - h; else y2 = y1 + h
    } else {
      h = w / ratio
      if (north) y1 = y2 - h; else y2 = y1 + h
    }
  }

  if (keepRatio) applyRatio()

  if (w < MIN_NODE_W) { w = MIN_NODE_W; if (west) x1 = x2 - w; else x2 = x1 + w }
  if (h < MIN_NODE_H) { h = MIN_NODE_H; if (north) y1 = y2 - h; else y2 = y1 + h }
  if (keepRatio) applyRatio()

  return { x: Math.round(x1), y: Math.round(y1), w: Math.round(w), h: Math.round(h) }
}

/**
 * 一组卡片整体移动时的位移夹紧。
 *
 * 关键点：必须按"整组"算一个共同位移，而不是每张各自夹紧 ——
 * 否则靠边的卡片会先停下、其它的继续动，相对位置就乱了。
 */
export interface MovableRect { x: number; y: number; w: number; h: number }

export function clampGroupDelta(items: MovableRect[], dx: number, dy: number): { dx: number; dy: number } {
  let minDx = -Infinity, maxDx = Infinity
  let minDy = -Infinity, maxDy = Infinity
  for (const it of items) {
    minDx = Math.max(minDx, -ORIGIN_X - it.x)
    maxDx = Math.min(maxDx, ORIGIN_X - it.w - it.x)
    minDy = Math.max(minDy, -ORIGIN_Y - it.y)
    maxDy = Math.min(maxDy, ORIGIN_Y - it.h - it.y)
  }
  if (!items.length) return { dx, dy }
  return {
    dx: Math.min(Math.max(dx, minDx), maxDx),
    dy: Math.min(Math.max(dy, minDy), maxDy)
  }
}

/**
 * 白板剪贴板的内容。
 *
 * `shapes` 是后来加的（白板绘制功能）：绘制的图形要和卡片一样能复制粘贴。
 * **可选**，这样老剪贴板内容（或其它地方构造的对象）不会因为缺字段而报错。
 */
export interface BoardClipboard {
  nodes: WhiteboardNode[]
  edges: WhiteboardEdge[]
  shapes?: WhiteboardShape[]
}

/**
 * 把选中的卡片（以及它们之间的连线）与图形抓成剪贴板内容。
 *
 * ⚠️ 两个易错点（都被踩过）：
 *   ① 早退条件必须是"卡片和图形**都**没选中"才返回 null。
 *      原来只判 `!picked.length`，于是"只框选图形"时会直接返回 null，粘贴不出任何东西。
 *   ② 只有一端在选中集合里的连线不该跟着走（保持原行为）。
 */
export function copySelection(
  nodes: WhiteboardNode[], edges: WhiteboardEdge[], selectedIds: string[],
  shapes: WhiteboardShape[] = [], selectedShapeIds: string[] = []
): BoardClipboard | null {
  const picked = nodes.filter((n) => selectedIds.includes(n.id))
  const pickedShapes = shapes.filter((s) => selectedShapeIds.includes(s.id))
  if (!picked.length && !pickedShapes.length) return null
  const ids = new Set(picked.map((n) => n.id))
  // 只带走两端都在选中的连线；连到外面的线不该跟着走
  const inner = edges.filter((e) => ids.has(e.from) && ids.has(e.to))
  return {
    nodes: picked.map((n) => ({ ...n })),
    edges: inner.map((e) => ({ ...e })),
    shapes: pickedShapes.map((s) => ({ ...s, points: s.points?.map((p) => ({ ...p })) }))
  }
}

/**
 * 粘贴：生成全新 ID 的副本，保持相对位置，落在指定位置（不指定就偏移一点）。
 * 新 ID 与连线的一并重映射，避免和原卡片串在一起。
 *
 * 图形与卡片用**同一个位移量**，这样"卡片 + 图形一起复制"时相对关系不乱。
 */
export function planPaste(
  clip: BoardClipboard, at: Pt | null, newId: () => string
): { nodes: WhiteboardNode[]; edges: WhiteboardEdge[]; shapes: WhiteboardShape[] } {
  const clipShapes = clip.shapes ?? []
  if (!clip.nodes.length && !clipShapes.length) return { nodes: [], edges: [], shapes: [] }

  const idMap = new Map<string, string>()
  const copies = clip.nodes.map((n) => {
    const id = newId()
    idMap.set(n.id, id)
    return { ...n, id }
  })

  // 整体包围盒要把图形也算进去，否则"只复制图形"时算不出落点
  const nodeRects = copies.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }))
  const shapeRects = clipShapes.map(shapeBox)
  const box = boundsOf([...nodeRects, ...shapeRects]) ?? { x: 0, y: 0, w: 0, h: 0 }
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 }
  const target = at ?? { x: center.x + 30, y: center.y + 30 }
  const d = clampGroupDelta(
    [...nodeRects, ...shapeRects],
    target.x - center.x,
    target.y - center.y
  )

  return {
    nodes: copies.map((n) => ({ ...n, x: Math.round(n.x + d.dx), y: Math.round(n.y + d.dy) })),
    edges: clip.edges.map((e) => ({ ...e, id: newId(), from: idMap.get(e.from)!, to: idMap.get(e.to)! })),
    shapes: clipShapes.map((s) => moveShape({ ...s, id: newId(), points: s.points?.map((p) => ({ ...p })) }, d.dx, d.dy))
  }
}

// 文字高度估算已挪到 @shared/board-height（主进程与渲染层共用同一套算法）
export { charWidth, estimateTextHeight, type TextMetricsInput } from '@shared/board-height'

