/**
 * 组合包补丁校验（装机前必过）。
 *
 * 为什么需要：`cordis.patch.yml` 是**直接改 profile 插件图**的东西，
 * 写坏了会影响整个 DSH（不只是本插件）。这里在安装前做结构校验：
 *   · YAML 能否解析（`!!js` 标签先摘掉，DSH 自己会处理它）
 *   · 顶层是 patch 条目数组；每条 insert 里的行都有 id / name；行 id 不重复
 *   · 「羽毛笔」preset 行：config.id / name / plugins 齐备，且 persona 的常驻规则真的在
 *   · plugins 里的包名与官方 standard preset 对比：**一个不多一个不少**（防笔误）
 *
 *   node tools/check-patch.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { ROOT, WORKAPP_PKG_JSON, packageDirName } from './paths.mjs'
import { join } from 'node:path'

const requireFromWorkapp = createRequire(WORKAPP_PKG_JSON)
const yaml = requireFromWorkapp('js-yaml')

const PATCH = join(ROOT, 'packages/' + packageDirName() + '/cordis.patch.yml')

/**
 * 官方 standard preset 的补丁文件（用来对比"插件清单一个不多一个不少"）。
 *
 * 它在 DSH 安装包里（`@deepseek-ai/dsh-web-app/presets/cordis.patch.yml`），
 * **位置因机器而异**，所以按顺序自动找，**找不到就跳过这条对比**（不算失败）：
 *   1. 环境变量 DSH_STANDARD_PATCH
 *   2. 已解包的 DSH 目录
 *   3. 从 `app.asar` 里读（用 Electron 的 asar 工具，装了才试）
 */
const STANDARD = (() => {
  const direct = [
    process.env.DSH_STANDARD_PATCH,
    join(ROOT, '.tmp', 'wapp-standard.patch.yml'),
    'D:/DeepSeekHarness/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/cordis.patch.yml',
    'D:/DeepSeekHarness/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml'
  ].filter((p) => typeof p === 'string' && p !== '')
  const hit = direct.find((p) => existsSync(p))
  if (hit !== undefined) return hit
  // 退一步：从 app.asar 里直接读
  const ASAR = 'D:/DeepSeekHarness/resources/app.asar'
  const inner = '\\dsh\\node_modules\\@deepseek-ai\\dsh-web-app\\presets\\cordis.patch.yml'
  if (!existsSync(ASAR)) return direct[0]
  try {
    const { createRequire } = require('node:module')
    const req = createRequire(join(ROOT, 'package.json'))
    const asar = req('@electron/asar')
    const text = asar.extractFile(ASAR, inner).toString('utf8')
    const tmp = join(ROOT, '.tmp', 'wapp-standard.patch.yml')
    writeFileSync(tmp, text, 'utf8')
    return tmp
  } catch { return direct[0] }
})()

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`)
}

/** 摘掉 !!js 标签（DSH 的 Loader 自己认它，普通解析器不认） */
function stripJsTags(text) {
  return text.replace(/!!js\s+/g, '')
}

const raw = readFileSync(PATCH, 'utf8')
let doc = null
try {
  doc = yaml.load(stripJsTags(raw))
  check('YAML 可解析', true, `${PATCH.split('/').pop()}（${raw.split('\n').length} 行）`)
} catch (e) {
  check('YAML 可解析', false, String(e.message).slice(0, 200))
  console.log('\n补丁有语法错误，**不要安装**。')
  process.exit(1)
}

check('顶层是 patch 条目数组', Array.isArray(doc), Array.isArray(doc) ? `${doc.length} 条` : typeof doc)
const rows = []
for (const entry of doc ?? []) {
  if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.insert)) {
    check('每个条目都有 insert 数组', false, JSON.stringify(entry).slice(0, 80))
    continue
  }
  rows.push(...entry.insert)
}
check('所有 patch 条目结构正确', rows.length > 0, `共 ${rows.length} 行`)

const badRows = rows.filter((r) => typeof r?.id !== 'string' || typeof r?.name !== 'string' || r.id === '' || r.name === '')
check('每行都有非空 id 与 name', badRows.length === 0, badRows.length === 0 ? rows.map((r) => r.id).join(', ') : JSON.stringify(badRows).slice(0, 160))

const ids = rows.map((r) => r.id)
const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
check('行 id 不重复', dup.length === 0, dup.join(', '))

// ---------- preset 行 ----------
const presetRow = rows.find((r) => r.name === '@deepseek-ai/dsh-agent-preset')
check('存在 preset 行', presetRow !== undefined, presetRow?.id ?? '')
const cfg = presetRow?.config ?? {}
check('preset config.id = notes-assistant-user', cfg.id === 'notes-assistant-user', String(cfg.id))
check('preset 有显示名「羽毛笔」', cfg.name === '羽毛笔', String(cfg.name))
check('preset 有描述', typeof cfg.description === 'string' && cfg.description.length > 10, String(cfg.description).slice(0, 60))

const plugins = Array.isArray(cfg.plugins) ? cfg.plugins : []
check('preset 声明了 plugins 列表', plugins.length > 5, `${plugins.length} 行`)

const persona = plugins.find((p) => p.id === 'persona')
const prefix = persona?.config?.prefix ?? ''
check('persona 常驻规则存在且够长', typeof prefix === 'string' && prefix.length > 200, `${prefix.length} 字`)
for (const key of ['产物只有三种', '出口契约', '白板', '笔记', '待办']) {
  check(`常驻规则包含「${key}」`, prefix.includes(key))
}
check('常驻规则写明"禁止把图片或文档当成品"', prefix.includes('禁止生成图片或文档当成品'))

const toolsRow = plugins.find((p) => p.name === 'dsh-quill-user/tools')
check('挂上了笔记工具层 dsh-quill/tools', toolsRow !== undefined, toolsRow?.id ?? '')

// ---------- 与官方 standard 对比包名 ----------
if (existsSync(STANDARD)) {
  const std = yaml.load(stripJsTags(readFileSync(STANDARD, 'utf8')))
  const stdPlugins = std?.[0]?.insert?.[0]?.config?.plugins ?? []
  const names = (list) => list.map((p) => p.name).filter((n) => n !== 'cordis:group')
  const mine = new Set(names(plugins))
  const theirs = names(stdPlugins)
  const missing = theirs.filter((n) => !mine.has(n) && n !== '@deepseek-ai/dsh-plugin-manager/tools')
  const extra = [...mine].filter((n) => !theirs.includes(n))
  check('标准模式的工具一个不少（除插件管理）', missing.length === 0, missing.length === 0 ? `${theirs.length} 项全覆盖` : '缺：' + missing.join(', '))
  check('多出来的都是我有意加的', extra.length === 0 || (extra.length === 1 && extra[0] === 'dsh-quill-user/tools'), extra.join(', ') || '（无）')
} else {
  // 找不到官方文件就**如实跳过**（辅助对比，不该让整个套件变红）。
  // 想跑这条：设 DSH_STANDARD_PATCH 指向 dsh-web-app 的 presets/cordis.patch.yml。
  console.log('  [SKIP] 与官方 standard 对比 —— 没找到 dsh-web-app 的 presets/cordis.patch.yml')
  console.log('         （可设 DSH_STANDARD_PATCH 指过去再跑这条）')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
console.log(failed.length === 0 ? '\n补丁结构正确，可以安装。' : '\n有问题，先别安装。')
process.exit(failed.length === 0 ? 0 : 1)
