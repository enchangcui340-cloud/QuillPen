/**
 * 模块 id 隔离校验（新增护栏）。
 *
 * 事故复盘：两份插件的 client.js 都写着 `window.__ModuleLoader__.load({ id: 'dsh-quill' })`
 * —— DSH 用这个 id 做模块键，后注册的同名模块会被忽略/覆盖，
 * 症状是**新插件的面板根本不出现**（而且因为 dev 版还在，你会以为"只是没看到"）。
 * 这里把它钉死：产物里的 id 必须等于 package.json 的 name。
 *
 *   node tools/check-bundle-id.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PKG, packageName } from './paths.mjs'

const results = []
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d ? ' -- ' + d : ''}`) }

const name = packageName()
const client = readFileSync(join(PKG, 'lib', 'client.js'), 'utf8')
const m = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(client)
check('client.js 里有模块 id', m !== null, m === null ? '没找到 load({ id })' : m[1])
check('模块 id 等于包名（避免两个插件撞 id）', m?.[1] === name, `id=${m?.[1]} / name=${name}`)

// 若是用户版，还要求 id 与 dev 版不同（同机共存的前提）
if (name.endsWith('-user')) {
  check('模块 id 与 dev 版不同（dsh-quill ≠ dsh-quill-user）', m?.[1] !== 'dsh-quill', String(m?.[1]))
}

// 顺带把"客户端注册的面板 id"与"host 侧路由"也核一遍，防止只改一半
const entry = readFileSync(join(PKG, '..', '..', 'src-client', 'dsh-entry.tsx'), 'utf8')
const panelId = /const PANEL_ID = '([^']+)'/.exec(entry)?.[1] ?? ''
check('面板 id 已按版本区分', panelId !== '', `PANEL_ID=${panelId}`)
check('main 与 sidebar 用的是同一个 PANEL_ID（否则入口出不来）',
  /slots\.register\(\{ name: 'main', key: PANEL_ID \}/.test(entry) &&
  /slots\.register\(\{ name: 'sidebar\.panellist', id: PANEL_ID/.test(entry), '')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.n}：${f.d}`)
process.exit(failed.length === 0 ? 0 : 1)
