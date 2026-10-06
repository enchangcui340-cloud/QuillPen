import { askText } from './AskDialog'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Note, ShapeKind, ShapePt, WhiteboardEdge, WhiteboardFile, WhiteboardNode, WhiteboardShape } from '@shared/types'
import { toast } from './Toast'
import Modal from './Modal'
import ContextMenu, { type MenuItem } from './ContextMenu'
import ShapeLayer, { CurveHandles, ShapeMarkerDefs } from './ShapeLayer'
import {
  boxesIntersect, hitControlPoint, hitSegment, hitShape, insertPointOnSegment, makeBoxShape, makeFreeShape,
  makeLineShape, moveShape, normalizeShapes, shapeBox, shapePathOf
} from '../lib/shapes'
import { IDLE, ctrlIndexAt, onDrawDown, onDrawMove, onDrawUp, type DrawSession, CURVE_HIT, CTRL_HIT } from '../lib/draw-session'
import {
  anchorOf, boundsOf, edgeMidpoint, edgePath, fitSize, nearestSide, rectFromPoints, rectsIntersect, resizeRect,
  clampGroupDelta, clampX, clampY, containerOffset, copySelection, estimateTextHeight, planPaste,
  type BoardClipboard, EDGE_HIT, EDGE_STROKE, EDGE_STROKE_SELECTED, MAX_ZOOM, MIN_ZOOM, ORIGIN_X, ORIGIN_Y, SIDES, WORLD_H, WORLD_W, toLocalX, toLocalY,
  type Handle, type Rect, type Side
} from '../lib/board'
// DSH 版：附件地址统一走 /quill/attachment（原来这里另有一份 dsh-attachment:// 的重复实现）
import { attachmentUrl } from '../lib/attachments'
// 卡片配色板（6 色 × 深浅两套）：颜色定义与主题解析都在这里，别在组件里再散一份
import { CARD_PALETTE, cardColorHex, resolveCardColorKey } from '../lib/card-colors'

interface Props {
  note: Note
  board: WhiteboardFile
  noteTitles?: Record<string, string>
  onSaved: () => void
  onOpenNote: (id: string) => void
}

const FONT_SIZES = [13, 16, 20, 26]
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
/** 需要生成箭头 marker 的色板键（与 card-colors 的 6 色一致） */
const SHAPE_MARKER_KEYS = ['default', 'pink', 'blue', 'green', 'yellow', 'purple']
/** 选择/悬停时判"点到图形"的容差（线类比几何图形需要更大的容差才好点） */
const SHAPE_HIT = 8

/**
 * 绘制模式里的工具条（顺序即显示顺序）。
 * 第 1 个是「选择」——它让"画完自动切回选择状态"说得通：
 * 切回之后仍留在绘制模式里，可以接着框选/移动，再画下一个。
 */
const DRAW_TOOLS: { kind: 'select' | ShapeKind; icon: string; title: string }[] = [
  { kind: 'select', icon: '↖', title: '选择 / 移动（不画新东西）' },
  { kind: 'rect', icon: '▭', title: '矩形' },
  { kind: 'ellipse', icon: '◯', title: '椭圆' },
  { kind: 'triangle', icon: '△', title: '三角形' },
  { kind: 'diamond', icon: '◇', title: '菱形' },
  { kind: 'line', icon: '╱', title: '直线' },
  { kind: 'arrow', icon: '→', title: '箭头' },
  { kind: 'curve', icon: '∿', title: '曲线（点两下成线，点线中部加点，拖点变形，点空白锁定）' },
  { kind: 'free', icon: '✎', title: '自由绘制（按住拖动）' }
]

interface View { x: number; y: number; z: number }

/** 白板内部的卡片剪贴板（同一个应用内跨白板也能粘贴） */
let boardClipboard: BoardClipboard | null = null

/** 白板：自由摆放卡片、四边连线、框选批量拖动、平移缩放。 */
export default function Whiteboard({ note, board, noteTitles, onSaved, onOpenNote }: Props): React.ReactElement {
  const [nodes, setNodes] = useState<WhiteboardNode[]>(board.nodes)
  const [edges, setEdges] = useState<WhiteboardEdge[]>(board.edges)
  // 绘制的图形。旧白板没有 shapes 字段 → 归一化成空数组。
  // 注意：这里不能用下面的 newId()（它在后面才定义，会踩 TDZ），所以内联一个同规则的生成器。
  const [shapes, setShapes] = useState<WhiteboardShape[]>(() =>
    normalizeShapes(board.shapes, () => 's' + Math.random().toString(36).slice(2, 9))
  )
  const [selectedShapeIds, setSelectedShapeIds] = useState<string[]>([])
  const [hoverShapeId, setHoverShapeId] = useState<string | null>(null)
  /**
   * 绘制模式与当前工具。
   *   tool = 'select' 表示"在绘制模式里但不画东西"，即选择/移动
   * （你的第 2 条"画完自动切回选择状态"就是切回 'select'）
   */
  const [drawTool, setDrawTool] = useState<'select' | ShapeKind>('select')
  const [drawColor, setDrawColor] = useState<string>('blue')
  /** 是否处于绘制模式（工具栏整体切换） */
  const [drawMode, setDrawMode] = useState(false)
  /** 正在绘制中的临时图形（还没落定） */
  const [draftShape, setDraftShape] = useState<WhiteboardShape | null>(null)
  /** 自由绘制的原始采样点（松手时才成图形） */
  const freeRef = useRef<ShapePt[]>([])
  /** 正在编辑控制点的曲线（曲线工具点空白后置 null＝锁定） */
  const [editingCurve, setEditingCurve] = useState<{ id: string; points: ShapePt[]; color: string } | null>(null)
  const editingCurveRef = useRef<{ id: string; points: ShapePt[]; color: string } | null>(null)
  const [hoverCtrlIndex, setHoverCtrlIndex] = useState<number | null>(null)
  /** 正在拖动的控制点索引 */
  const dragCtrlRef = useRef<number | null>(null)
  /** 绘制会话（放在 ref 里：mousemove 频繁，用 state 会卡） */
  const drawSessionRef = useRef<DrawSession>(IDLE)
  const drawModeRef = useRef(false)
  const commitCurveRef = useRef<() => void>(() => undefined)
  /** 起点。几何图形/线用它记录按下位置；曲线工具用它判断"这次点击是落点还是插点" */
  const drawStartRef = useRef<ShapePt | null>(null)

  /**
   * 曲线控制点的**唯一写入口**。
   *
   * 为什么必须唯一：曲线的点同时被两个地方用到 ——
   *   ① `editingCurve`（画控制点用），② `shapes`（画曲线本体用）。
   * 之前拖动时只更新了 ①，于是"控制点在动、曲线不动"（用户报的问题）。
   * 现在两边一起写，任何改动路径都不会漏。
   *
   * ⚠️ 必须定义在**所有使用点之前**（rAF 合帧、鼠标事件都要用它），否则会踩 TDZ。
   */
  const applyCurvePoints = useCallback((id: string, points: ShapePt[], color: string): void => {
    setEditingCurve({ id, points, color })
    setShapes((prev) => {
      const exists = prev.some((s) => s.id === id)
      return exists
        ? prev.map((s) => (s.id === id ? { ...s, points } : s))
        : [...prev, { id, kind: 'curve' as const, color, points }]
    })
    setDirty(true)
  }, [])

  /*
   * ── 拖动预览的 rAF 合帧 ─────────────────────────────────────────────
   *
   * 为什么需要：`mousemove` 一帧内可能触发多次（高刷屏 / 快速划动），
   * 每次都 setState 会让 React 重复渲染整棵白板。
   * 这里把"预览相关"的更新压成**每帧一次**：先写 ref，rAF 里落地一次。
   *
   * ⚠️ 松手前必须 `flushDrawFrame()` —— 否则最后一帧还在 rAF 队列里，
   * 落定用的数据会落后一帧（看起来"图形比手慢半拍"）。
   */
  const rafRef = useRef<number | null>(null)
  const pendingDraftRef = useRef<{ has: boolean; value: WhiteboardShape | null }>({ has: false, value: null })
  const pendingCurveRef = useRef<{ has: boolean; id: string; points: ShapePt[]; color: string } | null>(null)

  /** 把当前挂起的预览更新立刻落地（松手 / 切工具 / 卸载前调用） */
  const flushDrawFrame = useCallback((): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (pendingDraftRef.current.has) {
      setDraftShape(pendingDraftRef.current.value)
      pendingDraftRef.current = { has: false, value: null }
    }
    const pc = pendingCurveRef.current
    if (pc !== null && pc.has) {
      applyCurvePoints(pc.id, pc.points, pc.color)
      pendingCurveRef.current = null
    }
  }, [applyCurvePoints])

  /** 安排一次合帧落地（同一帧内多次调用只会真正落地一次） */
  const scheduleFrame = useCallback((): void => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      if (pendingDraftRef.current.has) {
        setDraftShape(pendingDraftRef.current.value)
        pendingDraftRef.current = { has: false, value: null }
      }
      const pc = pendingCurveRef.current
      if (pc !== null && pc.has) {
        applyCurvePoints(pc.id, pc.points, pc.color)
        pendingCurveRef.current = null
      }
    })
  }, [applyCurvePoints])

  const scheduleDraft = useCallback((value: WhiteboardShape | null): void => {
    pendingDraftRef.current = { has: true, value }
    scheduleFrame()
  }, [scheduleFrame])

  const scheduleCurvePoints = useCallback((id: string, points: ShapePt[], color: string): void => {
    pendingCurveRef.current = { has: true, id, points, color }
    scheduleFrame()
  }, [scheduleFrame])
  const [title, setTitle] = useState(board.title)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 1 })
  const [viewReady, setViewReady] = useState(false)
  const [band, setBand] = useState<Rect | null>(null)
  const [draft, setDraft] = useState<{ from: string; side: Side; x: number; y: number } | null>(null)
  const [menu, setMenu] = useState<
    { x: number; y: number; kind: 'edge'; edgeId: string }
    | { x: number; y: number; kind: 'card'; nodeId: string }
    | { x: number; y: number; kind: 'shape'; shapeId: string }
    | { x: number; y: number; kind: 'blank' }
    | null
  >(null)
  const [labelEdit, setLabelEdit] = useState<{ edgeId: string; value: string } | null>(null)
  const [dirty, setDirty] = useState(false)
  const [viewer, setViewer] = useState<{ src: string; zoom: number } | null>(null)
  const [notePicker, setNotePicker] = useState<{ forNode: string } | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const mtimeRef = useRef(note.fileMtimeMs)
  const dirtyRef = useRef(false)
  const movedRef = useRef(false)
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const shapesRef = useRef(shapes)
  const viewRef = useRef(view)
  const spaceRef = useRef(false)
  const dragRef = useRef<{ ids: string[]; sx: number; sy: number; origin: Record<string, { x: number; y: number }> } | null>(null)
  /**
   * 图形拖动（与卡片拖动并列，两者不同时进行）。
   * origin 存**拖动开始时那些图形的快照** —— 每帧都以快照为基准算位移，
   * 否则累积误差会让图形越拖越飘。
   */
  const shapeDragRef = useRef<{ ids: string[]; sx: number; sy: number; origin: Record<string, WhiteboardShape> } | null>(null)
  const resizeRef = useRef<{ id: string; handle: Handle; sx: number; sy: number; start: Rect; keepRatio: boolean } | null>(null)
  const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const bandRef = useRef<{ sx: number; sy: number } | null>(null)
  const selectedRef = useRef<string[]>([])
  /** 选中的图形 id（与卡片的 selectedRef 并列；复制/删除都要一起看） */
  const selectedShapesRef = useRef<string[]>([])
  /** 鼠标最后一次在画布上的世界坐标，用于"粘贴到鼠标处" */
  const pointerRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  useEffect(() => { nodesRef.current = nodes }, [nodes])
  useEffect(() => { edgesRef.current = edges }, [edges])
  useEffect(() => { shapesRef.current = shapes }, [shapes])
  useEffect(() => { editingCurveRef.current = editingCurve }, [editingCurve])
  useEffect(() => { drawModeRef.current = drawMode }, [drawMode])
  // 注意：commitCurveRef 的赋值必须放在 commitCurve 定义**之后**（见下方），
  // 否则依赖数组里引用未初始化的 const 会踩 TDZ（踩过）。
  useEffect(() => { viewRef.current = view }, [view])
  useEffect(() => { spaceRef.current = spaceHeld }, [spaceHeld])
  useEffect(() => { selectedRef.current = selectedIds }, [selectedIds])
  useEffect(() => { selectedShapesRef.current = selectedShapeIds }, [selectedShapeIds])

  /**
   * 跟随外部刷新同步「保存基准」与标题。
   *
   * 不加这段会踩到一个必然发生的坑：新建白板时会**自动打开**它（那时标题还是「未命名」、
   * mtime 也是创建时的值），紧接着改名会重写文件、mtime 变了，而 `useRef(...)` 只在首次
   * 挂载取一次值 —— 于是第一次点保存必被判定为「保存冲突」，标题也会退回「未命名」。
   * （这条是交互冒烟测试抓到的：发出去的基准比磁盘旧 623ms。）
   *
   * 有未保存改动时不动基准，避免把别人真实的改动悄悄覆盖掉（保持冲突检测有效）。
   */
  const syncedRef = useRef({ id: note.id, mtime: note.fileMtimeMs })
  useEffect(() => {
    if (dirtyRef.current) return
    if (syncedRef.current.id === note.id && syncedRef.current.mtime === note.fileMtimeMs) return
    syncedRef.current = { id: note.id, mtime: note.fileMtimeMs }
    mtimeRef.current = note.fileMtimeMs
    setTitle(note.title)
  }, [note.id, note.title, note.fileMtimeMs])

  const save = useCallback(async (silent = false): Promise<void> => {
    if (!dirtyRef.current) return
    try {
      const result = await window.api.boardSave(
        note.id,
        { ...board, title, nodes: nodesRef.current, edges: edgesRef.current, shapes: shapesRef.current },
        mtimeRef.current
      )
      if (!result.ok) { toast('保存冲突：文件已被外部修改，请重新打开白板', 'error'); return }
      if (typeof result.fileMtimeMs === 'number') mtimeRef.current = result.fileMtimeMs
      setDirty(false)
      dirtyRef.current = false
      if (!silent) toast('白板已保存', 'success')
      onSaved()
    } catch (e) {
      toast('保存失败：' + (e as Error).message, 'error')
    }
  }, [board, note.id, title, onSaved])

  useEffect(() => {
    return () => {
      if (dirtyRef.current) {
        void window.api.boardSave(note.id, { ...board, title, nodes: nodesRef.current, edges: edgesRef.current, shapes: shapesRef.current }, mtimeRef.current).catch(() => undefined)
      }
    }
  }, [board, note.id, title])

  useEffect(() => {
    const timer = setInterval(() => { if (dirtyRef.current) void save(true) }, 8000)
    return () => clearInterval(timer)
  }, [save])

  useEffect(() => { void loadNotes().then(setNotes).catch(() => undefined) }, [])

  // ---------------- 视口 ----------------
  /** 把视口对准某点：有卡片就对准内容中心，空板对准世界中心 */
  const centerOn = useCallback((target?: { x: number; y: number }, z = 1): void => {
    const el = canvasRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const content = boundsOf(nodesRef.current.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })))
    const c = target ?? (content
      ? { x: content.x + content.w / 2, y: content.y + content.h / 2 }
      : { x: 0, y: 0 })
    setView({ x: rect.width / 2 - c.x * z, y: rect.height / 2 - c.y * z, z })
    setViewReady(true)
  }, [])

  useEffect(() => {
    // 老白板的卡片都堆在左上角，直接对世界中心会看不到东西：有卡片对准卡片，空板才对准世界中心
    if (!viewReady) centerOn()
  }, [viewReady, centerOn])

  // 滚轮 = 以鼠标为中心缩放画面（React 的 onWheel 是被动监听，改不了默认行为，这里手动挂）
  // 平移不占用滚轮：用「按住滚轮拖动」或「空格 + 拖动」
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const v = viewRef.current
      const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.z * Math.exp(-e.deltaY * 0.0015)))
      if (nz === v.z) return
      const wx = (e.clientX - r.left - v.x) / v.z
      const wy = (e.clientY - r.top - v.y) / v.z
      setView({ x: e.clientX - r.left - wx * nz, y: e.clientY - r.top - wy * nz, z: nz })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // 空格 = 临时平移手势（按住空白处拖动画面）
  useEffect(() => {
    const isField = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null
      return !!el && /^(INPUT|TEXTAREA)$/.test(el.tagName)
    }
    const down = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && !isField(e.target)) { e.preventDefault(); setSpaceHeld(true) }
      if (e.key === 'Escape') {
        setEditingId(null)
        setSelectedIds([])
        setSelectedShapeIds([])
        setSelectedEdge(null)
        setLabelEdit(null)
        // 绘制模式下 Esc 的语义（见《设计规范》§六）：
        //   正在画 / 正在编辑曲线 → 收尾（锁定曲线）；否则 → 退出绘制模式
        if (drawModeRef.current) {
          if (drawSessionRef.current.mode !== 'idle' || editingCurveRef.current !== null) {
            commitCurveRef.current()
            setDraftShape(null)
            drawSessionRef.current = IDLE
          } else {
            setDrawMode(false)
            setDrawTool('select')
          }
        }
      }
    }
    const up = (e: KeyboardEvent): void => { if (e.code === 'Space') setSpaceHeld(false) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])

  /** 屏幕坐标 -> 世界坐标（与容器 transform 严格互逆） */
  // 说明：容器把局部坐标 (wx + ORIGIN) 映射为 screen = (wx + ORIGIN) * z + tx，
  // 而 tx = view.x - ORIGIN * z，代入即 screen = wx * z + view.x，与 toWorld 互逆。

  const toWorld = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const el = canvasRef.current
    const v = viewRef.current
    if (!el) return { x: e.clientX, y: e.clientY }
    const r = el.getBoundingClientRect()
    return { x: (e.clientX - r.left - v.x) / v.z, y: (e.clientY - r.top - v.y) / v.z }
  }

  const updateNode = useCallback((id: string, patch: Partial<WhiteboardNode>) => {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)))
    setDirty(true)
  }, [])

  const addNode = useCallback((node: WhiteboardNode) => {
    setNodes((prev) => [...prev, node])
    setSelectedIds([node.id])
    setSelectedEdge(null)
    setDirty(true)
  }, [])

  const newId = (): string => 'n' + Math.random().toString(36).slice(2, 9)

  /** 新卡片放在当前视野中间，免得在很大的画布上凭空出现在看不见的地方 */
  const atViewCenter = (w: number, h: number): { x: number; y: number } => {
    const el = canvasRef.current
    const v = viewRef.current
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    const cx = (r.width / 2 - v.x) / v.z
    const cy = (r.height / 2 - v.y) / v.z
    return {
      x: clampX(Math.round(cx - w / 2 + (Math.random() * 60 - 30)), w),
      y: clampY(Math.round(cy - h / 2 + (Math.random() * 60 - 30)), h)
    }
  }

  const loadNotes = async (): Promise<Note[]> => {
    const tree = await window.api.noteTree()
    const flat: Note[] = []
    const walk = (list: typeof tree): void => {
      for (const n of list) {
        if (n.type === 'note' && n.id) flat.push({ id: n.id, title: n.name.replace(/\.canvas\.json$|\.md$/, ''), kind: n.kind ?? 'md' } as Note)
        if (n.children) walk(n.children)
      }
    }
    walk(tree)
    return flat
  }

  const rectOf = (n: WhiteboardNode): Rect => ({ x: n.x, y: n.y, w: n.w, h: n.h })

  const addText = (): void => {
    const pos = atViewCenter(210, 120)
    addNode({ id: newId(), type: 'text', ...pos, w: 210, h: 120, text: '双击编辑文字', fontSize: 16, color: cardColorHex('default') })
  }

  const addImage = async (): Promise<void> => {
    try {
      const picked = await window.api.attachmentImport()
      if (!picked) return
      const url = attachmentUrl(picked.rel)
      const size = await imageSize(url)
      const fitted = fitSize(size.w, size.h)
      addNode({ id: newId(), type: 'image', ...atViewCenter(fitted.w, fitted.h), w: fitted.w, h: fitted.h, src: picked.rel })
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const addLink = async (): Promise<void> => {
    // DSH 版：window.prompt 在 Electron 渲染进程里不可用，改用应用内对话框
    const url = await askText('输入网页链接（http/https）', 'https://')
    if (!url) return
    if (!/^https?:\/\//i.test(url)) { toast('只支持 http/https 链接', 'error'); return }
    addNode({ id: newId(), type: 'link', ...atViewCenter(220, 70), w: 220, h: 70, url })
  }

  const addNoteCard = async (): Promise<void> => {
    const id = newId()
    addNode({ id, type: 'note', ...atViewCenter(220, 110), w: 220, h: 110 })
    setNotes(await loadNotes())
    setNotePicker({ forNode: id })
  }

  /** 复制选中的卡片与图形（以及卡片之间的连线） */
  const doCopy = useCallback((silent = false): boolean => {
    const clip = copySelection(
      nodesRef.current, edgesRef.current, selectedRef.current,
      shapesRef.current, selectedShapesRef.current
    )
    if (!clip) { if (!silent) toast('先选中卡片或图形再复制', 'error'); return false }
    boardClipboard = clip
    if (!silent) {
      const n = clip.nodes.length
      const s = clip.shapes?.length ?? 0
      const parts: string[] = []
      if (n > 0) parts.push(n + ' 张卡片')
      if (s > 0) parts.push(s + ' 个图形')
      toast('已复制 ' + parts.join(' + '), 'success')
    }
    return true
  }, [])

  /** 粘贴：保持相对位置，落在鼠标处（没有鼠标位置就偏移一点） */
  const doPaste = useCallback((at?: { x: number; y: number } | null): void => {
    if (!boardClipboard) { toast('剪贴板里还没有内容', 'error'); return }
    const spot = at ?? pointerRef.current
    const { nodes: fresh, edges: freshEdges, shapes: freshShapes } = planPaste(boardClipboard, spot, newId)
    if (!fresh.length && !freshShapes.length) return
    setNodes((prev) => [...prev, ...fresh])
    setEdges((prev) => [...prev, ...freshEdges])
    setShapes((prev) => [...prev, ...freshShapes])
    setSelectedIds(fresh.map((n) => n.id))
    setSelectedShapeIds(freshShapes.map((s) => s.id))
    setSelectedEdge(null)
    setDirty(true)
    const parts: string[] = []
    if (fresh.length > 0) parts.push(fresh.length + ' 张卡片')
    if (freshShapes.length > 0) parts.push(freshShapes.length + ' 个图形')
    toast('已粘贴 ' + parts.join(' + '), 'success')
  }, [])

  // 复制 / 粘贴快捷键（在输入框里打字时不拦截）
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (el && (/^(INPUT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable)) return
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 'c') { if (doCopy(true)) e.preventDefault() }
      else if (k === 'v') { if (boardClipboard) { e.preventDefault(); doPaste() } }
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [doCopy, doPaste])

  const removeNode = (id: string): void => {
    setNodes((prev) => prev.filter((n) => n.id !== id))
    setEdges((prev) => prev.filter((x) => x.from !== id && x.to !== id))
    setSelectedIds((prev) => prev.filter((x) => x !== id))
    setDirty(true)
  }

  /** 删除一批图形（图形的删除就是把自己从数组里拿掉，没有连带关系） */
  const removeShapes = useCallback((ids: string[]): void => {
    if (ids.length === 0) return
    const kill = new Set(ids)
    setShapes((prev) => prev.filter((s) => !kill.has(s.id)))
    setSelectedShapeIds((prev) => prev.filter((x) => !kill.has(x)))
    setDirty(true)
  }, [])

  /**
   * 统一清空选择。
   * 选择状态现在有三处（卡片 / 图形 / 连线），散着写必漏一处 —— 集中一个函数。
   */
  const clearSelection = useCallback((): void => {
    setSelectedIds([])
    setSelectedShapeIds([])
    setSelectedEdge(null)
  }, [])

  /** 图形上按下：选中它并开始拖动（与卡片同样的手感：已在选中的一起动） */
  const onShapeMouseDown = (e: React.MouseEvent, shape: WhiteboardShape): void => {
    e.stopPropagation()
    if (e.button !== 0) return
    let ids = selectedShapeIds
    if (e.shiftKey) {
      ids = selectedShapeIds.includes(shape.id)
        ? selectedShapeIds.filter((x) => x !== shape.id)
        : [...selectedShapeIds, shape.id]
    } else if (!selectedShapeIds.includes(shape.id)) {
      ids = [shape.id]
    }
    setSelectedShapeIds(ids)
    setSelectedIds([])
    setSelectedEdge(null)
    const p = toWorld(e)
    const origin: Record<string, WhiteboardShape> = {}
    for (const s of shapesRef.current) if (ids.includes(s.id)) origin[s.id] = s
    shapeDragRef.current = { ids, sx: p.x, sy: p.y, origin }
    movedRef.current = false
  }

  /** 图形右键菜单：只提供删除（颜色在绘制前选定，按需求不提供改色） */
  const onShapeContextMenu = (e: React.MouseEvent, shape: WhiteboardShape): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!selectedShapeIds.includes(shape.id)) {
      setSelectedShapeIds([shape.id])
      setSelectedIds([])
      setSelectedEdge(null)
    }
    setMenu({ x: e.clientX, y: e.clientY, kind: 'shape', shapeId: shape.id })
  }

  // Delete / Backspace 删除选中的卡片与图形（在输入框里打字时不拦截）
  useEffect(() => {    const down = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t !== null && /^(INPUT|TEXTAREA)$/.test(t.tagName)) return
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const shapeIds = selectedShapesRef.current
      const nodeIds = selectedRef.current
      if (shapeIds.length === 0 && nodeIds.length === 0) return
      e.preventDefault()
      if (shapeIds.length > 0) removeShapes(shapeIds)
      if (nodeIds.length > 0) {
        const kill = new Set(nodeIds)
        setNodes((prev) => prev.filter((n) => !kill.has(n.id)))
        setEdges((prev) => prev.filter((x) => !kill.has(x.from) && !kill.has(x.to)))
        setSelectedIds([])
      }
      setDirty(true)
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [removeShapes])

  const removeEdge = (id: string): void => {
    setEdges((prev) => prev.filter((e) => e.id !== id))
    if (selectedEdge === id) setSelectedEdge(null)
    setDirty(true)
  }

  // ---------------- 鼠标交互 ----------------

  /**
   * 曲线"锁定"：把编辑中的曲线定稿，控制点消失，之后不能再改。
   * 触发场景：点空白、切换工具、退出绘制模式、保存、离开白板（见《设计规范》§四）。
   *
   * ⚠️ 这个函数必须定义在**所有使用点之前**（Esc 的 effect、工具栏的 onClick、画布事件都用到它），
   * 否则会踩 TDZ：`Cannot access 'commitCurve' before initialization`（踩过）。
   */
  const commitCurve = useCallback((): void => {
    const cur = editingCurveRef.current
    if (cur === null) return
    /*
     * 只需**清掉编辑态**：点已经在 `applyCurvePoints` 里同步写进 `shapes` 了。
     * 「只有 1 个点就丢弃」的保护仍然有意义 —— 那种情况下 `shapes` 里本就没有这条曲线
     * （`applyCurvePoints` 只在第 2 个点落下时才第一次被调用）。
     */
    setEditingCurve(null)
  }, [])

  // commitCurve 定义好了，这里才能安全地把它挂到 ref 上（Esc 的处理函数要用）
  useEffect(() => { commitCurveRef.current = commitCurve }, [commitCurve])

  const onCanvasMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    const t = e.target as HTMLElement
    if (t !== e.currentTarget && !t.classList.contains('board-inner')) return
    setMenu(null)

    // 中键 / 空格 = 平移（绘制模式下也保留，否则没法边画边挪视野）
    if (e.button === 1 || spaceRef.current) {
      e.preventDefault()
      panRef.current = { sx: e.clientX, sy: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y }
      return
    }
    if (e.button !== 0) return
    movedRef.current = false

    // ---- 绘制模式：交给状态机决定 ----
    if (drawTool !== 'select') {
      const p = toWorld(e)
      // 曲线是"点击"式：但**已经成形**（≥2 点）时，按下要能拖控制点 / 点中部插点。
      // 落点（还没开始 / 只有 1 个点）则完全交给 onClick，mousedown 不做事。
      if (drawTool === 'curve') {
        const cur = editingCurveRef.current
        if (cur !== null && cur.points.length >= 2) {
          const ctrl = hitControlPoint(cur.points, p, CTRL_HIT)
          if (ctrl !== null) {
            dragCtrlRef.current = ctrl
            drawSessionRef.current = { mode: 'curve-drag', ctrlIndex: ctrl }
            return
          }
          const seg = hitSegment(cur.points, p, CURVE_HIT)
          if (seg !== null) {
            // 点在线段中部 → 在**点击位置的投影**处插入控制点，并顺手进入拖动
            const pts = insertPointOnSegment(cur.points, seg.index, p)
            applyCurvePoints(cur.id, pts, cur.color)
            dragCtrlRef.current = seg.index + 1
            drawSessionRef.current = { mode: 'curve-drag', ctrlIndex: seg.index + 1 }
            return
          }
        }
        return
      }
      const out = onDrawDown({
        kind: drawTool, color: drawColor, p, shift: e.shiftKey,
        newId, editingCurve
      })
      if (out.session.mode !== 'idle') drawSessionRef.current = out.session
      if (out.draft !== undefined) setDraftShape(out.draft)
      // 非曲线工具若在画的时候还有曲线在编辑，先锁定它（避免两条曲线状态打架）
      if (editingCurve !== null) commitCurve()
      if (out.handled) return
    }

    // 左键拖空白 = 框选卡片（平移用中键拖动或按住空格拖动）
    const p = toWorld(e)
    bandRef.current = { sx: p.x, sy: p.y }
    setBand({ x: p.x, y: p.y, w: 0, h: 0 })
  }

  const onCanvasMouseMove = (e: React.MouseEvent<HTMLDivElement>): void => {
    pointerRef.current = toWorld(e)
    const pan = panRef.current
    if (pan) {
      if (Math.abs(e.clientX - pan.sx) > 2 || Math.abs(e.clientY - pan.sy) > 2) movedRef.current = true
      setView((v) => ({ ...v, x: pan.ox + (e.clientX - pan.sx), y: pan.oy + (e.clientY - pan.sy) }))
      return
    }
    const bandStart = bandRef.current
    if (bandStart) {
      const p = toWorld(e)
      // 必须记下"正在框选"：否则松手后浏览器补发的 click 会被当成"点空白"，
      // 立刻把刚框出来的选中清掉（框选就白做了）
      if (Math.abs(p.x - bandStart.sx) > 2 || Math.abs(p.y - bandStart.sy) > 2) movedRef.current = true
      setBand(rectFromPoints({ x: bandStart.sx, y: bandStart.sy }, p))
      return
    }

    // ---- 绘制模式：更新预览 ----
    if (drawTool !== 'select' && drawSessionRef.current.mode !== 'idle') {
      const p = toWorld(e)
      const out = onDrawMove({
        session: drawSessionRef.current, kind: drawTool, color: drawColor,
        p, shift: e.shiftKey, editingCurve: editingCurveRef.current
      })
      if (out.draft !== undefined) scheduleDraft(out.draft)
      if (out.curvePoints !== undefined) {
        // 点源用 ref（不是闭包里的 editingCurve）：拖动期间 state 还没刷新，
        // 用闭包值会拖回上一帧的位置。
        const cur = editingCurveRef.current
        if (cur !== null) scheduleCurvePoints(cur.id, out.curvePoints, cur.color)
      }
      // 记住自由绘制的原始点（松手时才抽稀生成）
      if (drawSessionRef.current.mode === 'free') {
        drawSessionRef.current = {
          ...drawSessionRef.current,
          freePts: [...(drawSessionRef.current.freePts ?? []), p]
        }
      }
      movedRef.current = true
      return
    }

    // 曲线编辑态下的悬停高亮（不按下也能看到"点这里能拖"）
    if (drawTool === 'curve' && editingCurve !== null) {
      setHoverCtrlIndex(ctrlIndexAt(editingCurve.points, toWorld(e)))
    }

    // 绘制模式下悬停图形做轻微高亮
    if (drawTool !== 'select') {
      const p = toWorld(e)
      const hit = shapesRef.current.find((s) => hitShape(s, p, SHAPE_HIT))
      setHoverShapeId(hit?.id ?? null)
    }

    const resize = resizeRef.current
    if (resize) {
      const v = viewRef.current
      const next = resizeRect(resize.start, resize.handle, (e.clientX - resize.sx) / v.z, (e.clientY - resize.sy) / v.z, resize.keepRatio)
      // 调整大小时不允许压到文字看不见：按内容算一个最小高度
      const target = nodesRef.current.find((n) => n.id === resize.id)
      let h = next.h
      if (target?.type === 'text') {
        const need = estimateTextHeight({
          text: target.text ?? '',
          w: next.w,
          fontSize: target.fontSize ?? 16
        })
        if (h < need) h = need
      }
      updateNode(resize.id, { x: clampX(next.x, next.w), y: clampY(next.y, h), w: next.w, h })
      return
    }
    // 图形拖动（与卡片拖动并列；两者不同时进行）
    const sdrag = shapeDragRef.current
    if (sdrag) {
      const p = toWorld(e)
      const dx = p.x - sdrag.sx
      const dy = p.y - sdrag.sy
      movedRef.current = Math.abs(dx) > 1 || Math.abs(dy) > 1
      setShapes((prev) => prev.map((s) => {
        const o = sdrag.origin[s.id]
        if (o === undefined) return s
        return moveShape(o, dx, dy)
      }))
      return
    }

    const drag = dragRef.current
    if (drag) {
      const p = toWorld(e)
      const raw = { x: p.x - drag.sx, y: p.y - drag.sy }
      movedRef.current = Math.abs(raw.x) > 1 || Math.abs(raw.y) > 1
      // 整组算一个共同位移：相对位置严格不变（各自夹紧会错位）
      const group = drag.ids
        .map((id) => {
          const o = drag.origin[id]
          const n = nodesRef.current.find((x) => x.id === id)
          return o && n ? { x: o.x, y: o.y, w: n.w, h: n.h } : null
        })
        .filter(Boolean) as { x: number; y: number; w: number; h: number }[]
      const d = clampGroupDelta(group, raw.x, raw.y)
      setNodes((prev) => prev.map((n) => {
        const o = drag.origin[n.id]
        if (!o) return n
        return { ...n, x: Math.round(o.x + d.dx), y: Math.round(o.y + d.dy) }
      }))
      setDirty(true)
      return
    }
    if (draft) {
      const p = toWorld(e)
      setDraft({ ...draft, x: p.x, y: p.y })
    }
  }

  const finishLink = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!draft) return
    const start = draft
    setDraft(null)
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
    const targetId = (el?.closest('.board-node') as HTMLElement | null)?.dataset.nodeId
    if (!targetId || targetId === start.from) return
    const target = nodesRef.current.find((n) => n.id === targetId)
    if (!target) return
    const edge: WhiteboardEdge = {
      id: newId(), from: start.from, to: targetId, fromSide: start.side,
      toSide: nearestSide(rectOf(target), toWorld(e))
    }
    setEdges((prev) => [...prev, edge])
    setSelectedEdge(edge.id)
    setDirty(true)
  }

  const onCanvasMouseUp = (e: React.MouseEvent<HTMLDivElement>): void => {
    finishLink(e)

    // ---- 绘制模式：落定图形 ----
    if (drawTool !== 'select') {
      const session = drawSessionRef.current
      if (session.mode === 'box' || session.mode === 'line' || session.mode === 'free') {
        // 松手前先把挂起的预览落地，否则最后一帧还在 rAF 队列里（看起来"比手慢半拍"）
        flushDrawFrame()
        const out = onDrawUp({
          session, kind: drawTool, color: drawColor, p: toWorld(e), shift: e.shiftKey, newId
        })
        if (out.commit !== null) {
          setShapes((prev) => [...prev, out.commit as WhiteboardShape])
          setDirty(true)
          /*
           * 「画完自动切回选择状态」——**自由绘制除外**。
           *
           * 自由绘制通常要连着画好几笔；每笔都切回选择、还给个选中高亮，会很难用。
           * 所以 free 下保持工具不变、也不设选中，用户自己点「↖ 选择」或按 Esc 退出。
           * （见《白板绘制功能-设计规范》§4.1 的例外说明。）
           */
          if (drawTool !== 'free') {
            setDrawTool('select')
            setSelectedShapeIds([out.commit.id])
            setSelectedIds([])
            setSelectedEdge(null)
            setHoverShapeId(null)
          }
        }
        setDraftShape(null)
        pendingDraftRef.current = { has: false, value: null }
        drawSessionRef.current = IDLE
        endInteractions()
        return
      }
      // 曲线拖控制点松手：拖动过程中已经写进 shapes 了（applyCurvePoints），这里只需收尾
      if (session.mode === 'curve-drag') {
        flushDrawFrame()
        drawSessionRef.current = IDLE
        dragCtrlRef.current = null
        endInteractions()
        return
      }
    }

    if (bandRef.current && band) {
      /*
       * 框选：卡片与图形一起框（各自按包围盒判断）。
       *
       * 坐标说明（这里曾经算错过，把 band 又减了一次 ORIGIN，导致框选永远为空）：
       *   · `toWorld()` 返回的是**世界坐标**（= clientX - rect.left - view.x；
       *     因为 inner 的 transform 已经把 ORIGIN 的平移算进 view 里了）；
       *   · `rectOf(n)` / `shapeBox(s)` 也是世界坐标 → **两边基准一致，直接用**。
       */
      const hits = nodesRef.current.filter((n) => rectsIntersect(rectOf(n), band)).map((n) => n.id)
      const shapeHits = shapesRef.current
        .filter((s) => boxesIntersect(shapeBox(s), band))
        .map((s) => s.id)
      setSelectedIds(hits)
      setSelectedShapeIds(shapeHits)
      setSelectedEdge(null)
    }
    endInteractions()
  }

  const endInteractions = (): void => {
    bandRef.current = null
    setBand(null)
    dragRef.current = null
    shapeDragRef.current = null
    resizeRef.current = null
    panRef.current = null
    setPanning(false)
  }

  /** 开始拖动：已在选中的卡片一起移动，未选中的先选中它 */
  const startNodeDrag = (e: React.MouseEvent, node: WhiteboardNode): void => {
    let ids = selectedIds
    if (e.shiftKey) {
      ids = selectedIds.includes(node.id) ? selectedIds.filter((x) => x !== node.id) : [...selectedIds, node.id]
    } else if (!selectedIds.includes(node.id)) {
      ids = [node.id]
    }
    setSelectedIds(ids)
    setSelectedEdge(null)
    const p = toWorld(e)
    const origin: Record<string, { x: number; y: number }> = {}
    for (const n of nodesRef.current) if (ids.includes(n.id)) origin[n.id] = { x: n.x, y: n.y }
    dragRef.current = { ids, sx: p.x, sy: p.y, origin }
    movedRef.current = false
  }

  // ---------------- 连线与菜单 ----------------
  /**
   * 连线的两端接在哪条边 —— **只读文件里的值，绝不重算**。
   *
   * 为什么以前会"自己变"：这里原来写的是
   *     edge.fromSide ?? nearestSide(rectOf(b), anchorOf(rectOf(a), 'right'))
   * 也就是"文件里没存就每次渲染按当前坐标猜一条边"。
   * AI 画的线不带 fromSide/toSide，于是**每移动一次卡片，线就重新挑一次边**，
   * 看起来就是"连线会自己跑"。而且那两行的两个矩形还传反了（算的是对方的边）。
   *
   * 现在的规则（用户要求）：**连线一旦画下就固定，除非删掉重画**。
   * 所以这里不再兜底 —— 文件里是什么就是什么。
   *
   * 兜底 `'right'` 只对"老白板里缺 side 的线"生效（读取时已由迁移逻辑补齐，见 notes.ts）；
   * 万一仍有漏网的，也只会稳定地画成 right，而不会随卡片移动而变。
   */
  const resolveSides = useCallback((edge: WhiteboardEdge): { from: Side; to: Side } => {
    return { from: edge.fromSide ?? 'right', to: edge.toSide ?? 'left' }
  }, [])

  const edgeShapes = useMemo(() => edges.map((edge) => {
    const a = nodes.find((n) => n.id === edge.from)
    const b = nodes.find((n) => n.id === edge.to)
    if (!a || !b) return null
    const { from, to } = resolveSides(edge)
    const pa = anchorOf(rectOf(a), from)
    const pb = anchorOf(rectOf(b), to)
    return { edge, d: edgePath(pa, from, pb, to), mid: edgeMidpoint(pa, from, pb, to) }
  }).filter(Boolean) as { edge: WhiteboardEdge; d: string; mid: { x: number; y: number } }[], [edges, nodes, resolveSides])

  const linkPreview = useMemo(() => {
    if (!draft) return null
    const a = nodes.find((n) => n.id === draft.from)
    if (!a) return null
    return edgePath(anchorOf(rectOf(a), draft.side), draft.side, { x: draft.x, y: draft.y }, 'left')
  }, [draft, nodes])

  function menuItems(): MenuItem[] {
    const m = menu
    if (!m) return []

    if (m.kind === 'blank') {
      const clipDetail = boardClipboard
        ? '（' + [
            (boardClipboard.nodes.length > 0 ? boardClipboard.nodes.length + ' 张卡片' : ''),
            ((boardClipboard.shapes?.length ?? 0) > 0 ? (boardClipboard.shapes?.length ?? 0) + ' 个图形' : '')
          ].filter((x) => x !== '').join(' + ') + '）'
        : ''
      return [
        { label: boardClipboard ? '粘贴' + clipDetail : '粘贴（剪贴板为空）', onClick: () => doPaste(toWorld({ clientX: m.x, clientY: m.y })) },
        { separator: true },
        { label: '添加文本卡片', onClick: addText },
        { label: '添加图片卡片', onClick: () => void addImage() },
        { label: '添加笔记引用卡片', onClick: () => void addNoteCard() },
        { label: '添加外部链接卡片', onClick: addLink },
        { separator: true },
        { label: '回到内容中心', onClick: () => centerOn() }
      ]
    }

    // 图形右键：只提供删除（颜色在绘制前选定，按需求不提供改色）
    if (m.kind === 'shape') {
      const n = selectedShapeIds.length > 1 ? selectedShapeIds.length : 1
      return [
        { label: n > 1 ? '删除这 ' + n + ' 个图形' : '删除图形', danger: true, onClick: () => removeShapes(selectedShapeIds.length > 0 ? selectedShapeIds : [m.shapeId]) }
      ]
    }

    if (m.kind === 'edge') {
      const edge = edges.find((e) => e.id === m.edgeId)
      return [
        {
          label: edge?.label ? '编辑线上文字' : '在中间插入文字',
          onClick: () => {
            setLabelEdit({ edgeId: m.edgeId, value: edge?.label ?? '' })
            if (edge && !edge.label) {
              setEdges((prev) => prev.map((x) => (x.id === m.edgeId ? { ...x, label: ' ' } : x)))
              setDirty(true)
            }
          }
        },
        { label: '删除连线', danger: true, onClick: () => removeEdge(m.edgeId) }
      ]
    }

    const node = nodes.find((n) => n.id === m.nodeId)
    if (!node) return []
    const items: MenuItem[] = []

    if (node.type === 'text') {
      const next = FONT_SIZES[(FONT_SIZES.indexOf(node.fontSize ?? 16) + 1) % FONT_SIZES.length]
      items.push({ label: '编辑文字', onClick: () => setEditingId(node.id) })
      items.push({ label: '字号（当前 ' + (node.fontSize ?? 16) + '）→ ' + next, onClick: () => updateNode(node.id, { fontSize: next }) })
      items.push({ label: node.bold ? '取消加粗' : '加粗', onClick: () => updateNode(node.id, { bold: !node.bold }) })
    }
    if (node.type === 'image' && node.src) {
      items.push({ label: '查看大图', onClick: () => setViewer({ src: attachmentUrl(node.src as string), zoom: 1 }) })
    }
    if (node.type === 'note') {
      if (node.noteId) items.push({ label: '打开引用的笔记', onClick: () => onOpenNote(node.noteId as string) })
      items.push({ label: node.noteId ? '更换引用的笔记' : '选择引用的笔记', onClick: () => void loadNotes().then((list) => { setNotes(list); setNotePicker({ forNode: node.id }) }) })
    }
    if (node.type === 'link') {
      if (node.url) items.push({ label: '打开链接', onClick: () => { void window.api.openExternal(node.url as string).catch((err: Error) => toast(err.message, 'error')) } })
      items.push({ label: '修改链接', onClick: () => { void (async () => {
        const url = await askText('修改链接（http/https）', node.url ?? 'https://')
        if (!url) return
        if (!/^https?:\/\//i.test(url)) { toast('只支持 http/https 链接', 'error'); return }
        updateNode(node.id, { url })
      })() } })
    }

    items.push({ separator: true })
    items.push({ label: selectedRef.current.length > 1 ? '复制这 ' + selectedRef.current.length + ' 张卡片' : '复制卡片', onClick: () => doCopy() })
    items.push({ separator: true })
    // 卡片颜色收进一个「卡片颜色」父项 + 子菜单（原来 4 个颜色平铺在菜单里，太占地方）
    items.push({
      label: '卡片颜色',
      children: CARD_PALETTE.map((entry) => ({
        label: entry.label,
        swatch: entry.key,
        checked: resolveCardColorKey(node.color) === entry.key,
        onClick: () => updateNode(node.id, { color: entry.light })
      }))
    })
    items.push({ separator: true })
    items.push({ label: '删除卡片', danger: true, onClick: () => removeNode(node.id) })
    return items
  }

  function commitLabel(): void {
    const edit = labelEdit
    if (!edit) return
    setLabelEdit(null)
    const text = edit.value.trim()
    setEdges((prev) => prev.map((e) => (e.id === edit.edgeId ? { ...e, label: text || undefined } : e)))
    setDirty(true)
  }

  // 内层用的是"含原点偏移"的局部坐标，而 view 是"世界坐标"下的平移量，
  // 所以外层 transform 要减掉 ORIGIN * z，否则卡片会整体偏出屏幕。
  const offset = containerOffset(view)
  const tx = offset.x
  const ty = offset.y

  const single = selectedIds.length === 1 ? selectedIds[0] : null

  return (
    <>
      <div className="note-toolbar">
        <input className="input" style={{ maxWidth: 170 }} value={title} onChange={(e) => { setTitle(e.target.value); setDirty(true) }} placeholder="白板名称" />
        <div className="spacer" />
        {drawMode ? (
          /* ── 绘制模式的工具栏：工具 + 颜色 + 完成 ──
             进入绘制模式后整体替换，避免按钮挤成一团。 */
          <>
            {DRAW_TOOLS.map((t, i) => (
              <button
                key={t.kind}
                className={'btn small draw-tool' + (drawTool === t.kind ? ' primary' : '')}
                title={t.title}
                onClick={() => {
                  // 切工具时把正在编辑的曲线锁定（否则它会一直"挂"在画布上）
                  if (t.kind !== 'curve') commitCurve()
                  setDrawTool(t.kind)
                  setDraftShape(null)
                  drawSessionRef.current = IDLE
                }}
              >
                {t.icon}
              </button>
            ))}
            <span className="toolbar-divider" />
            {CARD_PALETTE.map((c) => (
              <button
                key={c.key}
                className={'btn small draw-swatch' + (drawColor === c.key ? ' primary' : '')}
                title={'颜色：' + c.label}
                data-card-color={c.key}
                onClick={() => setDrawColor(c.key)}
              />
            ))}
            <span className="toolbar-divider" />
            <button
              className="btn small"
              onClick={() => { commitCurve(); setDrawMode(false); setDrawTool('select'); setDraftShape(null) }}
            >
              完成
            </button>
          </>
        ) : (
          <>
            <button className="btn small" onClick={addText}>+ 文本卡片</button>
            <button className="btn small" onClick={() => void addImage()}>+ 图片</button>
            <button className="btn small" onClick={() => void addNoteCard()}>+ 笔记引用</button>
            <button className="btn small" onClick={addLink}>+ 外部链接</button>
            <button
              className="btn small"
              title="进入绘制模式：几何图形 / 直线 / 箭头 / 曲线 / 自由绘制"
              onClick={() => { setDrawMode(true); setDrawTool('rect') }}
            >
              ✏️ 绘制
            </button>
            <button className="btn small" title="把视野对准卡片内容" onClick={() => centerOn()}>居中</button>
            <button className="btn small" title="点击恢复 100%" onClick={() => setView((v) => ({ ...v, z: 1 }))}>{Math.round(view.z * 100)}%</button>
            <button className="btn small primary" disabled={!dirty} onClick={() => void save()}>保存</button>
          </>
        )}
      </div>

      <div className="board-wrap">
        <div
          className={'board-canvas' + (spaceHeld || panning ? ' panning' : '') +
            (drawMode ? ' drawing' : '') + (editingCurve !== null ? ' curve-editing' : '')}
          ref={canvasRef}
          style={{
            // 点阵画在视口上：随平移移动、随缩放变密，画布再大也不会画不出来
            backgroundImage: 'radial-gradient(var(--board-dot) ' + (1.2 * view.z).toFixed(2) + 'px, transparent ' + (1.2 * view.z).toFixed(2) + 'px)',
            backgroundSize: (20 * view.z) + 'px ' + (20 * view.z) + 'px',
            backgroundPosition: tx + 'px ' + ty + 'px'
          }}
          onMouseDown={onCanvasMouseDown}
          onMouseMove={onCanvasMouseMove}
          onMouseUp={onCanvasMouseUp}
          onMouseLeave={endInteractions}
          onContextMenu={(e) => {
            const t = e.target as HTMLElement
            if (t !== e.currentTarget && !t.classList.contains('board-inner')) return
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, kind: 'blank' })
          }}
        >
          <div
            className="board-inner"
            onClick={(e) => {
              if (e.target !== e.currentTarget) return
              // 刚才是拖动画面 / 框选，不算"点击空白"
              if (movedRef.current) { movedRef.current = false; return }

              // ---- 绘制模式：曲线的"点击落点"在这里处理 ----
              // 曲线不是拖拽式，而是：点一下落起点 → 再点成线 → 点线段中部插控制点 → 点空白锁定
              if (drawModeRef.current && drawTool === 'curve') {
                const p = toWorld(e)
                const cur = editingCurveRef.current

                // 情况 ①：还没开始 → 落第一个点
                if (cur === null) {
                  setEditingCurve({ id: newId(), points: [{ x: p.x, y: p.y }], color: drawColor })
                  return
                }
                // 情况 ②：只落了起点 → 这次点击补上第二个点，曲线成形（此时看起来是直线）
                if (cur.points.length === 1) {
                  // 用唯一写入口：同时更新控制点与曲线本体（1 个点时画不出东西，2 个点起才看得到线）
                  applyCurvePoints(cur.id, [...cur.points, { x: p.x, y: p.y }], cur.color)
                  return
                }
                // 情况 ③：已成形。点到控制点或线段中部 = 拖/插（在 mousedown 里处理）；
                //         点到别处 = 锁定这条曲线
                const hitCtrl = hitControlPoint(cur.points, p, CTRL_HIT)
                const hitSeg = hitSegment(cur.points, p, CURVE_HIT)
                if (hitCtrl === null && hitSeg === null) commitCurve()
                return
              }
              // 其它绘制工具靠拖拽，点空白不做事
              if (drawModeRef.current) return

              // 点空白处退出编辑：正在编辑的文字框失焦，同时收起选中与菜单
              const active = document.activeElement as HTMLElement | null
              if (active && active !== document.body) active.blur()
              setSelectedIds([])
              setSelectedShapeIds([])
              setSelectedEdge(null)
              setLabelEdit(null)
              setMenu(null)
            }}
            style={{
              width: WORLD_W,
              height: WORLD_H,
              transform: 'translate(' + tx + 'px, ' + ty + 'px) scale(' + view.z + ')',
              transformOrigin: '0 0'
            }}
          >
            <svg className="board-svg" width={WORLD_W} height={WORLD_H}>
              {/* 世界原点在内层中心，连线用世界坐标绘制 */}
              <g transform={'translate(' + toLocalX(0) + ' ' + toLocalY(0) + ')'}>
              <defs>
                <marker id="arrow" markerWidth="11" markerHeight="11" refX="8.6" refY="5.5" orient="auto" markerUnits="userSpaceOnUse">
                  <path d="M1.5,1.5 L8.6,5.5 L1.5,9.5" fill="none" stroke="#8b93a1" strokeWidth="1.7"
                    strokeLinecap="round" strokeLinejoin="round" />
                </marker>
                <marker id="arrow-sel" markerWidth="11" markerHeight="11" refX="8.6" refY="5.5" orient="auto" markerUnits="userSpaceOnUse">
                  <path d="M1.5,1.5 L8.6,5.5 L1.5,9.5" fill="none" stroke="var(--accent)" strokeWidth="1.7"
                    strokeLinecap="round" strokeLinejoin="round" />
                </marker>
                {/* 绘制的箭头要跟着线色走，所以每个色板键各一个 marker（见 ShapeLayer 的说明） */}
                {SHAPE_MARKER_KEYS.map((key) => (
                  <marker
                    key={key}
                    id={'arrow-' + key}
                    markerWidth="11" markerHeight="11" refX="8.6" refY="5.5"
                    orient="auto" markerUnits="userSpaceOnUse"
                  >
                    <path d="M1.5,1.5 L8.6,5.5 L1.5,9.5" fill="none" stroke={'var(--draw-' + key + '-line)'} strokeWidth="1.7"
                      strokeLinecap="round" strokeLinejoin="round" />
                  </marker>
                ))}
              </defs>

              {edgeShapes.map(({ edge, d }) => {
                const isSel = selectedEdge === edge.id
                return (
                  <g key={edge.id}>
                    <path
                      d={d} stroke="transparent" strokeWidth={EDGE_HIT} fill="none"
                      style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                      onMouseDown={(e) => { e.stopPropagation(); setSelectedEdge(edge.id); setSelectedIds([]) }}
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSelectedEdge(edge.id); setMenu({ x: e.clientX, y: e.clientY, kind: 'edge', edgeId: edge.id }) }}
                    />
                    <path
                      d={d} fill="none"
                      stroke={isSel ? 'var(--accent)' : '#8b93a1'}
                      strokeWidth={isSel ? EDGE_STROKE_SELECTED : EDGE_STROKE}
                      strokeLinecap="round"
                      markerEnd={isSel ? 'url(#arrow-sel)' : 'url(#arrow)'}
                      style={{ pointerEvents: 'none' }}
                    />
                  </g>
                )
              })}

              {linkPreview && <path d={linkPreview} fill="none" stroke="var(--accent)" strokeWidth={EDGE_STROKE} strokeDasharray="6 5" />}

              {/*
                绘制的图形。
                图层顺序（见《白板绘制功能-设计规范》§六）：底纹 → 连线 → **图形** → 卡片。
                放在连线之后是因为"画上去的注解该显眼"；
                放在卡片之前是因为**填充不透明** —— 若在卡片之上，一个矩形就能把卡片整个盖住、还点不到。
              */}
              <ShapeLayer
                shapes={shapes}
                selectedIds={selectedShapeIds}
                hoverId={hoverShapeId}
                interactive={!drawMode}
                onShapeMouseDown={onShapeMouseDown}
                onShapeContextMenu={onShapeContextMenu}
                draft={draftShape}
              />

              {/* 曲线编辑中的控制点（只在绘制模式 + 正在编辑某条曲线时出现） */}
              {editingCurve !== null && (
                <CurveHandles
                  points={editingCurve.points}
                  hoverIndex={hoverCtrlIndex}
                />
              )}

              </g>
            </svg>

            {edgeShapes.filter((s) => s.edge.label).map(({ edge, mid }) => (
              <div
                key={'label-' + edge.id}
                className={'edge-label' + (selectedEdge === edge.id ? ' selected' : '')}
                style={{ left: toLocalX(mid.x), top: toLocalY(mid.y) }}
                onMouseDown={(e) => { e.stopPropagation(); setSelectedEdge(edge.id); setSelectedIds([]) }}
                onDoubleClick={(e) => { e.stopPropagation(); setLabelEdit({ edgeId: edge.id, value: edge.label ?? '' }) }}
                title="双击编辑，右键可删除这条连线"
              >
                {labelEdit?.edgeId === edge.id
                  ? (
                    <input
                      className="edge-label-input"
                      autoFocus
                      value={labelEdit.value}
                      onChange={(e) => setLabelEdit({ edgeId: edge.id, value: e.target.value })}
                      onMouseDown={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') commitLabel()
                        if (e.key === 'Escape') setLabelEdit(null)
                      }}
                      onBlur={commitLabel}
                    />
                  )
                  : edge.label}
              </div>
            ))}

            {band && <div className="board-band" style={{ left: toLocalX(band.x), top: toLocalY(band.y), width: band.w, height: band.h }} />}

            {nodes.map((node) => {
              const active = selectedIds.includes(node.id)
              const isEditing = editingId === node.id
              const showDots = (hover === node.id || active) && !draft
              // 卡片配色：色板内 → 由 data-card-color + 主题变量决定颜色（深/浅各一套）；
              // 色板外的自定义颜色 → 保留原样（内联背景），不参与主题切换
              const colorKey = resolveCardColorKey(node.color)
              return (
                <div
                  key={node.id}
                  data-node-id={node.id}
                  data-card-color={colorKey ?? 'custom'}
                  className={'board-node' + (active ? ' selected' : '') + (isEditing ? ' editing' : '')}
                  style={{
                    left: toLocalX(node.x),
                    top: toLocalY(node.y),
                    width: node.w,
                    height: node.h,
                    // 色板外的自定义颜色：底色按原样，**文字色按底色亮度自动选深/浅** ——
                    // 否则浅色自定义底 + 浅色主题文字（或反过来）会看不见。
                    ...(colorKey === null ? { background: node.color ?? '#fff', color: readableTextOn(node.color ?? '#fff') } : {})
                  }}
                  onMouseEnter={() => setHover(node.id)}
                  onMouseLeave={() => setHover((h) => (h === node.id ? null : h))}
                  onMouseDown={(e) => {
                    if (isEditing && (e.target as HTMLElement).closest('textarea')) return
                    if ((e.target as HTMLElement).closest('button,.link-title,input,.link-dot,.resize-handle')) return
                    // 按住空格 / 中键时把事件让给画布，由画布负责平移
                    if (spaceRef.current || e.button === 1) return
                    e.stopPropagation()
                    startNodeDrag(e, node)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    if (node.type === 'text') { setEditingId(node.id); setSelectedIds([node.id]) }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (!selectedIds.includes(node.id)) setSelectedIds([node.id])
                    setSelectedEdge(null)
                    setMenu({ x: e.clientX, y: e.clientY, kind: 'card', nodeId: node.id })
                  }}
                >
                  <div className="node-body">
                    {node.type === 'text' && (
                      <textarea
                        // 只有双击进入编辑时文字框才接管鼠标，平时整张卡片都能拖动
                        readOnly={!isEditing}
                        value={node.text ?? ''}
                        style={{
                          fontSize: node.fontSize ?? 16,
                          fontWeight: node.bold ? 700 : 400,
                          pointerEvents: isEditing ? 'auto' : 'none'
                        }}
                        onMouseDown={(e) => { if (!isEditing) e.preventDefault() }}
                        onChange={(e) => {
                          // 文字超出卡片就直接长高，保证写多少都能看见
                          const text = e.target.value
                          const need = estimateTextHeight({ text, w: node.w, fontSize: node.fontSize ?? 16 })
                          updateNode(node.id, need > node.h ? { text, h: need } : { text })
                        }}
                        onBlur={() => setEditingId((cur) => (cur === node.id ? null : cur))}
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setEditingId(null) }}
                      />
                    )}
                    {node.type === 'image' && node.src && (
                      <BoardImage rel={node.src} onOpen={(src) => { if (!movedRef.current) setViewer({ src, zoom: 1 }) }} />
                    )}
                    {node.type === 'image' && !node.src && <span className="small muted">图片缺失</span>}
                    {node.type === 'note' && (node.noteId
                      ? <span className="link-title" onClick={() => onOpenNote(node.noteId as string)}>📄 {titleOfNote(node.noteId, notes, noteTitles)}</span>
                      : <button className="btn small" onClick={() => void loadNotes().then((list) => { setNotes(list); setNotePicker({ forNode: node.id }) })}>选择笔记</button>
                    )}
                    {node.type === 'link' && (
                      <span className="link-title" onClick={() => { if (node.url) void window.api.openExternal(node.url).catch((err: Error) => toast(err.message, 'error')) }}>{node.url}</span>
                    )}
                  </div>

                  {showDots && SIDES.map((side) => (
                    <span
                      key={side}
                      className={'link-dot link-dot-' + side}
                      title="按住拖到另一张卡片即可连线"
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        const p = toWorld(e)
                        setDraft({ from: node.id, side, x: p.x, y: p.y })
                      }}
                    />
                  ))}

                  {single === node.id && HANDLES.map((h) => (
                    <span
                      key={h}
                      className={'resize-handle rh-' + h}
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        resizeRef.current = {
                          id: node.id, handle: h, sx: e.clientX, sy: e.clientY,
                          start: rectOf(node),
                          keepRatio: node.type === 'image'
                        }
                      }}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="note-status">
        <span>{nodes.length} 个卡片 · {edges.length} 条连线{selectedIds.length > 1 ? ' · 已选 ' + selectedIds.length + ' 张' : ''}</span>
        <span className="small muted">· 拖空白框选（可整组移动）· Ctrl+C / Ctrl+V 复制粘贴卡片 · 滚轮缩放 · 按住滚轮拖动或空格+拖动平移 · 双击文字卡片编辑</span>
        <div className="spacer" />
        <span>{dirty ? '有未保存的修改（8 秒自动保存）' : '已保存'}</span>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}

      {viewer && (
        <Modal
          title="图片查看"
          width={860}
          onClose={() => setViewer(null)}
          footer={
            <>
              <button className="btn" onClick={() => setViewer({ ...viewer, zoom: Math.max(0.2, viewer.zoom - 0.2) })}>缩小</button>
              <span className="small muted">{(viewer.zoom * 100).toFixed(0)}%</span>
              <button className="btn" onClick={() => setViewer({ ...viewer, zoom: Math.min(4, viewer.zoom + 0.2) })}>放大</button>
              <button className="btn primary" onClick={() => setViewer(null)}>关闭</button>
            </>
          }
        >
          <div style={{ overflow: 'auto', maxHeight: '58vh', textAlign: 'center' }}>
            <img src={viewer.src} alt="查看" style={{ transform: 'scale(' + viewer.zoom + ')', transformOrigin: 'top left' }} />
          </div>
          <div className="small muted">仅支持缩放查看，不提供图片编辑，也不会修改原图。</div>
        </Modal>
      )}

      {notePicker && (
        <Modal title="选择要引用的笔记" onClose={() => setNotePicker(null)} footer={<button className="btn" onClick={() => setNotePicker(null)}>关闭</button>}>
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            {notes.length === 0 && <div className="small muted" style={{ padding: 12 }}>笔记库中还没有笔记，可先在“笔记库”中创建。</div>}
            {notes.map((n) => (
              <div key={n.id} className="list-row" style={{ cursor: 'pointer' }} onClick={() => { updateNode(notePicker.forNode, { noteId: n.id, w: 220, h: 110 }); setNotePicker(null) }}>
                <span className="grow">{n.title}</span>
                <span className="badge">{n.kind === 'whiteboard' ? '白板' : '笔记'}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  )
}

/**
 * 白板内图片：默认走 dsh-attachment 自定义协议（不占内存、不重复编码）。
 * 万一协议被环境挡住，自动回退到 IPC 读取并转成 data URL，保证图片一定看得见。
 */
function BoardImage({ rel, onOpen }: { rel: string; onOpen: (src: string) => void }): React.ReactElement {
  const [src, setSrc] = useState(() => attachmentUrl(rel))
  const [failed, setFailed] = useState(false)
  useEffect(() => { setSrc(attachmentUrl(rel)); setFailed(false) }, [rel])
  if (failed) return <span className="small muted">图片无法显示（文件可能已被移动或删除）</span>
  return (
    <img
      src={src}
      alt="白板图片"
      draggable={false}
      style={{ width: '100%', height: '100%', objectFit: 'contain', cursor: 'zoom-in' }}
      onError={() => {
        if (src.startsWith('data:')) { setFailed(true); return }
        void window.api.attachmentData(rel)
          .then((r) => { if (r?.dataUrl) setSrc(r.dataUrl); else setFailed(true) })
          .catch(() => setFailed(true))
      }}
      onClick={() => onOpen(src)}
    />
  )
}

function titleOfNote(id: string, notes: Note[], titles?: Record<string, string>): string {
  return titles?.[id] ?? notes.find((n) => n.id === id)?.title ?? '（笔记）'
}

function imageSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth || 200, h: img.naturalHeight || 150 })
    img.onerror = () => resolve({ w: 200, h: 150 })
    img.src = src
  })
}
