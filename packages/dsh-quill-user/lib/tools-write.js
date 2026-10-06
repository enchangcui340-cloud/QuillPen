/**
 * 笔记工具层：**写入类**工具（P2）。
 *
 * 覆盖「笔记夹 / 笔记 / 白板 / 待办 / 标签」的建、改、移、删。
 * 全部走宿主已有的写通道，因此天然继承：原子写、id 生成、frontmatter 规则、
 * 重名自动加序号、删除进回收站（可恢复）、保存冲突检测。
 *
 * 两条重要约束（实现里已处理）：
 *   1. `note:save` 内部用 `upsertFrontmatter(content, {id})` —— 它会**保留原文里的 title**，
 *      所以覆写正文时必须把原有 frontmatter 带上；本文件在缺 frontmatter 时自动补齐。
 *   2. `board:save` 的冲突结果是内层 `{ok:false,conflict:true}`，不是抛错 —— 必须自己检查，
 *      否则会静默丢改动（见 tool-kit 的 saveBoard）。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ch, findNoteByPath, flatten, fmtBytes, isEdgeSide, libraryRoot, newBoardId, normalizeCardColor,
  optionalBool, optionalDir, optionalEnum, optionalNumber, optionalString, readBoardForEdit,
  readNoteForEdit, rectOfNode, requireString, resolveEdgeSides, safeRelPath, saveBoard, saveNoteText, tool
} from './tool-kit.js'

export const writeTools = []

/**
 * 校验 AI 给的连线边值。
 *
 * 以前这里是 `String(raw.fromSide)` —— **只做字符串化，不校验**。
 * 于是 AI 写个 `"右"` / `"RIGHT"` / `"east"` 会被原样存进文件，
 * 渲染时落到 `anchorOf` 的 default 分支（当 right 用）→ **静默画错**，很难查。
 * 现在非法值直接报错（与 add_shape 校验 kind 的做法一致）。
 */
function requireEdgeSide(v, field) {
  const raw = String(v ?? '').trim()
  if (!isEdgeSide(raw)) {
    throw new Error(`${field} 只能是 top / right / bottom / left（收到「${raw}」）`)
  }
  return raw
}

/* ============================ 小工具 ============================ */

/** 把整篇文本切成 frontmatter 正文（没有 frontmatter 时 fm 为 null） */
function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (m === null) return { fm: null, body: text }
  return { fm: m[1], body: text.slice(m[0].length) }
}
/** 保证正文带上 frontmatter：模型只给正文时，把原有 frontmatter 补回去（保住 title/created） */
function ensureFrontmatter(provided, existing) {
  if (/^---\r?\n/.test(provided)) return provided
  const { fm } = splitFrontmatter(existing)
  if (fm === null) return provided
  return '---\n' + fm + '\n---\n' + provided
}
/** 归一化正文（统一换行、结尾一个换行） */
const tidy = (s) => s.replace(/\r\n/g, '\n').replace(/\n{0,}$/, '\n')

/** 参数里的 id / path 引用（在 validate 里只做形状检查，真正的解析在 run 里） */
const refArgs = (a) => ({ id: typeof a.id === 'string' ? a.id.trim() : '', path: typeof a.path === 'string' ? a.path.trim() : '' })

/** 删除类工具统一提示 */
const SAFE_NOTE = '（不会真删：进回收站，可随时恢复）'

/* ============================ 笔记夹 ============================ */

writeTools.push(tool({
  name: 'folder_create',
  description: '新建笔记夹（可指定父夹，默认建在库根目录）。同名时会自动加序号，保证"新建即成功"。返回新笔记夹的库内相对路径。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      dir: { type: 'string', description: '父笔记夹的库内相对路径；留空=库根目录' },
 name: { type: 'string', description: '笔记夹名称' }
    },
    required: ['name']
  },
  validate: (a) => ({ dir: optionalDir(a), name: requireString(a, 'name', { max: 100 }) }),
  async run({ dir, name }) {
    const created = await ch('folder:create', [dir, name])
    return { summary: `已新建笔记夹「${created}」`, text: `新建笔记夹：${created}（父级：${dir === '' ? '库根目录' : dir}）`, data: { path: created, name, dir } }
  }
}))

writeTools.push(tool({
  name: 'folder_rename',
  description: '重命名笔记夹（里面的笔记与子夹一起保留）。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
 path: { type: 'string', description: '要改名的笔记夹的库内相对路径' },
 name: { type: 'string', description: '新名称（只写名字，不要带路径）' }
    },
    required: ['path', 'name']
  },
  validate: (a) => ({ path: safeRelPath(requireString(a, 'path'), '笔记夹路径'), name: requireString(a, 'name', { max: 100 }) }),
  async run({ path, name }) {
    const now = await ch('folder:rename', [path, name])
    return { summary: `笔记夹已改名为「${now}」`, text: `「${path}」→「${now}」`, data: { from: path, to: now } }
  }
}))

writeTools.push(tool({
  name: 'folder_move',
  description: '把笔记夹移动到另一个笔记夹下面（连同内部所有内容）。不能移到自身或自己的子目录。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
 path: { type: 'string', description: '要移动的笔记夹路径' },
      to: { type: 'string', description: '目标父夹路径；留空=移到库根目录' }
    },
    required: ['path']
  },
  validate: (a) => ({ path: safeRelPath(requireString(a, 'path'), '笔记夹路径'), to: optionalDir(a, 'to') }),
  async run({ path, to }) {
    await ch('folder:move', [path, to])
    const leaf = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path
    const now = to === '' ? leaf : to + '/' + leaf
    return { summary: `笔记夹已移动到「${now}」`, text: `「${path}」→「${now}」`, data: { from: path, to: now } }
  }
}))

writeTools.push(tool({
  name: 'folder_trash',
  description: `删除笔记夹及其中的全部笔记 ${SAFE_NOTE}。`,
  parameters: {
    type: 'object',
    additionalProperties: false,
 properties: { path: { type: 'string', description: '要删除的笔记夹路径' } },
    required: ['path']
  },
  validate: (a) => ({ path: safeRelPath(requireString(a, 'path'), '笔记夹路径') }),
  async run({ path }) {
    await ch('folder:delete', [path])
    return { summary: `笔记夹「${path}」已移入回收站`, text: `已删除笔记夹：${path} ${SAFE_NOTE}`, data: { path } }
  }
}))

/* ============================ 笔记（Markdown） ============================ */

writeTools.push(tool({
  name: 'note_create',
  description: '新建一篇 Markdown 笔记（可指定放进哪个笔记夹，默认库根目录）。返回 id 与路径，之后用 note_write 写正文。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      dir: { type: 'string', description: '放进哪个笔记夹（库内相对路径）；留空=库根目录' },
 title: { type: 'string', description: '笔记标题（同时作为文件名）' }
    },
    required: ['title']
  },
  validate: (a) => ({ dir: optionalDir(a), title: requireString(a, 'title', { max: 200 }) }),
  async run({ dir, title }) {
    const note = await ch('note:create', [{ dir, kind: 'md', title }])
    return {
      summary: `已新建笔记「${note.title}」`,
      text: `新建笔记：${note.dir === '' ? note.fileName : note.dir + '/' + note.fileName}\nid：${note.id}\n（用 note_write 写正文）`,
      data: { id: note.id, title: note.title, path: note.dir === '' ? note.fileName : note.dir + '/' + note.fileName }
    }
  }
}))

writeTools.push(tool({
  name: 'note_write',
  description: [
    '写 Markdown 笔记正文。三种模式：',
    '· overwrite：整篇替换（只给正文即可，原有 frontmatter 会自动保留）；',
    '· append：在正文末尾追加；',
    '· replace_section：替换某个标题小节的内容（需要给 section，写小节标题文字）。',
    '会自动处理保存冲突：若这篇笔记正在面板里被改过，会报错提示先重新读一遍。'
  ].join('\n'),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '笔记 id（推荐）' },
      path: { type: 'string', description: '库内相对路径（没有 id 时用）' },
      mode: { type: 'string', enum: ['overwrite', 'append', 'replace_section'], description: '写入模式（默认 overwrite）' },
 content: { type: 'string', description: '要写入的 Markdown 正文' },
      section: { type: 'string', description: 'replace_section 模式要替换的小节标题（不含 # 号）' }
    },
    required: ['content']
  },
  validate: (a) => ({
    ...refArgs(a),
    mode: optionalEnum(a, 'mode', ['overwrite', 'append', 'replace_section'], 'overwrite'),
    content: requireString(a, 'content', { max: 5_000_000 }),
    section: optionalString(a, 'section')
  }),
  async run({ id, path, mode, content, section }) {
    const ref = await (async () => (id !== '' ? { id } : await findNoteByPath(safeRelPath(path, '笔记路径'))))()
    const { note, content: current } = await readNoteForEdit(ref.id)
    const mtime = note.fileMtimeMs
    let next
    if (mode === 'append') {
      const { fm, body } = splitFrontmatter(current)
      const merged = tidy(body) + (body.trim() === '' ? '' : '\n') + tidy(content)
      next = fm === null ? merged : '---\n' + fm + '\n---\n' + merged
    } else if (mode === 'replace_section') {
      if (section === '') throw new Error('replace_section 模式需要给 section（小节标题）')
      const { fm, body } = splitFrontmatter(current)
      const lines = body.replace(/\r\n/g, '\n').split('\n')
      const want = section.replace(/^#+\s*/, '').trim()
      let start = -1
      let end = lines.length
      let level = 0
      for (let i = 0; i < lines.length; i++) {
        const m = /^(#{1,6})\s+(.*)$/.exec(lines[i])
        if (m === null) continue
        if (start === -1 && m[2].trim() === want) { start = i; level = m[1].length; continue }
        if (start !== -1 && m[1].length <= level) { end = i; break }
      }
      if (start === -1) throw new Error(`正文里没有找到小节「${section}」（请先用 note_read 看一遍它的标题写法）`)
      const replaced = [...lines.slice(0, start + 1), '', ...tidy(content).split('\n'), '', ...lines.slice(end)]
      const merged = replaced.join('\n').replace(/\n{3,}/g, '\n\n')
      next = fm === null ? merged : '---\n' + fm + '\n---\n' + merged
    } else {
      next = ensureFrontmatter(content, current)
    }
    await saveNoteText(ref.id, next, mtime)
    const after = await ch('note:read', [ref.id])
    return {
      summary: `已写入「${note.title}」（${mode}，正文 ${next.length} 字）`,
      text: `已保存「${note.title}」\n模式：${mode}\n路径：${note.dir === '' ? note.fileName : note.dir + '/' + note.fileName}\n当前正文长度：${String(after?.content ?? '').length} 字`,
      data: { id: ref.id, title: note.title, mode, bytes: next.length }
    }
  }
}))

writeTools.push(tool({
  name: 'note_rename',
  description: '重命名笔记（文件名与文档标题一起更新，id 不变）。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '笔记 id（推荐）' },
      path: { type: 'string', description: '库内相对路径（没有 id 时用）' },
 title: { type: 'string', description: '新标题' }
    },
    required: ['title']
  },
  validate: (a) => ({ ...refArgs(a), title: requireString(a, 'title', { max: 200 }) }),
  async run({ id, path, title }) {
    const ref = id !== '' ? { id } : await findNoteByPath(safeRelPath(path, '笔记路径'))
    const note = await ch('note:rename', [ref.id, title])
    return { summary: `已重命名为「${note.title}」`, text: `新路径：${note.dir === '' ? note.fileName : note.dir + '/' + note.fileName}`, data: { id: note.id, title: note.title } }
  }
}))

writeTools.push(tool({
  name: 'note_move',
  description: '把笔记移动到另一个笔记夹（目标夹不存在会自动创建）。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '笔记 id（推荐）' },
      path: { type: 'string', description: '库内相对路径（没有 id 时用）' },
      dir: { type: 'string', description: '目标笔记夹路径；留空=移到库根目录' }
    }
  },
  validate: (a) => ({ ...refArgs(a), dir: optionalDir(a) }),
  async run({ id, path, dir }) {
    const ref = id !== '' ? { id } : await findNoteByPath(safeRelPath(path, '笔记路径'))
    const note = await ch('note:move', [ref.id, dir])
    return {
      summary: `已移动「${note.title}」到「${dir === '' ? '库根目录' : dir}」`,
      text: `新路径：${note.dir === '' ? note.fileName : note.dir + '/' + note.fileName}`,
      data: { id: note.id, title: note.title, dir: note.dir }
    }
  }
}))

writeTools.push(tool({
  name: 'note_trash',
  description: `删除笔记 ${SAFE_NOTE}。`,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '笔记 id（推荐）' },
      path: { type: 'string', description: '库内相对路径（没有 id 时用）' }
    }
  },
  validate: (a) => refArgs(a),
  async run({ id, path }) {
    const ref = id !== '' ? { id } : await findNoteByPath(safeRelPath(path, '笔记路径'))
    await ch('note:delete', [ref.id])
    return { summary: '笔记已移入回收站', text: `已删除 ${ref.id} ${SAFE_NOTE}`, data: { id: ref.id } }
  }
}))

/* ============================ 白板 ============================ */

writeTools.push(tool({
  name: 'board_create',
  description: '新建一块白板（可指定放进哪个笔记夹）。返回 id，之后用 board_edit 画卡片与连线。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      dir: { type: 'string', description: '放进哪个笔记夹；留空=库根目录' },
 title: { type: 'string', description: '白板标题（同时作为文件名）' }
    },
    required: ['title']
  },
  validate: (a) => ({ dir: optionalDir(a), title: requireString(a, 'title', { max: 200 }) }),
  async run({ dir, title }) {
    const note = await ch('note:create', [{ dir, kind: 'whiteboard', title }])
    return {
      summary: `已新建白板「${note.title}」`,
      text: `新建白板：${note.dir === '' ? note.fileName : note.dir + '/' + note.fileName}\nid：${note.id}\n（用 board_edit 加卡片/连线）`,
      data: { id: note.id, title: note.title, path: note.dir === '' ? note.fileName : note.dir + '/' + note.fileName }
    }
  }
}))

/* ============================ 绘制图形的构造与校验 ============================
   给 board_edit 的 add_shape / update_shape 用。
   要点：**挡住 AI 写坏的数据**（未知 kind 报错而不是静默丢弃、坐标 clamp、点数上限），
   否则一个写坏的白板打不开，用户会直接丢内容。 */

/** 8 种图形 */
const SHAPE_KINDS = ['rect', 'ellipse', 'triangle', 'diamond', 'line', 'arrow', 'curve', 'free']
/** 线类（用 points 描述） */
const SHAPE_LINE_KINDS = ['line', 'arrow', 'curve', 'free']
/** 中文/英文别名 → kind */
const SHAPE_ALIASES = {
  矩形: 'rect', 长方形: 'rect', 方框: 'rect', 方块: 'rect', 方形: 'rect', rect: 'rect', rectangle: 'rect',
  椭圆: 'ellipse', 圆: 'ellipse', 圆形: 'ellipse', 圆圈: 'ellipse', ellipse: 'ellipse', circle: 'ellipse', oval: 'ellipse',
  三角: 'triangle', 三角形: 'triangle', triangle: 'triangle',
  菱形: 'diamond', 钻石: 'diamond', 棱形: 'diamond', diamond: 'diamond', rhombus: 'diamond',
  直线: 'line', 线: 'line', 线段: 'line', 横线: 'line', 竖线: 'line', line: 'line',
  箭头: 'arrow', 指向: 'arrow', 箭: 'arrow', arrow: 'arrow',
  曲线: 'curve', 弧线: 'curve', 光滑线: 'curve', 弯线: 'curve', curve: 'curve', bezier: 'curve',
  自由: 'free', 涂鸦: 'free', 手绘: 'free', 随手画: 'free', free: 'free', freehand: 'free', pencil: 'free'
}
/** 色板键（与卡片同一套） */
const SHAPE_COLORS = ['default', 'pink', 'blue', 'green', 'yellow', 'purple']
const COLOR_ALIASES = {
  原色: 'default', 默认: 'default', 白: 'default', 灰: 'default', default: 'default',
  粉: 'pink', 粉色: 'pink', pink: 'pink',
  蓝: 'blue', 蓝色: 'blue', blue: 'blue',
  绿: 'green', 绿色: 'green', green: 'green',
  黄: 'yellow', 黄色: 'yellow', yellow: 'yellow',
  紫: 'purple', 紫色: 'purple', purple: 'purple'
}
/** 世界坐标范围（与前端 WORLD_W/H 一致） */
const SHAPE_MAX_X = 21000
const SHAPE_MAX_Y = 14000
const SHAPE_MAX_POINTS = 2000
const SHAPE_MIN_SIZE = 8
const SHAPE_DEFAULT_W = 120
const SHAPE_DEFAULT_H = 80

function resolveShapeKind(v) {
  const raw = String(v ?? '').trim()
  if (raw === '') throw new Error('add_shape：缺少 kind（矩形/椭圆/三角形/菱形/直线/箭头/曲线/自由）')
  const lower = raw.toLowerCase()
  const hit = SHAPE_KINDS.includes(lower) ? lower : (SHAPE_ALIASES[raw] ?? SHAPE_ALIASES[lower])
  if (hit === undefined) {
    throw new Error(`不认识的图形种类「${raw}」（可用：矩形 / 椭圆 / 三角形 / 菱形 / 直线 / 箭头 / 曲线 / 自由，或英文 rect/ellipse/triangle/diamond/line/arrow/curve/free）`)
  }
  return hit
}

function resolveShapeColor(v, fallback) {
  if (v === undefined || v === null || String(v).trim() === '') return fallback ?? 'default'
  const raw = String(v).trim()
  const lower = raw.toLowerCase()
  if (SHAPE_COLORS.includes(lower)) return lower
  if (COLOR_ALIASES[raw] !== undefined) return COLOR_ALIASES[raw]
  // 允许 hex（用户自定义色）；规整成小写
  if (/^#[0-9a-f]{3,8}$/i.test(raw)) return lower
  throw new Error(`不认识的图形颜色「${raw}」（可用：原色/粉色/蓝色/绿色/黄色/紫色，或 #rrggbb）`)
}

const clampNum = (v, min, max) => Math.max(min, Math.min(max, v))

/** 解析一个点；非有限数直接报错（不静默丢弃，否则 AI 不知道自己写错了） */
function parsePt(p, where) {
  const x = Number(p?.x)
  const y = Number(p?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${where}：坐标必须是数字，收到 ${JSON.stringify(p)}`)
  return { x: clampNum(x, -SHAPE_MAX_X, SHAPE_MAX_X), y: clampNum(y, -SHAPE_MAX_Y, SHAPE_MAX_Y) }
}

/**
 * 由 op 参数构造一个合法图形。
 * @param prev 更新时的原图形（用于"只改一部分字段"）
 */
function buildShape(raw, newBoardId, prev) {
  const kind = resolveShapeKind(raw.kind ?? prev?.kind)
  const color = resolveShapeColor(raw.color, prev?.color ?? 'default')
  const isLine = SHAPE_LINE_KINDS.includes(kind)

  if (isLine) {
    // points 支持三种写法：points 数组 / from+to 简写 / 沿用 prev
    let pts = []
    if (Array.isArray(raw.points)) {
      if (raw.points.length > SHAPE_MAX_POINTS) throw new Error(`add_shape：点太多（${raw.points.length}，上限 ${SHAPE_MAX_POINTS}）`)
      pts = raw.points.map((p) => parsePt(p, 'add_shape.points'))
    } else if (Array.isArray(raw.from) && Array.isArray(raw.to)) {
      pts = [parsePt({ x: raw.from[0], y: raw.from[1] }, 'add_shape.from'), parsePt({ x: raw.to[0], y: raw.to[1] }, 'add_shape.to')]
    } else if (Array.isArray(prev?.points)) {
      pts = prev.points.map((p) => ({ x: p.x, y: p.y }))
    }
    if (pts.length < 2) throw new Error(`add_shape：${kind} 至少需要 2 个点（用 points:[{x,y},{x,y}] 或 from/to）`)
    return { id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newBoardId(), kind, color, points: pts }
  }

  // 几何图形：x/y/w/h
  const x = Number.isFinite(Number(raw.x)) ? Number(raw.x) : (prev?.x ?? 0)
  const y = Number.isFinite(Number(raw.y)) ? Number(raw.y) : (prev?.y ?? 0)
  const w = Number.isFinite(Number(raw.w)) ? Math.abs(Number(raw.w)) : (prev?.w ?? SHAPE_DEFAULT_W)
  const h = Number.isFinite(Number(raw.h)) ? Math.abs(Number(raw.h)) : (prev?.h ?? SHAPE_DEFAULT_H)
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newBoardId(),
    kind,
    color,
    x: clampNum(x, -SHAPE_MAX_X, SHAPE_MAX_X),
    y: clampNum(y, -SHAPE_MAX_Y, SHAPE_MAX_Y),
    w: clampNum(w, SHAPE_MIN_SIZE, SHAPE_MAX_X),
    h: clampNum(h, SHAPE_MIN_SIZE, SHAPE_MAX_Y)
  }
}

/** 给"改动记录"用的一句话描述 */
function describeShape(s) {
  if (SHAPE_LINE_KINDS.includes(s.kind)) {
    const pts = s.points ?? []
    const head = pts.slice(0, 4).map((p) => `(${Math.round(p.x)},${Math.round(p.y)})`).join('→')
    return `${pts.length} 点 ${head}${pts.length > 4 ? '…' : ''}`
  }
  return `x=${Math.round(s.x)} y=${Math.round(s.y)} w=${Math.round(s.w)} h=${Math.round(s.h)}`
}

writeTools.push(tool({
  name: 'board_edit',
  description: [
    '改一块白板：批量增删改卡片、连线与绘制图形，一次提交。先 board_read 看现状，再用 ops 描述改动。',
    '卡片与图形坐标都是世界坐标，x 向右、y 向下；建议尺寸 文本卡片 210×120 或 145×60，字号 16；水平间距约 60、垂直间距约 40。',
    '省略 x/y 时自动排到现有卡片右侧。',
    'ops 里每项：{op, ...}',
    '· add_node    {type:"text"|"image"|"note"|"link", x?, y?, w?, h?, text?, color?, fontSize?, bold?, src?, noteId?, url?}',
    '  color 可以写中文色名：原色 / 粉色 / 蓝色 / 绿色 / 黄色 / 紫色（也可写 hex）；' ,
    '  深色主题下这些颜色会自动换成另一套明度，不用你操心 —— 语义色名照写即可。',
    '· update_node {id, ...同上任意字段}',
    '· remove_node {id}（连带删除与它相连的线）',
    '· add_edge    {from, to, label?, fromSide?, toSide?}',
    '· update_edge {id, label?, fromSide?, toSide?}',
    '· remove_edge {id}',
    '',
    '— 绘制图形（白板上"画"出来的几何图形与线，和卡片是两种东西）—',
    '· add_shape    {kind, color?, x?, y?, w?, h?, points?}',
    '  kind 可写中文：矩形/椭圆/三角形/菱形（用 x,y,w,h）；直线/箭头/曲线/自由（用 points）',
    '  points 是 [{x,y},…]，画的顺序即连点顺序；line/arrow 给 2 个点，curve 给 2 个以上',
    '  线类也可以用简写 {from:[x,y], to:[x,y]} 代替 points',
    '· update_shape {id, ...同上任意字段}（可以改颜色；改 kind 会按新种类重算字段）',
    '· remove_shape {id}',
    '· set_title   {title}'
  ].join('\n'),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '白板 id（推荐）' },
      path: { type: 'string', description: '库内相对路径（没有 id 时用）' },
      ops: {
        type: 'array',
        description: '要执行的改动列表',
        items: {
          type: 'object',
          additionalProperties: true,
          // 每一项都必须带 op（顶层 required 说的是"必须给 ops"，这一层说的是"每个 op 必须写 op 字段"）
          required: ['op'],
          properties: {
            op: { type: 'string', description: 'add_node / update_node / remove_node / add_edge / update_edge / remove_edge / set_title' }
          }
        }
      }
    },
    required: ['ops']
  },
  validate: (a) => {
    const ops = Array.isArray(a.ops) ? a.ops : null
    if (ops === null || ops.length === 0) throw new Error('缺少参数「ops」（要给出至少一项改动）')
    if (ops.length > 200) throw new Error('一次最多 200 项改动（请分批）')
    return { ...refArgs(a), ops }
  },
  async run({ id, path, ops }) {
    const ref = id !== '' ? { id } : await findNoteByPath(safeRelPath(path, '白板路径'))
    const { board, mtime } = await readBoardForEdit(ref.id)
    const nodes = [...(board.nodes ?? [])]
    const edges = [...(board.edges ?? [])]
    // 图形：读出来时可能是 undefined（旧白板没有这个字段），一律当空数组
    const shapes = [...(board.shapes ?? [])]
    let title = board.title
    const done = []

    const nodeById = (nid) => nodes.find((n) => n.id === nid)
    const nextAutoPos = () => {
      const right = nodes.reduce((m, n) => Math.max(m, (n.x ?? 0) + (n.w ?? 0)), 0)
      return { x: right === 0 ? 0 : right + 60, y: nodes.length === 0 ? 0 : (nodes[nodes.length - 1].y ?? 0) }
    }

    for (const raw of ops) {
      const op = String(raw.op ?? '').trim()
      if (op === 'add_node') {
        const type = String(raw.type ?? 'text')
        if (!['text', 'image', 'note', 'link'].includes(type)) throw new Error(`add_node：type 只能是 text/image/note/link（收到 ${type}）`)
        const pos = nextAutoPos()
        const node = {
          id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newBoardId(),
          type,
          x: raw.x === undefined ? pos.x : Number(raw.x),
          y: raw.y === undefined ? pos.y : Number(raw.y),
          w: raw.w === undefined ? (type === 'text' ? 210 : 220) : Number(raw.w),
          h: raw.h === undefined ? (type === 'text' ? 120 : 70) : Number(raw.h)
        }
        if (raw.text !== undefined) node.text = String(raw.text)
        // 颜色：允许写中文色名（原色/粉色/蓝色/绿色/黄色/紫色），统一规整成存盘用的 hex
        if (raw.color !== undefined) node.color = normalizeCardColor(raw.color)
        if (raw.fontSize !== undefined) node.fontSize = Number(raw.fontSize)
        if (raw.bold !== undefined) node.bold = Boolean(raw.bold)
        if (raw.src !== undefined) node.src = String(raw.src)
        if (raw.noteId !== undefined) node.noteId = String(raw.noteId)
        if (raw.url !== undefined) node.url = String(raw.url)
        for (const k of ['x', 'y', 'w', 'h']) if (!Number.isFinite(node[k])) throw new Error(`add_node：${k} 必须是数字`)
        nodes.push(node)
        done.push(`加卡片 ${node.id}${node.text !== undefined ? '「' + String(node.text).slice(0, 20) + '」' : ''}`)
      } else if (op === 'update_node') {
        const nid = requireString(raw, 'id', { hint: '要改的卡片 id' })
        const node = nodeById(nid)
        if (node === undefined) throw new Error(`update_node：白板里没有卡片 ${nid}`)
        for (const k of ['x', 'y', 'w', 'h', 'fontSize']) if (raw[k] !== undefined) node[k] = Number(raw[k])
        for (const k of ['text', 'color', 'src', 'noteId', 'url']) if (raw[k] !== undefined) node[k] = k === 'color' ? normalizeCardColor(raw[k]) : String(raw[k])
        if (raw.bold !== undefined) node.bold = Boolean(raw.bold)
        done.push(`改卡片 ${nid}`)
      } else if (op === 'remove_node') {
        const nid = requireString(raw, 'id', { hint: '要删的卡片 id' })
        const idx = nodes.findIndex((n) => n.id === nid)
        if (idx < 0) throw new Error(`remove_node：白板里没有卡片 ${nid}`)
        nodes.splice(idx, 1)
        for (let i = edges.length - 1; i >= 0; i--) if (edges[i].from === nid || edges[i].to === nid) edges.splice(i, 1)
        done.push(`删卡片 ${nid}（含相关连线）`)
      } else if (op === 'add_edge') {
        const from = requireString(raw, 'from', { hint: '起点卡片 id' })
        const to = requireString(raw, 'to', { hint: '终点卡片 id' })
        const nodeFrom = nodeById(from)
        const nodeTo = nodeById(to)
        if (nodeFrom === undefined) throw new Error(`add_edge：没有起点卡片 ${from}`)
        if (nodeTo === undefined) throw new Error(`add_edge：没有终点卡片 ${to}`)
        const edge = { id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : 'e' + newBoardId().slice(1), from, to }
        if (raw.label !== undefined) edge.label = String(raw.label)
        /*
         * 两端接哪条边：**在这里算一次就写进文件，之后永不重算**。
         *
         * 为什么必须在这里定死：界面渲染只读文件里的 `fromSide`/`toSide`，不再按当前坐标猜
         * （原来渲染端有个"没存就重算"的兜底，导致 AI 画的线**每移动一次卡片就重新挑一次边**，
         * 看起来就是"连线会自己跑"）。
         * 所以：AI 不给，我们就按"朝对方中心"算好写进去；AI 给了，就尊重 AI 的（校验合法性）。
         */
        if (raw.fromSide !== undefined) edge.fromSide = requireEdgeSide(raw.fromSide, 'fromSide')
        if (raw.toSide !== undefined) edge.toSide = requireEdgeSide(raw.toSide, 'toSide')
        if (edge.fromSide === undefined || edge.toSide === undefined) {
          const auto = resolveEdgeSides(rectOfNode(nodeFrom), rectOfNode(nodeTo))
          if (edge.fromSide === undefined) edge.fromSide = auto.from
          if (edge.toSide === undefined) edge.toSide = auto.to
        }
        edges.push(edge)
        done.push(`连线 ${from}→${to}${edge.label ? '「' + edge.label + '」' : ''}（${edge.fromSide} → ${edge.toSide}）`)
      } else if (op === 'update_edge') {
        const eid = requireString(raw, 'id', { hint: '要改的连线 id' })
        const edge = edges.find((e) => e.id === eid)
        if (edge === undefined) throw new Error(`update_edge：白板里没有连线 ${eid}`)
        if (raw.label !== undefined) edge.label = String(raw.label)
        // 显式改边是允许的（这是"换连法"的正规出口之一，另一个是删了重画）
        if (raw.fromSide !== undefined) edge.fromSide = requireEdgeSide(raw.fromSide, 'fromSide')
        if (raw.toSide !== undefined) edge.toSide = requireEdgeSide(raw.toSide, 'toSide')
        done.push(`改连线 ${eid}`)
      } else if (op === 'remove_edge') {
        const eid = requireString(raw, 'id', { hint: '要删的连线 id' })
        const idx = edges.findIndex((e) => e.id === eid)
        if (idx < 0) throw new Error(`remove_edge：白板里没有连线 ${eid}`)
        edges.splice(idx, 1)
        done.push(`删连线 ${eid}`)
      } else if (op === 'set_title') {
        title = requireString(raw, 'title', { max: 200 })
        done.push(`标题改为「${title}」`)
      } else if (op === 'add_shape') {
        const shape = buildShape(raw, newBoardId)
        shapes.push(shape)
        done.push(`加图形 ${shape.kind}（${shape.color}）${describeShape(shape)}`)
      } else if (op === 'update_shape') {
        const sid = requireString(raw, 'id', { hint: '要改的图形 id' })
        const idx = shapes.findIndex((s) => s.id === sid)
        if (idx < 0) throw new Error(`update_shape：白板里没有图形 ${sid}`)
        const cur = shapes[idx]
        // 允许改：颜色、位置尺寸、控制点、甚至种类（种类换了就按新种类重算字段）
        const next = buildShape({ ...raw, kind: raw.kind ?? cur.kind }, newBoardId, cur)
        shapes[idx] = { ...next, id: sid }
        done.push(`改图形 ${sid} → ${shapes[idx].kind}（${shapes[idx].color}）${describeShape(shapes[idx])}`)
      } else if (op === 'remove_shape') {
        const sid = requireString(raw, 'id', { hint: '要删的图形 id' })
        const idx = shapes.findIndex((s) => s.id === sid)
        if (idx < 0) throw new Error(`remove_shape：白板里没有图形 ${sid}`)
        shapes.splice(idx, 1)
        done.push(`删图形 ${sid}`)
      } else {
        throw new Error(`不认识的 op：${op}（可用：add_node / update_node / remove_node / add_edge / update_edge / remove_edge / add_shape / update_shape / remove_shape / set_title）`)
      }
    }

    // ⚠️ 保存必须显式带上 shapes —— 漏了就会把用户画的图形从文件里抹掉
    await saveBoard(ref.id, { ...board, title, nodes, edges, shapes }, mtime)
    return {
      summary: `白板「${title}」已更新：${done.length} 项改动，现有 ${nodes.length} 卡片 / ${edges.length} 连线 / ${shapes.length} 图形`,
      text: `已保存白板「${title}」\n改动：\n  · ` + done.join('\n  · ') + `\n现在：${nodes.length} 张卡片 / ${edges.length} 条连线 / ${shapes.length} 个图形`,
      data: { id: ref.id, title, nodes: nodes.length, edges: edges.length, shapes: shapes.length, applied: done }
    }
  }
}))

writeTools.push(tool({
  name: 'board_rename',
  description: '重命名白板（文件名与文档标题一起更新，id 不变）。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '白板 id（推荐）' },
      path: { type: 'string', description: '库内相对路径（没有 id 时用）' },
 title: { type: 'string', description: '新标题' }
    },
    required: ['title']
  },
  validate: (a) => ({ ...refArgs(a), title: requireString(a, 'title', { max: 200 }) }),
  async run({ id, path, title }) {
    const ref = id !== '' ? { id } : await findNoteByPath(safeRelPath(path, '白板路径'))
    const note = await ch('note:rename', [ref.id, title])
    return { summary: `白板已重命名为「${note.title}」`, text: `新路径：${note.dir === '' ? note.fileName : note.dir + '/' + note.fileName}`, data: { id: note.id, title: note.title } }
  }
}))

writeTools.push(tool({
  name: 'board_move',
  description: '把白板移动到另一个笔记夹（目标夹不存在会自动创建）。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '白板 id（推荐）' },
      path: { type: 'string', description: '库内相对路径（没有 id 时用）' },
      dir: { type: 'string', description: '目标笔记夹路径；留空=移到库根目录' }
    }
  },
  validate: (a) => ({ ...refArgs(a), dir: optionalDir(a) }),
  async run({ id, path, dir }) {
    const ref = id !== '' ? { id } : await findNoteByPath(safeRelPath(path, '白板路径'))
    const note = await ch('note:move', [ref.id, dir])
    return { summary: `白板「${note.title}」已移动到「${dir === '' ? '库根目录' : dir}」`, text: `新路径：${note.dir === '' ? note.fileName : note.dir + '/' + note.fileName}`, data: { id: note.id, dir: note.dir } }
  }
}))

writeTools.push(tool({
  name: 'board_trash',
  description: `删除白板 ${SAFE_NOTE}。`,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '白板 id（推荐）' },
      path: { type: 'string', description: '库内相对路径（没有 id 时用）' }
    }
  },
  validate: (a) => refArgs(a),
  async run({ id, path }) {
    const ref = id !== '' ? { id } : await findNoteByPath(safeRelPath(path, '白板路径'))
    await ch('note:delete', [ref.id])
    return { summary: '白板已移入回收站', text: `已删除 ${ref.id} ${SAFE_NOTE}`, data: { id: ref.id } }
  }
}))

/* ============================ 待办 ============================ */

writeTools.push(tool({
  name: 'todo_add',
  description: '新增一条**库内待办**（笔记软件里的待办，不是你的执行清单）。可带截止时间、标签、关联笔记。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
 name: { type: 'string', description: '待办内容' },
      ddl: { type: 'string', description: '截止时间（建议 ISO 形式，如 2026-10-05T18:00 或 2026-10-05）' },
      tagIds: { type: 'array', description: '标签 id 列表（先用 tag_list 查）', items: { type: 'string' } },
      priority: { type: 'string', enum: ['important', 'minor', 'optional'], description: '重要 / 次要 / 可选' },
      noteId: { type: 'string', description: '关联的笔记 id（可选）' }
    },
    required: ['name']
  },
  validate: (a) => ({
    name: requireString(a, 'name', { max: 300 }),
    ddl: a.ddl === undefined || a.ddl === null || a.ddl === '' ? undefined : String(a.ddl),
    tagIds: Array.isArray(a.tagIds) ? a.tagIds.map((x) => String(x)) : undefined,
    priority: a.priority === undefined || a.priority === '' ? undefined : optionalEnum(a, 'priority', ['important', 'minor', 'optional'], undefined),
    noteId: a.noteId === undefined || a.noteId === '' ? undefined : String(a.noteId)
  }),
  async run(input) {
    // 注意：库的 create 强制要求优先级（缺了会报"优先级不合法"），
    // 默认值与界面里的 TaskDialog 保持一致（'minor' = 次要）。
    const task = await ch('task:create', [{
      name: input.name,
      tagIds: input.tagIds ?? [],
      priority: input.priority ?? 'minor',
      ddl: input.ddl ?? null,
      noteId: input.noteId ?? null
    }])
    return {
      summary: `已新增待办「${task.name}」${task.ddl ? '（截止 ' + task.ddl + '）' : ''}`,
      text: `待办已创建：${task.name}\nid：${task.id}${task.ddl ? '\n截止：' + task.ddl : ''}${(task.tagIds ?? []).length ? '\n标签：' + task.tagIds.join(', ') : ''}${task.noteId ? '\n关联笔记：' + task.noteId : ''}`,
      data: { id: task.id, name: task.name, ddl: task.ddl, priority: task.priority, tagIds: task.tagIds, noteId: task.noteId }
    }
  }
}))

writeTools.push(tool({
  name: 'todo_update',
  description: [
    '改一条库内待办：内容、截止时间、优先级、标签、关联笔记。',
    '注意：**已完成的任务不能修改**（库的设计如此）；想改就先恢复成未完成——但库不支持取消完成，',
    '所以误标完成时请用 todo_trash 删掉再重建。'
  ].join(''),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
 id: { type: 'string', description: '待办 id' },
      name: { type: 'string', description: '新内容' },
      ddl: { type: 'string', description: '新截止时间；传空字符串表示清空' },
      priority: { type: 'string', enum: ['important', 'minor', 'optional'], description: '优先级' },
      tagIds: { type: 'array', description: '新的标签 id 列表（整组替换）', items: { type: 'string' } },
      noteId: { type: 'string', description: '关联笔记 id；传空字符串表示取消关联' }
    },
    required: ['id']
  },
  validate: (a) => {
    const patch = {}
    if (a.name !== undefined) patch.name = requireString(a, 'name', { max: 300 })
    if (a.ddl !== undefined) patch.ddl = a.ddl === '' ? null : String(a.ddl)
    if (a.priority !== undefined) patch.priority = optionalEnum(a, 'priority', ['important', 'minor', 'optional'], undefined)
    if (a.tagIds !== undefined) {
      if (!Array.isArray(a.tagIds)) throw new Error('参数「tagIds」必须是数组')
      patch.tagIds = a.tagIds.map((x) => String(x))
    }
    if (a.noteId !== undefined) patch.noteId = a.noteId === '' ? null : String(a.noteId)
    if (Object.keys(patch).length === 0) throw new Error('至少要给一个要改的字段（name / ddl / priority / tagIds / noteId）')
    return { id: requireString(a, 'id'), patch }
  },
  async run({ id, patch }) {
    const task = await ch('task:update', [id, patch])
    return { summary: `已更新待办「${task.name}」`, text: `已更新：${task.name}（改了 ${Object.keys(patch).join(', ')}）`, data: { id: task.id, name: task.name, ddl: task.ddl, priority: task.priority, tagIds: task.tagIds, noteId: task.noteId } }
  }
}))

writeTools.push(tool({
  name: 'todo_complete',
  description: '把一条库内待办标记为完成。注意：**完成不可撤销**（库的设计如此，界面里也写着"完成状态不可撤销"）；误标完成只能删掉重建。',
  parameters: {
    type: 'object',
    additionalProperties: false,
 properties: { id: { type: 'string', description: '待办 id' } },
    required: ['id']
  },
  validate: (a) => ({ id: requireString(a, 'id') }),
  async run({ id }) {
    const task = await ch('task:complete', [id])
    return { summary: `待办「${task?.name ?? id}」已完成`, text: `已完成：${task?.name ?? id}（不可撤销）`, data: { id, done: true } }
  }
}))

writeTools.push(tool({
  name: 'todo_trash',
  description: `删除一条库内待办 ${SAFE_NOTE}（待办回收站）。`,
  parameters: {
    type: 'object',
    additionalProperties: false,
 properties: { id: { type: 'string', description: '待办 id' } },
    required: ['id']
  },
  validate: (a) => ({ id: requireString(a, 'id') }),
  async run({ id }) {
    await ch('task:delete', [id])
    return { summary: '待办已移入回收站', text: `已删除待办 ${id} ${SAFE_NOTE}`, data: { id } }
  }
}))

/* ============================ 标签 ============================ */

writeTools.push(tool({
  name: 'tag_create',
  description: '新建标签（可指定父标签，形成层级）。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
 name: { type: 'string', description: '标签名称' },
      parentId: { type: 'string', description: '父标签 id；留空=顶层标签' }
    },
    required: ['name']
  },
  validate: (a) => ({ name: requireString(a, 'name', { max: 60 }), parentId: optionalString(a, 'parentId') }),
  async run({ name, parentId }) {
    const tag = await ch('tag:create', [name, parentId === '' ? null : parentId])
    return { summary: `已新建标签「${tag?.name ?? name}」`, text: `标签已创建：${tag?.name ?? name}\nid：${tag?.id ?? '?'}`, data: { id: tag?.id, name: tag?.name, parentId: tag?.parentId ?? null } }
  }
}))

writeTools.push(tool({
  name: 'tag_rename',
  description: '重命名标签（只改名字；用它标记过的待办会自动跟着显示新名字）。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
 id: { type: 'string', description: '标签 id' },
 name: { type: 'string', description: '新名称' }
    },
    required: ['id', 'name']
  },
  validate: (a) => ({ id: requireString(a, 'id'), name: requireString(a, 'name', { max: 60 }) }),
  async run({ id, name }) {
    const tag = await ch('tag:rename', [id, name])
    return { summary: `标签已改名为「${tag?.name ?? name}」`, text: `标签 ${id} → ${tag?.name ?? name}`, data: { id, name: tag?.name ?? name } }
  }
}))

writeTools.push(tool({
  name: 'tag_move',
  description: '把标签移到另一个标签下面（改变层级）。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
 id: { type: 'string', description: '标签 id' },
      parentId: { type: 'string', description: '新父标签 id；留空=移到顶层' }
    },
    required: ['id']
  },
  validate: (a) => ({ id: requireString(a, 'id'), parentId: optionalString(a, 'parentId') }),
  async run({ id, parentId }) {
    const tag = await ch('tag:move', [id, parentId === '' ? null : parentId])
    return { summary: `标签已移动`, text: `标签 ${tag?.name ?? id} 现在在 ${tag?.parentId ? '「' + tag.parentId + '」下面' : '顶层'}`, data: { id, parentId: tag?.parentId ?? null } }
  }
}))

writeTools.push(tool({
  name: 'tag_trash',
  description: '删除标签（用它标记过的待办不受影响，只是少了这个标签）。',
  parameters: {
    type: 'object',
    additionalProperties: false,
 properties: { id: { type: 'string', description: '标签 id' } },
    required: ['id']
  },
  validate: (a) => ({ id: requireString(a, 'id') }),
  async run({ id }) {
    await ch('tag:delete', [id])
    return { summary: '标签已删除', text: `已删除标签 ${id}`, data: { id } }
  }
}))

/* ============================ 回收站 ============================ */

/** 取一个字符串数组参数（元素非空） */
function idList(args, key = 'ids') {
  const raw = args[key]
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw !== '' ? [raw] : null)
  if (list === null || list.length === 0) throw new Error(`缺少参数「${key}」（要给出至少一个 id）`)
  if (list.length > 200) throw new Error(`一次最多 200 个 id（请分批）`)
  return list.map((x) => {
    if (typeof x !== 'string' || x.trim() === '') throw new Error(`「${key}」里的 id 必须是非空文本`)
    return x.trim()
  })
}

writeTools.push(tool({
  name: 'trash_restore',
  description: '把回收站里的东西恢复回去（笔记回到原位置；待办回到待办列表）。删除都是软删除，所以这是"误删找回"的正确手段。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['note', 'task'], description: '笔记回收站还是待办回收站' },
      ids: { type: 'array', description: '要恢复的 id 列表（先用 trash_list 查）', items: { type: 'string' } }
    },
    required: ['kind', 'ids']
  },
  validate: (a) => ({ kind: optionalEnum(a, 'kind', ['note', 'task'], 'note'), ids: idList(a) }),
  async run({ kind, ids }) {
    if (kind === 'note') {
      // 笔记回收站一次可以恢复多个（宿主收数组）
      await ch('trashNote:restore', [ids])
    } else {
      // 待办回收站一次只能恢复一个（宿主收单个 id），这里循环
      for (const id of ids) await ch('trashTask:restore', [id])
    }
    return { summary: `已从${kind === 'note' ? '笔记' : '待办'}回收站恢复 ${ids.length} 项`, text: `已恢复：${ids.join(', ')}`, data: { kind, ids } }
  }
}))

writeTools.push(tool({
  name: 'trash_purge',
  description: [
    '**彻底删除**（不可恢复）回收站里的东西。',
    '两条硬性要求：',
    '① 只有在用户**明确要求"彻底删除/永久删除"**时才能调用，并把 confirm 设为 true；用户只说"删掉"时请用 *_trash（进回收站，可恢复）。',
    '② 这个操作还会**连带清理整个库里"没有任何笔记引用"的附件**（笔记库的既有行为，清理范围是全库、不是你删的那一篇）。',
    '   如果库里存在这种附件，本工具会先拒绝一次并把清单给你 —— 请把这件事告诉用户，得到确认后再带 confirmOrphanCleanup=true 重试。'
  ].join('\n'),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: ['note', 'task'], description: '笔记回收站还是待办回收站' },
      ids: { type: 'array', description: '要彻底删除的 id 列表', items: { type: 'string' } },
      confirm: { type: 'boolean', description: '必须显式传 true 表示"用户已明确要求永久删除"' },
      confirmOrphanCleanup: { type: 'boolean', description: '已知会连带清理库里无人引用的附件，且用户已同意' }
    },
    required: ['kind', 'ids', 'confirm']
  },
  validate: (a) => {
    if (optionalBool(a, 'confirm') !== true) {
      throw new Error('这是不可恢复的彻底删除：需要用户明确要求，并在调用时把 confirm 设为 true')
    }
    return {
      kind: optionalEnum(a, 'kind', ['note', 'task'], 'note'),
      ids: idList(a),
      confirmOrphanCleanup: optionalBool(a, 'confirmOrphanCleanup')
    }
  },
  async run({ kind, ids, confirmOrphanCleanup }) {
    // 先查"会被连带清理的附件"（只读），不为空就必须先让用户知情
    let orphans = { count: 0, files: [] }
    try {
      orphans = await ch('attachment:orphans')
    } catch { /* 老版本宿主没有这个通道时跳过这道保护 */ }
    if ((orphans?.count ?? 0) > 0 && confirmOrphanCleanup !== true) {
      const sample = (orphans.files ?? []).slice(0, 8).join('、')
      throw new Error(
        `这道彻底删除还会**连带清理 ${orphans.count} 个"没有任何笔记引用"的附件**（清理范围是整个库，不是你删的那几条）。\n` +
        `例如：${sample}${orphans.count > 8 ? ' 等等' : ''}\n` +
        '请先把这一点告诉用户；用户确认后，带 confirmOrphanCleanup=true 再调用一次。\n' +
        '（如果用户其实只想删掉那几条内容、不想动附件，请改用 *_trash：进回收站，附件不会被清理。）'
      )
    }
    if (kind === 'note') await ch('trashNote:purge', [ids])
    else for (const id of ids) await ch('trashTask:purge', [id])
    const cleaned = (orphans?.count ?? 0) > 0 ? `\n同时清理了 ${orphans.count} 个无人引用的附件` : ''
    return {
      summary: `已彻底删除 ${ids.length} 项（不可恢复）${cleaned ? '，并清理 ' + orphans.count + ' 个孤立附件' : ''}`,
      text: `已永久删除：${ids.join(', ')}${cleaned}`,
      data: { kind, ids, orphanAttachmentsCleaned: orphans?.count ?? 0, orphanSample: (orphans?.files ?? []).slice(0, 20) }
    }
  }
}))

writeTools.push(tool({
  name: 'note_restore_origin',
  description: '把"从库外导入进来的笔记"移回它导入前的原始位置（撤销误导入）。只对记录过来源的笔记有效。',
  parameters: {
    type: 'object',
    additionalProperties: false,
 properties: { id: { type: 'string', description: '笔记 id' } },
    required: ['id']
  },
  validate: (a) => ({ id: requireString(a, 'id') }),
  async run({ id }) {
    const result = await ch('note:restoreOrigin', [id])
    return {
      summary: result?.moved === true ? '已移回原始位置' : '这篇笔记没有可用的原始位置记录',
      text: `moved=${result?.moved === true}，当前目录：${result?.dir ?? '（未知）'}`,
      data: { id, moved: result?.moved === true, dir: result?.dir ?? null }
    }
  }
}))

/* ============================ 附件 ============================ */

writeTools.push(tool({
  name: 'attachment_import',
  description: [
    '把一个**库外的文件**（任意绝对路径：图片、PDF、文档…）拷进笔记库的 `_attachments/`，',
    '返回库内相对路径（例如 `_attachments/图.png`）——之后可以在笔记里用 `![](该路径)` 引用，',
    '或用 board_edit 以 image 卡片引用它。同名文件会自动加序号，不会覆盖。'
  ].join(''),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
 sourcePath: { type: 'string', description: '库外文件的绝对路径' },
      name: { type: 'string', description: '存进库里的文件名（默认沿用原文件名）' }
    },
    required: ['sourcePath']
  },
  validate: (a) => ({ sourcePath: requireString(a, 'sourcePath', { hint: '绝对路径，例如 D:\\资料\\图.png' }), name: optionalString(a, 'name') }),
  async run({ sourcePath, name }) {
    const picked = await ch('attachment:import', [sourcePath, name === '' ? undefined : name])
    if (picked === null || picked === undefined) throw new Error('导入失败：宿主没有返回附件信息（路径可能不存在）')
    return {
      summary: `已导入附件「${picked.name}」`,
      text: `已导入：${picked.rel}\n在笔记里可以这样引用：![](${picked.rel})`,
      data: { rel: picked.rel, name: picked.name }
    }
  }
}))

writeTools.push(tool({
  name: 'attachment_list',
  description: '列出笔记库里的附件（`_attachments/` 下的文件：名字、大小、修改时间）。用于确认某个文件是否已经在库里。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      nameContains: { type: 'string', description: '只看文件名包含这段文字的项目（可选）' },
      limit: { type: 'integer', description: '最多列多少条（默认 100）' }
    }
  },
  validate: (a) => ({ nameContains: optionalString(a, 'nameContains'), limit: optionalNumber(a, 'limit', 100, 1, 1000) }),
  async run({ nameContains, limit }) {
    const root = await libraryRoot()
    const dir = join(root, 'notes', '_attachments')
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const st = statSync(join(dir, e.name))
          return { name: e.name, size: st.size, mtime: st.mtime.toISOString() }
        })
    } catch {
      return { summary: '还没有附件目录', text: '（库里还没有 _attachments 目录）', data: { count: 0, files: [] } }
    }
    if (nameContains !== '') entries = entries.filter((e) => e.name.toLowerCase().includes(nameContains.toLowerCase()))
    entries.sort((a, b) => b.mtime.localeCompare(a.mtime))
    const picked = entries.slice(0, limit)
    const lines = picked.map((e) => `· ${e.name}  ${fmtBytes(e.size)}  ${e.mtime.slice(0, 16).replace('T', ' ')}`)
    const total = entries.length
    return {
      summary: `附件共 ${total} 个${picked.length < total ? '（列出最近 ' + picked.length + ' 个）' : ''}`,
      text: lines.length === 0 ? '（没有符合条件的附件）' : `_attachments/ 下的文件：\n` + lines.join('\n'),
      data: { count: total, files: picked }
    }
  }
}))

/* ============================ 多库 ============================ */

writeTools.push(tool({
  name: 'library_switch',
  description: [
    '切换当前笔记库（切到另一个数据目录）。',
    '**只在用户明确要求换库时调用**，不要自作主张切换；切换后请回报当前库的名字与路径，',
    '并提醒用户面板里显示的内容也会跟着变。用 library_list 查看有哪些库可切。'
  ].join(''),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '库 id（推荐，来自 library_list）' },
      dir: { type: 'string', description: '库的绝对路径（没有 id 时用）' }
    }
  },
  validate: (a) => ({ id: optionalString(a, 'id'), dir: optionalString(a, 'dir') }),
  async run({ id, dir }) {
    if (id === '' && dir === '') throw new Error('要给 id 或 dir 其中之一（先用 library_list 看看有哪些库）')
    const before = await ch('libraries:list')
    const beforeName = (before?.items ?? []).find((l) => l.id === before.activeId)?.name ?? '（未知）'
    let viaCreate = false
    if (id !== '') {
      // 用 id 切：走 libraries:activate —— 它同时更新"服务层"与"注册表的 activeId"，两边一致
      await ch('libraries:activate', [id])
    } else {
      const normalized = dir.replace(/\\/g, '/').toLowerCase()
      const known = (before?.items ?? []).find((l) => String(l.dir).replace(/\\/g, '/').toLowerCase() === normalized)
      if (known !== undefined) {
        await ch('libraries:activate', [known.id])
      } else {
        // 没登记过的目录：走 libraries:create —— 它会把目录登记进注册表并激活。
        // （不能用 library:switch：那个只换服务层，注册表的 activeId 不动，两边会不一致）
        const leaf = dir.includes('\\') ? dir.slice(dir.lastIndexOf('\\') + 1) : (dir.includes('/') ? dir.slice(dir.lastIndexOf('/') + 1) : dir)
        await ch('libraries:create', [dir, leaf])
        viaCreate = true
      }
    }
    const after = await ch('libraries:list')
    const active = (after?.items ?? []).find((l) => l.id === after.activeId)
    const stats = await ch('library:stats')
    return {
      summary: `已从「${beforeName}」切换到「${active?.name ?? '?'}」${viaCreate ? '（新登记了这个目录）' : ''}`,
      text: `当前库：${active?.name ?? '?'}\n路径：${active?.dir ?? '?'}\n笔记数：${stats?.notes ?? '?'}\n（面板显示的内容也会跟着变）`,
      data: { from: beforeName, id: active?.id ?? null, name: active?.name ?? null, dir: active?.dir ?? null, notes: stats?.notes ?? null, registered: viaCreate }
    }
  }
}))
