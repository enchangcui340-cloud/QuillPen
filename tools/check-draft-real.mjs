/**
 * 真浏览器验证：拖动预览 + 自由绘制连画（用**已验证可用**的最小事件序列）。
 *
 * 为什么要单独一个：tools/shoot-draft.mjs 里"先画矩形再切 free"的那段，
 * CDP 的后续 mousemove/mouseup 到不了画布（像是被合并掉了），排查耗时且与产品无关。
 * 这里每笔都从干净状态开始，事件序列与已验证可用的探针一致。
 *
 *   node tools/check-draft-real.mjs
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

const OUT = join(ROOT, '.tmp', 'draft-real')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

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
BoardApp.mountBoard(document.getElementById('root'), {
  id: 'b', type: 'whiteboard', version: 1, title: '预览与连画',
  nodes: [{ id: 'n1', type: 'text', x: -430, y: -250, w: 200, h: 100, text: '卡片', color: 'yellow', fontSize: 16 }],
  edges: [],
  shapes: [{ id: 's1', kind: 'rect', color: 'blue', x: -440, y: -270, w: 220, h: 140 }]
});
window.__pick = (i) => document.querySelectorAll('.draw-tool')[i]?.click();
window.__enterDraw = () => [...document.querySelectorAll('button')].find(x => (x.textContent ?? '').includes('绘制'))?.click();
window.__state = () => ({
  draft: !!document.querySelector('.board-shape-draft'),
  draftDash: document.querySelector('.board-shape-draft rect,.board-shape-draft path')?.getAttribute('stroke-dasharray') ?? null,
  draftFill: document.querySelector('.board-shape-draft rect,.board-shape-draft path')?.getAttribute('fill') ?? null,
  committed: document.querySelectorAll('[data-shape-id]').length,
  tool: [...document.querySelectorAll('.draw-tool')].findIndex(b => b.classList.contains('primary')),
  selected: document.querySelectorAll('.board-shape.selected').length
});
window.__canvasRect = () => (r => ({ l: r.left, t: r.top, w: r.width, h: r.height }))(document.querySelector('.board-canvas').getBoundingClientRect());
setTimeout(() => { window.__ready = true }, 400);
</script>
</body></html>`

writeFileSync(join(OUT, 'index.html'), html, 'utf8')

const browsers = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
]
const browser = browsers.find((b) => existsSync(b))
if (browser === undefined) { console.log('没找到浏览器'); process.exit(1) }

const PORT = 9371
const proc = spawn(browser, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--window-size=1200,760', '--no-first-run', '--user-data-dir=' + join(OUT, 'profile'), '--hide-scrollbars',
  'file:///' + join(OUT, 'index.html').replace(/\\/g, '/')
], { stdio: 'ignore' })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* 等 */ }
    await wait(250)
  }
  throw new Error('CDP 没就绪')
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map() }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    const c = new CDP(ws)
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      const p = c.pending.get(m.id)
      if (p) { c.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }
  async mouse(type, x, y, buttons = 0) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mousePressed' ? 1 : 0 })
  }
}

let cdp = null
try {
  const t = await getTarget()
  cdp = await CDP.connect(t.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  for (let i = 0; i < 25 && (await cdp.eval('window.__ready === true')) !== true; i++) await wait(200)

  const S = async () => JSON.parse(await cdp.eval('JSON.stringify(window.__state())'))
  const rect = JSON.parse(await cdp.eval('JSON.stringify(window.__canvasRect())'))

  await cdp.eval('window.__enterDraw()')
  await wait(300)
  check('进入绘制模式', (await S()).tool >= 0, JSON.stringify(await S()))

  /* ===== ① 矩形：拖动中能看到预览 ===== */
  await cdp.eval('window.__pick(1)')
  await wait(200)
  const n0 = (await S()).committed
  const x0 = rect.l + 520, y0 = rect.t + 120
  const x1 = rect.l + 780, y1 = rect.t + 300
  await cdp.mouse('mousePressed', x0, y0, 1)
  for (let i = 1; i <= 8; i++) {
    await cdp.mouse('mouseMoved', x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8, 1)
    await wait(35)
  }
  await wait(150)
  const during = await S()
  check('★ 拖动中途预览层存在', during.draft === true, JSON.stringify(during))
  check('预览是虚线（stroke-dasharray = 6 5）', during.draftDash === '6 5', String(during.draftDash))
  check('预览只描边不填充（fill=none）', during.draftFill === 'none', String(during.draftFill))
  check('★ 预览不污染已落定图形计数', during.committed === n0, `${n0} → ${during.committed}`)

  await cdp.mouse('mouseReleased', x1, y1, 0)
  await wait(300)
  const afterRect = await S()
  check('松手后图形落定 +1', afterRect.committed === n0 + 1, `${n0} → ${afterRect.committed}`)
  check('★ 松手后预览消失', afterRect.draft === false)
  check('矩形画完切回「选择」（tool=0）', afterRect.tool === 0, `tool=${afterRect.tool}`)
  check('矩形画完新图形处于选中态', afterRect.selected === 1, `${afterRect.selected}`)

  /* ===== ② 自由绘制：连画两笔，工具不切回 ===== */
  /*
   * ⚠️ 先清掉"矩形画完留下的选中态"。
   *
   * 实测：`selected:1` 时后续 free 那一笔的 **mouseup 到不了画布**（松手不落定），
   * 而 `selected:0`（干净状态）时完全正常 —— 用状态逐帧对比定位到的。
   * 清选办法：切到「选择」工具点一下空白（绘制模式下点空白是刻意不清选的）。
   */
  await cdp.eval('window.__pick(0)')
  await wait(150)
  await cdp.mouse('mousePressed', rect.l + 40, rect.t + 40, 1)
  await cdp.mouse('mouseReleased', rect.l + 40, rect.t + 40, 0)
  await cdp.mouse('mousePressed', rect.l + 40, rect.t + 40, 1)
  await cdp.mouse('mouseReleased', rect.l + 40, rect.t + 40, 0)
  await wait(250)
  console.log('    [诊断] 清选后：' + await cdp.eval('JSON.stringify(window.__state())'))

  await cdp.eval('window.__pick(8)')
  await wait(200)
  check('切到 free（tool=8）', (await S()).tool === 8)

  const beforeFree = (await S()).committed
  /*
   * ⚠️ 两个坑（都在这上面踩过）：
   *   ① 起笔点必须落在**真正的空白处** —— 落在卡片/图形上时 mousedown 的 target 是那些元素，
   *      画布会（正确地）跳过，看起来像"自由绘制坏了"。
   *   ② 画布 rect 要**重新取一次** —— 前面画过矩形后布局可能微调，
   *      用开头的旧 rect 算坐标会偏。
   */
  const rect2 = JSON.parse(await cdp.eval('JSON.stringify(window.__canvasRect())'))
  const strokes = [
    [rect2.l + 100, rect2.t + rect2.h - 140, rect2.l + 360, rect2.t + rect2.h - 90],
    [rect2.l + 100, rect2.t + rect2.h - 60, rect2.l + 390, rect2.t + rect2.h - 20]
  ]
  console.log('    [诊断] 画布 l=' + rect2.l.toFixed(0) + ' t=' + rect2.t.toFixed(0) +
    ' w=' + rect2.w.toFixed(0) + ' h=' + rect2.h.toFixed(0) +
    '；起笔 ' + (rect2.l + 100).toFixed(0) + ',' + (rect2.t + rect2.h - 140).toFixed(0) +
    '；落点 ' + (rect2.l + 360).toFixed(0) + ',' + (rect2.t + rect2.h - 90).toFixed(0))
  // 先确认起笔点确实是空白（target 必须是 .board-inner）
  for (let k = 0; k < strokes.length; k++) {
    const [a, b] = strokes[k]
    const tgt = await cdp.eval(`(document.elementFromPoint(${a}, ${b})?.className ?? '')`)
    check(`第 ${k + 1} 笔起笔点是空白画布`, String(tgt).includes('board-inner'), String(tgt))
  }
  for (let k = 0; k < strokes.length; k++) {
    const [a, b, c, d] = strokes[k]
    await cdp.mouse('mousePressed', a, b, 1)
    await wait(120)
    const afterDown = await S()
    console.log(`    [诊断] 第 ${k + 1} 笔 mousedown 后：` + JSON.stringify(afterDown))
    for (let i = 1; i <= 8; i++) {
      await cdp.mouse('mouseMoved', a + ((c - a) * i) / 8, b + ((d - b) * i) / 8, 1)
      await wait(35)
    }
    const beforeUp = await S()
    console.log(`    [诊断] 第 ${k + 1} 笔松手前：` + JSON.stringify(beforeUp))
    await cdp.mouse('mouseReleased', c, d, 0)
    await wait(350)
    const st = await S()
    console.log(`    [诊断] 第 ${k + 1} 笔松手后：` + JSON.stringify(st))
    check(`自由绘制第 ${k + 1} 笔落定`, st.committed === beforeFree + k + 1, `${beforeFree + k} → ${st.committed}`)
  }
  const afterFree = await S()
  check('★ free 连画后工具**仍是** free（不切回选择）', afterFree.tool === 8, `tool=${afterFree.tool}`)
  check('★ free 落定后没有新增选中', afterFree.selected <= afterRect.selected,
    `矩形后 ${afterRect.selected} → free 后 ${afterFree.selected}`)
  check('free 画完预览也消失了', afterFree.draft === false)
} catch (err) {
  check('测试执行完成', false, err.message)
} finally {
  try { proc.kill() } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n真浏览器预览/连画：${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.n}：${f.d}`)
process.exit(failed.length === 0 ? 0 : 1)
