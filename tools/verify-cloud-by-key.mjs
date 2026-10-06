/**
 * 验证用户版的云目录完整链路：**用 key 接入 → 上传 → 云端有内容 → 下载**。
 * 需要 tools/fixtures/cloud-dir.json（由 create-test-cloud.mjs 生成）。
 *
 *   node tools/verify-cloud-by-key.mjs
 */
import { existsSync, readFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ROOT, LIBRARY_SNAPSHOT, packageDirName } from './paths.mjs'

const FX = join(ROOT, 'tools', 'fixtures', 'cloud-dir.json')
if (!existsSync(FX)) { console.log('[SKIP] 没有 cloud-dir.json —— 先跑 tools/create-test-cloud.mjs'); process.exit(0) }

const work = join(ROOT, '.cloudcheck')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const libDir = join(work, 'lib')
process.env.DSH_QUILL_DATA_DIR = join(work, 'data')
process.env.DSH_QUILL_LIBRARY_ROOT = libDir
process.env.DSH_QUILL_NO_REGISTRY_INHERIT = '1'

const results = []
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d ? ' -- ' + d : ''}`) }

const mod = await import('../packages/' + packageDirName() + '/lib/host.js')
const rt = await mod.createRuntime({ dataDir: process.env.DSH_QUILL_DATA_DIR, libraryRoot: libDir })

const fx = JSON.parse(readFileSync(FX, 'utf8'))
const payload = { v: 1, h: fx.host, p: fx.port, u: fx.user, id: fx.id, n: fx.name, k: Buffer.from(fx.privateKeyB64, 'base64').toString('utf8') }
const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
const key = `QC1-${payload.id}-${body}-${createHash('sha256').update(body).digest('hex').slice(0, 6)}`

console.log('=== 用 key 接入 ===')
const test = await rt.invoke('cloud:test-key', [key])
check('测试 key 连接成功', test?.ok === true, test?.ok === true ? `${test.value.files} 个文件` : String(test?.error).slice(0, 60))

// 库内容从快照取（避免依赖用户真实库）
const { cpSync } = await import('node:fs')
cpSync(LIBRARY_SNAPSHOT, libDir, { recursive: true })
const notesCount = readdirSync(join(libDir, 'notes')).length
console.log(`\n=== 上传（库里有 ${notesCount} 个条目） ===`)

const connect = await rt.invoke('cloud:connect-key', [key, ''])
check('接入云目录成功', connect?.ok === true, connect?.ok === true ? String(connect.value?.name) : String(connect?.error).slice(0, 60))
const libId = connect?.value?.id

if (libId !== undefined) {
  const up = await rt.invoke('cloud:upload2', [libId])
  check('上传成功', up?.ok === true, up?.ok === true ? `上传 ${up.value?.uploaded ?? '?'} 个文件` : String(up?.error).slice(0, 60))

  const after = await rt.invoke('cloud:test-key', [key])
  check('云端真的有内容了', after?.ok === true && (after.value?.files ?? 0) > 0, `云端 ${after?.value?.files ?? 0} 个文件`)

  const st = await rt.invoke('cloud:status2', [libId])
  check('状态可读（容量/设备）', st?.ok === true, st?.ok === true ? `已用 ${st.value?.usage?.bytes ?? 0} 字节` : String(st?.error).slice(0, 60))

  const down = await rt.invoke('cloud:download2', [libId])
  check('下载成功', down?.ok === true, down?.ok === true ? '已同步云端内容到本机' : String(down?.error).slice(0, 60))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
rmSync(work, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
