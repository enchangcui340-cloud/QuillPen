/**
 * 用户/前端视角全量巡检（一二挡合并回归）。
 *
 * 目标：站在"用户会怎么点"的角度，把界面上**每一个入口、每一个弹窗、每一个右键菜单**
 * 都走一遍，同时全程统计错误提示，确保没有"点了没反应 / 一点就报错"的地方。
 *
 * 与 smoke-interact 的分工：
 *   · smoke-interact  —— 深：少数几条链路，一直验到磁盘文件
 *   · smoke-user      —— 广：所有入口都可达，且全程零错误提示
 *
 *   node tools/smoke-user.mjs
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createEnv, wait, domHelpers } from './jsdom-env.mjs'
import { REAL_LIBRARY } from './paths.mjs'

const env = await createEnv()
const { window, container, libDir } = env
const H = domHelpers(window)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`)
}

// ---------- 错误提示收集 ----------
const errors = new Set()
function sweepErrors() {
  for (const t of container.querySelectorAll('.toast')) {
    const text = (t.textContent ?? '').trim()
    if (text !== '' && (t.className.includes('error') || /失败|错误|出错|异常|不存在/.test(text))) errors.add(text)
  }
  const bodyText = container.textContent ?? ''
  for (const bad of ['面板渲染出错', '应用启动失败', 'undefined is not', 'Cannot read properties']) {
    if (bodyText.includes(bad)) errors.add(bad)
  }
}
async function act(label, fn, ms = 700) {
  fn()
  await wait(ms)
  sweepErrors()
}

// ---------- 真实数据护栏 ----------
const REAL_PATHS = [
  REAL_LIBRARY,
  join(process.env.APPDATA ?? '', 'workapp')
]
function snapshotTree(root) {
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
const realBefore = REAL_PATHS.map((p) => [p, snapshotTree(p)])

// ---------- 0. 挂载 ----------
env.mount(container)
await wait(1500)
check('面板挂载成功', container.querySelector('#dsh-quill-user-root') !== null, '')

const railBtns = () => [...container.querySelectorAll('.rail-btn')]
check('图标条有 4 个入口', railBtns().length === 4, railBtns().map((b) => b.getAttribute('title')).join(' / '))

// ---------- A0. 隐藏 DSH 左侧栏 ----------
{
  let toggleCalls = 0
  globalThis.__quillLayout__ = { toggleSidebar: () => { toggleCalls++ } }
  const hideBtn = [...container.querySelectorAll('[title]')].find((b) => (b.getAttribute('title') ?? '').includes('隐藏侧边栏'))
  check('顶栏有「隐藏侧边栏」按钮', hideBtn !== undefined, hideBtn?.getAttribute('title') ?? '')
  if (hideBtn) {
    H.click(hideBtn)
    await wait(400)
    check('点击后确实调用了宿主的 toggleSidebar', toggleCalls === 1, `调用 ${toggleCalls} 次`)
  }
  sweepErrors()
}

// ---------- A. 区域可达 ----------
for (const title of ['Todolist', '笔记库']) {
  const btn = railBtns().find((b) => (b.getAttribute('title') ?? '') === title)
  if (btn === undefined) { check(`区域「${title}」入口存在`, false, ''); continue }
  await act(title, () => H.click(btn), 900)
  const areaText = (container.querySelector('.task-layout, .notes-layout')?.textContent ?? '').trim()
  check(`区域「${title}」渲染出内容`, areaText.length > 10, `${areaText.replace(/\s+/g, ' ').slice(0, 70)}…`)
}

// ---------- B. 弹窗可达 ----------
{
  const trashBtn = railBtns().find((b) => (b.getAttribute('title') ?? '').includes('回收站'))
  await act('打开回收站', () => H.click(trashBtn), 900)
  const dlg = [...container.querySelectorAll('.modal')].at(-1)
  const tabs = [...(dlg?.querySelectorAll('button.tab') ?? [])].map((b) => (b.textContent ?? '').trim())
  check('回收站弹窗有两个标签页', tabs.length === 2, tabs.join(' / '))
  const noteTab = [...(dlg?.querySelectorAll('button.tab') ?? [])].find((b) => (b.textContent ?? '').includes('笔记回收站'))
  await act('切到笔记回收站', () => H.click(noteTab), 600)
  check('笔记回收站有内容行', (dlg?.textContent ?? '').length > 20, '')
  await act('关闭回收站', () => H.click(dlg?.querySelector('[title="关闭"]')), 600)
  check('回收站已关闭', container.querySelector('.modal') === null || [...container.querySelectorAll('.modal')].length === 0, '')
}
{
  const setBtn = railBtns().find((b) => (b.getAttribute('title') ?? '').includes('设置'))
  await act('打开设置', () => H.click(setBtn), 900)
  const dlg = [...container.querySelectorAll('.modal')].at(-1)
  const text = dlg?.textContent ?? ''
  check('设置含「数据目录」', text.includes('数据目录'), '')
  check('设置含「界面主题」', text.includes('界面主题'), '')
  check('设置含数据目录管理', text.includes('新建') && text.includes('切换'), '')
  check('设置里没有 AI 字段（模型 ID/接口地址）', !text.includes('模型 ID') && !text.includes('接口地址'), '')
  const themeSelect = dlg?.querySelector('select')
  check('主题下拉有 3 个选项', themeSelect?.querySelectorAll('option').length === 3, '')
  await act('关闭设置', () => H.click(dlg?.querySelector('[title="关闭"]')), 600)
}

// ---------- C. 右键菜单可达 ----------
const menuLabels = () => [...container.querySelectorAll('.ctx-menu .ctx-item')].map((b) => (b.textContent ?? '').trim())
const closeMenu = () => window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
async function expectMenu(name, target, mustHave) {
  if (target === undefined || target === null) { check(`右键菜单：${name}`, false, '找不到触发元素'); return }
  H.contextMenu(target)
  await wait(500)
  sweepErrors()
  const labels = menuLabels()
  const missing = mustHave.filter((m) => !labels.some((l) => l.includes(m)))
  check(`右键菜单：${name}`, labels.length > 0 && missing.length === 0,
    labels.length === 0 ? '菜单没弹出' : `实际项：${labels.join('|')}${missing.length ? '，缺少：' + missing.join('、') : ''}`)
  closeMenu()
  await wait(300)
}

// 先回到笔记库
const notesRail = railBtns().find((b) => (b.getAttribute('title') ?? '').includes('笔记库'))
await act('回到笔记库', () => H.click(notesRail), 800)

// 判别方式：笔记行的操作按钮是 title="重命名"，笔记夹是 title="重命名笔记夹"
// （界面显示的是标题不是文件名，所以不能用 ".md" 判断）
const nodes = [...container.querySelectorAll('.tree-node')]
const folderNode = nodes.find((n) => n.querySelector('[title="重命名笔记夹"]') !== null)
const mdNode = nodes.find((n) => n.querySelector('[title="重命名"]') !== null)
await expectMenu('笔记夹节点（顶层夹）', folderNode, ['新建', '重命名', '删除'])
await expectMenu('笔记节点（.md）', mdNode, ['重命名', '复制到', '删除'])
const treeScroll = container.querySelector('.tree-scroll')
await expectMenu('笔记库空白处', treeScroll, ['新建文本笔记', '新建白板'])
const boardNode = nodes.find((n) => /canvas|白板/.test(n.textContent ?? ''))
if (boardNode) await expectMenu('白板节点', boardNode, ['重命名', '删除'])

// 待办区：任务条目没有右键菜单（用的是悬停按钮），标签面板空白处有菜单
const todoRail = railBtns().find((b) => (b.getAttribute('title') ?? '') === 'Todolist')
await act('切到 Todolist', () => H.click(todoRail), 800)
const taskItem = container.querySelector('.task-item')
check('任务条目有悬停操作按钮', taskItem !== null && (taskItem.querySelectorAll('.task-actions button').length > 0 || taskItem.querySelector('.check') !== null),
  taskItem === null ? '没有任务条目' : `${taskItem.querySelectorAll('.task-actions button').length} 个操作按钮`)
const tagScroll = container.querySelector('.tag-tree-scroll')
await expectMenu('标签面板空白处', tagScroll, ['新建顶层标签'])

// 编辑器区域（笔记库 → 打开一篇笔记 → 右键格式菜单）
await act('回笔记库', () => H.click(notesRail), 700)
const anyNote = [...container.querySelectorAll('.tree-node')].find((n) => (n.textContent ?? '').includes('.md'))
if (anyNote) {
  await act('打开一篇笔记', () => H.click(anyNote), 1200)
  const editor = container.querySelector('.cm-content')
  await expectMenu('编辑器格式菜单', editor, ['加粗', '插入图片', '插入分割线'])
}

// ---------- D. 全程错误提示 ----------
sweepErrors()
check('全程零错误提示', errors.size === 0, errors.size === 0 ? '没有任何报错弹窗' : [...errors].slice(0, 4).join('；'))

// ---------- E. 真实数据零改动 ----------
{
  const diffs = []
  for (const [root, before] of realBefore) {
    const after = snapshotTree(root)
    for (const [rel, sig] of after) {
      const old = before.get(rel)
      if (old === undefined) diffs.push(`新增 ${rel}`)
      else if (old !== sig) diffs.push(`改动 ${rel}`)
    }
    for (const rel of before.keys()) if (!after.has(rel)) diffs.push(`删除 ${rel}`)
  }
  check('用户真实数据零改动', diffs.length === 0, diffs.length === 0 ? '快照完全一致' : diffs.slice(0, 4).join('；'))
}

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok)
console.log(`\n=== 汇总 ===\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
console.log('库副本：' + libDir)
process.exit(failed.length === 0 ? 0 : 1)
