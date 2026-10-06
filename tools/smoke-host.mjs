/**
 * 本地 Node 冒烟测试（第一环）—— 不依赖 DSH、不重启应用。
 *
 * 做法：把**库的备份副本**拷到临时目录，用构建好的宿主半边（lib/host.js）
 * 真跑一遍通道：读 -> 建 -> 改 -> 改名 -> 删 -> 回收站还原。
 * 断言：frontmatter 的 id 不变、索引与文件一致、回收站语义正确、磁盘文件全部进树。
 *
 *   node tools/smoke-host.mjs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { LIBRARY_SNAPSHOT, packageDirName, ROOT } from './paths.mjs'

const SRC_LIB = LIBRARY_SNAPSHOT
const WORK_ROOT = join(ROOT, '.tmp', 'smoke')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const work = join(WORK_ROOT, stamp)
const libDir = join(work, 'lib')
const notesDir = join(libDir, 'notes')
const dataDir = join(work, 'data')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`)
}

console.log('=== 准备 ===')
mkdirSync(work, { recursive: true })
cpSync(SRC_LIB, libDir, { recursive: true })
console.log('  副本：' + libDir)

// 测试隔离：不继承用户真实的库注册表
process.env.DSH_QUILL_NO_REGISTRY_INHERIT = '1'
const { createRuntime } = await import('../packages/' + packageDirName() + '/lib/host.js')
const t0 = Date.now()
const rt = await createRuntime({ dataDir, libraryRoot: libDir })
console.log(`  runtime 就绪（${Date.now() - t0}ms）：库=${rt.libraryRoot()}`)
console.log(`  已注册通道：${rt.channels.length} 个`)

/** 调用一个通道并拆开信封 */
async function call(channel, ...args) {
  const res = await rt.invoke(channel, args)
  if (res === undefined) return { ok: false, error: `通道不存在：${channel}` }
  return res
}
function findNode(nodes, pred) {
  for (const n of nodes ?? []) {
    if (pred(n)) return n
    const hit = findNode(n.children, pred)
    if (hit) return hit
  }
  return null
}
function countNodes(nodes, pred) {
  return (nodes ?? []).reduce((n, x) => n + (pred(x) ? 1 : 0) + countNodes(x.children, pred), 0)
}
function diskNotes(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === '_attachments') continue
    const abs = join(dir, e.name)
    if (e.isDirectory()) diskNotes(abs, out)
    else if (/\.(md|canvas\.json)$/i.test(e.name)) out.push(abs)
  }
  return out
}

console.log('\n=== 一、只读通道 ===')
// 面板一挂载就会调这几个：App(configGet/librariesList/libraryStats) + 各区域
const cfg = await call('config:get')
check('config:get（App 挂载时调用）', cfg.ok && typeof cfg.value === 'object', cfg.ok ? `theme=${cfg.value?.theme} lastArea=${cfg.value?.lastArea}` : cfg.error)

const libs = await call('libraries:list')
check('libraries:list（App 挂载时调用）', libs.ok && Array.isArray(libs.value?.items), libs.ok ? `${libs.value.items.length} 个库, activeId=${libs.value.activeId}` : libs.error)

const info = await call('app:info')
check('app:info', info.ok && typeof info.value?.libraryPath === 'string', info.ok ? info.value.libraryPath : info.error)

const stats = await call('library:stats')
check('library:stats', stats.ok, JSON.stringify(stats.value ?? stats.error))

const tree = await call('note:tree')
const total = countNodes(tree.value, () => true)
check('note:tree', tree.ok && total > 0, `${total} 个节点`)

const tasks = await call('task:list')
check('task:list', tasks.ok && Array.isArray(tasks.value), `${tasks.value?.length ?? 0} 条待办`)

const tags = await call('tag:list')
check('tag:list', tags.ok && Array.isArray(tags.value), `${tags.value?.length ?? 0} 个标签`)

const trashNotes = await call('trashNote:list')
check('trashNote:list', trashNotes.ok, `${trashNotes.value?.length ?? 0} 条`)

const trashTasks = await call('trashTask:list')
check('trashTask:list', trashTasks.ok, `${trashTasks.value?.length ?? 0} 条`)

const someNote = findNode(tree.value, (n) => n.type === 'note' && n.kind !== 'whiteboard')
if (someNote) {
  const read = await call('note:read', someNote.id)
  check('note:read', read.ok && typeof read.value?.content === 'string', `《${someNote.name}》 ${read.value?.content?.length ?? 0} 字`)
} else {
  check('note:read', false, '树里没有 Markdown 笔记')
}

const someBoard = findNode(tree.value, (n) => n.type === 'note' && n.kind === 'whiteboard')
if (someBoard) {
  const b = await call('board:read', someBoard.id)
  check('board:read', b.ok, b.ok ? `《${someBoard.name}》节点 ${b.value?.nodes?.length ?? 0} / 连线 ${b.value?.edges?.length ?? 0}` : b.error)
} else {
  check('board:read', false, '树里没有白板')
}

console.log('\n=== 二、写循环（只在副本上） ===')
const folder = await call('folder:create', '', '冒烟测试夹')
check('folder:create', folder.ok, folder.ok ? JSON.stringify(folder.value) : folder.error)

// 签名：note:create 收一个对象 { dir, kind, title }
const created = await call('note:create', { dir: '冒烟测试夹', kind: 'md', title: '冒烟测试笔记' })
check('note:create', created.ok && created.value?.id, created.ok ? created.value.id : created.error)
const noteId = created.value?.id

let beforeId = ''
if (noteId) {
  const r1 = await call('note:read', noteId)
  const content1 = r1.value?.content ?? ''
  beforeId = (content1.match(/^id:\s*(\S+)/m) ?? [])[1] ?? ''
  check('新笔记带 frontmatter id', /^---[\s\S]*?^id:\s*\S+/m.test(content1), beforeId)

  const saved = await call('note:save', noteId, content1.replace(/# .*/, '# 冒烟测试内容\n\n这是自动化测试写入的一行。'), 0)
  check('note:save', saved.ok, saved.ok ? 'ok' : saved.error)

  const renamed = await call('note:rename', noteId, '冒烟测试改名')
  check('note:rename', renamed.ok, renamed.ok ? 'ok' : renamed.error)

  const r2 = await call('note:read', noteId)
  const afterId = ((r2.value?.content ?? '').match(/^id:\s*(\S+)/m) ?? [])[1] ?? ''
  check('改名后 id 不变', beforeId !== '' && afterId === beforeId, `${beforeId} -> ${afterId}`)

  const deleted = await call('note:delete', noteId)
  check('note:delete', deleted.ok, deleted.ok ? 'ok' : deleted.error)

  const trashAfter = await call('trashNote:list')
  const inTrash = (trashAfter.value ?? []).some((t) => t.id === noteId || t.note?.id === noteId)
  check('删除后进回收站', inTrash, `回收站 ${trashAfter.value?.length ?? 0} 条`)

  // 签名：trashNote:restore 收的是 id 数组
  const restored = await call('trashNote:restore', [noteId])
  check('回收站还原', restored.ok, restored.ok ? 'ok' : restored.error)

  const r3 = await call('note:read', noteId)
  check('还原后仍可读', r3.ok, r3.ok ? 'ok' : r3.error)
}

console.log('\n=== 三、磁盘一致性 ===')
// 回归：磁盘上的每个笔记文件都必须出现在树里。
// 曾有一块白板因文件头带 YAML frontmatter，JSON.parse 抛错被整块跳过（界面上凭空消失）。
const onDisk = diskNotes(notesDir)
// 重新取一次树：上面的 tree 是写循环之前的快照
const treeNow = await call('note:tree')
const inTree = countNodes(treeNow.value, (n) => n.type === 'note')
check('磁盘文件全部出现在树里', onDisk.length === inTree, `磁盘 ${onDisk.length} 个 / 树里 ${inTree} 个`)

const indexFile = join(libDir, 'data', 'notes.json')
check('索引文件存在', existsSync(indexFile), indexFile)
if (existsSync(indexFile)) {
  const idx = JSON.parse(readFileSync(indexFile, 'utf8'))
  check('索引条目数 == 磁盘笔记数', Array.isArray(idx) && idx.length === onDisk.length, `索引 ${Array.isArray(idx) ? idx.length : '?'} / 磁盘 ${onDisk.length}`)
}
check('冒烟测试夹已创建', existsSync(join(notesDir, '冒烟测试夹')), join(notesDir, '冒烟测试夹'))

// ---------- 路径解析：在资源管理器中显示（修过一次的真 bug） ----------
console.log('\n=== 路径解析（shell:reveal） ===')
{
  // 注入假的系统集成：否则跑一次测试就会在你桌面上弹资源管理器
  const revealed = []
  rt.setShellHandler({ showItemInFolder: (p) => revealed.push(p) })

  const flat = []
  ;(function walk(list) {
    for (const n of list ?? []) {
      if (n.type === 'note') flat.push(n)
      walk(n.children)
    }
  })((await call('note:tree')).value)

  const rootNote = flat.find((n) => !String(n.path).includes('/'))
  const nestedNote = flat.find((n) => String(n.path).includes('/'))

  if (rootNote !== undefined) {
    // 旧客户端在 dir='' 时会拼出 "/xxx.md" —— Windows 会把它当绝对路径，于是解析被绕过
    const cases = [
      ['根目录笔记（相对路径）', String(rootNote.path)],
      ['根目录笔记（前导斜杠＝旧客户端行为）', '/' + String(rootNote.path)]
    ]
    for (const [name, arg] of cases) {
      const before = revealed.length
      const res = await call('shell:reveal', arg)
      const got = revealed[revealed.length - 1]
      check(`reveal 能解析${name}`, res.ok === true && revealed.length === before + 1 && existsSync(got),
        res.ok === true ? got : String(res.error))
    }
  } else {
    check('存在根目录笔记（用于测试）', false, '副本里没有库根目录下的笔记')
  }

  if (nestedNote !== undefined) {
    const res = await call('shell:reveal', String(nestedNote.path))
    const got = revealed[revealed.length - 1]
    check('reveal 能解析嵌套相对路径', res.ok === true && existsSync(got), res.ok === true ? got : String(res.error))
  }

  const absTarget = join(notesDir, '冒烟测试夹')
  const resAbs = await call('shell:reveal', absTarget)
  check('reveal 支持真正的绝对路径', resAbs.ok === true && revealed[revealed.length - 1] === absTarget, String(revealed[revealed.length - 1]))

  const resBad = await call('shell:reveal', '不存在的文件-xyz.md')
  check('reveal 对不存在的路径给出可读错误', resBad.ok === false && String(resBad.error).includes('文件不存在'), String(resBad.error).slice(0, 90))
  rt.setShellHandler(undefined)
}

console.log('\n=== 汇总 ===')
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
}
console.log('工作目录（保留供排查）：' + work)
process.exitCode = failed.length === 0 ? 0 : 1
