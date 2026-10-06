/**
 * 按钮扫雷（用户视角的"点了没反应"排查）。
 *
 * 做法：把界面上**每一个按钮**都点一遍（跳过删除类破坏性操作），每次点击后判断两件事：
 *   1. 有没有冒出错误提示（硬失败）；
 *   2. 有没有产生**可观察的变化**（宿主通道调用 / DOM 变化 / 弹窗开合）。
 *      什么都没变的记为"无反应"，交人工确认 —— 因为有些按钮本来就可能"无事发生"
 *      （比如已经在居中状态时点「居中」、未改动时点「保存」）。
 *
 *   node tools/audit-buttons.mjs
 */
import { createEnv, wait, domHelpers } from './jsdom-env.mjs'

const env = await createEnv()
const { window, container, calls } = env
const H = domHelpers(window)

const DESTRUCTIVE = /删除|移除|断开|清空|永久|注销|离开|退出|重置|放弃/
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`)
}
const noReaction = []
const newErrors = []
const seenErrors = new Set()
let sidebarToggles = 0
let pickerCalls = 0
// 文件框接一个"用户点了取消"的桩：这样"插入图片/选择文件"这类按钮有确定结局，
// 不会把 jsdom 卡在那里，也能被记为"有反应（弹了文件框）"
globalThis.__DSH_PICK_FILE_HOOK__ = async () => {
  pickerCalls++
  return null
}

function sweepErrors() {
  for (const t of container.querySelectorAll('.toast')) {
    const text = (t.textContent ?? '').trim()
    if (text === '') continue
    if (t.className.includes('error') || /失败|错误|出错|异常/.test(text)) {
      if (!seenErrors.has(text)) { seenErrors.add(text); newErrors.push(text) }
    }
  }
  const body = container.textContent ?? ''
  if (body.includes('面板渲染出错') && !seenErrors.has('面板渲染出错')) {
    seenErrors.add('面板渲染出错')
    newErrors.push('面板渲染出错')
  }
}
const domHash = () => {
  // 去掉 toast 区域，避免"错误提示出现"被当成变化
  const clone = container.cloneNode(true)
  for (const t of clone.querySelectorAll('.toast-wrap')) t.remove()
  const html = clone.innerHTML
  // 全量哈希（之前只取长度+前 80 字，像"内联改名输入框冒出来"这种变化就被漏掉了）
  let h = 5381
  for (let i = 0; i < html.length; i++) h = ((h * 33) ^ html.charCodeAt(i)) >>> 0
  return `${html.length}:${h}`
}
const state = () => ({
  calls: calls.length,
  dom: domHash(),
  modals: container.querySelectorAll('.modal').length,
  menu: container.querySelectorAll('.ctx-menu').length,
  sidebarToggles
})
const lastModal = () => [...container.querySelectorAll('.modal')].at(-1) ?? null
/** 关掉这次点击可能打开的弹窗/菜单，回到干净状态 */
async function cleanup() {
  for (let i = 0; i < 6; i++) {
    const menus = [...container.querySelectorAll('.ctx-menu')]
    if (menus.length > 0) {
      window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await wait(150)
    }
    const modals = [...container.querySelectorAll('.modal')]
    if (modals.length === 0) break
    const btn = modals[modals.length - 1].querySelector('[title="关闭"]')
    if (btn === null) break
    H.click(btn)
    await wait(200)
  }
}

/** 收集当前界面上所有可点元素（按钮），跳过破坏性操作 */
function collectTargets() {
  const list = []
  for (const b of container.querySelectorAll('button')) {
    const label = (b.textContent ?? '').trim() || b.getAttribute('title') || b.getAttribute('aria-label') || '(无文字)'
    if (b.disabled === true) continue
    if (DESTRUCTIVE.test(label) || DESTRUCTIVE.test(b.getAttribute('title') ?? '')) continue
    list.push({ el: b, label: label.slice(0, 24) })
  }
  return list
}

async function sweepWhere(where, maxClicks = 35) {
  const done = new Set()
  let clicks = 0
  console.log(`\n--- ${where} ---`)
  while (clicks < maxClicks) {
    // 每轮重新采集：点一下界面就会重渲染，预采集的元素会失效
    const targets = collectTargets()
    // 用「标签 + 同名序号」作为稳定标识，保证同一轮里不重复点同一个
    const counted = new Map()
    let picked = null
    for (const t of targets) {
      const nth = counted.get(t.label) ?? 0
      counted.set(t.label, nth + 1)
      const key = `${t.label}#${nth}`
      if (!done.has(key)) { done.add(key); picked = t; break }
    }
    if (picked === null) break

    const before = state()
    const errsBefore = newErrors.length
    const picksBefore = pickerCalls
    H.click(picked.el)
    await wait(500)
    sweepErrors()
    const after = state()
    const changed = after.calls !== before.calls || after.modals !== before.modals || after.menu !== before.menu
      || after.dom !== before.dom || after.sidebarToggles !== before.sidebarToggles || pickerCalls !== picksBefore
    const errored = newErrors.length > errsBefore
    if (errored) console.log(`       ✗ 报错：${picked.label} → ${newErrors.slice(errsBefore).join(' / ')}`)
    else if (!changed) noReaction.push(`${where} / ${picked.label}`)
    clicks++
    await cleanup()
  }
  console.log(`       点了 ${clicks} 个（界面共 ${collectTargets().length} 个按钮）`)
}

// ---------- 各区域逐个扫 ----------
env.mount(container)
await wait(1500)
sweepErrors()
check('面板挂载', container.querySelector('#dsh-quill-user-root') !== null, '')
// 给"隐藏侧边栏"接一个桩，否则它点了确实没有界面变化（真实环境里会收起宿主左栏）
globalThis.__quillLayout__ = { toggleSidebar: () => { sidebarToggles++ } }

const rail = (k) => [...container.querySelectorAll('.rail-btn')].find((b) => (b.getAttribute('title') ?? '').includes(k))

H.click(rail('Todolist'))
await wait(800)
await sweepWhere('Todolist')

H.click(rail('笔记库'))
await wait(800)
await sweepWhere('笔记库')

// 打开一篇笔记，扫编辑器的工具栏
const noteNode = [...container.querySelectorAll('.tree-node')].find((n) => n.querySelector('[title="重命名"]') !== null)
if (noteNode) {
  H.click(noteNode)
  await wait(1200)
  await sweepWhere('笔记编辑器')
}

// 打开白板，扫白板工具栏
const boardNode = [...container.querySelectorAll('.tree-node')].find((n) => (n.textContent ?? '').includes('白板') || (n.textContent ?? '').includes('头脑风暴'))
if (boardNode) {
  H.click(boardNode)
  await wait(1200)
  await sweepWhere('白板')
}

// 弹窗：回收站 / 设置
for (const [key, name] of [['回收站', '回收站弹窗'], ['设置', '设置弹窗']]) {
  H.click(rail(key))
  await wait(900)
  await sweepWhere(name, 20)
  await cleanup()
}

// ---------- 结论 ----------
sweepErrors()
check('全程没有出现新的错误提示', newErrors.length === 0, newErrors.length === 0 ? '零报错' : newErrors.slice(0, 5).join('；'))
console.log('\n=== 点了没反应的按钮（需人工确认是否正常） ===')
if (noReaction.length === 0) console.log('   （无）')
for (const n of noReaction) console.log('   · ' + n)
console.log(`\n共 ${noReaction.length} 个`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
process.exit(failed.length === 0 ? 0 : 1)
