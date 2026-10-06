/**
 * jsdom 测试环境（供 smoke-render / smoke-interact 复用）。
 *
 * 做四件事：
 *   1. esbuild 把"真实组件 + 测试入口"打成 CJS；
 *   2. 建 jsdom，补齐 React/CodeMirror 在 jsdom 里会用到、但 jsdom 没有的 API；
 *   3. 把 fetch 直连到真实宿主 runtime（进程内，不走 HTTP）；
 *   4. 返回 window / 容器 / runtime / 调用记录。
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, LIBRARY_SNAPSHOT, WORKAPP_PKG_JSON, packageDirName } from './paths.mjs'

const requireFromWorkapp = createRequire(WORKAPP_PKG_JSON)
const PROJECT = ROOT

/**
 * esbuild 找 React / CodeMirror 等客户端依赖的 node_modules 路径。
 *
 * 不能写死本机路径（开源用户没有那个目录，会导致 esbuild 从别处解析出**第二份 React**，
 * 症状是 "Invalid hook call / Cannot read properties of null (reading 'useState')"）。
 * 优先用实际装着依赖的那份（就是 WORKAPP_PKG_JSON 所在的 node_modules）。
 */
const DEPS_MODULES = join(dirname(WORKAPP_PKG_JSON), 'node_modules')

export async function createEnv(options = {}) {
  const libSrc = options.libSrc ?? LIBRARY_SNAPSHOT
  // 临时目录跟着仓库走（原来写死 D:/DSH/test01/.tmp，开源用户没有那个路径）
  const work = join(ROOT, '.tmp', 'jsdom', new Date().toISOString().replace(/[:.]/g, '-'))
  const libDir = join(work, 'lib')
  const dataDir = join(work, 'data')
  mkdirSync(work, { recursive: true })
  cpSync(libSrc, libDir, { recursive: true })
  // 允许调用方在"建 runtime 之前"往副本里造数据（性能测试用）
  if (typeof options.prepare === 'function') options.prepare(libDir)

  const { build } = requireFromWorkapp('esbuild')
  const { JSDOM } = requireFromWorkapp('jsdom')

  const bundleFile = join(work, 'render-test.cjs')
  await build({
    entryPoints: [join(PROJECT, 'tools', 'render-entry.tsx')],
    outfile: bundleFile,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'chrome120',
    jsx: 'automatic',
    logLevel: 'silent',
    absWorkingDir: PROJECT,
    nodePaths: [DEPS_MODULES],
    define: { 'window.api': 'globalThis.__quillApi' },
    loader: { '.png': 'dataurl' },
    plugins: [
      {
        name: 'quill-alias',
        setup(b) {
          b.onResolve({ filter: /^@shared\// }, (args) => ({
            path: join(PROJECT, 'shared', args.path.slice('@shared/'.length)) + '.ts'
          }))
          b.onResolve({ filter: /^(ssh2|pdfjs-dist)/ }, () => ({ path: join(PROJECT, 'src-host', 'stubs', 'pdfjs.ts') }))
          b.onResolve({ filter: /\?(url|raw)$/ }, () => ({ path: 'empty', namespace: 'empty' }))
          b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: 'export default ""', loader: 'js' }))
        }
      }
    ]
  })

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:19387/',
    pretendToBeVisual: true
  })
  const { window } = dom

  // ---- 补齐 jsdom 缺的浏览器 API ----
  window.matchMedia = window.matchMedia ?? ((query) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false
  }))
  try {
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => undefined }, configurable: true })
  } catch { /* 已存在则忽略 */ }
  window.requestAnimationFrame = window.requestAnimationFrame ?? ((cb) => setTimeout(() => cb(Date.now()), 0))
  window.cancelAnimationFrame = window.cancelAnimationFrame ?? ((id) => clearTimeout(id))
  window.ResizeObserver = window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }
  window.MutationObserver = window.MutationObserver ?? class { observe() {} disconnect() {} takeRecords() { return [] } }
  window.document.elementsFromPoint = window.document.elementsFromPoint ?? (() => [])
  const noRects = function () { return [] }
  const zeroRect = function () { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } }
  for (const proto of [window.Element.prototype, window.Range.prototype]) {
    if (proto.getClientRects === undefined) proto.getClientRects = noRects
    if (proto.getBoundingClientRect === undefined) proto.getBoundingClientRect = zeroRect
  }
  for (const name of ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture', 'scrollIntoView']) {
    if (window.HTMLElement.prototype[name] === undefined) {
      window.HTMLElement.prototype[name] = name === 'hasPointerCapture' ? function () { return false } : function () {}
    }
  }
  // 删除确认走的是浏览器 confirm：测试里一律"确认"
  window.confirm = () => true
  window.alert = () => undefined
  window.prompt = () => 'test'

  /**
   * 假的 Image：jsdom 默认不加载图片，`img.onload` 永不触发 ——
   * 而白板"加图片卡片"要等 `imageSize()` 拿到尺寸才建节点，于是会卡住。
   * 这里给它一个立即回调的替身，让图片链路能在测试里跑完。
   * （真实浏览器里由浏览器加载，无需这个替身。）
   */
  class TestImage {
    constructor() {
      this.naturalWidth = 240
      this.naturalHeight = 160
      this.width = 240
      this.height = 160
      this.onload = null
      this.onerror = null
      this._src = ''
    }
    get src() { return this._src }
    set src(value) {
      this._src = value
      setTimeout(() => { if (typeof this.onload === 'function') this.onload() }, 0)
    }
    addEventListener(type, handler) { if (type === 'load') this.onload = handler }
  }
  window.Image = TestImage

  // ---- 把 node 侧全局指向 jsdom（node 里有些是只读 getter，必须 defineProperty） ----
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'DragEvent', 'File', 'Blob', 'FileReader', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'MutationObserver', 'DOMRect', 'Range', 'Selection', 'DOMParser', 'XMLSerializer', 'NodeFilter', 'Window', 'Document', 'DocumentFragment', 'Image']
  for (const key of globals) {
    if (window[key] === undefined) continue
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = false

  // ---- fetch → 宿主 runtime（进程内直连） ----
  // 测试隔离：禁止继承用户真实的库注册表，避免任何一步"切换数据目录"跑到真实库里
  process.env.DSH_QUILL_NO_REGISTRY_INHERIT = '1'
  const { createRuntime } = await import('../packages/' + packageDirName() + '/lib/host.js')
  const rt = await createRuntime({ dataDir, libraryRoot: libDir })
  const calls = []
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('/quill-user/api')) {
      return { ok: false, status: 404, async json() { return { ok: false, error: 'not found' } } }
    }
    const body = JSON.parse(init?.body ?? '{}')
    const result = (await rt.invoke(body.channel, body.args ?? [])) ?? { ok: false, error: '未知通道：' + body.channel }
    calls.push({ channel: body.channel, ok: result.ok === true, inner: result.value, error: result.error, at: Date.now(), args: body.args })
    return { ok: true, status: 200, async json() { return result } }
  }

  const mount = requireFromWorkapp(bundleFile).mount
  const container = window.document.getElementById('root')

  return { window, container, rt, calls, libDir, dataDir, work, mount, bundleFile }
}

/** 等一会儿（React 的 effect / 请求 / 防抖都在这段时间里落地） */
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 便捷 DOM 助手 */
export function domHelpers(window) {
  const click = (el) => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  }
  const contextMenu = (el) => {
    el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, button: 2 }))
  }
  const setInput = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, value)
    else el.value = value
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  const pressKey = (el, key) => {
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    el.dispatchEvent(new window.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
  }
  const byTitle = (root, title) => [...root.querySelectorAll('[title]')].find((e) => e.getAttribute('title') === title)
  const byText = (root, text) => [...root.querySelectorAll('button, div, span, label')].find((e) => (e.textContent ?? '').trim() === text)
  const contains = (root, text) => (root.textContent ?? '').includes(text)
  return { click, contextMenu, setInput, pressKey, byTitle, byText, contains }
}
