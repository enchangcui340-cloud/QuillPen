/**
 * 跑全部测试套件（含白板绘制功能新增的 4 套），汇总结果。
 *
 *   node tools/run-all.mjs            # 全部
 *   node tools/run-all.mjs --fast     # 跳过慢的（真浏览器 / 性能 / 云）
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:/DSH/test01/dsh-quill-user'
const fast = process.argv.includes('--fast')

/** 这些套件慢或依赖外部环境，--fast 时跳过 */
const SLOW = new Set(['check-shape-select.mjs', 'smoke-perf.mjs', 'smoke-cloud.mjs', 'smoke-doc-read.mjs'])

const suites = readdirSync(join(ROOT, 'tools'))
  .filter((f) => /^(check|smoke)-.*\.mjs$/.test(f) && f !== 'run-all.mjs')
  .sort()

const rows = []
for (const s of suites) {
  if (fast && SLOW.has(s)) { rows.push({ s, ok: null, note: '（--fast 跳过）' }); continue }
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [join(ROOT, 'tools', s)], {
    cwd: ROOT, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024
  })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  // 从输出里抓"N/M 通过"或"X/Y ok"
  const m = /(\d+)\s*\/\s*(\d+)\s*(?:通过|ok|pass)/i.exec(out)
  const counts = m === null ? null : { pass: Number(m[1]), total: Number(m[2]) }
  const ok = r.status === 0
  rows.push({ s, ok, counts, ms: Date.now() - t0, tail: out.split('\n').filter((l) => /\[FAIL\]|不通过|失败/.test(l)).slice(0, 4) })
  const tag = ok ? '[OK]  ' : '[FAIL]'
  console.log(`${tag} ${s.padEnd(30)} ${counts === null ? '' : counts.pass + '/' + counts.total}  ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  if (!ok) for (const l of rows[rows.length - 1].tail) console.log('        ' + l.trim().slice(0, 120))
}

const ran = rows.filter((r) => r.ok !== null)
const bad = ran.filter((r) => r.ok === false)
const totalPass = ran.reduce((a, r) => a + (r.counts?.pass ?? 0), 0)
const totalAll = ran.reduce((a, r) => a + (r.counts?.total ?? 0), 0)

console.log('\n========================================')
console.log(`套件：${ran.length - bad.length}/${ran.length} 通过` + (fast ? `（跳过 ${rows.length - ran.length} 套）` : ''))
if (totalAll > 0) console.log(`断言：${totalPass}/${totalAll} 通过`)
if (bad.length > 0) {
  console.log('\n失败的套件：')
  for (const b of bad) console.log('  · ' + b.s)
}
process.exit(bad.length === 0 ? 0 : 1)
