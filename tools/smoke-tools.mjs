/**
 * 「羽毛笔」工具层冒烟（P1 只读 + P2 写入 + P3 回收站/附件/多库）。
 *
 * 做法：不经过 DSH，直接用假的 ctx 收集工具定义，然后在**库副本**上真调每一个工具，
 * 断言返回结构与内容都说得通（写入类还要求"调用后磁盘/库里真的变了"）；
 * 再做越界与错误路径的负向测试。
 * 全程对**用户真实库**做快照比对，保证测试没碰到真数据。
 *
 *   node tools/smoke-tools.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LIBRARY_SNAPSHOT, REAL_LIBRARY, packageDirName, ROOT } from './paths.mjs'

const SRC_LIB = LIBRARY_SNAPSHOT
const work = join(join(ROOT, '.tmp', 'smoke-tools'), new Date().toISOString().replace(/[:.]/g, '-'))
const libDir = join(work, 'lib')
const dataDir = join(work, 'data')
mkdirSync(work, { recursive: true })
cpSync(SRC_LIB, libDir, { recursive: true })

// 测试隔离：指向副本 + 不继承真实库注册表
process.env.DSH_QUILL_LIBRARY_ROOT = libDir
process.env.DSH_QUILL_DATA_DIR = dataDir
process.env.DSH_QUILL_NO_REGISTRY_INHERIT = '1'

/* ---------- 真实数据护栏 ---------- */
const REAL_PATHS = [
  REAL_LIBRARY,
  join(process.env.APPDATA ?? '', 'workapp')
]
function snapshot(root) {
  const map = new Map()
  const walk = (dir, prefix) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const rel = prefix === '' ? e.name : prefix + '/' + e.name
      const abs = join(dir, e.name)
      if (e.isDirectory()) { walk(abs, rel); continue }
      try { const st = statSync(abs); map.set(rel, `${st.size}:${st.mtimeMs}`) } catch { /* 忽略 */ }
    }
  }
  walk(root, '')
  return map
}
const realBefore = REAL_PATHS.map((p) => [p, snapshot(p)])

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`)
}

/* ---------- 收集工具定义 ---------- */
const definitions = []
const fakeCtx = { tools: { register: (d) => { definitions.push(d); return () => {} } }, logger: { info: () => {} } }
const mod = await import('../packages/' + packageDirName() + '/lib/tools.js')
mod.apply(fakeCtx)

const byName = new Map(definitions.map((d) => [d.name, d]))
const call = async (name, args = {}) => {
  const def = byName.get(name)
  if (def === undefined) throw new Error('没有这个工具：' + name)
  return await def.execute(args, { signal: undefined })
}

console.log(`\n=== 注册检查（共 ${definitions.length} 个工具） ===`)
check(`工具数量 = 42（只读/系统 14 + 写入 28）`, definitions.length === 42, `实际 ${definitions.length}：` + definitions.map((d) => d.name).join(', '))
const shapeOk = definitions.every((d) =>
  typeof d.name === 'string' && d.name !== '' &&
  typeof d.description === 'string' && d.description.length > 10 &&
  typeof d.parameters === 'object' &&
  typeof d.output?.schema === 'object' &&
  typeof d.output?.render === 'function' &&
  typeof d.execute === 'function')
check('每个工具都有 name/description/parameters/output.schema/output.render/execute', shapeOk)
check('返回 schema 与 execute 返回值形状一致（ok/summary/text）',
  definitions.every((d) => ['ok', 'summary', 'text'].every((k) => Object.prototype.hasOwnProperty.call(d.output.schema.properties, k))))

/* ---------- 只读工具逐个调用 ---------- */
console.log('\n=== 只读工具调用 ===')

const overview = await call('notes_overview')
check('notes_overview 返回统计', overview.ok === true && overview.data.counts.notes > 0,
  `笔记 ${overview.data.counts.notes} / 白板 ${overview.data.counts.boards} / 夹 ${overview.data.counts.folders} / 待办未完成 ${overview.data.counts.openTodos}`)

const folders = await call('folder_list')
check('folder_list 能列出笔记夹', folders.ok === true, folders.summary)

const all = await call('note_list', { dir: '*' })
check('note_list(dir="*") 列出全部', all.ok === true && all.data.items.length > 0, all.summary)

const mdOnly = await call('note_list', { dir: '*', kind: 'md' })
const boardsOnly = await call('note_list', { dir: '*', kind: 'whiteboard' })
check('note_list 按 kind 过滤生效', mdOnly.data.items.every((i) => i.kind === 'md') && boardsOnly.data.items.every((i) => i.kind === 'whiteboard'),
  `md ${mdOnly.data.items.length} / whiteboard ${boardsOnly.data.items.length}`)

const firstNote = mdOnly.data.items[0]
const read = await call('note_read', { id: firstNote.id })
check('note_read（按 id）读到正文', read.ok === true && typeof read.data.content === 'string' && read.data.content.length > 0,
  `${read.data.title}：${read.data.content.length} 字`)

const readByPath = await call('note_read', { path: firstNote.path })
check('note_read（按库内相对路径）也能读到', readByPath.ok === true && readByPath.data.id === firstNote.id, firstNote.path)

const boardList = await call('board_list')
check('board_list 列出白板并统计卡片/连线', boardList.ok === true && boardList.data.boards.length > 0,
  boardList.data.boards.map((b) => `${b.title}(${b.nodes}/${b.edges})`).join(', '))

const board0 = boardList.data.boards.find((b) => b.nodes > 0) ?? boardList.data.boards[0]
const boardRead = await call('board_read', { id: board0.id })
check('board_read 读出卡片与连线', boardRead.ok === true && Array.isArray(boardRead.data.nodes),
  `${boardRead.data.title}：${boardRead.data.nodes.length} 卡片 / ${boardRead.data.edges.length} 连线`)

const todos = await call('todo_list', { status: 'all' })
check('todo_list 列出待办', todos.ok === true && Array.isArray(todos.data.todos), todos.summary)
const openTodos = await call('todo_list', { status: 'open' })
check('todo_list 状态过滤生效', openTodos.data.todos.every((t) => !t.done), openTodos.summary)

const tags = await call('tag_list')
check('tag_list 列出标签', tags.ok === true && Array.isArray(tags.data.tags), tags.summary)

const trash = await call('trash_list', { kind: 'all' })
check('trash_list 列出回收站', trash.ok === true, trash.summary)

const libs = await call('library_list')
check('library_list 列出笔记库', libs.ok === true && libs.data.libraries.length >= 1, `${libs.summary}`)

// 搜索：用第一篇笔记正文里的一个词去搜
const probe = (read.data.content.match(/[\u4e00-\u9fa5]{2,4}/g) ?? ['笔记'])[0]
const search = await call('notes_search', { query: probe, limit: 10 })
check('notes_search 能搜到内容', search.ok === true && search.data.matches.length > 0,
  `搜「${probe}」命中 ${search.data.matches.length} 个文件（扫描 ${search.data.scanned}）`)

/* ---------- 写入工具：每个都要"调用后磁盘/库里真的变了" ---------- */
console.log('\n=== 写入工具（P2） ===')

const noteAbs = (rel) => join(libDir, 'notes', rel)
const treeNow = async () => await call('note_list', { dir: '*' })
const hasPath = async (rel) => (await treeNow()).data.items.some((i) => i.path === rel)
/** 笔记夹不在 note_list 里（它只列笔记/白板），要用 folder_list 判断 */
const hasFolder = async (path) => (await call('folder_list')).data.folders.some((f) => f.path === path)

// —— 笔记夹 ——
const f1 = await call('folder_create', { name: '旅程夹' })
check('folder_create 建出笔记夹', f1.ok === true && await hasFolder('旅程夹'), f1.data.path)
const f1r = await call('folder_rename', { path: '旅程夹', name: '旅程夹2' })
check('folder_rename 改名生效（旧名没了、新名在）', f1r.ok === true && !(await hasFolder('旅程夹')) && await hasFolder('旅程夹2'), f1r.data.to)
const f2 = await call('folder_create', { dir: '旅程夹2', name: '子夹' })
check('folder_create 支持建在父夹下', f2.ok === true && await hasFolder('旅程夹2/子夹'), f2.data.path)
const f3 = await call('folder_move', { path: '旅程夹2/子夹', to: '' })
check('folder_move 把子夹移到库根', f3.ok === true && await hasFolder('子夹') && !(await hasFolder('旅程夹2/子夹')), f3.data.to)
const f4 = await call('folder_trash', { path: '子夹' })
check('folder_trash 删除笔记夹', f4.ok === true && !(await hasFolder('子夹')), '')

// —— 笔记 ——
const n1 = await call('note_create', { dir: '旅程夹2', title: '旅程笔记' })
check('note_create 建出笔记文件', n1.ok === true && existsSync(noteAbs(n1.data.path)), n1.data.path)
const nId = n1.data.id
const w1 = await call('note_write', { id: nId, mode: 'overwrite', content: '# 小节一\n\n正文A\n' })
const rawAfterWrite = readFileSync(noteAbs(n1.data.path), 'utf8')
check('note_write overwrite 写入正文', w1.ok === true && rawAfterWrite.includes('正文A'), `${rawAfterWrite.length} 字节`)
check('note_write 覆写后仍保留 title（frontmatter 没丢）', rawAfterWrite.includes('title: 旅程笔记') && rawAfterWrite.includes(`id: ${nId}`), rawAfterWrite.split('\n').slice(0, 4).join(' | '))
const w2 = await call('note_write', { id: nId, mode: 'append', content: '追加行' })
const rawAfterAppend = readFileSync(noteAbs(n1.data.path), 'utf8')
check('note_write append 追加且不丢原内容', w2.ok === true && rawAfterAppend.includes('正文A') && rawAfterAppend.includes('追加行'), '')
const w3 = await call('note_write', { id: nId, mode: 'replace_section', section: '小节一', content: '换过的内容' })
const rawAfterSection = readFileSync(noteAbs(n1.data.path), 'utf8')
check('note_write replace_section 精确替换小节', w3.ok === true && rawAfterSection.includes('换过的内容') && !rawAfterSection.includes('正文A'), '')
const n2 = await call('note_rename', { id: nId, title: '旅程笔记2' })
check('note_rename 改名且 id 不变', n2.ok === true && n2.data.id === nId && await hasPath('旅程夹2/旅程笔记2.md'), n2.data.title)
const n3 = await call('note_move', { id: nId, dir: '' })
check('note_move 把笔记移到库根', n3.ok === true && await hasPath('旅程笔记2.md'), n3.data.dir)
const n4 = await call('note_trash', { id: nId })
const trashAfterNote = await call('trash_list', { kind: 'note' })
check('note_trash 删除后树里没了、回收站里有', n4.ok === true && !(await hasPath('旅程笔记2.md')) && trashAfterNote.text.includes('旅程笔记2'),
  trashAfterNote.summary)

// —— 白板 ——
const b1 = await call('board_create', { title: '旅程白板' })
check('board_create 建出白板文件', b1.ok === true && existsSync(noteAbs(b1.data.path)), b1.data.path)
const bId = b1.data.id
const be1 = await call('board_edit', {
  id: bId,
  ops: [
    { op: 'add_node', id: 'nA', type: 'text', x: 0, y: 0, w: 210, h: 120, text: '起点' },
    { op: 'add_node', id: 'nB', type: 'text', x: 300, y: 0, w: 210, h: 120, text: '终点' },
    { op: 'add_edge', id: 'e1', from: 'nA', to: 'nB', label: '然后' }
  ]
})
const boardAfterAdd = await call('board_read', { id: bId })
check('board_edit 加卡片与连线', be1.ok === true && boardAfterAdd.data.nodes.length === 2 && boardAfterAdd.data.edges.length === 1,
  `${boardAfterAdd.data.nodes.length} 卡片 / ${boardAfterAdd.data.edges.length} 连线`)
const be2 = await call('board_edit', { id: bId, ops: [{ op: 'update_node', id: 'nA', text: '起点（改）' }, { op: 'remove_node', id: 'nB' }] })
const boardAfterDel = await call('board_read', { id: bId })
check('board_edit 改卡片 + 删卡片连带删连线', be2.ok === true && boardAfterDel.data.nodes.length === 1 && boardAfterDel.data.edges.length === 0,
  `剩 ${boardAfterDel.data.nodes.length} 卡片 / ${boardAfterDel.data.edges.length} 连线；文字=${boardAfterDel.data.nodes[0]?.text}`)
const be3 = await call('board_edit', { id: bId, ops: [{ op: 'add_node', type: 'text', text: '自动定位' }] })
const boardAuto = await call('board_read', { id: bId })
const autoNode = boardAuto.data.nodes.find((n) => n.text === '自动定位')
check('board_edit 省略 x/y 能自动定位（排在已有卡片右侧）', be3.ok === true && autoNode !== undefined && autoNode.x >= 210, `x=${autoNode?.x}`)
const b2 = await call('board_rename', { id: bId, title: '旅程白板2' })
check('board_rename 生效', b2.ok === true && await hasPath('旅程白板2.canvas.json'), b2.data.title)
const b3 = await call('board_move', { id: bId, dir: '旅程夹2' })
check('board_move 生效', b3.ok === true && await hasPath('旅程夹2/旅程白板2.canvas.json'), b3.data.dir)
const b4 = await call('board_trash', { id: bId })
check('board_trash 生效', b4.ok === true && !(await hasPath('旅程夹2/旅程白板2.canvas.json')), '')

// —— 待办 ——
const tagsForTodo = await call('tag_list')
const someTag = tagsForTodo.data.tags[0]?.id
const t1 = await call('todo_add', { name: '旅程待办', ddl: '2026-10-10' })
const tasksAfterAdd = await call('todo_list', { status: 'all' })
check('todo_add 新增待办（含截止）', t1.ok === true && tasksAfterAdd.data.todos.some((t) => t.id === t1.data.id && t.ddl === '2026-10-10'), t1.summary)
const t2 = await call('todo_update', { id: t1.data.id, name: '旅程待办2', tagIds: someTag !== undefined ? [someTag] : [] })
check('todo_update 改内容与标签', t2.ok === true && t2.data.name === '旅程待办2', `${t2.data.name} tags=${JSON.stringify(t2.data.tagIds)}`)
const t3 = await call('todo_complete', { id: t1.data.id })
const tasksAfterDone = await call('todo_list', { status: 'done' })
check('todo_complete 标记完成', t3.ok === true && tasksAfterDone.data.todos.some((t) => t.id === t1.data.id), '')
const t4 = await call('todo_trash', { id: t1.data.id })
const tasksAfterTrash = await call('todo_list', { status: 'all' })
check('todo_trash 删除后列表里没了', t4.ok === true && !tasksAfterTrash.data.todos.some((t) => t.id === t1.data.id), '')

// —— 标签 ——
const g1 = await call('tag_create', { name: '旅程标签' })
check('tag_create 建出标签', g1.ok === true && g1.data.id !== undefined, g1.data.id)
const g2 = await call('tag_create', { name: '旅程子标签', parentId: g1.data.id })
check('tag_create 支持父子层级', g2.ok === true && g2.data.parentId === g1.data.id, g2.data.parentId)
const g3 = await call('tag_rename', { id: g2.data.id, name: '旅程子标签2' })
check('tag_rename 生效', g3.ok === true && g3.data.name === '旅程子标签2', g3.data.name)
const g4 = await call('tag_move', { id: g2.data.id, parentId: '' })
check('tag_move 移到顶层', g4.ok === true && g4.data.parentId === null, String(g4.data.parentId))
const g5 = await call('tag_trash', { id: g2.data.id })
const tagsAfter = await call('tag_list')
check('tag_trash 删除后标签树里没了', g5.ok === true && !tagsAfter.data.tags.some((t) => t.id === g2.data.id), '')

/* ---------- 回收站 / 附件 / 多库（P3） ---------- */
console.log('\n=== 回收站 / 附件 / 多库（P3） ===')

// —— 删 → 恢复（笔记）——
const rn = await call('note_create', { title: '回收站测试笔记' })
const rnPath = rn.data.path
await call('note_trash', { id: rn.data.id })
const trash1 = await call('trash_list', { kind: 'note' })
check('删除后出现在笔记回收站（结构化可定位）', trash1.data.notes.some((n) => n.id === rn.data.id), trash1.summary)
const rr = await call('trash_restore', { kind: 'note', ids: [rn.data.id] })
check('trash_restore 把笔记恢复回原位置', rr.ok === true && existsSync(join(libDir, 'notes', rnPath)), rnPath)
check('恢复后回收站里没有了', !(await call('trash_list', { kind: 'note' })).data.notes.some((n) => n.id === rn.data.id), '')

// —— 删 → 恢复（待办）——
const rt = await call('todo_add', { name: '回收站测试待办' })
await call('todo_trash', { id: rt.data.id })
const trashTask1 = await call('trash_list', { kind: 'task' })
check('删除后出现在待办回收站', trashTask1.data.tasks.some((t) => t.id === rt.data.id), trashTask1.summary)
const rrt = await call('trash_restore', { kind: 'task', ids: [rt.data.id] })
const tasksRestored = await call('todo_list', { status: 'all' })
check('trash_restore 把待办恢复回去', rrt.ok === true && tasksRestored.data.todos.some((t) => t.id === rt.data.id), '')

// —— 附件导入（放在"彻底删除"之前：那个操作会按设计清理孤儿附件，之后再数就不准了）——
const outsideDoc = join(work, '导入测试.md')
writeFileSync(outsideDoc, '# 来自库外的文件\n\n附件导入测试。\n', 'utf8')
const imp = await call('attachment_import', { sourcePath: outsideDoc, name: '导入测试.md' })
check('attachment_import 把库外文件拷进 _attachments', imp.ok === true && existsSync(join(libDir, 'notes', imp.data.rel)),
  imp.data.rel)
const impBytes = readFileSync(join(libDir, 'notes', imp.data.rel), 'utf8')
check('导入的附件内容与原文件一致', impBytes === readFileSync(outsideDoc, 'utf8'), `${impBytes.length} 字节`)
const attList = await call('attachment_list', { nameContains: '导入测试' })
check('attachment_list 能按名字过滤到它', attList.ok === true && attList.data.files.some((f) => f.name === '导入测试.md'), attList.summary)
const attAll = await call('attachment_list', { limit: 1000 })
const dirAttCount = readdirSync(join(libDir, 'notes', '_attachments')).length
check('attachment_list 列全（与实际文件数一致）', attAll.data.count === dirAttCount, `列出 ${attAll.data.count} / 磁盘 ${dirAttCount}`)
const orphansBefore = await call('attachment_orphans')
check('attachment_orphans 能列出无人引用的附件（只查不删）', orphansBefore.ok === true && orphansBefore.data.count > 0,
  `${orphansBefore.data.count} 个孤儿 / 共 ${attAll.data.count} 个附件`)

// —— 彻底删除（不可恢复）：两道确认 ——
await call('note_trash', { id: rn.data.id })
let purgeBlocked = false
try { await call('trash_purge', { kind: 'note', ids: [rn.data.id] }) } catch (e) { purgeBlocked = String(e.message).includes('confirm') }
check('trash_purge 不给 confirm 会被拒绝（防误删）', purgeBlocked, '')
// 库里存在"无人引用"的附件时，还必须先知情：不带 confirmOrphanCleanup 再被拦一次
let orphanBlocked = false
let orphanMsg = ''
try { await call('trash_purge', { kind: 'note', ids: [rn.data.id], confirm: true }) } catch (e) { orphanBlocked = true; orphanMsg = String(e.message) }
check('trash_purge 会先拦住"连带清理附件"这件事（要求知情确认）',
  orphansBefore.data.count === 0 ? true : (orphanBlocked && orphanMsg.includes('附件') && orphanMsg.includes(String(orphansBefore.data.count))),
  orphansBefore.data.count === 0 ? '（库里没有孤儿附件，无需这道保护）' : orphanMsg.split('\n')[0].slice(0, 80))
const attCountBefore = attAll.data.count
const purged = await call('trash_purge', { kind: 'note', ids: [rn.data.id], confirm: true, confirmOrphanCleanup: true })
const trashAfterPurge = await call('trash_list', { kind: 'note' })
const trashDir = join(libDir, '.trash')
const trashFiles = existsSync(trashDir) ? readdirSync(trashDir) : []
const attCountAfter = (await call('attachment_list', { limit: 1000 })).data.count
check('trash_purge 彻底删除：回收站记录与文件都没了',
  purged.ok === true && !trashAfterPurge.data.notes.some((n) => n.id === rn.data.id) && !trashFiles.some((f) => f.includes('回收站测试笔记')),
  `回收站文件 ${trashFiles.length} 个`)
check('trash_purge 连带清理了无人引用的附件（与预期一致）',
  purged.data.orphanAttachmentsCleaned === attCountBefore - attCountAfter,
  `附件 ${attCountBefore} → ${attCountAfter}，报告清理 ${purged.data.orphanAttachmentsCleaned} 个`)

// —— 多库：切换再切回（顺带验证 runtime 活引用）——
const lib2 = join(work, 'lib2')
// 目标目录要"像笔记库"（宿主会检查有没有 notes 文件夹）
mkdirSync(join(lib2, 'notes'), { recursive: true })
mkdirSync(join(lib2, 'data'), { recursive: true })
const sw = await call('library_switch', { dir: lib2 })
const libsAfter = await call('library_list')
const activeNow = libsAfter.data.libraries.find((l) => l.active)
check('library_switch 切到新库', sw.ok === true && (activeNow?.dir ?? '').replace(/\\/g, '/').toLowerCase() === lib2.replace(/\\/g, '/').toLowerCase(),
  `${sw.data.from} → ${sw.data.name}（${activeNow?.dir}）`)
const treeInLib2 = await call('note_list', { dir: '*' })
check('切库后面板读到的就是新库（笔记数与旧库不同）', treeInLib2.data.items.length <= 1, `新库里有 ${treeInLib2.data.items.length} 项`)
const originalId = libsAfter.data.libraries.find((l) => l.dir.replace(/\\/g, '/').toLowerCase() !== lib2.replace(/\\/g, '/').toLowerCase())?.id
const swBack = await call('library_switch', { id: originalId })
const treeBack = await call('note_list', { dir: '*' })
// 不写死条数：只要求"切回后能读到原库的条目，且明显多于那个空的新库"。
// 曾经写死 > 5，一旦测试用的夹具库比真实库小就会假失败。
check('library_switch 能切回原库（runtime 活引用生效）', swBack.ok === true && treeBack.data.items.length > treeInLib2.data.items.length,
  `切回后 ${treeBack.data.items.length} 项（新库 ${treeInLib2.data.items.length} 项）`)

/* ---------- 负向测试（越界与错误路径） ---------- */
console.log('\n=== 负向测试（越界与错误路径） ===')
async function expectThrow(name, fn, mustInclude) {
  try {
    await fn()
    check(name, false, '本该报错却成功了')
  } catch (e) {
    const msg = String(e?.message ?? e)
    check(name, msg.includes(mustInclude), msg.slice(0, 110))
  }
}
await expectThrow('绝对路径被拒绝', () => call('note_read', { path: 'C:/Windows/win.ini' }), '相对路径')
await expectThrow('.. 逃逸被拒绝', () => call('note_read', { path: '../../secret.md' }), '..')
await expectThrow('不存在的笔记给出可读错误', () => call('note_read', { path: '不存在/没有这篇.md' }), '找不到')
await expectThrow('格式非法的 id 被拒绝（宿主校验）', () => call('note_read', { id: 'note_not_exist_xxx' }), '不合法')
await expectThrow('格式合法但不存在的 id → 笔记不存在', () => call('note_read', { id: 'note_ffffffffffffffffffff' }), '不存在')
await expectThrow('kind 非法值被拒绝', () => call('note_list', { kind: 'pdf' }), '只能是')
await expectThrow('白板用 note_read 会被提示改用 board_read', () => call('note_read', { id: board0.id }), 'board_read')
await expectThrow('缺参报错', () => call('notes_search', {}), 'query')

/* ---------- 真实数据零改动 ---------- */
{
  const diffs = []
  for (const [root, before] of realBefore) {
    const after = snapshot(root)
    for (const [rel, sig] of after) {
      const old = before.get(rel)
      if (old === undefined) diffs.push(`新增 ${rel}`)
      else if (old !== sig) diffs.push(`改动 ${rel}`)
    }
    for (const rel of before.keys()) if (!after.has(rel)) diffs.push(`删除 ${rel}`)
  }
  check('用户真实数据零改动', diffs.length === 0, diffs.length === 0 ? '快照完全一致' : diffs.slice(0, 4).join('；'))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 汇总 ===\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
console.log('库副本：' + libDir)
process.exit(failed.length === 0 ? 0 : 1)
