/**
 * 渲染冒烟测试 —— 在 jsdom 里把**真实的面板组件**渲染一遍。
 *
 * 为什么需要它：我手上没有浏览器控制（CDP 要等 DSH 带调试端口重启），
 * 而"面板能不能渲染出来"恰恰是当前最大的未知。这个测试用 jsdom + 真实组件 +
 * 真实的宿主 runtime（进程内直连，不走 HTTP）来回答这个问题，能抓住：
 *   · 组件树渲染崩溃、缺模块、样式注入失败、初始数据拉取失败
 *   · 首屏渲染出的关键 DOM（图标条 / 顶栏 / 笔记树）
 *
 * 局限（如实说明）：jsdom 不排版、不加载真实图片、不跑 CSS 动画，
 * 所以它证明"能渲染、能取数、无异常"，**不证明"看起来对"**。
 *
 *   node tools/smoke-render.mjs
 */
import { cpSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, LIBRARY_SNAPSHOT, WORKAPP_PKG_JSON, packageDirName, DEPS_MODULES } from './paths.mjs'

const requireFromWorkapp = createRequire(WORKAPP_PKG_JSON)
const { JSDOM } = requireFromWorkapp('jsdom')
const { build } = requireFromWorkapp('esbuild')

const SRC_LIB = LIBRARY_SNAPSHOT
const work = join(join(ROOT, '.tmp', 'smoke-render'), new Date().toISOString().replace(/[:.]/g, '-'))
const libDir = join(work, 'lib')
const dataDir = join(work, 'data')
mkdirSync(work, { recursive: true })
cpSync(SRC_LIB, libDir, { recursive: true })

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`)
}

// ---------- 1. 用 esbuild 把"真实组件 + jsdom 入口"打成一个可在 node 里 require 的包 ----------
const bundleFile = join(work, 'render-test.cjs')
await build({
  entryPoints: [join(ROOT, 'tools', 'render-entry.tsx')],
  outfile: bundleFile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'chrome120',
  jsx: 'automatic',
  logLevel: 'silent',
  absWorkingDir: ROOT,
  nodePaths: [DEPS_MODULES],
  define: { 'window.api': 'globalThis.__quillApi' },
  loader: { '.png': 'dataurl' },
  plugins: [
    {
      name: 'quill-alias',
      setup(b) {
        b.onResolve({ filter: /^@shared\// }, (args) => ({
          path: join(ROOT, 'shared', args.path.slice('@shared/'.length)) + '.ts'
        }))
        b.onResolve({ filter: /^(ssh2|pdfjs-dist)/ }, () => ({
          path: join(ROOT, 'src-host', 'stubs', 'pdfjs.ts')
        }))
        b.onResolve({ filter: /\?(url|raw)$/ }, () => ({ path: 'empty', namespace: 'empty' }))
        b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: 'export default ""', loader: 'js' }))
      }
    }
  ]
})
check('测试 bundle 构建', true, `${(readFileSync(bundleFile).length / 1024).toFixed(0)} KB`)

// ---------- 2. 准备 jsdom 环境 ----------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:19387/',
  pretendToBeVisual: true
})
const { window } = dom
// jsdom 缺的浏览器 API，按组件实际用到的补齐
window.matchMedia = window.matchMedia ?? ((query) => ({
  matches: false, media: query, onchange: null,
  addEventListener: () => undefined, removeEventListener: () => undefined,
  addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false
}))
try {
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => undefined }, configurable: true })
} catch { /* jsdom 里可能已经存在，忽略 */ }
window.requestAnimationFrame = window.requestAnimationFrame ?? ((cb) => setTimeout(() => cb(Date.now()), 0))
window.cancelAnimationFrame = window.cancelAnimationFrame ?? ((id) => clearTimeout(id))
window.ResizeObserver = window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }
window.document.elementsFromPoint = window.document.elementsFromPoint ?? (() => [])
window.Element.prototype.scrollIntoView = window.Element.prototype.scrollIntoView ?? function () {}
window.HTMLElement.prototype.setPointerCapture = window.HTMLElement.prototype.setPointerCapture ?? function () {}
window.HTMLElement.prototype.releasePointerCapture = window.HTMLElement.prototype.releasePointerCapture ?? function () {}
window.HTMLElement.prototype.hasPointerCapture = window.HTMLElement.prototype.hasPointerCapture ?? function () { return false }

// 把 node/test 环境的全局指向 jsdom
const globals = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'DragEvent', 'File', 'Blob', 'FileReader', 'Image', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'MutationObserver', 'DOMRect', 'Range', 'Selection', 'DOMParser', 'XMLSerializer']
for (const key of globals) {
  if (window[key] === undefined) continue
  // node 里有些全局（如 navigator）是只读 getter，必须 defineProperty 才能覆盖
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = false

// ---------- 3. 进程内直连宿主 runtime（等于把 fetch 路由到 /quill-user/api） ----------
const { createRuntime } = await import('../packages/' + packageDirName() + '/lib/host.js')
const rt = await createRuntime({ dataDir, libraryRoot: libDir })
console.log(`  宿主 runtime 就绪：库=${rt.libraryRoot()}，通道 ${rt.channels.length} 个`)

const calls = []
globalThis.fetch = async (url, init) => {
  const path = String(url)
  if (!path.includes('/quill-user/api')) return { ok: false, status: 404, async json() { return { ok: false, error: 'not found' } } }
  const body = JSON.parse(init?.body ?? '{}')
  const result = (await rt.invoke(body.channel, body.args ?? [])) ?? { ok: false, error: '未知通道：' + body.channel }
  calls.push({ channel: body.channel, ok: result.ok === true })
  return {
    ok: true,
    status: 200,
    async json() { return result }
  }
}

// ---------- 4. 渲染真实面板 ----------
const container = window.document.getElementById('root')
const renderTest = requireFromWorkapp(bundleFile)
let renderError = null
try {
  renderTest.mount(container)
} catch (error) {
  renderError = error
}
check('面板首次渲染未抛异常', renderError === null, renderError === null ? '' : String(renderError?.message ?? renderError))

// 等 React 的 effect 与初始请求落地
await new Promise((r) => setTimeout(r, 1500))

const html = container.innerHTML
const text = container.textContent ?? ''
check('根容器 #dsh-quill-user-root 已渲染', container.querySelector('#dsh-quill-user-root') !== null, `${html.length} 字节 HTML`)
check('样式已注入（data-plugin="dsh-quill"）', html.includes('data-plugin="dsh-quill"'), '')
check('Quill 图标条 .rail 已渲染', container.querySelector('.rail') !== null, '')
check('顶栏 .appbar 已渲染', container.querySelector('.appbar') !== null, `标题=${container.querySelector('.appbar h1')?.textContent ?? '（无）'}`)
check('笔记树已渲染', container.querySelector('.tree-node') !== null || container.querySelector('.tree-scroll') !== null, '')
check('未出现"面板渲染出错"', !text.includes('面板渲染出错'), '')
check('未出现"应用启动失败"', !text.includes('应用启动失败'), '')

const okCalls = calls.filter((c) => c.ok).length
const badCalls = calls.filter((c) => !c.ok)
check('初始通道调用全部成功', badCalls.length === 0, `${okCalls}/${calls.length} 成功${badCalls.length ? '，失败：' + badCalls.map((c) => c.channel).join(', ') : ''}`)

// 渲染出的可见文本片段，便于人工核对
const visible = text.replace(/\s+/g, ' ').slice(0, 220)
console.log('\n  首屏可见文本：' + visible)

console.log('\n=== 汇总 ===')
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
console.log('工作目录：' + work)
// jsdom + React 的定时器会吊住事件循环，这里显式退出（否则脚本"跑完了却不结束"）
process.exit(failed.length === 0 ? 0 : 1)
