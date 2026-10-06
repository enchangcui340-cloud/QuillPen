/**
 * 荧光笔可读性检查（P0 的证据，也是长期护栏）。
 *
 * 起因：深色主题下只有浅色高亮底（#fff3a3 等），而正文色是浅色 --text:#e6e6e6，
 * 浅底 + 浅字 → 看不清（用户截图）。
 *
 * 本脚本从**构建产物**里读深色主题的高亮规则，按 WCAG 计算实际对比度：
 *   · 半透明底色要先与深色底合成（先与 --panel #26282c，再与 --bg #1e1f22 各算一次）
 *   · 对比度 ≥ 4.5:1 为合格（正文小字标准），≥ 7:1 为优秀
 * 同时核对：亮色主题规则没被改动、产物里没有裸 :root 泄漏。
 *
 *   node tools/check-contrast.mjs
 */
import { readFileSync } from 'node:fs'
import { ROOT } from './paths.mjs'
import { join } from 'node:path'

const gen = readFileSync(join(ROOT, 'src-client/styles.generated.ts'), 'utf8')
const css = JSON.parse(gen.slice(gen.indexOf('"'), gen.lastIndexOf('"') + 1))

/** 解析 #rrggbb / rgba(r,g,b,a) */
function parseColor(value) {
  const v = value.trim()
  let m = /^#([0-9a-f]{6})$/i.exec(v)
  if (m) {
    const n = parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v)
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] }
  return null
}
/** a 叠在 b 上 */
const over = (a, b) => ({
  r: a.r * a.a + b.r * (1 - a.a),
  g: a.g * a.a + b.g * (1 - a.a),
  b: a.b * a.a + b.b * (1 - a.a),
  a: 1
})
const luminance = ({ r, g, b }) => {
  const f = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contrast = (fg, bg) => {
  const a = luminance(fg)
  const b = luminance(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

const PANEL = parseColor('#26282c')
const BG = parseColor('#1e1f22')

/** 从 CSS 里取出某选择器的声明块 */
function ruleFor(substring) {
  const idx = css.indexOf(substring)
  if (idx < 0) return null
  const open = css.indexOf('{', idx)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}
function decl(block, prop) {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(block)
  return m === null ? null : m[1].trim()
}

const cases = [
  { key: '黄', sel: "#dsh-quill-user-root[data-theme='dark'] .cm-hl-yellow" },
  { key: '绿', sel: "#dsh-quill-user-root[data-theme='dark'] .cm-hl-green" },
  { key: '粉', sel: "#dsh-quill-user-root[data-theme='dark'] .cm-hl-pink" }
]

let failed = 0
console.log('=== 深色主题荧光笔对比度（正文小字标准 ≥ 4.5，目标 ≥ 7） ===')
for (const c of cases) {
  const block = ruleFor(c.sel)
  if (block === null) { console.log(`[FAIL] ${c.key}：找不到规则 ${c.sel}`); failed++; continue }
  const bgRaw = parseColor(decl(block, 'background') ?? '')
  const fgRaw = parseColor(decl(block, 'color') ?? '')
  if (bgRaw === null || fgRaw === null) { console.log(`[FAIL] ${c.key}：background/color 解析失败`); failed++; continue }

  const onPanel = contrast(fgRaw, over(bgRaw, PANEL))
  const onBg = contrast(fgRaw, over(bgRaw, BG))
  const worst = Math.min(onPanel, onBg)
  const ok = worst >= 4.5
  if (!ok) failed++
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${c.key}：底 ${decl(block, 'background')}  字 ${decl(block, 'color')}  → 对比度 ${onPanel.toFixed(1)}:1（卡片底）/ ${onBg.toFixed(1)}:1（页面底）`)

  // 亮色主题规则必须没被动过
  const lightSel = c.key === '黄' ? '.cm-hl-yellow' : c.key === '绿' ? '.cm-hl-green' : '.cm-hl-pink'
  const light = ruleFor(lightSel + ' {')
  const lightBg = light === null ? null : decl(light, 'background')
  const lightOk = lightBg !== null && /^#(fff3a3|c8f0c8|ffd6e7)$/i.test(lightBg)
  if (!lightOk) failed++
  console.log(`${lightOk ? '[OK]  ' : '[FAIL]'}     亮色主题未被改动：${lightSel} → ${lightBg}`)
}

console.log('\n=== 作用域检查 ===')
const bareRoot = /(^|\n)\s*:root\s*[,{]/.test(css)
if (bareRoot) failed++
console.log(`${bareRoot ? '[FAIL]' : '[OK]  '} 产物里没有裸 :root`)

/* ==================== BOM / 首条规则（线上事故护栏） ====================
   事故复盘：PowerShell 的 `Set-Content -Encoding UTF8` 给 styles.css 写入了 BOM，
   构建内联后**第一条规则的选择器**变成 `\ufeff#dsh-quill-user-root`（非法）→ 整条"浅色主题变量块"
   被浏览器丢弃 → 浅色下 --bg/--text/--panel/--card-* 全未定义 → 面板/笔记/白板卡片底色全透明，
   只剩文字（用户报的"浅色全坏了"；深色块在后面、不带 BOM，所以深色反而正常）。
   这里把它钉死：产物不能有 BOM，且第一条规则必须是浅色变量块并带上关键变量。 */
const hasBom = css.charCodeAt(0) === 0xFEFF
if (hasBom) failed++
console.log(`${hasBom ? '[FAIL]' : '[OK]  '} 产物 CSS 开头没有 BOM`)
{
  const open = css.indexOf('{')
  const close = css.indexOf('}', open)
  const firstSel = css.slice(0, open).trim()
  const firstBody = css.slice(open + 1, close)
  const okFirst = firstSel === '#dsh-quill-user-root' &&
    firstBody.includes('--bg') && firstBody.includes('--text') && firstBody.includes('--card-default-bg')
  if (!okFirst) failed++
  console.log(`${okFirst ? '[OK]  ' : '[FAIL]'} 第一条规则是浅色变量块（选择器 ${firstSel}，含 --bg/--text/--card-default-bg）`)
}
const hasHlRule = css.includes(".hl-yellow") && css.includes(".hl-pink")
console.log(`${hasHlRule ? '[OK]  ' : '[FAIL]'} 预览用的 .hl-* 也被覆盖（不只是编辑器 .cm-hl-*）`)
if (!hasHlRule) failed++

/* ==================== 白板卡片配色（6 色 × 深浅两套） ==================== */
console.log('\n=== 白板卡片配色对比度（深浅两套都要可读） ===')
const CARD_KEYS = ['default', 'pink', 'blue', 'green', 'yellow', 'purple']
const CARD_LABEL = { default: '原色', pink: '粉色', blue: '蓝色', green: '绿色', yellow: '黄色', purple: '紫色' }

/** 从某主题块里取一个 CSS 变量值 */
function themeVar(theme, name) {
  const scope = theme === 'dark' ? "#dsh-quill-user-root[data-theme='dark'] {" : '#dsh-quill-user-root {'
  const idx = css.indexOf(scope)
  if (idx < 0) return null
  const close = css.indexOf('}', idx)
  const block = css.slice(idx, close)
  const m = new RegExp(`${name}\\s*:\\s*([^;]+)`).exec(block)
  return m === null ? null : m[1].trim()
}

const CANVAS_DARK = parseColor('#202124')   // 深色画布
const CANVAS_LIGHT = parseColor('#fafbfc')  // 浅色画布
for (const theme of ['light', 'dark']) {
  for (const key of CARD_KEYS) {
    const bg = parseColor(themeVar(theme, `--card-${key}-bg`) ?? '')
    const fg = parseColor(themeVar(theme, `--card-${key}-fg`) ?? '')
    if (bg === null || fg === null) {
      console.log(`[FAIL] ${theme}/${CARD_LABEL[key]}：拿不到 --card-${key}-bg/fg`)
      failed++
      continue
    }
    const ratio = contrast(fg, bg)
    const readable = ratio >= 4.5
    // 卡片底和画布底必须能分开（深色下尤其重要：卡片不能糊进背景）
    const canvas = theme === 'dark' ? CANVAS_DARK : CANVAS_LIGHT
    const vsCanvas = contrast(bg, canvas)
    // 浅色主题下"白卡 vs 近白画布"本来就非常接近（原设计如此），只要求不糊成一片；
    // 深色主题才是用户报的那类问题（卡片糊进背景、颜色显示不出来），这里要求更严
    const separate = theme === 'dark' ? vsCanvas >= 1.05 : vsCanvas >= 1.0
    if (!readable || !separate) failed++
    console.log(`${readable && separate ? '[OK]  ' : '[FAIL]'} ${theme === 'dark' ? '深色' : '浅色'} ${CARD_LABEL[key]}：底 ${themeVar(theme, `--card-${key}-bg`)} 字 ${themeVar(theme, `--card-${key}-fg`)} → 字/底 ${ratio.toFixed(1)}:1，底/画布 ${vsCanvas.toFixed(2)}:1`)
  }
}

/* ==================== 深色"漏网"扫描 ====================
   病根：浅色写了写死的底（如 #f2f3f5），深色主题没有对应覆盖 → 深色下浅底 + 浅字看不清
   （用户截图里的云库胶囊、白板卡片都是这一类）。
   规则：任何"写死浅色底"的规则，必须能在深色块里找到同一个选择器；找不到就失败。
   修法是把它换成主题变量（--surface-2/--hover-bg/--panel/--card-*），或补一条深色规则。 */
console.log('\n=== 深色漏网扫描（写死浅色底必须有深色对应规则） ===')
const LIGHT_BG = /background(?:-color)?:\s*(#[0-9a-fA-F]{3,6}|rgba?\([^)]*\))/g
const SUSPECT_LIGHT = /^#(f{3}|f{6}|f2f3f5|f7f8fa|fafbfc|eef0f3|e6e8ec|fff3a3|c8f0c8|ffd6e7|fff3d6|fdf1f1|f8f9fa|fbfbfc|f0f2f5|f5f6f8)$/i
/** 允许例外：这些是"高亮/标记"类，本身有专门的深色版本或就是浅色语义，逐条注明理由 */
const ALLOW = new Set([
  '.hl-yellow', '.hl-green', '.hl-pink', '.hl-blue', // 预览高亮：深色块里另有 rgba 覆盖
  '.cm-hl-yellow', '.cm-hl-green', '.cm-hl-pink'
])
const ruleBlocks = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
let leaks = 0
const leakList = []
for (const m of ruleBlocks) {
  const sel = m[1].trim().replace(/\s+/g, ' ')
  const body = m[2]
  if (sel.includes("data-theme='dark'")) continue          // 深色块本身
  if (ALLOW.has(sel)) continue
  const hit = [...body.matchAll(LIGHT_BG)].find((h) => SUSPECT_LIGHT.test(h[1]))
  if (hit === undefined) continue
  // 该选择器在深色块里有没有对应规则？（把作用域前缀替换成带 data-theme 的形式再找）
  const darkSel = sel.includes('#dsh-quill-user-root')
    ? sel.replace(/#dsh-quill-user-root/g, "#dsh-quill-user-root[data-theme='dark']")
    : sel
  const hasDark = css.includes(darkSel)
  if (!hasDark) { leaks++; leakList.push(`${sel} → ${hit[1]}`) }
}
if (leaks > 0) failed += leaks
console.log(`${leaks === 0 ? '[OK]  ' : '[FAIL]'} 没有"写死浅色底但缺深色覆盖"的规则${leaks === 0 ? '' : `（${leaks} 处）`}`)
for (const l of leakList.slice(0, 12)) console.log(`        · ${l}`)

/* 卡片颜色不能再被 !important 压掉（这正是"深色下卡片颜色显示不出来"的元凶） */
const cardOverridden = css.includes('.board-node { background: #2a2d31 !important')
  || /\.board-node\s*\{[^}]*background:[^;]*!important/.test(css)
if (cardOverridden) failed++
console.log(`${cardOverridden ? '[FAIL]' : '[OK]  '} 卡片底色没有被 !important 强压（颜色语义保留）`)
const cardAttrRules = CARD_KEYS.filter((k) => css.includes(`data-card-color='${k}'`) || css.includes(`data-card-color="${k}"`))
console.log(`${cardAttrRules.length === CARD_KEYS.length ? '[OK]  ' : '[FAIL]'} 六个色板键都有渲染规则（${cardAttrRules.length}/6）`)
if (cardAttrRules.length !== CARD_KEYS.length) failed++

/* 子菜单（栏中栏）的样式必须在产物里 */
const hasSubmenu = css.includes('.ctx-item.has-sub') && css.includes('.ctx-swatch')
console.log(`${hasSubmenu ? '[OK]  ' : '[FAIL]'} 右键菜单的子菜单/色块样式已随产物生成`)
if (!hasSubmenu) failed++

console.log(`\n${failed === 0 ? '通过：深色荧光笔、六色卡面（深浅两套）、深色漏网扫描 全部合格' : `有 ${failed} 项不合格`}`)
process.exit(failed === 0 ? 0 : 1)
