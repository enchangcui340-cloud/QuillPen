/**
 * 用**真浏览器**验证：编辑器的打字光标（caret）在深浅两种主题下都是蓝色。
 *
 * 做法：把真实产物 CSS + 一段模拟的 CodeMirror DOM 放进页面，
 * 让浏览器把 `.cm-cursor` 的 computedStyle 读出来（borderLeftColor / borderLeftWidth），
 * 再用 --dump-dom 取回结果 —— 不靠肉眼、不靠猜。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { ROOT, STYLES_GENERATED, packageName } from './paths.mjs'

const OUT = join(ROOT, '.tmp', 'caret-visual')
mkdirSync(OUT, { recursive: true })

// 本仓库的样式作用域 id（用户版是 #dsh-quill-user-root）
const SELF_ROOT_ID = packageName().endsWith('-user') ? 'dsh-quill-user-root' : 'dsh-quill-root'
const selfCases = [
  { name: 'self-浅色', gen: STYLES_GENERATED, theme: 'light', rootId: SELF_ROOT_ID },
  { name: 'self-深色', gen: STYLES_GENERATED, theme: 'dark', rootId: SELF_ROOT_ID }
]
// dev 版是**另一个仓库**：有就一起验，没有就只验本仓库（开源用户没有 dev 版）
const DEV_GEN = join(ROOT, '..', 'quill-dsh', 'src-client', 'styles.generated.ts')
const cases = existsSync(DEV_GEN)
  ? [
      { name: 'dev-浅色', gen: DEV_GEN, theme: 'light', rootId: 'dsh-quill-root' },
      { name: 'dev-深色', gen: DEV_GEN, theme: 'dark', rootId: 'dsh-quill-root' },
      ...selfCases
    ]
  : selfCases

const browsers = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
]
const browser = browsers.find((b) => existsSync(b))
if (browser === undefined) { console.log('[SKIP] 没找到浏览器（Edge/Chrome）—— 跳过光标渲染验证'); process.exit(0) }

let bad = 0
for (const c of cases) {
  const gen = readFileSync(c.gen, 'utf8')
  const css = JSON.parse(gen.slice(gen.indexOf('"'), gen.lastIndexOf('"') + 1))
  // 作用域 id 由用例显式给出（不要按名字猜 —— 曾被批量改名误改成一个值，导致 dev 那两项永远取不到规则）
  const rootId = c.rootId
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${css}
html,body{margin:0}
</style></head><body>
<div id="${rootId}"${c.theme === 'dark' ? " data-theme='dark'" : ''}>
  <div class="cm-host">
    <div class="cm-editor cm-focused">
      <div class="cm-scroller">
        <div class="cm-cursorLayer"><div class="cm-cursor" id="caret"></div></div>
        <div class="cm-content">正文示例 abc</div>
      </div>
    </div>
    <textarea id="ta"></textarea>
  </div>
</div>
<pre id="probe"></pre>
<script>
  const el = document.getElementById('caret');
  const ta = document.getElementById('ta');
  const cs = getComputedStyle(el);
  const root = getComputedStyle(document.getElementById('${rootId}'));
  document.getElementById('probe').textContent = JSON.stringify({
    theme: ${JSON.stringify(c.theme)},
    caretVar: root.getPropertyValue('--caret').trim(),
    caretBorderColor: cs.borderLeftColor,
    caretBorderWidth: cs.borderLeftWidth,
    textareaCaretColor: getComputedStyle(ta).caretColor
  });
</script>
</body></html>`
  const f = join(OUT, c.name + '.html')
  writeFileSync(f, html, 'utf8')
  const out = execFileSync(browser, ['--headless', '--disable-gpu', '--dump-dom', 'file:///' + f.replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 })
  const m = /<pre id="probe">([\s\S]*?)<\/pre>/.exec(out)
  const info = m === null ? null : JSON.parse(m[1])
  // 判定：蓝色 = 蓝通道明显大于红通道；且宽度 ≥2px
  const rgb = info === null ? null : /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(info.caretBorderColor)
  const isBlue = rgb !== null && Number(rgb[3]) > Number(rgb[1]) + 40 && Number(rgb[3]) > 120
  const thick = info !== null && parseFloat(info.caretBorderWidth) >= 2
  const ok = isBlue && thick
  if (!ok) bad++
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${c.name}：--caret=${info?.caretVar} 光标色=${info?.caretBorderColor} 粗细=${info?.caretBorderWidth} textarea=${info?.textareaCaretColor}`)
}
console.log(bad === 0 ? '\n两种主题、两个版本的光标都是蓝色且 >=2px ✓' : `\n${bad} 项不合格 ✗`)
process.exit(bad === 0 ? 0 : 1)
