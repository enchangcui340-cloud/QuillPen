/**
 * 卡片配色"两边一致"校验。
 *
 * 为什么需要：色板同时在两处定义 ——
 *   · 客户端渲染与菜单：`src-client/lib/card-colors.ts`
 *   · AI 工具层（board_edit 写色）：`packages/' + packageDirName() + '/lib/tool-kit.js`
 * 改一处忘另一处，就会出现"AI 写进去的颜色界面认不出来"这种诡异 bug。
 * 这里把两边解析出来逐项比对（键、浅色值、深色值、中文名）。
 *
 *   node tools/check-card-color-parity.mjs
 */
import { readFileSync } from 'node:fs'
import { ROOT, packageDirName } from './paths.mjs'
import { join } from 'node:path'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`)
}

/* ---------- 客户端色板 ---------- */
const TS = readFileSync(join(ROOT, 'src-client/lib/card-colors.ts'), 'utf8')
const clientEntries = []
for (const m of TS.matchAll(/key:\s*'([a-z]+)',\s*label:\s*'([^']+)',\s*light:\s*'(#[0-9a-fA-F]{6})',\s*dark:\s*'(#[0-9a-fA-F]{6})'/g)) {
  clientEntries.push({ key: m[1], label: m[2], light: m[3].toLowerCase(), dark: m[4].toLowerCase() })
}
check('客户端色板解析出 6 个颜色', clientEntries.length === 6, clientEntries.map((e) => e.key).join(', '))

/* ---------- 主题变量（浅/深两套） ---------- */
const CSS = readFileSync(join(ROOT, 'src-client/styles.css'), 'utf8')
const readVars = (blockStart) => {
  const from = CSS.indexOf(blockStart)
  if (from < 0) return {}
  const end = CSS.indexOf('}', from)
  const block = CSS.slice(from, end)
  const vars = {}
  for (const m of block.matchAll(/--card-([a-z]+)-(bg|fg):\s*(#[0-9a-fA-F]{6})/g)) vars[`${m[1]}-${m[2]}`] = m[3].toLowerCase()
  return vars
}
const lightVars = readVars(':root {')
const darkVars = readVars(":root[data-theme='dark'] {")

for (const entry of clientEntries) {
  check(`浅色变量 --card-${entry.key}-bg 与色板一致`, lightVars[`${entry.key}-bg`] === entry.light,
    `CSS=${lightVars[`${entry.key}-bg`]} / TS=${entry.light}`)
  check(`深色变量 --card-${entry.key}-bg 与色板一致`, darkVars[`${entry.key}-bg`] === entry.dark,
    `CSS=${darkVars[`${entry.key}-bg`]} / TS=${entry.dark}`)
  check(`--card-${entry.key}-fg 浅/深两套都定义了`, lightVars[`${entry.key}-fg`] !== undefined && darkVars[`${entry.key}-fg`] !== undefined, '')
}

/* ---------- 工具层（AI 侧） ---------- */
const KIT = readFileSync(join(ROOT, 'packages/' + packageDirName() + '/lib/tool-kit.js'), 'utf8')
const { CARD_COLOR_NAMES } = await import('../packages/' + packageDirName() + '/lib/tool-kit.js')
const kitHexes = new Set(Object.values(CARD_COLOR_NAMES).map((v) => String(v).toLowerCase()))
for (const entry of clientEntries) {
  check(`工具层认得色板值 ${entry.light}`, kitHexes.has(entry.light), '')
  check(`工具层认得中文色名「${entry.label}」`, String(CARD_COLOR_NAMES[entry.label] ?? '').toLowerCase() === entry.light,
    `工具层=${CARD_COLOR_NAMES[entry.label]}`)
}
// 中文色名必须齐全（AI 手册里承诺了这六个）
for (const name of ['原色', '粉色', '蓝色', '绿色', '黄色', '紫色']) {
  check(`中文色名「${name}」在工具层可用`, CARD_COLOR_NAMES[name] !== undefined, String(CARD_COLOR_NAMES[name] ?? '缺失'))
}

/* ---------- 手册里承诺的六个色值必须真实存在 ---------- */
const SKILL = readFileSync(join(ROOT, 'packages/' + packageDirName() + '/skills/notes-assistant-user/SKILL.md'), 'utf8')
for (const entry of clientEntries) {
  check(`手册里写了「${entry.label}」且色值正确`, SKILL.includes(entry.label) && SKILL.includes(entry.light),
    entry.light)
}
check('手册不再宣传老的四色表述', !SKILL.includes('只用这四个'), '')

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 汇总 ===\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
process.exit(failed.length === 0 ? 0 : 1)
