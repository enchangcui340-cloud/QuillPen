/**
 * 绘制模式的交互状态机。
 *
 * 为什么单独抽出来：Whiteboard.tsx 已经近千行，绘制交互自成一套
 * （按下/移动/松手 + 曲线三态 + 自由绘制采样），塞进去会难以维护。
 *
 * 与外部的关系：
 *   · 输入：鼠标的世界坐标、当前工具、修饰键；
 *   · 输出：一个"正在画的临时图形"（draft）或"要提交的图形"（commit）；
 *   · 本文件**不碰 React 状态**，只做计算，调用方负责 setState。
 *
 * 三种交互方式（见《设计规范》§四）：
 *   ① 几何图形 / 直线 / 箭头 / 自由绘制：按下 → 拖动 → 松手
 *   ② 曲线：点击落点 → 再点击成线 → 点线段中部插点 → 拖动控制点 → 点空白锁定
 */
import type { ShapeKind, ShapePt, WhiteboardShape } from '@shared/types'
import {
  hitControlPoint, hitSegment, insertPointOnSegment, makeBoxShape, makeFreeShape, makeLineShape,
  moveShape, samplePoints
} from './shapes'

/** 判定"点到线段"的容差（世界单位）——与 Design 规范里的 EDGE_HIT 同量级 */
export const CURVE_HIT = 10
/** 控制点命中半径（规范定 9） */
export const CTRL_HIT = 9

/**
 * 预览图形的固定 id。
 *
 * 为什么用固定值而不是 `newId()`：预览每帧都会重算一次，
 * 如果 id 每帧都变，React 会把 SVG 组当成"新元素"整棵重挂载 —— 白白重绘。
 * 真 id 由 `onDrawUp` 在落定那一刻生成，预览用不到。
 *
 * ⚠️ 渲染预览时**不能**把它当 `data-shape-id` 写出去：
 * 护栏测试（`tools/check-draw-interact.mjs`）用 `[data-shape-id]` 数"已落定的图形"，
 * 预览带上这个属性会把计数弄乱。
 */
export const DRAFT_ID = 'draft'

/** 绘制会话状态（放在 ref 里，避免每次 mousemove 都触发重渲染） */
export interface DrawSession {
  /** 当前正在做的动作 */
  mode: 'idle' | 'box' | 'line' | 'free' | 'curve-point' | 'curve-drag'
  /** box/line 的起点 */
  start?: ShapePt
  /** free 的原始采样点 */
  freePts?: ShapePt[]
  /** curve-drag：正在拖第几个控制点 */
  ctrlIndex?: number
}

export const IDLE: DrawSession = { mode: 'idle' }

/* ============================ 按下 ============================ */

export interface DownInput {
  kind: ShapeKind | 'select'
  color: string
  p: ShapePt
  shift: boolean
  newId: () => string
  /** 正在编辑的曲线（非 null 时，曲线工具优先做"插点/拖点"） */
  editingCurve: { id: string; points: ShapePt[] } | null
}

export interface DownOutput {
  session: DrawSession
  /** 要不要更新 draft 预览 */
  draft?: WhiteboardShape | null
  /** 曲线：要更新编辑中的控制点 */
  curvePoints?: ShapePt[]
  /** 曲线：要选中哪个控制点 */
  ctrlIndex?: number
  /** 是否已经"动手"（用于阻止后续的框选/点空白逻辑） */
  handled: boolean
}

/**
 * 画布左键按下。
 *
 * 曲线工具的特殊之处：它**不是**"按下-拖动"式，而是"点击落点"式，
 * 所以按下时只判断两件事：点到控制点了吗？点到线的中部了吗？
 */
export function onDrawDown(input: DownInput): DownOutput {
  const { kind, color, p, shift, newId, editingCurve } = input

  if (kind === 'select') return { session: IDLE, handled: false }

  // ---- 曲线：编辑态下的"拖控制点 / 点中部插点" ----
  if (kind === 'curve' && editingCurve !== null) {
    const ctrl = hitControlPoint(editingCurve.points, p, CTRL_HIT)
    if (ctrl !== null) {
      // 拖动已有控制点
      return { session: { mode: 'curve-drag', ctrlIndex: ctrl }, handled: true }
    }
    const seg = hitSegment(editingCurve.points, p, CURVE_HIT)
    if (seg !== null) {
      // 点在线段中部 → 在**点击位置的投影**处插入新控制点
      const pts = insertPointOnSegment(editingCurve.points, seg.index, p)
      return {
        session: IDLE,
        curvePoints: pts,
        // 插完顺手进入拖动，手感更顺（Adobe 也是这样）
        ctrlIndex: seg.index + 1,
        handled: true
      }
    }
    // 点在别处 → 交给调用方处理"锁定曲线"
    return { session: IDLE, handled: false }
  }

  // ---- 几何图形：按下开始拉框 ----
  if (kind === 'rect' || kind === 'ellipse' || kind === 'triangle' || kind === 'diamond') {
    const draft = makeBoxShape(newId(), kind, color, p, p, shift)
    return { session: { mode: 'box', start: p }, draft, handled: true }
  }

  // ---- 直线 / 箭头：按下开始拉线 ----
  if (kind === 'line' || kind === 'arrow') {
    return { session: { mode: 'line', start: p }, handled: true }
  }

  // ---- 自由绘制：开始采集 ----
  if (kind === 'free') {
    return { session: { mode: 'free', freePts: [p] }, handled: true }
  }

  // ---- 曲线首次落点：先记住起点（此时还不画东西）----
  if (kind === 'curve') {
    return { session: { mode: 'curve-point', start: p }, handled: true }
  }

  return { session: IDLE, handled: false }
}

/* ============================ 移动 ============================ */

export interface MoveInput {
  session: DrawSession
  kind: ShapeKind | 'select'
  color: string
  p: ShapePt
  shift: boolean
  /** 正在编辑的曲线（curve-drag 时要改它） */
  editingCurve: { id: string; points: ShapePt[] } | null
}

export interface MoveOutput {
  draft?: WhiteboardShape | null
  curvePoints?: ShapePt[]
}

/** 画布鼠标移动（只有正在绘制时才有输出） */
export function onDrawMove(input: MoveInput): MoveOutput {
  const { session, kind, color, p, shift, editingCurve } = input

  if (session.mode === 'box' && session.start !== undefined) {
    return { draft: makeBoxShape(DRAFT_ID, kind as ShapeKind, color, session.start, p, shift) }
  }

  if (session.mode === 'line' && session.start !== undefined) {
    // makeLineShape 在太短时返回 null；预览阶段允许为 null（等于"还没画出东西"）
    const s = makeLineShape(DRAFT_ID, kind as ShapeKind, color, session.start, p, shift)
    return { draft: s }
  }

  if (session.mode === 'free') {
    // 注意：这里把原始点塞进 draft 的 points，由渲染层按"已抽稀"的样子画
    const pts = [...(session.freePts ?? []), p]
    const sampled = samplePoints(pts)
    if (sampled.length < 2) return { draft: null }
    return { draft: { id: DRAFT_ID, kind: 'free', color, points: sampled } }
  }

  if (session.mode === 'curve-drag' && editingCurve !== null && session.ctrlIndex !== undefined) {
    // 拖动控制点：直接改那个点的坐标
    const pts = editingCurve.points.map((q, i) => (i === session.ctrlIndex ? { x: p.x, y: p.y } : q))
    return { curvePoints: pts }
  }

  return {}
}

/* ============================ 松手 ============================ */

export interface UpInput {
  session: DrawSession
  kind: ShapeKind | 'select'
  color: string
  p: ShapePt
  shift: boolean
  newId: () => string
}

export interface UpOutput {
  /** 要落定的图形（null = 这次操作作废） */
  commit: WhiteboardShape | null
  /** 曲线：这条曲线是否进入了"编辑态"（true 时调用方要设 editingCurve） */
  startCurveEdit?: { id: string; points: ShapePt[] }
}

/**
 * 画布左键松手 —— 把正在画的东西落定。
 *
 * 各工具的收尾规则：
 *   · box/line：松手即落定；太短（等于只是点了一下）时 box 用默认尺寸、line 丢弃
 *   · free：用整串采样点生成；太短丢弃
 *   · curve 首次点击：只是落第一个点，**不提交任何东西**（等第二次点击成线）
 */
export function onDrawUp(input: UpInput): UpOutput {
  const { session, kind, color, p, shift, newId } = input

  if (session.mode === 'box' && session.start !== undefined) {
    return { commit: makeBoxShape(newId(), kind as ShapeKind, color, session.start, p, shift) }
  }

  if (session.mode === 'line' && session.start !== undefined) {
    return { commit: makeLineShape(newId(), kind as ShapeKind, color, session.start, p, shift) }
  }

  if (session.mode === 'free') {
    const pts = [...(session.freePts ?? []), p]
    return { commit: makeFreeShape(newId(), color, pts) }
  }

  // 曲线拖控制点结束：不改结构，只是停止拖动
  if (session.mode === 'curve-drag') return { commit: null }

  // 曲线首次点击：落第一个点 → 直接进入编辑态，只带一个点（还画不出东西）
  // 第二次点击时由 composeCurveClick 补上第二个点。
  if (session.mode === 'curve-point' && session.start !== undefined) {
    return {
      commit: null,
      startCurveEdit: { id: newId(), points: [{ x: session.start.x, y: session.start.y }] }
    }
  }

  return { commit: null }
}

/* ============================ 曲线的"点击"（非拖动） ============================ */

/**
 * 曲线工具的一次左键**点击**（不是拖动）。
 *
 * 三种情况：
 *   ① 还没开始 → 落第一个点，进入编辑态（1 个点）
 *   ② 编辑态只有 1 个点 → 补第二个点，曲线成形（此时看起来是直线）
 *   ③ 编辑态 ≥2 个点 → 由 onDrawDown 处理（插点/拖点）；点到别处即"锁定"
 */
export function composeCurveClick(
  editing: { id: string; points: ShapePt[] } | null, p: ShapePt, color: string, newId: () => string
): { commit: WhiteboardShape | null; editing: { id: string; points: ShapePt[] } | null } {
  if (editing === null) {
    // ① 落第一个点
    return { commit: null, editing: { id: newId(), points: [{ x: p.x, y: p.y }] } }
  }
  if (editing.points.length === 1) {
    // ② 补第二个点 → 曲线成形
    const pts = [...editing.points, { x: p.x, y: p.y }]
    return { commit: { id: editing.id, kind: 'curve', color, points: pts }, editing: { id: editing.id, points: pts } }
  }
  // ③ 已有 2 点以上：点到别处 = 锁定（返回 editing=null 由调用方清理）
  return { commit: null, editing: null }
}

/* ============================ 命中测试辅助 ============================ */

/** 找出点命中的控制点索引（给 hover 高亮用） */
export function ctrlIndexAt(points: ShapePt[] | undefined, p: ShapePt): number | null {
  if (points === undefined) return null
  return hitControlPoint(points, p, CTRL_HIT)
}

/** 平移一个图形（给"选中后拖动"用；这里只是转出，便于测试） */
export { moveShape }
