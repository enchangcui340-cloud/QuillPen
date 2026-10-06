/**
 * 阶段 5 验证（真浏览器版）：图形与卡片同级——点选、框选、拖动、复制粘贴、删除。
 *
 * 为什么不用 jsdom：
 *   jsdom 里 `getBoundingClientRect` 是桩、没有真实布局，坐标换算全失真；
 *   而且用 `dispatchEvent` 造的事件 `isTrusted=false`，与真实鼠标行为不一致
 *   （我在这上面绕了很久，最后发现"框选坏了"其实是测试方法的问题）。
 *   这里改用 **CDP 的 Input.dispatchMouseEvent**，发出去的是**真实受信任事件**。
 *
 *   node tools/check-shape-select.mjs
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:/DSH/test01/quill-dsh'
const requireFromWorkapp = createRequire('D:/DSH/test01/workapp/package.json')
const { build } = requireFromWorkapp('esbuild')

const results = []
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d ? ' -- ' + d : ''}`) }

const OUT = join(ROOT, '.tmp', 'select-real')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

/* ---------- 打成页面脚本 ---------- */
await build({
  entryPoints: [join(ROOT, 'tools', 'board-render-entry.tsx')],
  outfile: join(OUT, 'app.js'),
  bundle: true, format: 'iife', globalName: 'BoardApp', platform: 'browser', target: 'chrome120',
  jsx: 'automatic', logLevel: 'silent', absWorkingDir: ROOT,
  nodePaths: ['D:/DSH/test01/workapp/node_modules'],
  define: { 'window.api': 'globalThis.__quillApi' },
  loader: { '.png': 'dataurl' },
  plugins: [{ name: 'a', setup(b) {
    b.onResolve({ filter: /^@shared\// }, (a) => ({ path: join(ROOT, 'shared', a.path.slice(8)) + '.ts' }))
    b.onResolve({ filter: /^(ssh2|pdfjs-dist)/ }, () => ({ path: join(ROOT, 'src-host', 'stubs', 'pdfjs.ts') }))
  } }]
})

const gen = readFileSync(join(ROOT, 'src-client', 'styles.generated.ts'), 'utf8')
const css = JSON.parse(gen.slice(gen.indexOf('"'), gen.lastIndexOf('"') + 1))

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${css}
html,body{margin:0;height:100%;overflow:hidden}
#dsh-quill-root{height:100vh;display:flex;flex-direction:column}
</style></head><body>
<div id="dsh-quill-root"><div id="root" style="flex:1;display:flex;flex-direction:column;min-height:0"></div></div>
<script src="app.js"></script>
<script>
window.__quillApi = new Proxy({}, { get: () => async () => ({ ok: true, value: {} }) });
// 两个图形 + 一张卡片（世界坐标）
const board = BoardApp.makeFixtureBoard();
board.shapes = [
  { id: 'sh1', kind: 'rect',  color: 'blue', x: -260, y: -120, w: 120, h: 80 },
  { id: 'sh2', kind: 'arrow', color: 'pink', points: [{ x: -100, y: 40 }, { x: 40, y: 100 }] }
];
board.nodes = [{ id: 'n1', type: 'text', x: 60, y: -100, w: 180, h: 90, text: '卡片甲', color: 'green' }];
board.edges = [];
BoardApp.mountBoard(document.getElementById('root'), board);

/** 供 CDP 调用：把世界坐标换算成屏幕坐标（用真实布局） */
window.__worldToScreen = (wx, wy) => {
  const inner = document.querySelector('.board-inner');
  const ir = inner.getBoundingClientRect();
  // inner 铺在世界原点处，尺寸 = 世界尺寸；世界 (0,0) 对应 inner 的中心
  const scale = ir.width / 21000;
  return { x: ir.left + (wx + 10500) * scale, y: ir.top + (wy + 7000) * scale };
};
window.__state = () => ({
  cards: [...document.querySelectorAll('.board-node')].map((n) => ({ id: n.dataset.nodeId, selected: n.classList.contains('selected') })),
  shapes: [...document.querySelectorAll('[data-shape-id]')].map((n) => ({
    id: n.dataset.shapeId, kind: n.dataset.shapeKind, selected: n.classList.contains('selected'),
    d: n.querySelector('path')?.getAttribute('d') ?? null,
    box: n.querySelector('rect') ? (r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y') }))(n.querySelector('rect')) : null
  })),
  band: document.querySelector('.board-band')?.getAttribute('style') ?? null
});
window.__clipboardHint = () => document.querySelectorAll('[data-shape-id]').length;
</script>
</body></html>`

writeFileSync(join(OUT, 'index.html'), html, 'utf8')

/* ---------- 启动真浏览器 + CDP ---------- */
const browsers = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
]
const browser = browsers.find((b) => existsSync(b))
if (browser === undefined) { console.log('没找到浏览器'); process.exit(1) }

const PORT = 9333
const proc = spawn(browser, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--window-size=1280,860', '--no-first-run', '--user-data-dir=' + join(OUT, 'profile'),
  'file:///' + join(OUT, 'index.html').replace(/\\/g, '/')
], { stdio: 'ignore' })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等 CDP 就绪并拿到页面 ws 地址 */
async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* 还没起来 */ }
    await wait(250)
  }
  throw new Error('CDP 没就绪')
}

/* ---------- 极简 CDP 客户端 ---------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map() }
  static async connect(url) {
    const { WebSocket } = await import('node:worker_threads').then(() => ({ WebSocket: globalThis.WebSocket }))
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    const c = new CDP(ws)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      const p = c.pending.get(msg.id)
      if (p) { c.pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result) }
    }
    return c
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => this.pending.set(id, { res, rej }))
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''))
    return r.result.value
  }
  /** 真实鼠标事件（isTrusted = true） */
  async mouse(type, x, y, opts = {}) {
    await this.send('Input.dispatchMouseEvent', {
      type, x, y, button: opts.button ?? 'left', buttons: opts.buttons ?? 0,
      clickCount: type === 'mousePressed' ? 1 : 0, modifiers: opts.modifiers ?? 0
    })
  }
  async drag(x0, y0, x1, y1, steps = 6) {
    await this.mouse('mousePressed', x0, y0, { buttons: 1 })
    for (let i = 1; i <= steps; i++) {
      await this.mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, { buttons: 1 })
      await wait(20)
    }
    await this.mouse('mouseReleased', x1, y1, { buttons: 0 })
  }
}

let cdp = null
try {
  const target = await getTarget()
  cdp = await CDP.connect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await wait(900)   // 等 React 挂载完

  const has = await cdp.eval('typeof window.__state === "function"')
  if (has !== true) throw new Error('页面脚本没加载完')

  const W2S = async (wx, wy) => cdp.eval(`JSON.stringify(window.__worldToScreen(${wx}, ${wy}))`).then(JSON.parse)
  const state = () => cdp.eval('JSON.stringify(window.__state())').then(JSON.parse)

  const s0 = await state()
  console.log('=== 起始状态 ===')
  console.log('  卡片：' + s0.cards.map((c) => c.id + (c.selected ? '(选中)' : '')).join(', '))
  console.log('  图形：' + s0.shapes.map((s) => s.id + '/' + s.kind).join(', '))

  /* ===== ① 单击图形 ===== */
  console.log('\n=== ① 单击选中图形 ===')
  {
    const p = await W2S(-200, -80)   // sh1 矩形内部
    await cdp.mouse('mousePressed', p.x, p.y, { buttons: 1 })
    await cdp.mouse('mouseReleased', p.x, p.y, { buttons: 0 })
    await wait(250)
    const s = await state()
    const sh1 = s.shapes.find((x) => x.id === 'sh1')
    check('点图形后它被选中', sh1?.selected === true, JSON.stringify(sh1))
    check('卡片未被选中', s.cards.every((c) => !c.selected))
  }

  /* ===== ② 点空白取消 ===== */
  console.log('\n=== ② 点空白取消选择 ===')
  {
    const p = await W2S(250, 150)
    await cdp.mouse('mousePressed', p.x, p.y, { buttons: 1 })
    await cdp.mouse('mouseReleased', p.x, p.y, { buttons: 0 })
    await wait(250)
    const s = await state()
    check('点空白后取消选中', s.shapes.every((x) => !x.selected) && s.cards.every((c) => !c.selected))
  }

  /* ===== ③ 框选（图形 + 卡片一起） ===== */
  console.log('\n=== ③ 框选（同时框到图形与卡片） ===')
  {
    const a = await W2S(-320, -180)
    const b = await W2S(300, 160)
    await cdp.drag(a.x, a.y, b.x, b.y, 8)
    await wait(300)
    const s = await state()
    check('框选选中了图形 sh1', s.shapes.find((x) => x.id === 'sh1')?.selected === true)
    check('★ 框选同时选中了卡片 n1', s.cards.find((c) => c.id === 'n1')?.selected === true,
      JSON.stringify(s.cards))
  }

  /* ===== ④ 复制粘贴（图形 + 卡片） ===== */
  console.log('\n=== ④ 复制粘贴（图形 + 卡片） ===')
  {
    const before = await state()
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', modifiers: 2, windowsVirtualKeyCode: 67 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', modifiers: 2, windowsVirtualKeyCode: 67 })
    await wait(150)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 })
    await wait(350)
    const after = await state()
    check('粘贴后图形数增加', after.shapes.length > before.shapes.length, `${before.shapes.length} → ${after.shapes.length}`)
    check('粘贴后卡片数增加', after.cards.length > before.cards.length, `${before.cards.length} → ${after.cards.length}`)
  }

  /* ===== ⑤ 只选图形时的复制（原来的 bug） ===== */
  console.log('\n=== ⑤ 只选中图形时的复制（原 bug：copySelection 返回 null） ===')
  {
    // 先点空白清选，再只点一个图形
    const blank = await W2S(300, 200)
    await cdp.mouse('mousePressed', blank.x, blank.y, { buttons: 1 })
    await cdp.mouse('mouseReleased', blank.x, blank.y, { buttons: 0 })
    await wait(200)
    const p = await W2S(-200, -80)
    await cdp.mouse('mousePressed', p.x, p.y, { buttons: 1 })
    await cdp.mouse('mouseReleased', p.x, p.y, { buttons: 0 })
    await wait(250)
    const s1 = await state()
    check('此刻只选中了图形（没有卡片）',
      s1.shapes.some((x) => x.selected) && s1.cards.every((c) => !c.selected),
      `图形选中 ${s1.shapes.filter((x) => x.selected).length} / 卡片选中 ${s1.cards.filter((c) => c.selected).length}`)
    const before = s1.shapes.length
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', modifiers: 2, windowsVirtualKeyCode: 67 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', modifiers: 2, windowsVirtualKeyCode: 67 })
    await wait(150)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 })
    await wait(350)
    const after = await state()
    check('★ 只选图形也能复制粘贴', after.shapes.length > before, `${before} → ${after.shapes.length}`)
  }

  /* ===== ⑥ 拖动图形 ===== */
  console.log('\n=== ⑥ 拖动图形 ===')
  {
    const blank = await W2S(300, 200)
    await cdp.mouse('mousePressed', blank.x, blank.y, { buttons: 1 })
    await cdp.mouse('mouseReleased', blank.x, blank.y, { buttons: 0 })
    await wait(200)
    const before = (await state()).shapes.find((x) => x.id === 'sh1')
    const from = await W2S(-200, -80)
    const to = await W2S(-140, -40)
    await cdp.drag(from.x, from.y, to.x, to.y, 6)
    await wait(300)
    const after = (await state()).shapes.find((x) => x.id === 'sh1')
    check('拖动后矩形位置变了', before?.box !== null && after?.box !== null &&
      (before.box.x !== after.box.x || before.box.y !== after.box.y),
      `${JSON.stringify(before?.box)} → ${JSON.stringify(after?.box)}`)
    check('位移方向正确（右下）', (after?.box?.x ?? 0) > (before?.box?.x ?? 0), `x ${before?.box?.x} → ${after?.box?.x}`)
  }

  /* ===== ⑦ Delete 删除 ===== */
  console.log('\n=== ⑦ Delete 删除选中的图形 ===')
  {
    const before = (await state()).shapes.length
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
    await wait(300)
    const after = (await state()).shapes.length
    check('Delete 删掉了图形', after < before, `${before} → ${after}`)
  }
} catch (err) {
  console.log('\n[异常] ' + err.message)
  check('测试执行完成', false, err.message)
} finally {
  try { proc.kill() } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n阶段 5：${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.n}：${f.d}`)
process.exit(failed.length === 0 ? 0 : 1)
