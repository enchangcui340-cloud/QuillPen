/**
 * 「羽毛笔」工具层（P1：只读工具）。
 *
 * 这一层是**模式专属**的：它被 agent preset 的插件列表引用（`dsh-quill/tools`），
 * 所以只有「羽毛笔」模式看得见这些工具，标准模式不受影响。
 *
 * 实现取向：
 *   · 所有工具都**复用面板那套 runtime 与 90 个宿主通道**（见 runtime.js），
 *     因此天然继承原子写、id 生成、frontmatter、回收站、冲突检测等语义；
 *   · 不引入 `@deepseek-ai/dsh-tools` 依赖（它牵连一堆内部包、版本耦合重），
 *     这里按 `ToolDefinition` 契约手写等价薄层：自己校验参数、自带 output.schema。
 *     注意：注册表会拿 output.schema 校验返回值，所以每个工具都返回同一个形状
 *     `{ ok, summary, text, data }`，schema 里 data 用"注解式"（不约束形状）。
 *
 *   · 路径一律是**库内相对路径**；拒绝绝对路径与 `..` 逃逸。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// 公共设施（返回值 schema、参数校验、库内路径解析、通道调用、树摊平）统一放在 tool-kit.js
// —— 读写工具共用同一套语义，避免两份实现跑偏。
import {
  ch, displayTitle, findNoteByPath, flatten, fmtBytes, folderOf, libraryRoot, optionalEnum, optionalNumber,
  optionalString, requireString, resolveNoteRef, safeRelPath, tool, truncate
} from './tool-kit.js'
import { writeTools } from './tools-write.js'
import { syncSkillHandbook } from './skill-sync.js'

export const name = 'dsh-quill-user-tools'
export const inject = ['tools']

/* ============================ 工具定义 ============================ */

const tools = []

/* ---- 1. 库概览 ---- */
tools.push(tool({
  name: 'notes_overview',
  description: '看清笔记库的现状：当前是哪个库、有多少笔记与白板、有哪些笔记夹、标签树、未完成待办、回收站条数。动手做任何笔记相关的事之前先调用它。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  validate: () => ({}),
  async run() {
    const [info, stats, tree, tags, tasks, trashNotes, libs] = await Promise.all([
      ch('app:info'), ch('library:stats'), ch('note:tree'), ch('tag:list'), ch('task:list'), ch('trashNote:list'), ch('libraries:list')
    ])
    const flat = flatten(tree)
    const folders = flat.filter((n) => n.type === 'folder')
    const notes = flat.filter((n) => n.type === 'note' && n.kind === 'md')
    const boards = flat.filter((n) => n.type === 'note' && n.kind === 'whiteboard')
    const open = (tasks ?? []).filter((t) => !t.done)
    const lines = []
    lines.push(`当前库：${info?.libraryPath ?? '（未知）'}`)
    lines.push(`统计：笔记 ${notes.length} 篇 / 白板 ${boards.length} 块 / 笔记夹 ${folders.length} 个 / 标签 ${tags?.length ?? 0} 个`)
    lines.push(`待办：未完成 ${open.length} 条，已完成 ${(tasks?.length ?? 0) - open.length} 条；回收站 ${trashNotes?.length ?? 0} 项`)
    lines.push(`库总量：${stats?.notes ?? '?'} 篇，${fmtBytes(stats?.sizeBytes ?? 0)}`)
    if (folders.length > 0) {
      lines.push('\n笔记夹：')
      for (const f of folders) lines.push(`  · ${f.path}（${f.children} 项）`)
    }
    if (open.length > 0) {
      lines.push('\n未完成待办：')
      for (const t of open.slice(0, 20)) lines.push(`  · ${t.name}${t.ddl ? '（' + t.ddl + '）' : ''}${t.done ? '' : ''}`)
      if (open.length > 20) lines.push(`  …还有 ${open.length - 20} 条`)
    }
    if ((libs?.items ?? []).length > 1) {
      lines.push('\n所有笔记库：')
      for (const l of libs.items) lines.push(`  · ${l.name}${l.id === libs.activeId ? '（当前）' : ''} — ${l.dir}`)
    }
    const summary = `库「${info?.libraryPath ?? '?'}」：笔记 ${notes.length} / 白板 ${boards.length} / 未完成待办 ${open.length}`
    return {
      summary,
      text: lines.join('\n'),
      data: {
        libraryPath: info?.libraryPath ?? null,
        counts: { notes: notes.length, boards: boards.length, folders: folders.length, tags: tags?.length ?? 0, openTodos: open.length, trash: trashNotes?.length ?? 0 },
        folders: folders.map((f) => ({ path: f.path, items: f.children })),
        libraries: (libs?.items ?? []).map((l) => ({ id: l.id, name: l.name, dir: l.dir, active: l.id === libs.activeId }))
      }
    }
  }
}))

/* ---- 2. 搜索 ---- */
tools.push(tool({
  name: 'notes_search',
  description: '在笔记库里搜内容：同时搜笔记标题、笔记正文、白板卡片上的文字。返回命中的文件（含笔记 id 与库内相对路径）与上下文片段。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
 query: { type: 'string', description: '要搜的关键词或短语' },
      limit: { type: 'integer', description: '最多返回多少个文件（默认 20）' },
      scanLimit: { type: 'integer', description: '最多扫描多少个文件（默认 800）' }
    },
    required: ['query']
  },
  validate: (a) => ({ query: requireString(a, 'query', { max: 200 }), limit: optionalNumber(a, 'limit', 20, 1, 100), scanLimit: optionalNumber(a, 'scanLimit', 800, 1, 5000) }),
  async run({ query, limit, scanLimit }) {
    const root = await libraryRoot()
    const tree = await ch('note:tree')
    const entries = flatten(tree).filter((n) => n.type === 'note')
    const needle = query.toLowerCase()
    const matches = []
    let scanned = 0
    for (const e of entries) {
      if (matches.length >= limit || scanned >= scanLimit) break
      const abs = join(root, 'notes', e.path)
      let raw = ''
      try {
        if (statSync(abs).size > 4 * 1024 * 1024) continue
        raw = readFileSync(abs, 'utf8')
      } catch { continue }
      scanned++
      const hits = []
      const lines = raw.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) hits.push({ line: i + 1, text: truncate(lines[i].trim(), 160) })
        if (hits.length >= 3) break
      }
      const titleHit = e.name.toLowerCase().includes(needle)
      if (hits.length > 0 || titleHit) {
        matches.push({ id: e.id, path: e.path, kind: e.kind, titleHit, hits })
      }
    }
    const lines = [`搜索「${query}」：${matches.length} 个文件命中（扫描了 ${scanned} 个文件）`]
    for (const m of matches) {
      lines.push(`\n· ${m.path}${m.kind === 'whiteboard' ? '（白板）' : ''}${m.titleHit ? ' ← 文件名命中' : ''}  id=${m.id}`)
      for (const h of m.hits) lines.push(`    第 ${h.line} 行：${h.text}`)
    }
    if (scanned >= scanLimit) lines.push(`\n（达到扫描上限 ${scanLimit} 个文件，结果可能不全）`)
    return { summary: `「${query}」命中 ${matches.length} 个文件`, text: lines.join('\n'), data: { query, matches, scanned, truncated: scanned >= scanLimit } }
  }
}))

/* ---- 3. 笔记夹 ---- */
tools.push(tool({
  name: 'folder_list',
  description: '列出笔记库里的所有笔记夹（含嵌套层级与每个夹的条目数）。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  validate: () => ({}),
  async run() {
    const tree = await ch('note:tree')
    const flat = flatten(tree)
    const folders = flat.filter((n) => n.type === 'folder')
    const lines = folders.length === 0 ? ['（还没有笔记夹）'] : folders.map((f) => `· ${f.path}（${f.children} 项）`)
    return { summary: `共 ${folders.length} 个笔记夹`, text: lines.join('\n'), data: { folders: folders.map((f) => ({ path: f.path, items: f.children })) } }
  }
}))

/* ---- 4. 条目列表 ---- */
tools.push(tool({
  name: 'note_list',
  description: '列出笔记与白板。可按笔记夹（dir）过滤（空字符串表示库根目录），也可按类型（kind）过滤。返回每条的 id、标题、库内相对路径 —— 后续读写都用这些 id。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      dir: { type: 'string', description: '笔记夹的库内相对路径；留空=库根目录；填 "*" 表示不限层级（全部）' },
      kind: { type: 'string', enum: ['md', 'whiteboard', 'all'], description: '只看笔记 / 只看白板 / 都看（默认）' }
    }
  },
  validate: (a) => ({
    dir: a.dir === undefined || a.dir === null ? '' : String(a.dir),
    kind: optionalEnum(a, 'kind', ['md', 'whiteboard', 'all'], 'all')
  }),
  async run({ dir, kind }) {
    const tree = await ch('note:tree')
    const all = flatten(tree)
    const notes = all.filter((n) => n.type === 'note')
    const anyLevel = dir === '*'
    const wantDir = anyLevel ? '' : safeRelPath(dir, '笔记夹路径')
    const picked = notes.filter((n) => {
      if (kind !== 'all' && n.kind !== kind) return false
      if (anyLevel) return true
      if (wantDir === '') return n.dir === ''
      return n.dir === wantDir || n.dir.startsWith(wantDir + '/')
    })
    const lines = picked.map((n) => `· [${n.kind === 'whiteboard' ? '白板' : '笔记'}] ${n.path}  id=${n.id}`)
    return {
      summary: `${anyLevel ? '全库' : (wantDir === '' ? '库根目录' : wantDir)}：${picked.length} 项`,
      text: lines.length === 0 ? '（这个范围里没有内容）' : lines.join('\n'),
      data: {
        dir: anyLevel ? '*' : wantDir,
        kind,
        // 树里只有文件名（`xxx.md` / `xxx.canvas.json`），这里去掉扩展名当作显示标题，
        // 与界面、与 board_read/note_read 的 title 保持一致
        items: picked.map((n) => ({ id: n.id, kind: n.kind, title: displayTitle(n.name), path: n.path }))
      }
    }
  }
}))

/* ---- 5. 读笔记 ---- */
tools.push(tool({
  name: 'note_read',
  description: '读一篇 Markdown 笔记的正文（原文，含 frontmatter）。用 id 或库内相对路径（path）指定。白板请用 board_read。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '笔记 id（推荐，来自 notes_overview / note_list / notes_search）' },
      path: { type: 'string', description: '库内相对路径（没有 id 时用），例如 "课程/第一课.md"' }
    }
  },
  validate: (a) => ({ id: typeof a.id === 'string' ? a.id : undefined, path: typeof a.path === 'string' ? a.path : undefined }),
  async run(ref) {
    const { id } = await resolveNoteRef(ref)
    const res = await ch('note:read', [id])
    const note = res?.note
    if (note === undefined || note === null) throw new Error('读不到这篇笔记：' + id)
    if (note.kind === 'whiteboard') throw new Error(`「${note.title}」是白板，请用 board_read(id="${id}")`)
    const content = String(res?.content ?? '')
    return {
      summary: `读到「${note.title}」（${content.length} 字）`,
      text: `【${note.title}】\n路径：${note.dir === '' ? note.fileName : note.dir + '/' + note.fileName}\nid：${note.id}\n更新：${note.updatedAt}\n\n----- 正文 -----\n${content}`,
      data: { id: note.id, title: note.title, kind: note.kind, path: note.dir === '' ? note.fileName : note.dir + '/' + note.fileName, content, updatedAt: note.updatedAt }
    }
  }
}))

/* ---- 6. 白板列表 ---- */
tools.push(tool({
  name: 'board_list',
  description: '列出笔记库里的所有白板（id、标题、路径、卡片数与连线数）。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  validate: () => ({}),
  async run() {
    const tree = await ch('note:tree')
    const boards = flatten(tree).filter((n) => n.type === 'note' && n.kind === 'whiteboard')
    const lines = []
    const data = []
    for (const b of boards) {
      let counts = '（读取失败）'
      let nodeCount = null
      let edgeCount = null
      try {
        const board = await ch('board:read', [b.id])
        nodeCount = (board?.nodes ?? []).length
        edgeCount = (board?.edges ?? []).length
        counts = `${nodeCount} 张卡片 / ${edgeCount} 条连线`
      } catch { /* 保留失败标记 */ }
      lines.push(`· ${b.path}（${counts}）  id=${b.id}`)
      data.push({ id: b.id, title: displayTitle(b.name), path: b.path, nodes: nodeCount, edges: edgeCount })
    }
    return { summary: `共 ${boards.length} 块白板`, text: lines.length === 0 ? '（还没有白板）' : lines.join('\n'), data: { boards: data } }
  }
}))

/* ---- 7. 读白板 ---- */
tools.push(tool({
  name: 'board_read',
  description: '读一块白板的全部内容：卡片（id、类型、位置 x/y、尺寸 w/h、底色、文字或引用的图片/笔记）、连线（id、从哪张到哪张、边、线上文字）与绘制的图形（id、种类、颜色、位置或控制点）。画白板前先读它，改白板时按 id 定位。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: '白板 id（推荐）' },
      path: { type: 'string', description: '库内相对路径（没有 id 时用）' }
    }
  },
  validate: (a) => ({ id: typeof a.id === 'string' ? a.id : undefined, path: typeof a.path === 'string' ? a.path : undefined }),
  async run(ref) {
    const { id } = await resolveNoteRef(ref)
    const board = await ch('board:read', [id])
    if (board === undefined || board === null) throw new Error('读不到这块白板：' + id)
    const nodes = board.nodes ?? []
    const edges = board.edges ?? []
    const shapes = board.shapes ?? []
    const lines = [`白板「${board.title}」 id=${board.id}  卡片 ${nodes.length} / 连线 ${edges.length} / 图形 ${shapes.length}`]
    lines.push('\n卡片：')
    for (const n of nodes.slice(0, 300)) {
      const label = n.type === 'text' ? truncate(n.text ?? '', 120)
        : n.type === 'image' ? `图片 ${n.src ?? '(无)'}`
          : n.type === 'note' ? `笔记引用 ${n.noteId ?? '(无)'}`
            : `链接 ${n.url ?? ''}`
      lines.push(`  · ${n.id} [${n.type}] x=${n.x} y=${n.y} w=${n.w} h=${n.h}${n.color ? ' 底色=' + n.color : ''}${n.fontSize ? ' 字号=' + n.fontSize : ''}${n.bold ? ' 加粗' : ''}  ${label}`)
    }
    if (nodes.length > 300) lines.push(`  …还有 ${nodes.length - 300} 张（本工具单次只列 300 张）`)
    if (edges.length > 0) {
      lines.push('\n连线：')
      for (const e of edges.slice(0, 300)) lines.push(`  · ${e.id} ${e.from} → ${e.to}${e.label ? '  「' + e.label + '」' : ''}${e.fromSide ? ' 从' + e.fromSide : ''}${e.toSide ? ' 进' + e.toSide : ''}`)
    }
    // 绘制的图形：几何图形报 x/y/w/h，线类报控制点。AI 看不到它们就会把新卡片排到图形上。
    if (shapes.length > 0) {
      lines.push('\n图形：')
      for (const s of shapes.slice(0, 300)) {
        const isLine = s.kind === 'line' || s.kind === 'arrow' || s.kind === 'curve' || s.kind === 'free'
        const where = isLine
          ? (s.points ?? []).map((p) => `(${Math.round(p.x)},${Math.round(p.y)})`).join(' → ')
          : `x=${Math.round(s.x ?? 0)} y=${Math.round(s.y ?? 0)} w=${Math.round(s.w ?? 0)} h=${Math.round(s.h ?? 0)}`
        lines.push(`  · ${s.id} [${s.kind}] 色=${s.color}  ${where}`)
      }
      if (shapes.length > 300) lines.push(`  …还有 ${shapes.length - 300} 个（本工具单次只列 300 个）`)
    }
    return {
      summary: `白板「${board.title}」：${nodes.length} 张卡片 / ${edges.length} 条连线 / ${shapes.length} 个图形`,
      text: lines.join('\n'),
      data: { id: board.id, title: board.title, nodes, edges, shapes }
    }
  }
}))

/* ---- 8. 待办 ---- */
tools.push(tool({
  name: 'todo_list',
  description: '列出笔记库里的待办（这是笔记软件中的待办，不是你自己的执行清单）。可按状态过滤，返回 id、内容、是否完成、截止时间、标签、关联笔记。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { status: { type: 'string', enum: ['open', 'done', 'all'], description: '未完成（默认）/ 已完成 / 全部' } }
  },
  validate: (a) => ({ status: optionalEnum(a, 'status', ['open', 'done', 'all'], 'open') }),
  async run({ status }) {
    const tasks = await ch('task:list')
    const tags = await ch('tag:list')
    const tagName = new Map((tags ?? []).map((t) => [t.id, t.name]))
    const picked = (tasks ?? []).filter((t) => (status === 'all' ? true : status === 'done' ? t.done : !t.done))
    const lines = picked.map((t) => {
      const names = (t.tagIds ?? []).map((id) => tagName.get(id) ?? id)
      return `· ${t.done ? '[已完成] ' : ''}${t.name}${t.ddl ? '（截止 ' + t.ddl + '）' : ''}${names.length ? ' 标签：' + names.join('/') : ''}${t.noteId ? ' 关联笔记：' + t.noteId : ''}  id=${t.id}`
    })
    return {
      summary: `${status === 'open' ? '未完成' : status === 'done' ? '已完成' : '全部'}待办：${picked.length} 条`,
      text: lines.length === 0 ? '（没有符合条件的待办）' : lines.join('\n'),
      data: { status, todos: picked.map((t) => ({ id: t.id, name: t.name, done: t.done, ddl: t.ddl, priority: t.priority, tagIds: t.tagIds ?? [], noteId: t.noteId })) }
    }
  }
}))

/* ---- 9. 标签 ---- */
tools.push(tool({
  name: 'tag_list',
  description: '列出标签树（id、名称、父标签）。给待办挂标签时用这里的 id。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  validate: () => ({}),
  async run() {
    const tags = await ch('tag:list')
    const byParent = new Map()
    for (const t of tags ?? []) {
      const key = t.parentId ?? ''
      if (!byParent.has(key)) byParent.set(key, [])
      byParent.get(key).push(t)
    }
    const lines = []
    const walk = (parent, depth) => {
      for (const t of byParent.get(parent) ?? []) {
        lines.push('  '.repeat(depth) + `· ${t.name}  id=${t.id}`)
        walk(t.id, depth + 1)
      }
    }
    walk('', 0)
    return { summary: `共 ${(tags ?? []).length} 个标签`, text: lines.length === 0 ? '（还没有标签）' : lines.join('\n'), data: { tags: tags ?? [] } }
  }
}))

/* ---- 10. 回收站 ---- */
tools.push(tool({
  name: 'trash_list',
  description: '列出回收站内容（笔记与待办）。删除的内容会进回收站、可恢复，所以这里是"误删找回"的第一步。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { kind: { type: 'string', enum: ['note', 'task', 'all'], description: '笔记回收站 / 待办回收站 / 两个都看（默认）' } }
  },
  validate: (a) => ({ kind: optionalEnum(a, 'kind', ['note', 'task', 'all'], 'all') }),
  async run({ kind }) {
    const out = []
    let notes = []
    if (kind === 'note' || kind === 'all') {
      notes = await ch('trashNote:list')
      out.push(`笔记回收站（${(notes ?? []).length} 项）：`)
      for (const n of notes ?? []) out.push(`  · [${n.kind === 'whiteboard' ? '白板' : '笔记'}] ${n.title}  原位置：${n.originalDir === '' ? '（库根）' : n.originalDir}  删除于 ${n.deletedAt}  id=${n.id}`)
    }
    let tasks = []
    if (kind === 'task' || kind === 'all') {
      tasks = await ch('trashTask:list')
      out.push(`待办回收站（${(tasks ?? []).length} 项）：`)
      for (const t of tasks ?? []) out.push(`  · ${t.task?.name ?? '?'}  删除于 ${t.deletedAt}  id=${t.task?.id ?? '?'}`)
    }
    const noteCount = (notes ?? []).length + (tasks ?? []).length
    return {
      summary: `${kind === 'all' ? '回收站' : kind === 'note' ? '笔记回收站' : '待办回收站'}共 ${noteCount} 项`,
      text: out.join('\n'),
      data: {
        kind,
        notes: (notes ?? []).map((n) => ({ id: n.id, kind: n.kind, title: n.title, originalDir: n.originalDir, deletedAt: n.deletedAt })),
        tasks: (tasks ?? []).map((t) => ({ id: t.task?.id, name: t.task?.name, deletedAt: t.deletedAt }))
      }
    }
  }
}))

/* ---- 11.5 孤立附件（只查不删） ---- */
tools.push(tool({
  name: 'attachment_orphans',
  description: [
    '列出 `_attachments/` 里**没有任何笔记/白板引用**的附件（只查不删）。',
    '为什么要关心它：库的"彻底删除"会连带清理这些文件，所以这份清单就是"一旦彻底删除会牵连到谁"。',
    '也可以用它提醒用户：库里有不少历史附件已经没人引用了。'
  ].join(''),
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  validate: () => ({}),
  async run() {
    const result = await ch('attachment:orphans')
    const files = result?.files ?? []
    const lines = files.slice(0, 50).map((f) => '· ' + f)
    return {
      summary: `有 ${result?.count ?? 0} 个无人引用的附件`,
      text: (files.length === 0 ? '（没有孤儿附件：所有附件都还被笔记引用着）' :
        `无人引用的附件（共 ${result.count} 个，列出前 50）：\n` + lines.join('\n')) +
        (files.length > 50 ? `\n…还有 ${files.length - 50} 个` : ''),
      data: { count: result?.count ?? 0, files: files.slice(0, 200) }
    }
  }
}))

/* ---- 11.6 文档保真读取 ---- */
tools.push(tool({
  name: 'doc_read',
  description: [
    '读一个文档的内容（给**绝对路径**，或库内相对路径）。三种情况：',
    '· PDF：**逐页渲染成图片**存进库内 `_attachments/`，并把每页的库内路径给你 —— 扫描件/纯图片 PDF 也能读；',
    '  拿到路径后请**逐页调用 read_image** 看图（有文本层时也会顺带给你文本）；',
    '· Office（docx/pptx/xlsx/xls）、HTML、CSV、文本：抽取文字给你；',
    '· 图片：直接把可引用的库内路径给你（库外的会先拷进库内）。',
    '参数：pages 只看指定页（如 [1,3]）；scale 渲染倍率 1~3（默认 2，字小可以调大）；maxPages 上限（默认 100）。'
  ].join('\n'),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
 path: { type: 'string', description: '文件路径（绝对路径，或库内相对路径）' },
      pages: { type: 'array', description: 'PDF 只渲染这几页（页码从 1 开始）', items: { type: 'integer' } },
      scale: { type: 'integer', description: 'PDF 渲染倍率 1~3（默认 2）' },
      maxPages: { type: 'integer', description: 'PDF 最多渲染多少页（默认 100）' }
    },
    required: ['path']
  },
  validate: (a) => {
    const path = requireString(a, 'path', { hint: '绝对路径或库内相对路径' })
    const pages = Array.isArray(a.pages) ? a.pages.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0) : undefined
    return { path, pages, scale: optionalNumber(a, 'scale', 2, 1, 3), maxPages: optionalNumber(a, 'maxPages', 100, 1, 500) }
  },
  async run({ path, pages, scale, maxPages }) {
    const result = await ch('doc:read', [path, { pages, scale, maxPages }])
    const kindLabel = result.kind === 'pdf' ? 'PDF' : result.kind === 'image' ? '图片' : '文档'
    const lines = []
    lines.push(`${kindLabel}：${result.name}（${fmtBytes(result.size)}）`)
    if (result.kind === 'pdf') {
      lines.push(`共 ${result.totalPages} 页，已渲染 ${result.pages.length} 页为图片：`)
      for (const p of result.pages) lines.push(`  · 第 ${p.page} 页 → ${p.rel}（${fmtBytes(p.bytes)}${p.chars > 0 ? '，含文本层 ' + p.chars + ' 字' : '，无文本层'}）`)
      lines.push('下一步：对上面每个路径调用 read_image 逐页查看，才能拿到准确内容。')
      if (result.text !== '') lines.push('\n文本层内容（可能不完整）：\n' + truncate(result.text, 2000))
    } else if (result.kind === 'image') {
      lines.push(`库内路径：${result.rel}`)
      lines.push('下一步：用 read_image 看这个文件。')
    } else {
      lines.push('抽取到的内容：')
      lines.push(truncate(result.text ?? '', 6000))
    }
    if (result.warning) lines.push('\n注意：' + result.warning)
    if (result.note) lines.push('\n（' + result.note + '）')
    return {
      summary: result.kind === 'pdf'
        ? `已把「${result.name}」的 ${result.pages.length}/${result.totalPages} 页渲染成图片`
        : result.kind === 'image'
          ? `「${result.name}」是图片，已给出库内路径`
          : `已抽取「${result.name}」的文本（${(result.text ?? '').length} 字）`,
      text: lines.join('\n'),
      data: {
        kind: result.kind,
        path: result.path,
        name: result.name,
        size: result.size,
        totalPages: result.totalPages,
        pages: result.pages,
        rel: result.rel,
        chars: (result.text ?? '').length
      }
    }
  }
}))

/* ---- 11.7 自带手册 ---- */
tools.push(tool({
  name: 'notes_handbook',
  description: [
    '取出「羽毛笔」的完整操作手册（工具地图、白板绘制规范、文档保真读取、常见配方、红线、这个库的特性）。',
    '**动手做笔记/白板/待办之前先读它**；第一次调用建议不带 section 读全文，之后按需读某一节。',
    '可用的节名（section）：概览、出口契约、工具地图、白板绘制规范、文档保真读取、常见配方、红线、库特性、交付自检'
  ].join('\n'),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      section: { type: 'string', description: '只看某一节（给出标题里的关键词即可，例如「白板」「红线」「配方」）' }
    }
  },
  validate: (a) => ({ section: optionalString(a, 'section') }),
  async run({ section }) {
    const here = dirname(fileURLToPath(import.meta.url))
    const candidates = [
      join(here, '..', 'skills', 'notes-assistant-user', 'SKILL.md'),
      join(here, 'skills', 'notes-assistant-user', 'SKILL.md')
    ]
    const file = candidates.find((c) => existsSync(c))
    if (file === undefined) throw new Error('包内找不到手册文件（skills/notes-assistant-user/SKILL.md）')
    const raw = readFileSync(file, 'utf8')
    // 去掉 frontmatter：那是给 DSH 技能目录看的，正文才是要给模型看的
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    if (section === '') {
      return {
        summary: `手册全文 ${body.length} 字`,
        text: body,
        data: { file, chars: body.length, section: null }
      }
    }
    // 按二级标题切节：命中关键词的那一节（到下一个同级标题为止）
    const lines = body.split('\n')
    const wanted = section.replace(/^#+\s*/, '').trim()
    let start = -1
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i]) && lines[i].includes(wanted)) { start = i; break }
    }
    if (start === -1) {
      const titles = lines.filter((l) => /^##\s+/.test(l)).map((l) => l.replace(/^##\s+/, ''))
      throw new Error(`手册里没有匹配「${section}」的小节。可用小节：\n  · ` + titles.join('\n  · '))
    }
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) { end = i; break }
    }
    const text = lines.slice(start, end).join('\n').trim()
    return {
      summary: `手册「${lines[start].replace(/^##\s+/, '')}」共 ${text.length} 字`,
      text,
      data: { file, chars: text.length, section: lines[start].replace(/^##\s+/, '') }
    }
  }
}))

/* ---- 12. 多库 ---- */
tools.push(tool({
  name: 'library_list',
  description: '列出本机所有笔记库（名称、路径、是否当前）。用户要"换一个库"时先看这里，再用 library_switch 切换。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  validate: () => ({}),
  async run() {
    const libs = await ch('libraries:list')
    const lines = (libs?.items ?? []).map((l) => `· ${l.name}${l.id === libs.activeId ? '（当前）' : ''}  ${l.kind === 'cloud' ? '[云] ' : ''}${l.dir}${l.exists === false ? '  ⚠️ 目录不存在' : ''}  id=${l.id}`)
    return {
      summary: `共 ${(libs?.items ?? []).length} 个笔记库，当前：${(libs?.items ?? []).find((l) => l.id === libs.activeId)?.name ?? '?'}`,
      text: lines.length === 0 ? '（没有登记任何库）' : lines.join('\n'),
      data: { activeId: libs?.activeId ?? null, libraries: (libs?.items ?? []).map((l) => ({ id: l.id, name: l.name, dir: l.dir, kind: l.kind, active: l.id === libs.activeId })) }
    }
  }
}))

/* ============================ 注册 ============================ */

export function apply(ctx) {
  // 顺手把「羽毛笔」技能手册装到 DSH 的技能根（rank 400）。外壳也会调一次，
  // 谁先跑谁装 —— 这样无论"面板先激活"还是"预设先挂载工具层"，手册都不会漏装。
  try {
    const result = syncSkillHandbook(ctx.logger)
    if (result.synced !== true) ctx.logger?.info?.(`[羽毛笔] 技能手册：${result.reason}`)
  } catch (e) {
    ctx.logger?.warn?.('[羽毛笔] 同步技能手册失败（不影响工具）：' + String(e?.message ?? e))
  }
  const all = [...tools, ...writeTools]
  for (const definition of all) ctx.tools.register(definition)
  ctx.logger?.info?.(`[羽毛笔] 已注册 ${all.length} 个笔记工具（只读 ${tools.length} + 写入 ${writeTools.length}）`)
}
