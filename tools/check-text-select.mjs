/**
 * 真浏览器验证：白板里"拖拽不该选中卡片文字，只有编辑时才能选"。
 *
 *   node tools/check-text-select.mjs
 *
 * 背景：框选卡片、画图形、平移画布时，指针拖过卡片会把卡片里的文字选上。
 * 修法是给世界层加 `user-select: none`，只在编辑态显式恢复 `text`
 *（与文件树的 .tree-node / .tree-rename 同一套做法）。
 *
 * 用真浏览器（CDP 真实鼠标事件）验证：`getSelection()` 是浏览器自己的选区状态，
 * jsdom 里拿不准，必须用真的。
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

const OUT = join(ROOT, '.tmp', 'text-select')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

await build({
  entryPoints: [join(ROOT, 'tools', 'board-render-entry.tsx')],
  outfile: join(OUT, 'app.js'),
  bundle: true, format: 'iife', globalName: 'BoardApp', platform: 'browser', target: 'chrome120',
  jsx: 'automatic', logLevel: 'silent', absWorkingDir: ROOT,
  nodePaths: [requireFromWorkapp('node:module') && join(ROOT, 'node_modules'), 'D:/DSH/test01/workapp/node_modules'],
  define: { 'window.api': 'globalThis.__quillApi' },
  loader: { '.png': 'dataurl' },
  plugins: [{ name: 'a', setup(b) {
    b.onResolve({ filter: /^@shared\// }, (a) => ({ path: join(ROOT, 'shared', a.path.slice(8)) + '.ts' }))
    b.onResolve({ filter: /^(ssh2|pdfjs-dist)/ }, () => ({ path: join(ROOT, 'src-host', 'stubs', 'pdfjs.ts') }))
  } }]
})

const gen = readFileSync(join(ROOT, 'src-client', 'styles.generated.ts'), 'utf8')
const css = JSON.parse(gen.slice(gen.indexOf('"'), gen.lastIndexOf('"') + 1))

const BOARD = `{
  id:'b', type:'whiteboard', version:1, title:'选字验证',
  nodes:[
    {id:'n1',type:'text',x:-400,y:-200,w:260,h:150,text:'这是一张文字卡片，里面的字不应该被拖拽选中。',color:'yellow',fontSize:16},
    {id:'n2',type:'text',x:100,y:-200,w:260,h:150,text:'第二张卡片，同样不该被选中。',color:'blue',fontSize:16}
  ],
  edges:[{id:'e1',from:'n1',to:'n2',label:'连线文字',fromSide:'right',toSide:'left'}],
  shapes:[]
}`

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${css}
html,body{margin:0;height:100%;overflow:hidden}
#dsh-quill-root{height:100vh;display:flex;flex-direction:column}
</style></head><body>
<div id="dsh-quill-root"><div id="root" style="flex:1;display:flex;flex-direction:column;min-height:0"></div></div>
<script src="app.js"></script>
<script>
window.__quillApi = new Proxy({}, { get: () => async () => ({ ok: true, value: {} }) });
BoardApp.mountBoard(document.getElementById('root'), ${BOARD});
window.__sel = () => String(window.getSelection() ?? '').trim();
window.__enterDraw = () => [...document.querySelectorAll('button')].find(x => (x.textContent ?? '').includes('绘制'))?.click();
window.__pick = (i) => document.querySelectorAll('.draw-tool')[i]?.click();
window.__canvasRect = () => (r => ({l:r.left,t:r.top,w:r.width,h:r.height}))(document.querySelector('.board-canvas').getBoundingClientRect());
/** 某张卡片在屏幕上的位置（用于"从卡片上拖过去"） */
window.__nodeRect = (id) => {
  const el = document.querySelector('[data-node-id="' + id + '"]');
  const r = el.getBoundingClientRect();
  return { l: r.left, t: r.top, w: r.width, h: r.height, cx: r.left + r.width/2, cy: r.top + r.height/2 };
};
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

const PORT = 9411
const proc = spawn(browser, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--window-size=1280,800', '--no-first-run', '--user-data-dir=' + join(OUT, 'profile'), '--hide-scrollbars',
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
  async mouse(type, x, y, buttons = 0, clickCount) {
    await this.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons,
      clickCount: clickCount ?? (type === 'mousePressed' ? 1 : 0)
    })
  }
  /** 从 A 拖到 B（用于制造"拖过卡片"的场景） */
  async drag(x0, y0, x1, y1, steps = 8) {
    await this.mouse('mousePressed', x0, y0, 1)
    for (let i = 1; i <= steps; i++) {
      await this.mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, 1)
      await wait(25)
    }
    await this.mouse('mouseReleased', x1, y1, 0)
  }
  async dblclick(x, y) {
    await this.mouse('mousePressed', x, y, 1, 1)
    await this.mouse('mouseReleased', x, y, 0, 1)
    await this.mouse('mousePressed', x, y, 1, 2)
    await this.mouse('mouseReleased', x, y, 0, 2)
  }
}

let cdp = null
try {
  const t = await getTarget()
  cdp = await CDP.connect(t.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  for (let i = 0; i < 25 && (await cdp.eval('window.__ready === true')) !== true; i++) await wait(200)

  const canvas = JSON.parse(await cdp.eval('JSON.stringify(window.__canvasRect())'))
  const n1 = JSON.parse(await cdp.eval('JSON.stringify(window.__nodeRect("n1"))'))
  const n2 = JSON.parse(await cdp.eval('JSON.stringify(window.__nodeRect("n2"))'))
  console.log('  画布 ' + JSON.stringify(canvas))
  console.log('  卡片1 中心 (' + n1.cx.toFixed(0) + ',' + n1.cy.toFixed(0) + ')')

  /* ===== ① 从卡片上拖过去 → 不该选中文字 ===== */
  console.log('\n=== ① 在卡片上拖拽（框选/移动）不该选中文字 ===')
  {
    await cdp.eval('window.getSelection().removeAllRanges()')
    // 从卡片1左边拖到卡片2右边：必然横穿两张卡片的文字
    await cdp.drag(n1.l + 5, n1.cy, n2.l + n2.w - 5, n2.cy, 10)
    await wait(250)
    const sel = await cdp.eval('window.__sel()')
    check('★ 拖过两张文字卡片后，没有选中任何文字', sel === '', `选中了「${sel.slice(0, 40)}」`)
  }

  /* ===== ② 在卡片上按下并挪动（模拟拖动卡片）→ 不该选中 ===== */
  console.log('\n=== ② 拖动卡片本身不该选中文字 ===')
  {
    await cdp.eval('window.getSelection().removeAllRanges()')
    await cdp.drag(n1.cx, n1.cy, n1.cx + 60, n1.cy + 40, 6)
    await wait(250)
    const sel = await cdp.eval('window.__sel()')
    check('★ 拖动卡片后没有选中文字', sel === '', `选中了「${sel.slice(0, 40)}」`)
    // 顺手确认卡片确实被移动了（说明拖动功能没被影响）
    const moved = JSON.parse(await cdp.eval('JSON.stringify(window.__nodeRect("n1"))'))
    check('拖动功能本身正常（卡片位置变了）', Math.abs(moved.l - n1.l) > 20,
      `left ${n1.l.toFixed(0)} → ${moved.l.toFixed(0)}`)
  }

  /* ===== ③ 绘制模式下拖过卡片 → 不该选中文字 ===== */
  console.log('\n=== ③ 绘制图形时拖过卡片不该选中文字 ===')
  {
    await cdp.eval('window.getSelection().removeAllRanges()')
    await cdp.eval('window.__enterDraw()')
    await wait(300)
    await cdp.eval('window.__pick(1)')   // 矩形
    await wait(200)
    const n1b = JSON.parse(await cdp.eval('JSON.stringify(window.__nodeRect("n1"))'))
    const n2b = JSON.parse(await cdp.eval('JSON.stringify(window.__nodeRect("n2"))'))
    await cdp.drag(n1b.l + 10, n1b.t + 10, n2b.l + n2b.w - 10, n2b.t + n2b.h - 10, 10)
    await wait(300)
    const sel = await cdp.eval('window.__sel()')
    check('★ 画矩形时拖过卡片没有选中文字', sel === '', `选中了「${sel.slice(0, 40)}」`)
    // 画布要照常退出绘制模式
    await cdp.eval(`[...document.querySelectorAll('button')].find(x => (x.textContent ?? '').trim() === '完成')?.click()`)
    await wait(250)
  }

  /* ===== ④ 双击进入编辑 → 这时**应该**能选中文字 ===== */
  console.log('\n=== ④ 编辑文字时应该能正常选中（关键：别修过头） ===')
  {
    const n1c = JSON.parse(await cdp.eval('JSON.stringify(window.__nodeRect("n1"))'))
    await cdp.dblclick(n1c.cx, n1c.cy)
    await wait(400)
    const editing = await cdp.eval(`!!document.querySelector('.board-node.editing textarea')`)
    check('双击后进入编辑态（出现 .editing textarea）', editing === true)

    // 诊断：焦点在哪、textarea 的可用样式是什么
    const diag = JSON.parse(await cdp.eval(`JSON.stringify((t => {
      if (!t) return { noTextarea: true };
      const cs = getComputedStyle(t);
      return {
        active: document.activeElement?.tagName + '.' + (document.activeElement?.className ?? ''),
        pointerEvents: cs.pointerEvents,
        userSelect: cs.userSelect,
        webkitUserSelect: cs.webkitUserSelect,
        readOnly: t.readOnly,
        disabled: t.disabled,
        value: t.value.length
      };
    })(document.querySelector('.board-node.editing textarea')))`))
    console.log('    [诊断] ' + JSON.stringify(diag))

    // 先把焦点真正放进 textarea（真实用户双击后光标就在里面）
    await cdp.eval(`(t => { t?.focus(); t?.setSelectionRange(0,0) })(document.querySelector('.board-node.editing textarea'))`)
    await wait(150)

    // 在 textarea 里用键盘全选（Ctrl+A）验证"可选"
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
    await wait(250)
    const taSel = await cdp.eval(`(t => t ? t.value.substring(t.selectionStart, t.selectionEnd) : '')(document.querySelector('.board-node.editing textarea'))`)
    check('★ 编辑态下能选中文字（说明没修过头）', taSel.length > 0, `选中了 ${taSel.length} 个字：${taSel.slice(0, 24)}`)

    // 用鼠标在 textarea 里拖选
    await cdp.eval(`(t => t && t.setSelectionRange(0,0))(document.querySelector('.board-node.editing textarea'))`)
    const ta = JSON.parse(await cdp.eval(`JSON.stringify((t => { const r = t.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height } })(document.querySelector('.board-node.editing textarea')))`))
    await cdp.drag(ta.l + 6, ta.t + ta.h / 2, ta.l + ta.w - 6, ta.t + ta.h / 2, 8)
    await wait(250)
    const taSel2 = await cdp.eval(`(t => t ? t.value.substring(t.selectionStart, t.selectionEnd) : '')(document.querySelector('.board-node.editing textarea'))`)
    check('★ 编辑态下鼠标拖选也能选中', taSel2.length > 0, `选中了 ${taSel2.length} 个字`)
  }

  /* ===== ⑤ 退出编辑后又不该能选 ===== */
  console.log('\n=== ⑤ 退出编辑后恢复"不选字" ===')
  {
    await cdp.eval(`document.querySelector('.board-node.editing textarea')?.blur()`)
    await cdp.eval('window.getSelection().removeAllRanges()')
    await wait(250)
    const n1d = JSON.parse(await cdp.eval('JSON.stringify(window.__nodeRect("n1"))'))
    const n2d = JSON.parse(await cdp.eval('JSON.stringify(window.__nodeRect("n2"))'))
    await cdp.drag(n1d.l + 5, n1d.cy, n2d.l + n2d.w - 5, n2d.cy, 8)
    await wait(250)
    const sel = await cdp.eval('window.__sel()')
    check('★ 退出编辑后拖拽又不会选中文字', sel === '', `选中了「${sel.slice(0, 40)}」`)
  }
} catch (err) {
  check('测试执行完成', false, err.message)
} finally {
  try { proc.kill() } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n白板选字控制：${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.n}：${f.d}`)
process.exit(failed.length === 0 ? 0 : 1)
