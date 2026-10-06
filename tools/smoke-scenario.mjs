/**
 * P6 冒烟：端到端场景（模拟「羽毛笔」真做事的方式）。
 *
 * 四个场景，每个都按"模型会怎么调工具"的顺序走完，最后**按库内实际状态断言**：
 *   ① 纯图片（扫描件）PDF → 笔记 + 白板（页图被引用，不再是孤儿附件）
 *   ② 一批库外文件 → 分类夹 + 笔记 + 索引白板
 *   ③ 口述 → 库内待办清单（截止/标签/关联笔记/优先级/完成）
 *   ④ 删 → 恢复 → 彻底删除 的完整生命周期（含两道路闸）
 *
 * 全程在**库副本**上跑，并对用户真实库做快照比对。
 *
 *   node tools/smoke-scenario.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT, LIBRARY_SNAPSHOT, REAL_LIBRARY, packageDirName } from './paths.mjs'

const SRC_LIB = LIBRARY_SNAPSHOT
const PYTHON = (() => {
  // 不写死本机路径：环境变量 → DSH_HOME 下的运行时 → PATH 里的 python/py
  const cands = [
    process.env.DSH_TEST_PYTHON,
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe') : undefined,
    join(process.env.USERPROFILE ?? '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python', 'python3', 'py'
  ].filter((p) => typeof p === 'string' && p !== '')
  for (const c of cands) {
    if (c.includes('/') || c.includes('\\')) { if (existsSync(c)) return c; continue }
    try { execFileSync(c, ['-c', 'print(1)'], { stdio: 'ignore', timeout: 15000 }); return c } catch { /* 试下一个 */ }
  }
  return undefined
})()
const work = join(join(ROOT, '.tmp', 'smoke-scenario'), new Date().toISOString().replace(/[:.]/g, '-'))
const libDir = join(work, 'lib')
const dataDir = join(work, 'data')
const fixtures = join(work, 'fixtures')
const outside = join(work, 'outside')
mkdirSync(work, { recursive: true })
mkdirSync(fixtures, { recursive: true })
mkdirSync(outside, { recursive: true })
cpSync(SRC_LIB, libDir, { recursive: true })

console.log('生成夹具…')
execFileSync(PYTHON, [join(join(ROOT, 'tools/make-doc-fixtures.py')), fixtures], { stdio: 'ignore' })
const SCAN_PDF = join(fixtures, '扫描件.pdf')

// 场景 ② 用的库外文件
writeFileSync(join(outside, '需求草稿.md'), '# 需求草稿\n\n关键字：需求要点一、需求要点二。\n', 'utf8')
writeFileSync(join(outside, '会议记录.md'), '# 会议记录\n\n关键字：会议决议与负责人。\n', 'utf8')
writeFileSync(join(outside, '示意图.txt'), '示意图说明：这是纯文本文件。\n', 'utf8')

process.env.DSH_QUILL_LIBRARY_ROOT = libDir
process.env.DSH_QUILL_DATA_DIR = dataDir
process.env.DSH_QUILL_NO_REGISTRY_INHERIT = '1'

/* ---------- 真实数据护栏 ---------- */
const REAL = REAL_LIBRARY
function snapshot(root) {
  const map = new Map()
  const walk = (dir, prefix) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const rel = prefix === '' ? e.name : prefix + '/' + e.name
      if (e.isDirectory()) { walk(join(dir, e.name), rel); continue }
      try { const st = statSync(join(dir, e.name)); map.set(rel, `${st.size}:${st.mtimeMs}`) } catch { /* 忽略 */ }
    }
  }
  walk(root, '')
  return map
}
const realBefore = snapshot(REAL)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`)
}

const definitions = []
const mod = await import('../packages/' + packageDirName() + '/lib/tools.js')
mod.apply({ tools: { register: (d) => { definitions.push(d); return () => {} } }, logger: { info: () => {}, warn: () => {} } })
const byName = new Map(definitions.map((d) => [d.name, d]))
const call = async (name, args = {}) => {
  const def = byName.get(name)
  if (def === undefined) throw new Error('没有这个工具：' + name)
  try { return await def.execute(args, { signal: undefined }) } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
}
const notesDir = join(libDir, 'notes')
const attDir = join(notesDir, '_attachments')
const attCount = () => (existsSync(attDir) ? readdirSync(attDir).length : 0)

/* ============================================================ 场景 ① */
console.log('\n=== 场景 ①：纯图片（扫描件）PDF → 笔记 + 白板 ===')
{
  const pdf = await call('doc_read', { path: SCAN_PDF })
  check('读懂扫描件：3 页渲染成图、无文本层', pdf.ok === true && pdf.data.pages.length === 3 && pdf.data.chars === 0,
    pdf.ok === true ? `${pdf.data.pages.length} 页` : pdf.error)

  const folder = await call('folder_create', { name: '扫描资料' })
  const note = await call('note_create', { dir: '扫描资料', title: '扫描件要点' })
  const refs = pdf.data.pages.map((p, i) => `![第 ${p.page} 页](${p.rel})`).join('\n\n')
  const written = await call('note_write', {
    id: note.data.id,
    mode: 'overwrite',
    content: '# 扫描件要点\n\n关键字：扫描件摘要。逐页如下：\n\n' + refs + '\n\n## 结论\n\n三页都要看原图。\n'
  })
  check('建笔记夹 + 建笔记 + 写入（含逐页图引用）', written.ok === true && folder.ok === true && note.ok === true, written.summary)
  const noteText = readFileSync(join(notesDir, note.data.path), 'utf8')
  check('笔记正文真的引用了 3 张页图', pdf.data.pages.every((p) => noteText.includes(p.rel)), `${noteText.length} 字`)

  const board = await call('board_create', { dir: '扫描资料', title: '扫描件结构' })
  const ops = []
  pdf.data.pages.forEach((p, i) => {
    ops.push({ op: 'add_node', id: 'p' + p.page, type: 'text', x: i * 270, y: 0, w: 210, h: 120, text: `第 ${p.page} 页`, color: '#ffffff' })
  })
  ops.push({ op: 'add_node', id: 'pic1', type: 'image', x: 0, y: 200, w: 220, h: 160, src: pdf.data.pages[0].rel })
  ops.push({ op: 'add_edge', from: 'p1', to: 'p2', label: '接着' })
  ops.push({ op: 'add_edge', from: 'p2', to: 'p3' })
  const edited = await call('board_edit', { id: board.data.id, ops })
  const boardRead = await call('board_read', { id: board.data.id })
  check('白板画成：3 张文字卡 + 1 张图片卡 + 2 条连线',
    edited.ok === true && boardRead.data.nodes.length === 4 && boardRead.data.edges.length === 2,
    `${boardRead.data.nodes.length} 卡片 / ${boardRead.data.edges.length} 连线`)
  check('图片卡引用了渲染出来的页图', boardRead.data.nodes.some((n) => n.type === 'image' && n.src === pdf.data.pages[0].rel), '')

  const orphans = await call('attachment_orphans')
  check('页图不再是"无人引用附件"（笔记与白板都引用了）',
    pdf.data.pages.every((p) => !orphans.data.files.includes(p.rel)),
    `页图 3 张，仍被列为孤儿 ${pdf.data.pages.filter((p) => orphans.data.files.includes(p.rel)).length} 张`)
  const search = await call('notes_search', { query: '扫描件摘要' })
  check('搜索能找到这篇笔记', search.ok === true && search.data.matches.length >= 1, search.summary)
}

/* ============================================================ 场景 ② */
console.log('\n=== 场景 ②：一批库外文件 → 分类夹 + 笔记 + 索引白板 ===')
{
  const folder = await call('folder_create', { name: '资料归档' })
  const made = []
  for (const f of ['需求草稿.md', '会议记录.md']) {
    const title = f.replace(/\.md$/, '')
    const n = await call('note_create', { dir: '资料归档', title })
    const content = readFileSync(join(outside, f), 'utf8')
    await call('note_write', { id: n.data.id, mode: 'overwrite', content })
    made.push(n.data)
  }
  const img = await call('attachment_import', { sourcePath: join(outside, '示意图.txt'), name: '示意图说明.txt' })
  const board = await call('board_create', { dir: '资料归档', title: '资料索引' })
  const ops = made.map((n, i) => ({ op: 'add_node', id: 'n' + i, type: 'text', x: i * 270, y: 0, w: 210, h: 120, text: n.title, color: '#cfe1fb' }))
  ops.push({ op: 'add_edge', from: 'n0', to: 'n1', label: '相关' })
  await call('board_edit', { id: board.data.id, ops })

  check('笔记夹建好了', folder.ok === true, String(folder.data?.path))
  const inFolder = await call('note_list', { dir: '资料归档' })
  check('两篇笔记都进了这个夹', inFolder.ok === true && inFolder.data.items.filter((i) => i.kind === 'md').length === 2,
    inFolder.ok === true ? `${inFolder.data.items.length} 项` : inFolder.error)
  const txt = readFileSync(join(notesDir, '资料归档', '需求草稿.md'), 'utf8')
  check('内容真的落盘了', txt.includes('需求要点一'), '')
  check('库外文件已导入为附件', img.ok === true && existsSync(join(notesDir, img.data.rel)), img.ok === true ? img.data.rel : img.error)
  const b = await call('board_read', { id: board.data.id })
  check('索引白板：2 张卡 + 1 条线', b.data.nodes.length === 2 && b.data.edges.length === 1, `${b.data.nodes.length}/${b.data.edges.length}`)
  const tree = await call('folder_list')
  check('笔记夹列表里能看到它', tree.data.folders.some((f) => f.path === '资料归档'), '')
}

/* ============================================================ 场景 ③ */
console.log('\n=== 场景 ③：口述 → 库内待办清单 ===')
{
  const tag = await call('tag_create', { name: '项目A' })
  const note = await call('note_create', { dir: '资料归档', title: '项目A 备忘' })
  const t1 = await call('todo_add', { name: '跟甲方确认需求范围', ddl: '2026-10-08', tagIds: [tag.data.id], priority: 'important', noteId: note.data.id })
  const t2 = await call('todo_add', { name: '整理会议纪要' })
  const t3 = await call('todo_add', { name: '准备下周演示' })
  const open = await call('todo_list', { status: 'open' })
  check('三条待办都进了库', open.ok === true && [t1, t2, t3].every((t) => open.data.todos.some((x) => x.id === t.data.id)), open.summary)
  const one = open.data.todos.find((t) => t.id === t1.data.id)
  check('截止时间生效', one?.ddl?.startsWith('2026-10-08') === true, String(one?.ddl))
  check('标签关联生效', (one?.tagIds ?? []).includes(tag.data.id), JSON.stringify(one?.tagIds))
  check('关联笔记生效', one?.noteId === note.data.id, String(one?.noteId))
  const t2full = open.data.todos.find((t) => t.id === t2.data.id)
  check('优先级默认 minor（与界面一致）', t2full?.priority === 'minor', String(t2full?.priority))
  const done = await call('todo_complete', { id: t3.data.id })
  const doneList = await call('todo_list', { status: 'done' })
  const openAfter = await call('todo_list', { status: 'open' })
  check('完成一条后：它在已完成里、不在未完成里',
    done.ok === true && doneList.data.todos.some((t) => t.id === t3.data.id) && !openAfter.data.todos.some((t) => t.id === t3.data.id),
    `已完成 ${doneList.data.todos.length} 条 / 未完成 ${openAfter.data.todos.length} 条`)
}

/* ============================================================ 场景 ④ */
console.log('\n=== 场景 ④：删 → 恢复 → 彻底删除 的完整生命周期 ===')
{
  const n = await call('note_create', { title: '生命周期测试' })
  await call('note_write', { id: n.data.id, mode: 'overwrite', content: '# 生命周期\n\n第一版内容。\n' })
  const att = await call('attachment_import', { sourcePath: join(outside, '示意图.txt'), name: '生命周期附件.txt' })
  await call('note_write', { id: n.data.id, mode: 'append', content: `\n附件：![](${att.data.rel})\n` })

  // 1) 删除 → 进回收站（附件保留）
  await call('note_trash', { id: n.data.id })
  const trash1 = await call('trash_list', { kind: 'note' })
  check('删除后进回收站、附件还在', trash1.data.notes.some((x) => x.id === n.data.id) && existsSync(join(notesDir, att.data.rel)), '')

  // 2) 恢复 → 回到原位置、内容与附件都在
  const restored = await call('trash_restore', { kind: 'note', ids: [n.data.id] })
  const backText = existsSync(join(notesDir, n.data.path)) ? readFileSync(join(notesDir, n.data.path), 'utf8') : ''
  check('恢复回原位置且内容完整', restored.ok === true && backText.includes('第一版内容') && backText.includes(att.data.rel), n.data.path)

  // 3) 再删 → 彻底删除：两道闸
  await call('note_trash', { id: n.data.id })
  const missingConfirm = await call('trash_purge', { kind: 'note', ids: [n.data.id] })
  check('第一道闸：不给 confirm 被拒绝', missingConfirm.ok === false && String(missingConfirm.error).includes('confirm'), '')
  const orphansBefore = await call('attachment_orphans')
  const withoutOrphanAck = await call('trash_purge', { kind: 'note', ids: [n.data.id], confirm: true })
  check('第二道闸：不给孤儿附件确认也被拒绝（并说明会连带删什么）',
    orphansBefore.data.count === 0 ? true : (withoutOrphanAck.ok === false && String(withoutOrphanAck.error).includes('附件')),
    orphansBefore.data.count === 0 ? '（无孤儿附件）' : String(withoutOrphanAck.error).split('\n')[0].slice(0, 60))

  const purged = await call('trash_purge', { kind: 'note', ids: [n.data.id], confirm: true, confirmOrphanCleanup: true })
  const trashAfter = await call('trash_list', { kind: 'note' })
  check('彻底删除成功：回收站记录消失', purged.ok === true && !trashAfter.data.notes.some((x) => x.id === n.data.id), purged.summary ?? '')
  check('被删笔记的文件也没了', !existsSync(join(libDir, '.trash', `${n.data.id}__生命周期测试.md`)), '')
  const orphansAfter = await call('attachment_orphans')
  check('连带清理是"报告过的"而不是静默的', purged.data.orphanAttachmentsCleaned === orphansBefore.data.count,
    `删前孤儿 ${orphansBefore.data.count} → 报告清理 ${purged.data.orphanAttachmentsCleaned}，之后剩 ${orphansAfter.data.count}`)
}

/* ============================================================ 总账 */
console.log('\n=== 库内总览（交付物） ===')
{
  const overview = await call('notes_overview')
  console.log(overview.text.split('\n').slice(0, 6).join('\n'))
  const boards = await call('board_list')
  const titles = boards.data.boards.map((b) => b.title)
  check('场景产出的两块白板都在库里', titles.includes('扫描件结构') && titles.includes('资料索引'), titles.join(', '))
  const all = await call('note_list', { dir: '*' })
  check('全库条目数比开始时多（真的产出了东西）', all.data.items.length >= 7, `${all.data.items.length} 项`)
}

{
  const after = snapshot(REAL)
  const diffs = []
  for (const [rel, sig] of after) {
    const old = realBefore.get(rel)
    if (old === undefined) diffs.push('新增 ' + rel)
    else if (old !== sig) diffs.push('改动 ' + rel)
  }
  for (const rel of realBefore.keys()) if (!after.has(rel)) diffs.push('删除 ' + rel)
  check('用户真实库零改动', diffs.length === 0, diffs.length === 0 ? '快照完全一致' : diffs.slice(0, 4).join('；'))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 汇总 ===\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
console.log('库副本：' + libDir)
process.exit(failed.length === 0 ? 0 : 1)
