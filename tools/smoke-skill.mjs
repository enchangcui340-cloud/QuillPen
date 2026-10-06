/**
 * P5 冒烟：「羽毛笔」技能手册（SKILL.md）与它的同步安装。
 *
 * 验四件事：
 *   1. frontmatter 合法（DSH 的 skill 发现要求 name + description；name 无效会被静默丢弃）；
 *   2. 手册真的写全了关键内容（出口契约/白板规范/红线/doc_read/踩过的坑）；
 *   3. 同步安装：写到 <DSH_HOME>/skills/<name>/SKILL.md、内容一致时不再写、
 *      **同名但不是我们的文件绝不覆盖**；
 *   4. 不碰用户的真实 ~/.dsh/skills（快照比对）。
 *
 *   node tools/smoke-skill.mjs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { ROOT, WORKAPP_PKG_JSON, packageDirName } from './paths.mjs'

const requireFromWorkapp = createRequire(WORKAPP_PKG_JSON)
const yaml = requireFromWorkapp('js-yaml')

const PKG_DIR = join(ROOT, 'packages', packageDirName())
const SKILL_SRC = join(PKG_DIR, 'skills', 'notes-assistant-user', 'SKILL.md')
const work = join(join(ROOT, '.tmp', 'smoke-skill'), new Date().toISOString().replace(/[:.]/g, '-'))
const fakeHome = join(work, 'dsh-home')
mkdirSync(fakeHome, { recursive: true })

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`)
}

/* ---------- 真实用户技能根快照（保证测试不碰它） ---------- */
const REAL_SKILLS = join(process.env.USERPROFILE ?? '', '.dsh', 'skills')
function snapshot(root) {
  const map = new Map()
  const walk = (dir, prefix) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const rel = prefix === '' ? e.name : prefix + '/' + e.name
      if (e.isDirectory()) { walk(join(dir, e.name), rel); continue }
      try { const st = statSync(join(dir, e.name)); map.set(rel, `${st.size}:${st.mtimeMs}`) } catch { /* 忽略 */ }
    }
  }
  walk(root, '')
  return map
}
const realBefore = snapshot(REAL_SKILLS)

/* ---------- 1. frontmatter 与内容 ---------- */
console.log('=== 手册本身 ===')
check('SKILL.md 存在', existsSync(SKILL_SRC), SKILL_SRC)
const raw = readFileSync(SKILL_SRC, 'utf8')
const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
check('有 YAML frontmatter', m !== null, m === null ? '没找到 --- 块' : `${m[1].split('\n').length} 行 frontmatter`)
let fm = {}
if (m !== null) {
  try { fm = yaml.load(m[1]); check('frontmatter 可解析', true) } catch (e) { check('frontmatter 可解析', false, e.message.slice(0, 80)) }
}
check('name 合法且与目录名一致（notes-assistant）', fm.name === 'notes-assistant-user', String(fm.name))
check('description 存在且够长（DSH 目录靠它决定是否加载）', typeof fm.description === 'string' && fm.description.length > 60, `${String(fm.description).length} 字`)
check('whenToUse 存在', typeof fm.whenToUse === 'string' && fm.whenToUse.length > 10, String(fm.whenToUse).slice(0, 40))
check('带 owner 标记（同步时用来判断"这是我们的文件"）', String(fm.metadata?.owner ?? '') === 'dsh-quill-user', JSON.stringify(fm.metadata))

const body = m === null ? raw : m[2]
const mustHave = [
  ['出口契约', '出口契约'],
  ['白板绘制规范', '白板绘制规范'],
  ['坐标系说明', 'x 向右、y 向下'],
  ['卡片尺寸表', '210 × 120'],
  ['四色配色', '#fdf3b8'],
  ['连线方位取值', "top` / `right` / `bottom` / `left`"],
  ['文档保真读取', 'doc_read'],
  ['逐页看图要求', 'read_image'],
  ['红线：彻底删除两层确认', 'confirmOrphanCleanup'],
  ['配方 A（文件整理）', '把一批文件整理成笔记'],
  ['库特性：完成不可撤销', '完成不可撤销'],
  ['库特性：优先级必填', '优先级**必填**'],
  ['交付自检', '交付前的自检'],
  ['工具地图', '工具地图']
]
for (const [label, needle] of mustHave) check(`手册包含：${label}`, body.includes(needle), '')

/* ---------- 2. 同步安装行为 ---------- */
console.log('\n=== 同步安装（DSH_HOME 指向临时目录） ===')
process.env.DSH_HOME = fakeHome
const shell = await import('../packages/' + packageDirName() + '/lib/index.js')
const logs = []
const mkCtx = () => ({
  logger: { info: (s) => logs.push('info: ' + s), warn: (s) => logs.push('warn: ' + s) },
  effect: () => undefined,
  webServer: { register: () => undefined },
  connection: { requestRejection: () => undefined }
})
shell.apply(mkCtx(), {})
const installed = join(fakeHome, 'skills', 'notes-assistant-user', 'SKILL.md')
check('激活时把手册装到 <DSH_HOME>/skills/<name>/SKILL.md', existsSync(installed), installed)
check('装进去的内容与包内一致', existsSync(installed) && readFileSync(installed, 'utf8') === raw, `${existsSync(installed) ? readFileSync(installed, 'utf8').length : 0} 字节`)
check('日志说明了这次同步', logs.some((l) => l.includes('已同步')), logs.find((l) => l.includes('已同步')) ?? logs.join(' | ').slice(0, 80))

// 幂等：内容一致时不再写（用 mtime 判断）
const mtime1 = statSync(installed).mtimeMs
await new Promise((r) => setTimeout(r, 60))
const logs2 = []
shell.apply({ ...mkCtx(), logger: { info: (s) => logs2.push(s), warn: (s) => logs2.push(s) } }, {})
check('内容一致时不重复写（mtime 未变）', statSync(installed).mtimeMs === mtime1, `mtime ${mtime1} → ${statSync(installed).mtimeMs}`)

// 用户自己放的同名技能：绝不覆盖
const custom = '---\nname: notes-assistant\ndescription: 用户自己的手册，别动它。\n---\n\n# 我自己的\n'
writeFileSync(installed, custom, 'utf8')
const logs3 = []
shell.apply({ ...mkCtx(), logger: { info: (s) => logs3.push(s), warn: (s) => logs3.push(s) } }, {})
check('同名但不是本插件的文件不会被覆盖', readFileSync(installed, 'utf8') === custom, '')
check('并留下一条 warn 说明为什么不覆盖', logs3.some((l) => l.includes('保持不动')), logs3.find((l) => l.includes('保持不动')) ?? '')

// 我们的旧版本（带 owner 标记）→ 应当更新
writeFileSync(installed, raw.replace('# 羽毛笔 · 操作手册', '# 羽毛笔 · 操作手册（旧版）'), 'utf8')
shell.apply(mkCtx(), {})
check('带 owner 标记的旧版本会被更新成最新', readFileSync(installed, 'utf8') === raw, '')

/* ---------- 3. 手册工具（不依赖 DSH 技能发现的那条路） ---------- */
console.log('\n=== notes_handbook 工具 ===')
{
  const defs = []
  const toolsMod = await import('../packages/' + packageDirName() + '/lib/tools.js')
  toolsMod.apply({ tools: { register: (d) => { defs.push(d); return () => {} } }, logger: { info: () => {}, warn: () => {} } })
  const def = defs.find((d) => d.name === 'notes_handbook')
  check('notes_handbook 已注册', def !== undefined)
  const full = await def.execute({}, {})
  check('返回全文且与包内手册一致（去掉 frontmatter）', full.text === raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''),
    `${full.text.length} 字`)
  check('全文包含关键内容', full.text.includes('出口契约') && full.text.includes('白板绘制规范') && full.text.includes('confirmOrphanCleanup'), '')
  const one = await def.execute({ section: '白板' }, {})
  check('按关键词取单节', one.ok !== false && one.text.includes('白板绘制规范') && one.text.length < full.text.length,
    `${one.text.length} 字（全文 ${full.text.length}）`)
  let bad = false
  try { await def.execute({ section: '不存在的节' }, {}) } catch (e) { bad = String(e.message).includes('可用小节') }
  check('给错节名时列出可用小节', bad, '')
}

/* ---------- 4. 发现规则自检（模拟 dsh-skill-filesystem 的扫描） ---------- */
console.log('\n=== 发现规则（模拟 skill-filesystem） ===')
const skillsRoot = join(fakeHome, 'skills')
const dirs = readdirSync(skillsRoot, { withFileTypes: true }).filter((e) => e.isDirectory())
const bundles = dirs.filter((e) => existsSync(join(skillsRoot, e.name, 'SKILL.md')))
check('技能以顶层目录 bundle 形式存在（不支持嵌套 **/SKILL.md）', bundles.length === 1 && bundles[0].name === 'notes-assistant-user',
  bundles.map((b) => b.name).join(', '))
check('目录名与 frontmatter 的 name 一致', bundles[0]?.name === fm.name, `${bundles[0]?.name} / ${fm.name}`)

/* ---------- 4. 用户真实技能根零改动 ---------- */
{
  const after = snapshot(REAL_SKILLS)
  const diffs = []
  for (const [rel, sig] of after) {
    const old = realBefore.get(rel)
    if (old === undefined) diffs.push('新增 ' + rel)
    else if (old !== sig) diffs.push('改动 ' + rel)
  }
  for (const rel of realBefore.keys()) if (!after.has(rel)) diffs.push('删除 ' + rel)
  check('用户真实 ~/.dsh/skills 零改动', diffs.length === 0, diffs.length === 0 ? `快照一致（${realBefore.size} 个文件）` : diffs.slice(0, 3).join('；'))
}

rmSync(work, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n=== 汇总 ===\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
process.exit(failed.length === 0 ? 0 : 1)
