/**
 * 连线取边规范校验（纯函数级，跑得快）。
 *
 *   node tools/check-edge-sides.mjs
 *
 * 背景：老实现把两个矩形传反了，并排两卡会连成 `left → right`（绕两卡一圈，锚点距 480；
 * 正确解 60）。12 个常见方位实测 **0/12 正确**。这里把它固化成测试。
 *
 * 同时校验 `tools-write.js` 的 side 白名单（非法值必须报错，不能静默兜底）。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

const ROOT = 'D:/DSH/test01/quill-dsh'
const PKG = join(ROOT, 'packages', 'dsh-quill')
const requireFromWorkapp = createRequire('D:/DSH/test01/workapp/package.json')

const results = []
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d ? ' -- ' + d : ''}`) }

const { build } = requireFromWorkapp('esbuild')
const outFile = join(ROOT, '.tmp', 'edge-sides-test.mjs')
await build({
  entryPoints: [join(ROOT, 'src-client', 'lib', 'board.ts')],
  outfile: outFile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
  absWorkingDir: ROOT,
  plugins: [{ name: 'a', setup(b) {
    b.onResolve({ filter: /^@shared\// }, (a) => ({ path: join(ROOT, 'shared', a.path.slice(8)) + '.ts' }))
  } }]
})
const B = await import('file:///' + outFile.replace(/\\/g, '/'))

const rectOf = (n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })
const N = (x, y, w = 210, h = 120) => ({ x, y, w, h })

/* ============================ ① 方向 → 取边对照表 ============================ */
console.log('=== ① 方位 → 取边（规范 §7.2 的机器版） ===')
/*
 * 判据说明（已与用户确认）：**按卡片形状归一化**，即沿用 `nearestSide` 的语义 ——
 * 把位移分别除以半宽 / 半高再比大小。卡片是 210×120（扁的），所以**竖直方向更容易"赢"**。
 *
 * 后果（下文期望值就是这么算出来的）：
 *   · (270,180) 各一格  → 归一化 2.57 vs 3.00 → 竖着连（bottom→top）
 *   · (400,-300)       → 归一化 3.81 vs 5.00 → 竖着连（top→bottom）
 *   · (540,160) 横向两格 → 归一化 5.14 vs 2.67 → 横着连（right→left）
 * 也就是说"同格距的斜向默认竖着连"，这与界面既有的取边语义一致。
 */
const CASES = [
  ['正右', N(0, 0), N(400, 0), 'right', 'left'],
  ['正左', N(0, 0), N(-400, 0), 'left', 'right'],
  ['正下', N(0, 0), N(0, 300), 'bottom', 'top'],
  ['正上', N(0, 0), N(0, -300), 'top', 'bottom'],
  ['并排（间距 60）', N(0, 0), N(270, 0), 'right', 'left'],
  ['紧贴（间距 0）', N(0, 0), N(210, 0), 'right', 'left'],
  ['右下（各一格）', N(0, 0), N(270, 180), 'bottom', 'top'],
  ['右上', N(0, 0), N(400, -300), 'top', 'bottom'],
  ['左下', N(0, 0), N(-400, 300), 'bottom', 'top'],
  ['左上', N(0, 0), N(-400, -300), 'top', 'bottom'],
  ['横向两格', N(0, 0), N(540, 160), 'right', 'left'],
  ['竖向两格', N(0, 0), N(270, 320), 'bottom', 'top'],
  ['垂直分离+水平重叠', N(0, 0), N(50, 300), 'bottom', 'top'],
  ['水平分离+垂直重叠', N(0, 0), N(400, 40), 'right', 'left'],
  ['小卡→下方大卡', N(0, 0, 145, 60), N(-100, 300, 400, 120), 'bottom', 'top'],
  ['小卡→右下大卡', N(0, 0, 100, 60), N(400, 400, 600, 400), 'bottom', 'top']
]
let shapeOk = 0
for (const [name, a, b, ef, et] of CASES) {
  const r = B.resolveEdgeSides(rectOf(a), rectOf(b))
  const ok = r.from === ef && r.to === et
  if (ok) shapeOk++
  check(`${name} → ${ef} → ${et}`, ok, ok ? '' : `实际 ${r.from} → ${r.to}`)
}
console.log(`  （方位表 ${shapeOk}/${CASES.length}）`)

/* ============================ ② 锚点距离（挡"绕圈"） ============================ */
console.log('\n=== ② 端点锚点距离（越大越绕） ===')
{
  // 用户反馈的两个场景，设一个宽松上界挡住"绕两卡一圈"
  const pairs = [
    ['并排', N(0, 0), N(270, 0), 100],
    ['右下', N(0, 0), N(270, 180), 300]
  ]
  for (const [name, a, b, limit] of pairs) {
    const r = B.resolveEdgeSides(rectOf(a), rectOf(b))
    const pa = B.anchorOf(rectOf(a), r.from)
    const pb = B.anchorOf(rectOf(b), r.to)
    const d = Math.hypot(pb.x - pa.x, pb.y - pa.y)
    check(`${name}：锚点距 ${d.toFixed(0)} ≤ ${limit}`, d <= limit, d > limit ? '太绕了' : '')
  }
  // 老实现在并排场景会给出 480，这里断言"绝不会那么大"
  const old = (() => {
    const a = N(0, 0), b = N(270, 0)
    const from = B.nearestSide(rectOf(b), B.anchorOf(rectOf(a), 'right'))
    const to = B.nearestSide(rectOf(a), B.anchorOf(rectOf(b), 'left'))
    const pa = B.anchorOf(rectOf(a), from)
    const pb = B.anchorOf(rectOf(b), to)
    return { from, to, d: Math.hypot(pb.x - pa.x, pb.y - pa.y) }
  })()
  check('（对照）老实现在并排场景确实是坏的', old.d > 400, `老实现 ${old.from}→${old.to} 距离 ${old.d.toFixed(0)}`)
}

/* ============================ ③ 永不选同侧 ============================ */
console.log('\n=== ③ 永不选同一条边（否则线横穿卡片） ===')
{
  /*
   * ⚠️ 排除"两卡中心重合"的退化情况：那时任何取边都没有意义
   *（现实中不该出现完全重叠的卡片；真出现了，画成什么样都无所谓，只要**稳定**）。
   */
  const same = []
  let skipped = 0
  for (let dx = -400; dx <= 400; dx += 50) {
    for (let dy = -400; dy <= 400; dy += 50) {
      const a = N(0, 0)
      const b = N(dx, dy)
      // 中心完全重合 → 跳过
      if (dx === 0 && dy === 0) { skipped++; continue }
      const r = B.resolveEdgeSides(rectOf(a), rectOf(b))
      if (r.from === r.to) same.push(`(${dx},${dy})=${r.from}`)
    }
  }
  check('除完全重合外，都不出现同侧', same.length === 0,
    same.length === 0 ? `（跳过 ${skipped} 个中心重合的退化情况）` : same.slice(0, 5).join(' '))
  // 退化情况也要稳定（同样输入永远同样输出）
  const degen1 = B.resolveEdgeSides(rectOf(N(0, 0)), rectOf(N(0, 0)))
  const degen2 = B.resolveEdgeSides(rectOf(N(0, 0)), rectOf(N(0, 0)))
  check('完全重合时输出稳定（不随机）', degen1.from === degen2.from && degen1.to === degen2.to)
}

/* ============================ ④ 对称性 ============================ */
console.log('\n=== ④ 位置互换 → 取边应对称 ===')
{
  const bad = []
  for (let dx = -400; dx <= 400; dx += 100) {
    for (let dy = -400; dy <= 400; dy += 100) {
      if (dx === 0 && dy === 0) continue
      const a = N(0, 0)
      const b = N(dx, dy)
      const ab = B.resolveEdgeSides(rectOf(a), rectOf(b))
      const ba = B.resolveEdgeSides(rectOf(b), rectOf(a))
      if (ab.from !== ba.to || ab.to !== ba.from) bad.push(`(${dx},${dy})`)
    }
  }
  check('A→B 的 from 等于 B→A 的 to', bad.length === 0, bad.slice(0, 5).join(' '))
}

/* ============================ ⑤ 返回值合法性 ============================ */
console.log('\n=== ⑤ 返回值只能是四条边之一 ===')
{
  const bad = []
  for (let dx = -500; dx <= 500; dx += 37) {
    for (let dy = -500; dy <= 500; dy += 41) {
      const r = B.resolveEdgeSides(rectOf(N(0, 0)), rectOf(N(dx, dy)))
      if (!B.isEdgeSide(r.from) || !B.isEdgeSide(r.to)) bad.push(`(${dx},${dy})`)
    }
  }
  check('全部落在 top/right/bottom/left', bad.length === 0, bad.slice(0, 5).join(' '))
  check('isEdgeSide 正确识别非法值', !B.isEdgeSide('右') && !B.isEdgeSide('RIGHT') && !B.isEdgeSide('east') && !B.isEdgeSide(undefined))
}

/* ============================ ⑥ AI 侧 side 白名单 ============================ */
console.log('\n=== ⑥ add_edge 的 side 白名单（非法必须报错） ===')
{
  const kit = await import('file:///' + join(PKG, 'lib', 'tool-kit.js').replace(/\\/g, '/'))
  check('tool-kit 有 isEdgeSide', typeof kit.isEdgeSide === 'function')
  check('isEdgeSide 接受合法值', ['top', 'right', 'bottom', 'left'].every((s) => kit.isEdgeSide(s)))
  check('isEdgeSide 拒绝中文/大写/英文单词', !kit.isEdgeSide('右') && !kit.isEdgeSide('RIGHT') && !kit.isEdgeSide('east'))
  check('tool-kit 有 resolveEdgeSides', typeof kit.resolveEdgeSides === 'function')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n连线取边规范：${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.n}：${f.d}`)
process.exit(failed.length === 0 ? 0 : 1)
