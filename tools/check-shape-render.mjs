/**
 * 阶段 2 验证：8 种图形是否**真的渲染出来了**（在 jsdom 里挂真实组件）。
 *
 *   node tools/check-shape-render.mjs
 *
 * 验的事：
 *   ① 8 种图形各自画出了正确的 SVG 元素（rect/ellipse/path）
 *   ② 颜色走的是 CSS 变量（几何图形填充用 --card-*-bg，线/描边用 --draw-*-line）
 *   ③ 箭头有 markerEnd，且指向**跟色**的 marker（不是写死的灰）
 *   ④ 图层顺序：图形在连线之后、卡片之前
 *   ⑤ 空图形列表不渲染任何东西（不产生垃圾 DOM）
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

const ROOT = 'D:/DSH/test01/quill-dsh'
const requireFromWorkapp = createRequire('D:/DSH/test01/workapp/package.json')
const { build } = requireFromWorkapp('esbuild')
const { JSDOM } = requireFromWorkapp('jsdom')

const results = []
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d ? ' -- ' + d : ''}`) }

/* ---------- 构建测试 bundle ---------- */
const outFile = join(ROOT, '.tmp', 'board-render-test.cjs')
await build({
  entryPoints: [join(ROOT, 'tools', 'board-render-entry.tsx')],
  outfile: outFile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'chrome120',
  jsx: 'automatic',
  logLevel: 'silent',
  absWorkingDir: ROOT,
  nodePaths: ['D:/DSH/test01/workapp/node_modules'],
  define: { 'window.api': 'globalThis.__quillApi' },
  loader: { '.png': 'dataurl' },
  plugins: [{
    name: 'alias',
    setup(b) {
      b.onResolve({ filter: /^@shared\// }, (a) => ({ path: join(ROOT, 'shared', a.path.slice('@shared/'.length)) + '.ts' }))
      b.onResolve({ filter: /^(ssh2|pdfjs-dist)/ }, () => ({ path: join(ROOT, 'src-host', 'stubs', 'pdfjs.ts') }))
    }
  }]
})
console.log('测试 bundle 构建完成：' + Math.round(requireFromWorkapp('node:fs').statSync(outFile).size / 1024) + ' KB')

/* ---------- 建 jsdom 环境 ---------- */
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:19387/',
  pretendToBeVisual: true
})
const { window } = dom
// 把 node 侧全局指向 jsdom。
// 注意：node 里 navigator 等是"只读 getter"，直接赋值会 TypeError，必须用 defineProperty
//（这个坑与 tools/jsdom-env.mjs 里踩过的是同一个）。
const GLOBALS = [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
  'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'DOMParser', 'XMLSerializer', 'SVGElement'
]
for (const key of GLOBALS) {
  const v = key === 'getComputedStyle' ? window.getComputedStyle.bind(window)
    : key === 'requestAnimationFrame' ? ((cb) => setTimeout(() => cb(Date.now()), 0))
      : key === 'cancelAnimationFrame' ? ((id) => clearTimeout(id))
        : window[key]
  if (v === undefined) continue
  Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true })
}
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
Object.defineProperty(window, 'matchMedia', { value: globalThis.matchMedia, configurable: true, writable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = false

// 面板用到的宿主接口：返回空数据即可（测的是渲染，不是数据）
globalThis.__quillApi = new Proxy({}, {
  get: () => async () => ({ ok: true, value: {} })
})

const mod = requireFromWorkapp(outFile)
const container = window.document.getElementById('root')
const board = mod.makeFixtureBoard()
mod.mountBoard(container, board)
await new Promise((r) => setTimeout(r, 400))

const html = container.innerHTML
const q = (sel) => container.querySelectorAll(sel)

console.log('\n=== ① 8 种图形各自渲染 ===')
check('图形容器 .board-shapes 已渲染', q('.board-shapes').length === 1)
check('图形节点数 = 8', q('[data-shape-id]').length === 8, `实际 ${q('[data-shape-id]').length}`)

const kinds = [...q('[data-shape-id]')].map((el) => el.getAttribute('data-shape-kind'))
for (const k of ['rect', 'ellipse', 'triangle', 'diamond', 'line', 'arrow', 'curve', 'free']) {
  check(`kind=${k} 已渲染`, kinds.includes(k), '')
}

console.log('\n=== ② SVG 元素类型正确 ===')
const g = (id) => container.querySelector(`[data-shape-id="${id}"]`)
check('rect 用 <rect>', g('s1')?.querySelector('rect') !== null)
check('ellipse 用 <ellipse>', g('s2')?.querySelector('ellipse') !== null)
check('triangle 用 <path>（闭合三角）', (g('s3')?.querySelector('path')?.getAttribute('d') ?? '').includes('Z'))
check('diamond 用 <path>（四边菱形）', (g('s4')?.querySelector('path')?.getAttribute('d') ?? '').split('L').length === 4)
check('line 用 <path>（fill=none）', g('s5')?.querySelector('path')?.getAttribute('fill') === 'none')
check('curve 的 d 含三次贝塞尔 C', (g('s7')?.querySelector('path')?.getAttribute('d') ?? '').includes('C'))
check('free 的 d 含 C（同样平滑过点）', (g('s8')?.querySelector('path')?.getAttribute('d') ?? '').includes('C'))

console.log('\n=== ③ 颜色走 CSS 变量（深浅自动换色） ===')
check('矩形填充用 --card-blue-bg', (g('s1')?.querySelector('rect')?.getAttribute('fill') ?? '').includes('--card-blue-bg'),
  g('s1')?.querySelector('rect')?.getAttribute('fill') ?? '')
check('矩形描边用 --draw-blue-line', (g('s1')?.querySelector('rect')?.getAttribute('stroke') ?? '').includes('--draw-blue-line'),
  g('s1')?.querySelector('rect')?.getAttribute('stroke') ?? '')
check('椭圆填充用 --card-pink-bg', (g('s2')?.querySelector('ellipse')?.getAttribute('fill') ?? '').includes('--card-pink-bg'))
check('直线颜色用 --draw-purple-line', (g('s5')?.querySelector('path')?.getAttribute('stroke') ?? '').includes('--draw-purple-line'),
  g('s5')?.querySelector('path')?.getAttribute('stroke') ?? '')

console.log('\n=== ④ 箭头 marker 跟色（不是写死的灰） ===')
const arrowMarker = g('s6')?.querySelector('path')?.getAttribute('marker-end') ?? ''
check('箭头有 marker-end', arrowMarker !== '', arrowMarker)
check('marker 指向 default 色（不是写死灰）', arrowMarker.includes('arrow-default'), arrowMarker)
check('非箭头图形没有 marker-end', (g('s5')?.querySelector('path')?.getAttribute('marker-end') ?? '') === '')
check('产物里 6 个跟色 marker 都在', ['default', 'pink', 'blue', 'green', 'yellow', 'purple'].every((k) => html.includes(`arrow-${k}`)),
  '')

console.log('\n=== ⑤ 图层顺序（底纹 → 连线 → 图形 → 卡片） ===')
const svg = container.querySelector('.board-svg')
const shapesG = container.querySelector('.board-shapes')
check('图形在 SVG 内部', svg !== null && shapesG !== null && svg.contains(shapesG))
{
  // 图层顺序要看 **.board-inner 的直接子元素顺序**：
  //   <svg>（连线 + 图形）→ .edge-label → .board-node（卡片）
  // 图形与连线同在 SVG 内，卡片是 SVG 之后的 DOM 元素 —— 所以"图形在卡片之下"成立。
  const inner = container.querySelector('.board-inner')
  const kids = [...(inner?.children ?? [])]
  const svgIdx = kids.findIndex((el) => el.classList.contains('board-svg'))
  const firstCardIdx = kids.findIndex((el) => el.classList.contains('board-node'))
  check('SVG（含图形）在卡片之前 → 图形在卡片之下', svgIdx >= 0 && (firstCardIdx < 0 || svgIdx < firstCardIdx),
    `svg@${svgIdx} 首个卡片@${firstCardIdx}`)

  // SVG 内部：图形必须画在连线之后（同层顺序）
  const svgKids = [...(svg?.children ?? [])]
  const gWrap = svgKids.find((el) => el.tagName.toLowerCase() === 'g')
  const shapeG = gWrap?.querySelector('.board-shapes') ?? null
  const allInWrap = [...(gWrap?.children ?? [])]
  const shapePos = allInWrap.indexOf(shapeG)
  check('图形在连线 path 之后（SVG 同层）', shapePos >= 0 && shapePos === allInWrap.length - 1,
    `图形在第 ${shapePos + 1}/${allInWrap.length} 位`)
}

console.log('\n=== ⑥ 选中态 ===')
{
  // 重新挂一块，选中 s1
  const c2 = window.document.createElement('div')
  window.document.body.appendChild(c2)
  const b2 = mod.makeFixtureBoard()
  mod.mountBoard(c2, b2)
  await new Promise((r) => setTimeout(r, 200))
  check('默认无选中类', c2.querySelectorAll('.board-shape.selected').length === 0)
}

console.log('\n=== ⑦ 空图形不留垃圾 DOM ===')
{
  const c3 = window.document.createElement('div')
  window.document.body.appendChild(c3)
  const b3 = { ...mod.makeFixtureBoard(), shapes: [] }
  mod.mountBoard(c3, b3)
  await new Promise((r) => setTimeout(r, 200))
  check('无图形时不渲染图形节点', c3.querySelectorAll('[data-shape-id]').length === 0)
  check('面板本体仍正常渲染（没崩）', c3.querySelector('.board-wrap') !== null, '')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n阶段 2：${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.n}：${f.d}`)
process.exit(failed.length === 0 ? 0 : 1)
