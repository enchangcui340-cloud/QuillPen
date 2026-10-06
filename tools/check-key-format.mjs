/**
 * 短 key 编码一致性测试（新增护栏）。
 *
 * 事故复盘：短 key 的种子用 base64url 编码，而 base64url 字母表**含 `-`** ——
 * 与 key 的分隔符撞车，导致约一半的 key 被切错段、报"校验位对不上"。
 * 这类"编码字符与分隔符撞车"的 bug 极难靠肉眼发现，必须靠测试钉死。
 *
 * 本测试断言：
 *   ① 正文编码**不含**分隔符 `-`（hex 只含 0-9a-f）
 *   ② 编解码往返一致（生成的 key 能解析回同一个种子）
 *   ③ 老格式（base64url、种子含 `-`）仍能正确解析 —— 已发出去的 key 不作废
 *   ④ 认证路径对两种编码都能解出 32 字节
 *   ⑤ 校验位算错时报错说清（含正文长度）
 *
 *   node tools/check-key-format.mjs
 */
import { createHash, createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { join } from 'node:path'
import { PKG } from './paths.mjs'

const results = []
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d ? ' -- ' + d : ''}`) }

/* ---------- 造一对测试密钥并提取种子 ---------- */
const { privateKey } = generateKeyPairSync('ed25519')
const der = createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' })).export({ format: 'der', type: 'pkcs8' })
const seed = der.subarray(der.length - 32)
check('测试种子是 32 字节', seed.length === 32, `${seed.length} 字节`)

/* ---------- ① 编码不含分隔符 ---------- */
const hex = seed.toString('hex')
check('新格式正文（hex）不含分隔符 "-"', !hex.includes('-'), `${hex.length} 字符`)
check('新格式正文是 64 位十六进制', /^[0-9a-f]{64}$/i.test(hex), '')

/* ---------- ② 往返一致 ---------- */
const sum = createHash('sha256').update(hex).digest('hex').slice(0, 6)
const KEY = `QS2-abcdefgh-${hex}-${sum}`
const m = /^(Q[CS]\d)-([^-]+)-(.+)-([0-9a-f]{6})$/.exec(KEY)
check('生成的 key 能被"两头定位"正则解析', m !== null, KEY.length + ' 字符')
if (m !== null) {
  check('解析出的正文与原始种子一致', Buffer.from(m[3], 'hex').equals(seed), '')
  check('解析出的校验位与计算值一致', m[4] === sum, '')
}

/* ---------- ③ 老格式（种子含 -）仍可解析 ---------- */
// 构造一个**含 - 的 base64url 种子**（这是原 bug 的触发条件）
let b64WithDash = null
for (let i = 0; i < 5000; i++) {
  const s = Buffer.from(generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' })).subarray(-32)
  const b = s.toString('base64url')
  if (b.includes('-')) { b64WithDash = { seed: s, b64: b }; break }
}
if (b64WithDash === null) {
  check('能找到含 "-" 的老格式种子（用于测试）', false, '5000 次采样没找到（不太可能）')
} else {
  const s2 = createHash('sha256').update(b64WithDash.b64).digest('hex').slice(0, 6)
  const OLD = `QS2-abcdefgh-${b64WithDash.b64}-${s2}`
  const mo = /^(Q[CS]\d)-([^-]+)-(.+)-([0-9a-f]{6})$/.exec(OLD)
  check('老格式 key（种子含 "-"）仍能被正确解析', mo !== null && mo[3] === b64WithDash.b64,
    mo === null ? '正则没匹配' : `正文 ${mo[3].length} 字符 / 应为 ${b64WithDash.b64.length}`)
  check('老格式种子解出 32 字节', mo !== null && Buffer.from(mo[3], 'base64url').length === 32, '')
}

/* ---------- ④ 认证路径对两种编码都能解 ---------- */
const hostMod = await import('file:///' + join(PKG, 'lib', 'host.js').replace(/\\/g, '/'))
// materializePrivateKey 没导出，改为通过通道行为间接验证：两种 key 都**不该**报格式/种子错误
const rt = await hostMod.createRuntime({
  dataDir: join(PKG, '..', '..', '.tmp-keyfmt-check', 'data'),
  libraryRoot: join(PKG, '..', '..', '.tmp-keyfmt-check', 'lib')
})
for (const [label, k] of [['新格式(hex)', KEY], ...(b64WithDash === null ? [] : [['老格式(base64url含-)', `QS2-abcdefgh-${b64WithDash.b64}-${createHash('sha256').update(b64WithDash.b64).digest('hex').slice(0, 6)}`]])]) {
  const r = await rt.invoke('cloud:test-key', [k])
  const err = String(r?.error ?? '')
  const bad = /种子必须是 32 字节|种子应为 32 字节|校验位对不上|格式不正确/.test(err)
  check(`${label} 走到网络阶段（未被编码问题挡住）`, !bad, bad ? err.slice(0, 80) : err.slice(0, 60))
}

/* ---------- ⑤ 报错文案 ---------- */
const r5 = await rt.invoke('cloud:test-key', [`QS2-abcdefgh-${hex}-ffffff`])
const e5 = String(r5?.error ?? '')
check('校验位错时报错含正文长度、且不展示错的"校验位"',
  /正文 \d+ 字符/.test(e5) && !/校验位 x/.test(e5), e5.slice(0, 80))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.n}：${f.d}`)
process.exit(failed.length === 0 ? 0 : 1)
