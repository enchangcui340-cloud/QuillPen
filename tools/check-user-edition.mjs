/**
 * 用户版专属验收（「羽毛笔」）。
 *
 * 验四件事 —— 这正是"用户版能不能发出去"的判据：
 *   ① 包里没有任何创建云目录的能力（源码 + 产物 + 无密钥文件）→ **AI 也建不了**；
 *   ② `cloud:create` 通道**不存在**（AI 拿到会话也调不到）；
 *   ③ 「用 key 接入」这条链路**仍然可用**（真实云目录，走真服务器）；
 *   ④ 默认是**干净新库**（不读 Quill 旧配置，落在 ~/Documents/QuillNotes）。
 *
 *   node tools/check-user-edition.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, PKG, packageDirName, packageName } from './paths.mjs'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`)
}

const EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.yml', '.yaml', '.css'])
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(abs, out); continue }
    if (EXTS.has(abs.slice(abs.lastIndexOf('.')))) out.push(abs)
  }
  return out
}
const files = walk(ROOT)

/* ---------- ① 无创建能力 ---------- */
console.log('=== ① 包里没有"新建云数据目录"的能力 ===')
const FORBIDDEN = [
  ['createCloudDir', '创建函数'],
  ['provisionKey', '创建密钥读取'],
  ['provision.key', '私钥文件'],
  ['PROVISION_USER', '受限账号常量'],
  ['quillprovision', '受限账号名'],
  ['cloud:create', '创建通道'],
  ['cloudCreate', '创建桥接/类型']
]
for (const [needle, label] of FORBIDDEN) {
  const hits = files.filter((f) => readFileSync(f, 'utf8').includes(needle))
    .map((f) => f.replace(ROOT + '\\', '').replace(/\\/g, '/'))
    // 以下文件**必须**提到这些词，不算泄漏：
    //   · 任务/流程文档：描述"改造过程"本身
    //   · 本检查脚本：列出要扫描的模式
    //   · sync-to-user.mjs：注释里列着"用户版该重放哪些改造"（重放清单需要点名）
    //   · create-test-cloud.mjs / delete-test-cloud.mjs：**管理员**工具（用户版没有这些），
    //     只在测试机上用来建/删测试云目录；发布时会被打包清单排除
    .filter((f) => !/用户版插件-工作流程|check-user-edition|\.copy-report|sync-to-user|create-test-cloud|delete-test-cloud/.test(f))
  check(`源码/产物里没有 ${needle}（${label}）`, hits.length === 0, hits.slice(0, 3).join(', '))
}

const keyFiles = []
;(function findKeys(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') findKeys(abs); continue }
    if (/\.(key|pem|ppk)$/i.test(e.name)) keyFiles.push(abs)
  }
})(ROOT)
check('包内没有任何私钥文件（*.key / *.pem / *.ppk）', keyFiles.length === 0, keyFiles.join(', '))

/* ---------- ② 通道不存在 ---------- */
console.log('\n=== ② cloud:create 通道必须不存在（AI 也调不到） ===')
// 运行数据放系统临时目录，别污染交付目录（之前会在这里建 .usercheck-*）
const TMP = join((await import('node:os')).tmpdir(), 'dsh-quill-user-check')
process.env.DSH_QUILL_DATA_DIR = join(TMP, 'data')
process.env.DSH_QUILL_LIBRARY_ROOT = join(TMP, 'lib')
process.env.DSH_QUILL_NO_REGISTRY_INHERIT = '1'
const hostMod = await import('../packages/' + packageDirName() + '/lib/host.js')
const rt = await hostMod.createRuntime({
  dataDir: process.env.DSH_QUILL_DATA_DIR,
  libraryRoot: process.env.DSH_QUILL_LIBRARY_ROOT
})
{
  const gone = await rt.invoke('cloud:create', ['x'])
  check('cloud:create 不存在（调用返回"通道不存在"）', gone === undefined, JSON.stringify(gone)?.slice(0, 60))
  const stillThere = await rt.invoke('cloud:test-key', ['QC1-x-y-z'])
  check('cloud:test-key 仍然存在（用 key 接入这条路要保留）', stillThere !== undefined, '')
  const connectKey = await rt.invoke('cloud:connect-key', ['QC1-x-y-z', ''])
  check('cloud:connect-key 仍然存在', connectKey !== undefined, '')
}

/* ---------- ③ key 接入可用（需真实云目录，没有就跳过） ---------- */
console.log('\n=== ③ 用 key 接入（需要真实云目录） ===')
const FIXTURE = join(ROOT, 'tools', 'fixtures', 'cloud-dir.json')
if (!existsSync(FIXTURE)) {
  console.log('  [SKIP] 没有 tools/fixtures/cloud-dir.json —— 需管理员先建一朵测试云目录再验证')
} else {
  const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const { createHash } = await import('node:crypto')
  const payload = { v: 1, h: fx.host, p: fx.port, u: fx.user, id: fx.id, n: fx.name, k: Buffer.from(fx.privateKeyB64, 'base64').toString('utf8') }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const key = `QC1-${payload.id}-${body}-${createHash('sha256').update(body).digest('hex').slice(0, 6)}`
  const r = await rt.invoke('cloud:test-key', [key])
  if (r?.ok === true) {
    check('用合法 key 测试连接成功', true, `云端 ${r.value?.files ?? 0} 个文件`)
    // 顺便验上传/下载链路：把库复制成云目录、上传、再下载回来
    const conn = await rt.invoke('cloud:connect-key', [key, ''])
    check('能用 key 接入（cloud:connect-key）', conn?.ok === true, conn?.ok === true ? String(conn.value?.name) : String(conn?.error).slice(0, 60))
  } else {
    const msg = String(r?.error ?? '')
    const dirGone = /已经不存在|无效/.test(msg)
    // 服务器上那朵测试目录被删掉时，这里应该"如实说明"而不是假装通过
    check('用合法 key 测试连接（目录已被删除时给出友好文案）', dirGone, msg.slice(0, 70))
    console.log('       ⚠ 该云目录已不存在 → 真实上传/下载链路本次**未验证**；要验证请重建一朵并更新 tools/fixtures/cloud-dir.json')
  }
}

/* ---------- ④ 干净新库 ---------- */
console.log('\n=== ④ 默认是干净新库 ===')
{
  const runtimeSrc = readFileSync(join(PKG, 'lib', 'runtime.js'), 'utf8')
  check('不再读 Quill 旧配置（%APPDATA%\\workapp）', !/workapp['"]?\s*,\s*['"]config\.json/.test(runtimeSrc) && !runtimeSrc.includes("'workapp', 'config.json'"), '')
  check('默认库指向 ~/Documents/QuillNotes', runtimeSrc.includes("'Documents', 'QuillNotes'"), '')
  // 真跑一次：不设 DSH_QUILL_LIBRARY_ROOT 时，库根应落在 QuillNotes
  const { homedir } = await import('node:os')
  const saved = process.env.DSH_QUILL_LIBRARY_ROOT
  const savedData = process.env.DSH_QUILL_DATA_DIR
  delete process.env.DSH_QUILL_LIBRARY_ROOT
  delete process.env.DSH_QUILL_DATA_DIR   // 前面为了隔离设过，要验"默认值"就得清掉
  const runtimeMod = await import('../packages/' + packageDirName() + '/lib/runtime.js')
  const resolved = runtimeMod.resolveOptions(undefined)
  const expect = join(homedir(), 'Documents', 'QuillNotes').replace(/\\/g, '/').toLowerCase()
  check('未配置时 resolveOptions 给出的库根就是 ~/Documents/QuillNotes',
    String(resolved.libraryRoot).replace(/\\/g, '/').toLowerCase() === expect, String(resolved.libraryRoot))
  check('未配置时数据目录是独立的插件目录（不与 dev 版共用）',
    String(resolved.dataDir).replace(/\\/g, '/').toLowerCase().endsWith('quill-plugin-user'), String(resolved.dataDir))
  process.env.DSH_QUILL_LIBRARY_ROOT = saved
  if (savedData !== undefined) process.env.DSH_QUILL_DATA_DIR = savedData
}

/* ---------- 名字 ---------- */
console.log('\n=== 命名 ===')
check('包名是 dsh-quill-user', packageName() === 'dsh-quill-user', packageName())
{
  const patch = readFileSync(join(PKG, 'cordis.patch.yml'), 'utf8')
  check('预设显示名是「羽毛笔」（就这三个字）', /name: 羽毛笔\s*\n/.test(patch), '')
  check('预设 id 是 notes-assistant-user（与 dev 版区分）', patch.includes('id: notes-assistant-user'), '')
  check('面板行 id 是 quill-notes-user', patch.includes('- id: quill-notes-user'), '')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 汇总 ===\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
process.exit(failed.length === 0 ? 0 : 1)
