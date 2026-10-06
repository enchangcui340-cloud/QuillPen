/**
 * 阶段 4 验证：绘制模式的真实交互（在 jsdom 里模拟鼠标，断言画布上真的多了图形）。
 *
 *   node tools/check-draw-interact.mjs
 *
 * 验的事：
 *   ① 点「✏️ 绘制」进入绘制模式，工具栏整体切换
 *   ② 8 个工具都能选中
 *   ③ 拖拽能画出几何图形 / 直线 / 箭头
 *   ④ 自由绘制：按住移动能出图形
 *   ⑤ 曲线：点一下落点 → 点第二下成线 → 点中部插控制点 → 点空白锁定
 *   ⑥ 画完**自动切回选择状态**，且刚画的图形被选中（用户第 2 条）
 *   ⑦ Esc 退出绘制模式
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

const ROOT = 'D:/DSH/test01/quill-dsh'
const requireFromWorkapp = createRequire('D:/DSH/test01/workapp/package.json')
const { build } = requireFromWorkapp('esbuild')
const { JSDOM } = requireFromWorkapp('jsdom')

const results = []
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d ? ' -- ' + d : ''}`) }

/* ---------- 构建 ---------- */
const outFile = join(ROOT, '.tmp', 'draw-interact.cjs')
await build({
  entryPoints: [join(ROOT, 'tools', 'board-render-entry.tsx')],
  outfile: outFile, bundle: true, format: 'cjs', platform: 'browser', target: 'chrome120',
  jsx: 'automatic', logLevel: 'silent', absWorkingDir: ROOT,
  nodePaths: ['D:/DSH/test01/workapp/node_modules'],
  define: { 'window.api': 'globalThis.__quillApi' },
  loader: { '.png': 'dataurl' },
  plugins: [{ name: 'a', setup(b) {
    b.onResolve({ filter: /^@shared\// }, (a) => ({ path: join(ROOT, 'shared', a.path.slice(8)) + '.ts' }))
    b.onResolve({ filter: /^(ssh2|pdfjs-dist)/ }, () => ({ path: join(ROOT, 'src-host', 'stubs', 'pdfjs.ts') }))
  } }]
})

/* ---------- jsdom 环境（沿用 jsdom-env 的全局设置方式） ---------- */
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:19387/', pretendToBeVisual: true
})
const { window } = dom
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
  'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'getComputedStyle',
  'DOMParser', 'XMLSerializer', 'SVGElement']
for (const k of GLOBALS) {
  const v = k === 'getComputedStyle' ? window.getComputedStyle.bind(window) : window[k]
  if (v !== undefined) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
}
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
Object.defineProperty(window, 'matchMedia', { value: globalThis.matchMedia, configurable: true, writable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = false
globalThis.__quillApi = new Proxy({}, { get: () => async () => ({ ok: true, value: {} }) })

const mod = requireFromWorkapp(outFile)
const container = window.document.getElementById('root')
const board = mod.makeFixtureBoard()
board.shapes = []   // 从空板开始，方便数"新画出来的"
mod.mountBoard(container, board)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await wait(400)

const $ = (sel) => container.querySelector(sel)
const $$ = (sel) => [...container.querySelectorAll(sel)]
const shapeCount = () => $$('[data-shape-id]').length
const canvas = $('.board-canvas')
const inner = $('.board-inner')

/** 用真实 MouseEvent 模拟一次"按下-移动-松手" */
function drag(fromX, fromY, toX, toY, steps = 4) {
  const opt = (x, y, extra = {}) => new window.MouseEvent('mousemove', {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, ...extra
  })
  const rect = inner.getBoundingClientRect()
  // 世界原点在容器中心：屏幕 = 中心 + 世界坐标（z=1 且 view 未平移时）
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  inner.dispatchEvent(new window.MouseEvent('mousedown', {
    bubbles: true, cancelable: true, clientX: cx + fromX, clientY: cy + fromY, button: 0, buttons: 1
  }))
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    inner.dispatchEvent(opt(cx + fromX + (toX - fromX) * t, cy + fromY + (toY - fromY) * t))
  }
  inner.dispatchEvent(new window.MouseEvent('mouseup', {
    bubbles: true, cancelable: true, clientX: cx + toX, clientY: cy + toY, button: 0, buttons: 0
  }))
}

/** 模拟一次纯点击（曲线用） */
function click(x, y) {
  const rect = inner.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  inner.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx + x, clientY: cy + y, button: 0, buttons: 1 }))
  inner.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: cx + x, clientY: cy + y, button: 0, buttons: 0 }))
  inner.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx + x, clientY: cy + y, button: 0 }))
}

/* ============================ ① 进入绘制模式 ============================ */
console.log('=== ① 进入绘制模式 ===')
check('初始不在绘制模式（工具栏是普通按钮）', $$('.draw-tool').length === 0)
const drawBtn = $$('button').find((b) => (b.textContent ?? '').includes('绘制'))
check('工具栏有「✏️ 绘制」入口', drawBtn !== undefined)
drawBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
await wait(150)
check('进入后出现绘制工具条（9 个：选择+8 工具）', $$('.draw-tool').length === 9, `实际 ${$$('.draw-tool').length} 个`)
check('出现 6 个颜色小圆点', $$('.draw-swatch').length === 6, `实际 ${$$('.draw-swatch').length} 个`)
check('出现「完成」按钮', $$('button').some((b) => (b.textContent ?? '').trim() === '完成'))
check('画布进入十字光标状态（class=drawing）', canvas?.classList.contains('drawing') === true)

console.log('\n=== ② 8 个工具都能切换 ===')
const TOOL_ORDER = ['rect', 'ellipse', 'triangle', 'diamond', 'line', 'arrow', 'curve', 'free']
const toolBtns = $$('.draw-tool')
for (let i = 0; i < TOOL_ORDER.length; i++) {
  const btn = toolBtns[i + 1] // 第 0 个是"选择"
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await wait(60)
  const active = $$('.draw-tool.primary')
  check(`工具 ${TOOL_ORDER[i]} 可选中`, active.length === 1, `高亮 ${active.length} 个`)
  // 顺手画一个，顺便验证每个工具都能落地
  if (['rect', 'ellipse', 'triangle', 'diamond', 'line', 'arrow'].includes(TOOL_ORDER[i])) {
    const before = shapeCount()
    drag(100 + i * 160, 100, 200 + i * 160, 190)
    await wait(120)
    check(`  ${TOOL_ORDER[i]} 拖拽后新增图形`, shapeCount() === before + 1, `${before} → ${shapeCount()}`)
  }
}

console.log('\n=== ③ 自由绘制 ===')
{
  // 切到 free（最后一个是 free，但上面循环结束时可能已切走，这里显式点一下）
  const freeBtn = $$('.draw-tool')[8]
  freeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await wait(80)
  const before = shapeCount()
  drag(0, 400, 200, 460, 10)
  await wait(150)
  check('自由绘制拖拽后新增图形', shapeCount() === before + 1, `${before} → ${shapeCount()}`)
  const free = $$('[data-shape-id]').find((el) => el.getAttribute('data-shape-kind') === 'free')
  check('新图形 kind=free', free !== undefined)
  check('自由绘制的路径是平滑曲线（含 C）', (free?.querySelector('path')?.getAttribute('d') ?? '').includes('C'))
}

/* ============================ ④ 曲线：三段式 ============================ */
console.log('\n=== ④ 曲线：点-点-插点-锁定 ===')
{
  const curveBtn = $$('.draw-tool')[7]
  curveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await wait(80)

  const before = shapeCount()
  // 第一次点击：落第一个点（还不该有图形）
  click(-400, -100)
  await wait(120)
  check('第 1 次点击：还不成图形（只落了起点）', shapeCount() === before, `${before} → ${shapeCount()}`)

  // 第二次点击：成线
  click(-200, -100)
  await wait(150)
  check('第 2 次点击：曲线成形', shapeCount() === before + 1, `${before} → ${shapeCount()}`)

  // 第三次点击：点线段中部 → 插控制点
  click(-300, -100)
  await wait(150)
  const curveEl = $$('[data-shape-id]').find((el) => el.getAttribute('data-shape-kind') === 'curve')
  const dBefore = curveEl?.querySelector('path')?.getAttribute('d') ?? ''
  check('第 3 次点击（点中部）：插入控制点，路径从直线变成曲线', dBefore.includes('C'), dBefore.slice(0, 40))

  // 点空白 → 锁定
  click(600, -400)
  await wait(150)
  check('点空白后控制点消失（曲线已锁定）', $$('.board-ctrl-point').length === 0, `还剩 ${$$('.board-ctrl-point').length} 个控制点`)
  check('锁定后图形数不变（没有多出东西）', shapeCount() === before + 1, `${shapeCount()}`)
}

/* ============================ ⑤ 画完自动切回选择 ============================ */
console.log('\n=== ⑤ 画完自动切回选择状态（用户第 2 条） ===')
{
  // 先确保在绘制模式
  if ($$('.draw-tool').length === 0) {
    const b = $$('button').find((x) => (x.textContent ?? '').includes('绘制'))
    b?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await wait(120)
  }
  // 选矩形并画
  $$('.draw-tool')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await wait(80)
  const before = shapeCount()
  drag(-500, 200, -380, 280)
  await wait(150)
  check('画完新增 1 个图形', shapeCount() === before + 1)
  check('★ 画完自动切回「选择」工具（工具栏高亮回到第 1 个）',
    $$('.draw-tool.primary').length === 1 && $$('.draw-tool')[0].classList.contains('primary'),
    `高亮在索引 ${$$('.draw-tool').findIndex((b) => b.classList.contains('primary'))}`)
  check('★ 刚画的图形处于选中态', $$('.board-shape.selected').length === 1, `${$$('.board-shape.selected').length} 个选中`)
}

/* ============================ ⑤b 自由绘制是例外：不自动切回 ============================ */
console.log('\n=== ⑤b 自由绘制连画：不切回选择（规范 §4.1 的例外） ===')
{
  if ($$('.draw-tool').length === 0) {
    const b = $$('button').find((x) => (x.textContent ?? '').includes('绘制'))
    b?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await wait(120)
  }
  // 切到 free（工具条索引 8）
  $$('.draw-tool')[8].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await wait(80)
  // 先清掉上一段遗留的选中态（⑤ 那里画矩形后是选中的），否则下面断言会被它干扰。
  // 注意：绘制模式下点空白**不会**清选（刻意的，免得画到一半把选中弄丢）→ 先切到「选择」工具。
  // 点两次：第一次可能被 movedRef（上一次拖动留下的"刚移动过"标记）吃掉。
  $$('.draw-tool')[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await wait(80)
  const cleared = shapeCount()
  const cr = inner.getBoundingClientRect()
  const bx = cr.left + cr.width * 0.92
  const by = cr.top + cr.height * 0.08
  for (let i = 0; i < 2; i++) {
    inner.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: bx, clientY: by }))
    inner.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, buttons: 0, clientX: bx, clientY: by }))
    inner.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, clientX: bx, clientY: by }))
    await wait(120)
  }
  // 记录清选后的基线：下面断言"free 落定**没有新增**选中"，不依赖能否彻底清空
  const selectedBefore = $$('.board-shape.selected').length
  check('（准备）图形数没被误删', shapeCount() === cleared, `${cleared} → ${shapeCount()}`)

  // 再切回 free 开始本段测试
  $$('.draw-tool')[8].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await wait(80)
  const before = shapeCount()
  drag(-100, 500, 60, 540, 6)
  await wait(150)
  check('第 1 笔画完新增图形', shapeCount() === before + 1, `${before} → ${shapeCount()}`)
  check('★ free 下**不**切回选择（工具仍是 free）',
    $$('.draw-tool')[8].classList.contains('primary'),
    `高亮在索引 ${$$('.draw-tool').findIndex((b) => b.classList.contains('primary'))}（8=free）`)
  check('★ free 落定后**没有新增**选中（避免连画时高亮碍事）',
    $$('.board-shape.selected').length <= selectedBefore,
    `画前 ${selectedBefore} 个 → 画后 ${$$('.board-shape.selected').length} 个`)

  // 连画第 2 笔，确认工具还在 free
  const mid = shapeCount()
  drag(100, 500, 260, 545, 6)
  await wait(150)
  check('连画第 2 笔也成功（工具没被切走）', shapeCount() === mid + 1, `${mid} → ${shapeCount()}`)
  check('连画后工具依然是 free', $$('.draw-tool')[8].classList.contains('primary'))
}

/* ============================ ⑤c 拖动预览（原来"只写不读"） ============================ */
console.log('\n=== ⑤c 拖动中能看到预览 ===')
{
  if ($$('.draw-tool').length === 0) {
    const b = $$('button').find((x) => (x.textContent ?? '').includes('绘制'))
    b?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await wait(120)
  }
  // 切到矩形（索引 1）
  $$('.draw-tool')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await wait(80)

  const committed = shapeCount()
  const r = inner.getBoundingClientRect()
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  const at = (x, y, buttons) => new window.MouseEvent('mousemove', {
    bubbles: true, cancelable: true, clientX: cx + x, clientY: cy + y, button: 0, buttons
  })

  // 按下但不松手
  inner.dispatchEvent(new window.MouseEvent('mousedown', {
    bubbles: true, cancelable: true, clientX: cx - 600, clientY: cy + 300, button: 0, buttons: 1
  }))
  // 移动几步；每步都要等一帧，否则会被 rAF 合帧吃掉（预览是合帧落地的）
  for (let i = 1; i <= 4; i++) {
    inner.dispatchEvent(at(-600 + i * 40, 300 + i * 25, 1))
    await wait(0)
  }
  await wait(60)

  const draftEl = container.querySelector('.board-shape-draft')
  check('★ 拖动**中途**就能看到预览（.board-shape-draft 存在）', draftEl !== null,
    draftEl === null ? '没有预览层' : '已出现')
  check('★ 预览不污染已落定图形的计数（[data-shape-id] 未变）',
    shapeCount() === committed, `${committed} → ${shapeCount()}`)
  check('预览层不吃鼠标事件（pointer-events: none）',
    (draftEl?.getAttribute('style') ?? '').includes('none') || draftEl?.getAttribute('style') === null,
    draftEl?.getAttribute('style') ?? '(无内联样式)')
  if (draftEl !== null) {
    const inner_el = draftEl.querySelector('rect, ellipse, path')
    check('预览是"只描边不填充"（fill=none）', inner_el?.getAttribute('fill') === 'none',
      inner_el?.getAttribute('fill') ?? '(无)')
    check('预览用虚线（strokeDasharray）', (inner_el?.getAttribute('stroke-dasharray') ?? '') !== '',
      inner_el?.getAttribute('stroke-dasharray') ?? '(无)')
  }

  // 松手落定
  inner.dispatchEvent(new window.MouseEvent('mouseup', {
    bubbles: true, cancelable: true, clientX: cx - 440, clientY: cy + 400, button: 0, buttons: 0
  }))
  await wait(200)
  check('松手后图形落定（+1）', shapeCount() === committed + 1, `${committed} → ${shapeCount()}`)
  check('★ 松手后预览消失', container.querySelector('.board-shape-draft') === null)
}

/* ============================ ⑥ Esc 退出 ============================ */
console.log('\n=== ⑥ Esc 退出绘制模式 ===')
{
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await wait(150)
  check('Esc 后回到普通工具栏（无 .draw-tool）', $$('.draw-tool').length === 0)
  check('画布不再显示十字光标', canvas?.classList.contains('drawing') !== true)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n阶段 4：${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.n}：${f.d}`)
process.exit(failed.length === 0 ? 0 : 1)
