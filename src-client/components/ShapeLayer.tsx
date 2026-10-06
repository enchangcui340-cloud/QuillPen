/**
 * 白板上"绘制的图形"的渲染层。
 *
 * 为什么单独一个组件：Whiteboard.tsx 已经 900 多行，图形渲染自成一块
 * （8 种图形 × 深浅主题 × 选中态），放一起会难以维护。
 *
 * 分工：
 *   · 本文件：只负责"把数据画出来"，不做任何交互；（交互在 Whiteboard.tsx 里）
 *   · `lib/shapes.ts`：所有坐标/路径计算；
 *   · CSS 变量 `--draw-<color>-line`：按主题换色（深浅两套），数据里只有色板键。
 */
import type { WhiteboardShape } from '@shared/types'
import { resolveCardColorKey } from '../lib/card-colors'
import { isLineKind, shapePathOf } from '../lib/shapes'

/** 尺寸常量：与《设计规范》一致，集中在这里避免散落 */
export const SHAPE_STROKE = 2.0
export const SHAPE_STROKE_SELECTED = 3.4
export const LINE_STROKE = 2.4
/** 控制点半径（曲线编辑态） */
export const CTRL_RADIUS = 5
export const CTRL_RADIUS_HOVER = 6.5

/**
 * 取图形用的 CSS 颜色值。
 *
 * 规则（见设计规范 §三）：
 *   · 几何图形**填充** = 卡片底色（同一套色板，视觉上是一家人）
 *   · **线 / 描边** = 同色系"压深一档"（`--draw-*-line`），保证看得清
 *
 * 颜色存的是色板键；未知值（历史自定义 hex）直接用原值，不参与主题切换。
 */
export function shapeColorVar(shape: WhiteboardShape): string {
  const key = resolveCardColorKey(shape.color)
  return key === null ? shape.color : `var(--draw-${key}-line)`
}

export function shapeFillVar(shape: WhiteboardShape): string {
  const key = resolveCardColorKey(shape.color)
  return key === null ? shape.color : `var(--card-${key}-bg)`
}

/** 颜色键（用于 marker id 与 data 属性）；未知颜色统一归到 default */
export function shapeColorKey(shape: WhiteboardShape): string {
  return resolveCardColorKey(shape.color) ?? 'default'
}

/**
 * 四种几何图形的 SVG 形状。
 *
 * `dash` 为真时**只描边、不填充 + 虚线**，用于拖动中的预览：
 * 能看清形状将落在哪里，又不遮住已有内容。
 */
function BoxShape({
  shape, fill, stroke, dash = false
}: { shape: WhiteboardShape; fill: string; stroke: string; dash?: boolean }): React.ReactElement {
  const x = shape.x ?? 0
  const y = shape.y ?? 0
  const w = Math.abs(shape.w ?? 0)
  const h = Math.abs(shape.h ?? 0)
  const common = {
    fill: dash ? 'none' : fill,
    stroke,
    strokeWidth: SHAPE_STROKE,
    strokeLinejoin: 'round' as const,
    // 预览虚线：与现有"拉连线时的 linkPreview"虚线风格保持一致
    ...(dash ? { strokeDasharray: '6 5' } : {})
  }

  switch (shape.kind) {
    case 'ellipse':
      return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />
    case 'triangle':
      return <path d={`M ${x + w / 2} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`} {...common} />
    case 'diamond':
      return <path d={`M ${x + w / 2} ${y} L ${x + w} ${y + h / 2} L ${x + w / 2} ${y + h} L ${x} ${y + h / 2} Z`} {...common} />
    case 'rect':
    default:
      return <rect x={x} y={y} width={w} height={h} rx={3} {...common} />
  }
}

interface Props {
  shapes: WhiteboardShape[]
  /** 选中的图形 id（选中时描边用 accent、加粗） */
  selectedIds?: string[]
  /** 悬停的图形 id（轻微高亮） */
  hoverId?: string | null
  /** 是否吃鼠标事件（绘制模式下不吃；普通模式下要能点选/拖动） */
  interactive?: boolean
  onShapeMouseDown?: (e: React.MouseEvent, shape: WhiteboardShape) => void
  onShapeContextMenu?: (e: React.MouseEvent, shape: WhiteboardShape) => void
  /**
   * 正在绘制、**还没落定**的图形（拖动预览）。
   * 画在一个独立的 `<g className="board-shape-draft">` 里，与已落定的图形完全分开 ——
   * 这样拖动时只重绘这一层，且不会污染测试用的 `[data-shape-id]` 计数。
   */
  draft?: WhiteboardShape | null
}

/**
 * 拖动预览层。
 *
 * 两条硬约束：
 *   ① **不能带 `data-shape-id`** —— 护栏测试（tools/check-draw-interact.mjs）用
 *      `[data-shape-id]` 数"已落定的图形"，预览带上它会把计数弄乱；
 *   ② `pointerEvents: 'none'` —— 预览不该抢走画布的鼠标事件。
 */
function DraftShape({ shape }: { shape: WhiteboardShape }): React.ReactElement {
  const line = shapeColorVar(shape)
  return (
    <g className="board-shape-draft" aria-hidden="true" style={{ pointerEvents: 'none' }}>
      {isLineKind(shape.kind) ? (
        <path
          d={shapePathOf(shape)}
          fill="none"
          stroke={line}
          strokeWidth={LINE_STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="6 5"
        />
      ) : (
        <BoxShape shape={shape} fill="none" stroke={line} dash />
      )}
    </g>
  )
}

/**
 * 把一批图形画到一个 `<g>` 里。
 *
 * 注意调用位置：要放在**连线之后、卡片之前**（见《设计规范》§六 的图层顺序）。
 * 因为填充是不透明的，若画在卡片之上会把卡片整个盖住、还点不到。
 */
export default function ShapeLayer({
  shapes, selectedIds = [], hoverId = null, interactive = false,
  onShapeMouseDown, onShapeContextMenu, draft = null
}: Props): React.ReactElement {
  // 即使没有已落定的图形，只要在拖预览也得渲染出这一层
  if (shapes.length === 0 && draft === null) return <g />

  return (
    <>
      <g className="board-shapes">
      {shapes.map((s) => {
        const selected = selectedIds.includes(s.id)
        // 选中态统一用 accent（与连线选中一致）
        const line = selected ? 'var(--accent)' : shapeColorVar(s)
        const strokeWidth = selected ? SHAPE_STROKE_SELECTED : (isLineKind(s.kind) ? LINE_STROKE : SHAPE_STROKE)
        const hovered = hoverId === s.id

        return (
          <g
            key={s.id}
            className={'board-shape' + (selected ? ' selected' : '') + (hovered ? ' hover' : '')}
            data-shape-id={s.id}
            data-shape-kind={s.kind}
            data-shape-color={shapeColorKey(s)}
            // 交互模式下要吃事件：否则点不到图形（绘制模式下则让画布全权处理）
            style={{ pointerEvents: interactive ? 'auto' : 'none', cursor: 'pointer' }}
            onMouseDown={interactive && onShapeMouseDown !== undefined ? (e) => onShapeMouseDown(e, s) : undefined}
            onContextMenu={interactive && onShapeContextMenu !== undefined ? (e) => onShapeContextMenu(e, s) : undefined}
          >
            {isLineKind(s.kind) ? (
              <path
                d={shapePathOf(s)}
                fill="none"
                stroke={line}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
                // 箭头：终点 marker，颜色跟随线色（每个色板键一个 marker，见 defs）
                markerEnd={s.kind === 'arrow' ? `url(#arrow-${selected ? 'sel' : shapeColorKey(s)})` : undefined}
              />
            ) : (
              <BoxShape shape={s} fill={shapeFillVar(s)} stroke={line} />
            )}
          </g>
        )
      })}
      </g>
      {/* 拖动预览：独立一层，放在已落定图形之后（盖在上面才看得见） */}
      {draft !== null && <DraftShape shape={draft} />}
    </>
  )
}

/**
 * 画箭头用的 marker 定义（每个色板键一个 + 一个选中态）。
 *
 * 为什么要这么多：SVG 的 `marker` **不继承** `context-stroke`（浏览器支持不一），
 * 所以只能按颜色各定义一个，用 `url(#arrow-<key>)` 引用。
 * 深浅主题不用各做一套 —— marker 内部用 CSS 变量即可自动换色。
 */
export function ShapeMarkerDefs({ colorKeys }: { colorKeys: string[] }): React.ReactElement {
  return (
    <defs>
      {colorKeys.map((key) => (
        <marker
          key={key}
          id={`arrow-${key}`}
          markerWidth="11" markerHeight="11" refX="8.6" refY="5.5"
          orient="auto" markerUnits="userSpaceOnUse"
        >
          <path
            d="M1.5,1.5 L8.6,5.5 L1.5,9.5"
            fill="none"
            stroke={`var(--draw-${key}-line)`}
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </marker>
      ))}
      <marker id="arrow-sel" markerWidth="11" markerHeight="11" refX="8.6" refY="5.5" orient="auto" markerUnits="userSpaceOnUse">
        <path d="M1.5,1.5 L8.6,5.5 L1.5,9.5" fill="none" stroke="var(--accent)" strokeWidth="1.7"
          strokeLinecap="round" strokeLinejoin="round" />
      </marker>
    </defs>
  )
}

/**
 * 曲线编辑态：画控制点（小圆），供拖动。
 * 只在"绘制模式 + 曲线正在编辑"时渲染。
 */
export function CurveHandles({
  points, activeIndex, hoverIndex
}: { points: { x: number; y: number }[]; activeIndex?: number; hoverIndex?: number | null }): React.ReactElement {
  return (
    <g className="board-ctrl-points">
      {points.map((p, i) => {
        const r = hoverIndex === i || activeIndex === i ? CTRL_RADIUS_HOVER : CTRL_RADIUS
        return (
          <circle
            key={i}
            cx={p.x} cy={p.y} r={r}
            className="board-ctrl-point"
            data-ctrl-index={i}
            fill="var(--panel)"
            stroke="var(--accent)"
            strokeWidth={2}
            style={{ pointerEvents: 'none' }}
          />
        )
      })}
    </g>
  )
}
