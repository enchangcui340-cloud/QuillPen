/**
 * 笔记工具层的公共设施（读/写工具共用）。
 *
 * 为什么单独一个文件：读写工具加起来 30 多个，公共部分（返回值 schema、参数校验、
 * 库内路径解析、通道调用、树摊平）必须在**一处**定义，否则很容易出现两套语义。
 *
 * 依赖的运行时见 `runtime.js`：工具层与面板外壳共用同一份 runtime / 同一批宿主通道。
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { callOrThrow, currentLibraryRoot } from './runtime.js'

/** 所有工具统一的返回 schema（data 不约束形状，允许各工具自定义） */
export const RETURN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string', description: '一句话结果，给用户复述用' },
    text: { type: 'string', description: '给模型看的可读清单' },
    data: { description: '结构化结果（形状随工具而定）' }
  },
  required: ['ok', 'summary', 'text']
}

/**
 * 手写版 defineTool：形状与官方 `@deepseek-ai/dsh-tools` 的一致，
 * 但不引入那个包（它牵连一堆内部包、版本耦合重）。参数校验自己做。
 */
export function tool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: {
      schema: RETURN_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? value?.summary ?? '') }]
    },
    presentCall: definition.presentCall,
    async execute(args, exec) {
      const params = definition.validate(args ?? {})
      const out = await definition.run(params, { signal: exec?.signal })
      return { ok: true, summary: out.summary, text: out.text, data: out.data }
    }
  }
}

/* ============================ 参数校验 ============================ */

export function requireString(args, key, opts = {}) {
  const raw = args[key]
  if (raw === undefined || raw === null || raw === '') {
    if (opts.optional === true) return opts.default
    throw new Error(`缺少参数「${key}」${opts.hint ? '（' + opts.hint + '）' : ''}`)
  }
  if (typeof raw !== 'string') throw new Error(`参数「${key}」必须是文本`)
  const value = raw.trim()
  if (value === '' && opts.optional !== true) throw new Error(`参数「${key}」不能为空`)
  if (opts.max !== undefined && value.length > opts.max) throw new Error(`参数「${key}」太长了（上限 ${opts.max} 字符）`)
  return value
}
export function optionalString(args, key, fallback = '') {
  const raw = args[key]
  if (raw === undefined || raw === null) return fallback
  if (typeof raw !== 'string') throw new Error(`参数「${key}」必须是文本`)
  return raw.trim()
}
export function optionalNumber(args, key, fallback, min, max) {
  const raw = args[key]
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`参数「${key}」必须是数字`)
  return Math.min(max, Math.max(min, Math.round(n)))
}
export function optionalEnum(args, key, allowed, fallback) {
  const raw = args[key]
  if (raw === undefined || raw === null || raw === '') return fallback
  const v = String(raw)
  if (!allowed.includes(v)) throw new Error(`参数「${key}」只能是：${allowed.join(' / ')}`)
  return v
}
export function optionalBool(args, key, fallback = false) {
  const raw = args[key]
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw === 'boolean') return raw
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`参数「${key}」必须是 true/false`)
}
/** 库内相对路径校验：拒绝绝对路径与 .. 逃逸 */
export function safeRelPath(raw, hint) {
  const p = String(raw ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) throw new Error(`${hint}：请用**库内相对路径**（例如 "课程/第一课.md"），不要用绝对路径`)
  const segs = p.split('/').filter((s) => s !== '')
  if (segs.includes('..')) throw new Error(`${hint}：路径里不能有 ".."`)
  return segs.join('/')
}
/** 可选的目录参数（'' = 库根目录） */
export function optionalDir(args, key = 'dir') {
  const raw = args[key]
  if (raw === undefined || raw === null || raw === '') return ''
  return safeRelPath(String(raw), '笔记夹路径')
}

/* ============================ 数据访问 ============================ */

export const ch = (channel, args = []) => callOrThrow(undefined, channel, args)
export const libraryRoot = () => currentLibraryRoot(undefined)

export function folderOf(rel) {
  const i = String(rel).lastIndexOf('/')
  return i < 0 ? '' : String(rel).slice(0, i)
}
export const truncate = (s, n) => (s === undefined || s === null ? '' : (String(s).length > n ? String(s).slice(0, n) + '…' : String(s)))
/** 显示标题：note:tree 只给文件名，去掉扩展名后与界面/note_read/board_read 的 title 一致 */
export const displayTitle = (fileName) => String(fileName ?? '').replace(/\.canvas\.json$/i, '').replace(/\.md$/i, '')
export const fmtBytes = (n) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B')

/**
 * 把 note:tree 摊平。
 * 注意：宿主给的 `path` **已经是完整相对路径**（笔记还带文件名），不能再拼父路径。
 */
export function flatten(tree, out = []) {
  for (const node of tree ?? []) {
    if (node.type === 'folder') {
      out.push({ type: 'folder', path: node.path, name: node.name, children: (node.children ?? []).length })
      flatten(node.children, out)
    } else {
      const full = String(node.path ?? node.name)
      out.push({ type: 'note', id: node.id, kind: node.kind, name: node.name, path: full, dir: folderOf(full) })
    }
  }
  return out
}

/** 在库内按相对路径找节点 */
export async function findNoteByPath(rel) {
  const tree = await ch('note:tree')
  const target = String(rel).replace(/\\/g, '/')
  const hit = flatten(tree).filter((n) => n.type === 'note').find((n) => n.path === target)
  if (hit === undefined) throw new Error(`库里找不到这个笔记：${rel}（提示：路径要相对笔记库，例如 "课程/第一课.md"）`)
  return hit
}

/** 支持用 id 或库内相对路径（path）指定一篇笔记/白板 */
export async function resolveNoteRef(args) {
  const id = typeof args.id === 'string' && args.id.trim() !== '' ? args.id.trim() : ''
  if (id !== '') return { id, viaPath: false }
  const rel = requireString(args, 'path', { hint: '库内相对路径，例如 "课程/第一课.md"' })
  const hit = await findNoteByPath(safeRelPath(rel, '笔记路径'))
  return { id: hit.id, viaPath: true }
}

/** 关键词大小写无关的匹配（中文没影响，英文更友好） */
export const hitOf = (haystack, needle) => String(haystack).toLowerCase().includes(String(needle).toLowerCase())

/**
 * 卡片配色板（与客户端 src-client/lib/card-colors.ts **必须一致**）。
 *
 * 存盘值用"浅色主题那一版的底色"（老文件、老工具、AI 直接写 hex 全都照旧）；
 * 深色主题下由客户端 CSS 换成另一套明度 —— 所以 AI 只要写这个 hex、或写中文色名即可。
 * `tools/check-card-color-parity.mjs` 会比对两边，防止改一处忘另一处。
 */
export const CARD_COLOR_NAMES = {
  原色: '#ffffff', 默认: '#ffffff', 白: '#ffffff', 白色: '#ffffff', default: '#ffffff',
  粉: '#fbd9e6', 粉色: '#fbd9e6', pink: '#fbd9e6',
  蓝: '#cfe1fb', 蓝色: '#cfe1fb', blue: '#cfe1fb',
  绿: '#cdeccf', 绿色: '#cdeccf', green: '#cdeccf',
  黄: '#fdf3b8', 黄色: '#fdf3b8', yellow: '#fdf3b8',
  紫: '#e3d9fb', 紫色: '#e3d9fb', purple: '#e3d9fb'
}

/** 把 AI/用户给的色值规整成存盘值：中文色名 → hex；未知 hex 原样保留 */
export function normalizeCardColor(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return raw
  const lower = raw.toLowerCase()
  return CARD_COLOR_NAMES[raw] ?? CARD_COLOR_NAMES[lower] ?? raw
}

/* ============================ 连线取边 ============================
 *
 * ⚠️ 这份实现必须与 `src-client/lib/board.ts` 的 `resolveEdgeSides` **完全一致**。
 * 两处是独立的代码单元（这里是纯 JS、DSH 直接加载；那边是 TS、打进 client.js），
 * 没法共用源码，所以靠 `tools/check-edge-side-parity.mjs` 跑同一批场景比对结果
 * —— 与卡片色板（CARD_COLOR_NAMES ↔ card-colors.ts）用的是同一套防漂移办法。
 *
 * 规范：**取"朝对方中心"的那条边**。理由见 board.ts 里的长注释。
 */

/** 合法的边 */
export const EDGE_SIDES = ['top', 'right', 'bottom', 'left']

/** 是不是合法的边（AI 传进来的值要过这一关，非法必须报错而不是静默兜底） */
export function isEdgeSide(v) {
  return v === 'top' || v === 'right' || v === 'bottom' || v === 'left'
}

/** 点落在矩形哪一边（按归一化距离比较，靠近哪边算哪边） */
export function nearestSideOf(r, p) {
  const dx = (p.x - (r.x + r.w / 2)) / Math.max(1, r.w / 2)
  const dy = (p.y - (r.y + r.h / 2)) / Math.max(1, r.h / 2)
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'top' : 'bottom'
}

/** 在矩形 self 上，取"朝 other 中心"的那条边 */
export function sideFacingCenter(self, other) {
  return nearestSideOf(self, { x: other.x + other.w / 2, y: other.y + other.h / 2 })
}

/**
 * 连线两端各接哪条边：**取"朝对方中心"的边**。
 * @param {{x:number,y:number,w:number,h:number}} a 起点卡片
 * @param {{x:number,y:number,w:number,h:number}} b 终点卡片
 */
export function resolveEdgeSides(a, b) {
  return { from: sideFacingCenter(a, b), to: sideFacingCenter(b, a) }
}

/** 从卡片节点取出矩形（连线取边只看这四项） */
export function rectOfNode(n) {
  return { x: Number(n?.x) || 0, y: Number(n?.y) || 0, w: Number(n?.w) || 0, h: Number(n?.h) || 0 }
}


/** 读一篇 md 的原始正文（工具内部用，拿 mtime 做保存基准） */
export async function readNoteForEdit(id) {
  const res = await ch('note:read', [id])
  const note = res?.note
  if (note === undefined || note === null) throw new Error('读不到这篇笔记：' + id)
  if (note.kind === 'whiteboard') throw new Error(`「${note.title}」是白板，请用 board_* 工具`)
  return { note, content: String(res?.content ?? '') }
}

/** 读一块白板（拿 mtime 做保存基准） */
export async function readBoardForEdit(id) {
  const board = await ch('board:read', [id])
  if (board === undefined || board === null) throw new Error('读不到这块白板：' + id)
  const meta = await ch('note:read', [id])
  return { board, mtime: meta?.note?.fileMtimeMs }
}

/** 保存白板并把"保存冲突"变成可读错误 */
export async function saveBoard(id, board, mtime) {
  const result = await ch('board:save', [id, board, mtime])
  if (result?.ok !== true) {
    throw new Error('保存冲突：这块白板在别处被改过（可能正开在面板里）。请先用 board_read 重新读一遍，再重做修改。')
  }
  return result
}

/** 保存 md 正文并把"保存冲突"变成可读错误 */
export async function saveNoteText(id, content, mtime) {
  const result = await ch('note:save', [id, content, mtime])
  if (result?.ok !== true) {
    throw new Error('保存冲突：这篇笔记在别处被改过（可能正开在面板里）。请先用 note_read 重新读一遍，再重做修改。')
  }
  return result
}

/** 新白板卡片 id（与前端同风格：n + 随机） */
export const newBoardId = () => 'n' + Math.random().toString(36).slice(2, 9)

/** 读原始文件（搜索等只读场景用；读不到返回 null） */
export function readTextIfSmall(abs, maxBytes = 4 * 1024 * 1024) {
  try {
    if (statSync(abs).size > maxBytes) return null
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/** 绝对路径（库内相对路径 → 真实文件），仅用于只读检查 */
export const absInNotes = (root, rel) => join(root, 'notes', String(rel).replace(/^\/+/, ''))
