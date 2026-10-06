/**
 * 连线取边的"两边一致"校验。
 *
 *   node tools/check-edge-side-parity.mjs
 *
 * 为什么需要：取边算法在**两个独立模块**里各有一份 ——
 *   · 界面侧：`src-client/lib/board.ts`      （TS，打进 client.js）
 *   · AI 侧：`packages/dsh-quill/lib/tool-kit.js`（纯 JS，DSH 直接加载）
 * 两者无法共用源码。改一处忘另一处，就会出现"AI 算出来一种连法、界面画成另一种"。
 *
 * 做法与卡片色板的 `check-card-color-parity.mjs` 一致：跑同一批场景，逐项比对结果。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

const ROOT = 'D:/DSH/test01/quill-dsh'
const PKG = join(ROOT, 'packages', 'dsh-quill')
const requireFromWorkapp = createRequire('D:/DSH/test01/workapp/package.json')

const results = []
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d ? ' -- ' + d : ''}`) }

/* ---------- 界面侧（从 TS 编译出来） ---------- */
const { build } = requireFromWorkapp('esbuild')
const outFile = join(ROOT, '.tmp', 'parity-board.mjs')
await build({
  entryPoints: [join(ROOT, 'src-client', 'lib', 'board.ts')],
  outfile: outFile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
  absWorkingDir: ROOT,
  plugins: [{ name: 'a', setup(b) {
    b.onResolve({ filter: /^@shared\// }, (a) => ({ path: join(ROOT, 'shared', a.path.slice(8)) + '.ts' }))
  } }]
})
const Client = await import('file:///' + outFile.replace(/\\/g, '/'))

/* ---------- AI 侧（纯 JS，直接加载） ---------- */
const Kit = await import('file:///' + join(PKG, 'lib', 'tool-kit.js').replace(/\\/g, '/'))

console.log('=== ① 两边都导出了同一组符号 ===')
for (const sym of ['resolveEdgeSides', 'sideFacingCenter', 'isEdgeSide']) {
  check(`client 有 ${sym}`, typeof Client[sym] === 'function')
  check(`kit 有 ${sym}`, typeof Kit[sym] === 'function')
}

console.log('\n=== ② 同一批场景，两边结果必须逐项相同 ===')
{
  const R = (x, y, w, h) => ({ x, y, w, h })
  let n = 0
  let bad = []
  // 覆盖：方格网 + 半格 + 极端尺寸 + 重叠 + 紧贴
  for (let dx = -600; dx <= 600; dx += 30) {
    for (let dy = -600; dy <= 600; dy += 30) {
      for (const [aw, ah, bw, bh] of [[210, 120, 210, 120], [145, 60, 300, 120], [100, 60, 600, 400]]) {
        const a = R(0, 0, aw, ah)
        const b = R(dx, dy, bw, bh)
        const c = Client.resolveEdgeSides(a, b)
        const k = Kit.resolveEdgeSides(a, b)
        n++
        if (c.from !== k.from || c.to !== k.to) {
          if (bad.length < 5) bad.push(`A(${aw}×${ah}) B(${dx},${dy},${bw}×${bh})  client=${c.from}→${c.to}  kit=${k.from}→${k.to}`)
        }
      }
    }
  }
  check(`${n} 组场景结果完全一致`, bad.length === 0, bad.join(' | '))
}

console.log('\n=== ③ 非法的 side 两边都拒绝 ===')
{
  const illegal = ['右', 'RIGHT', 'east', 'UP', '', ' ', 'none', '0']
  const clientRejects = illegal.every((v) => !Client.isEdgeSide(v))
  const kitRejects = illegal.every((v) => !Kit.isEdgeSide(v))
  check('client 的 isEdgeSide 拒绝全部非法值', clientRejects, illegal.filter((v) => Client.isEdgeSide(v)).join(','))
  check('kit 的 isEdgeSide 拒绝全部非法值', kitRejects, illegal.filter((v) => Kit.isEdgeSide(v)).join(','))
  const legal = ['top', 'right', 'bottom', 'left']
  check('两边都接受四个合法值',
    legal.every((v) => Client.isEdgeSide(v)) && legal.every((v) => Kit.isEdgeSide(v)))
}

console.log('\n=== ④ 常量表一致（EDGE_SIDES / SIDES） ===')
{
  const clientSides = [...Client.EDGE_SIDES].sort().join(',')
  const kitSides = [...Kit.EDGE_SIDES].sort().join(',')
  check('EDGE_SIDES 两边相同', clientSides === kitSides, `client=${clientSides} kit=${kitSides}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n取边实现一致性：${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.n}：${f.d}`)
process.exit(failed.length === 0 ? 0 : 1)
