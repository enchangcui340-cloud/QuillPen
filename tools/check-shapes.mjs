/**
 * shapes.ts 单元测试（白板绘制功能的纯函数层）。
 *
 *   node tools/check-shapes.mjs
 *
 * 覆盖：kind 别名、路径生成（直线/曲线平滑）、包围盒、相交、平移、
 *       自由绘制采样、曲线插点、命中（线段/控制点/整体）、构造（含反向拖拽与吸附）、归一化。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

const ROOT = 'D:/DSH/test01/quill-dsh'
const requireFromWorkapp = createRequire('D:/DSH/test01/workapp/package.json')

const results = []
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d ? ' -- ' + d : ''}`) }

/* ---------- 用 esbuild 把 TS 打成临时 JS 再 import ---------- */
const { build } = requireFromWorkapp('esbuild')
const outFile = join(ROOT, '.tmp', 'shapes-test.mjs')
await build({
  entryPoints: [join(ROOT, 'src-client', 'lib', 'shapes.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
  // @shared/types 只有类型，esbuild 会当作外部；运行时不需要它
  external: ['@shared/types']
})

const S = await import('file:///' + outFile.replace(/\\/g, '/'))

/* ============================ ① kind 别名 ============================ */
console.log('=== ① kind 别名解析 ===')
check('中文「矩形」→ rect', S.resolveShapeKind('矩形') === 'rect')
check('中文「圆」→ ellipse', S.resolveShapeKind('圆') === 'ellipse')
check('中文「箭头」→ arrow', S.resolveShapeKind('箭头') === 'arrow')
check('中文「涂鸦」→ free', S.resolveShapeKind('涂鸦') === 'free')
check('英文 "Rectangle" → rect（大小写不敏感）', S.resolveShapeKind('Rectangle') === 'rect')
check('未知输入返回 null', S.resolveShapeKind('三角形体') === null)
check('非字符串返回 null', S.resolveShapeKind(123) === null)
check('8 种 kind 齐全', S.SHAPE_KINDS.length === 8, S.SHAPE_KINDS.join(','))

/* ============================ ② 线类判定 ============================ */
console.log('\n=== ② 线类判定 ===')
check('line/arrow/curve/free 是线类', ['line', 'arrow', 'curve', 'free'].every((k) => S.isLineKind(k)))
check('rect/ellipse/triangle/diamond 不是线类', !['rect', 'ellipse', 'triangle', 'diamond'].some((k) => S.isLineKind(k)))

/* ============================ ③ 路径 ============================ */
console.log('\n=== ③ 路径生成 ===')
const p2 = [{ x: 0, y: 0 }, { x: 100, y: 50 }]
check('折线路径格式', S.polylinePath(p2) === 'M 0 0 L 100 50', S.polylinePath(p2))
check('单点路径不报错', S.polylinePath([{ x: 5, y: 6 }]) === 'M 5 6')
check('空数组返回空串', S.polylinePath([]) === '')
check('2 点的平滑路径退化成直线', S.smoothPath(p2) === 'M 0 0 L 100 50', S.smoothPath(p2))
const p4 = [{ x: 0, y: 0 }, { x: 50, y: 80 }, { x: 100, y: 0 }, { x: 150, y: 60 }]
const sp = S.smoothPath(p4)
check('多点平滑路径用三次贝塞尔（C 出现 3 次）', (sp.match(/C /g) ?? []).length === 3, `${(sp.match(/C /g) ?? []).length} 次`)
check('平滑路径经过首尾点', sp.startsWith('M 0 0') && sp.trim().endsWith('150 60'), sp.slice(0, 20) + '…' + sp.slice(-12))
check('平滑路径不产生 NaN', !sp.includes('NaN'), sp.includes('NaN') ? sp : '')

/* ---------- 平滑的数学正确性：曲线应经过每个控制点 ---------- */
{
  // 对 3 点情形，第 1 段的终点必须等于第 2 个控制点（三次贝塞尔的端点性质）
  const s3 = S.smoothPath([{ x: 0, y: 0 }, { x: 30, y: 40 }, { x: 60, y: 0 }])
  const seg1 = s3.split(' C ')[1] ?? ''
  const endOfSeg1 = seg1.split(', ').pop()
  check('3 点平滑：第 1 段终点 = 第 2 个控制点', endOfSeg1 === '30 40', `实际 ${endOfSeg1}`)
  const seg2 = s3.split(' C ')[2] ?? ''
  check('3 点平滑：第 2 段终点 = 第 3 个控制点', (seg2.split(', ').pop() ?? '') === '60 0', `实际 ${seg2.split(', ').pop()}`)
}

/* ============================ ④ 包围盒 ============================ */
console.log('\n=== ④ 包围盒 ===')
check('几何图形包围盒', JSON.stringify(S.shapeBox({ kind: 'rect', x: 10, y: 20, w: 100, h: 50 })) === JSON.stringify({ x: 10, y: 20, w: 100, h: 50 }))
check('负宽高取绝对值', S.shapeBox({ kind: 'rect', x: 10, y: 20, w: -100, h: -50 }).w === 100)
const lineBox = S.shapeBox({ kind: 'line', points: [{ x: 50, y: 90 }, { x: 10, y: 20 }] })
check('线类包围盒按点极值', lineBox.x === 10 && lineBox.y === 20 && lineBox.w === 40 && lineBox.h === 70, JSON.stringify(lineBox))
check('空点集不报错', S.shapeBox({ kind: 'free', points: [] }).w === 0)
const multi = S.shapesBounds([
  { kind: 'rect', x: 0, y: 0, w: 100, h: 100 },
  { kind: 'rect', x: 200, y: 50, w: 50, h: 50 }
])
check('多图形合并包围盒', multi.x === 0 && multi.y === 0 && multi.w === 250 && multi.h === 100, JSON.stringify(multi))
check('空列表返回 null', S.shapesBounds([]) === null)

/* ============================ ⑤ 相交（框选） ============================ */
console.log('\n=== ⑤ 相交判断（框选） ===')
check('部分重叠算相交', S.boxesIntersect({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 }))
check('完全包含算相交', S.boxesIntersect({ x: 0, y: 0, w: 100, h: 100 }, { x: 10, y: 10, w: 10, h: 10 }))
check('分离不算相交', !S.boxesIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 100, y: 100, w: 10, h: 10 }))
check('边缘相切算相交', S.boxesIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }))

/* ============================ ⑥ 平移 ============================ */
console.log('\n=== ⑥ 平移 ===')
const movedRect = S.moveShape({ kind: 'rect', x: 10, y: 20, w: 30, h: 40 }, 5, -7)
check('几何图形移 x/y', movedRect.x === 15 && movedRect.y === 13)
const movedLine = S.moveShape({ kind: 'line', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }, 3, 4)
check('线类移所有点', movedLine.points[0].x === 3 && movedLine.points[1].y === 14, JSON.stringify(movedLine.points))
check('平移不改原对象（纯函数）', movedRect.x === 15)

/* ============================ ⑦ 自由绘制采样 ============================ */
console.log('\n=== ⑦ 自由绘制采样 ===')
check('第一个点总是记录', S.shouldSample(undefined, { x: 0, y: 0 }))
check('距离不足不记录', !S.shouldSample({ x: 0, y: 0 }, { x: 1, y: 0 }))
check('距离够则记录', S.shouldSample({ x: 0, y: 0 }, { x: 5, y: 0 }))
{
  // 造 100 个密集点（每步 1 单位），采样后应显著变少
  const dense = Array.from({ length: 100 }, (_, i) => ({ x: i, y: 0 }))
  const sampled = S.samplePoints(dense)
  check('密集点被抽稀', sampled.length < 60 && sampled.length > 5, `100 → ${sampled.length}`)
  check('采样保留首点', sampled[0].x === 0)
  check('采样保留尾点', sampled[sampled.length - 1].x === 99, `尾点 x=${sampled[sampled.length - 1].x}`)
  check('采样后相邻点满足间隔', sampled.every((p, i) => i === 0 || Math.abs(p.x - sampled[i - 1].x) >= 2.5 - 1e-9))
}
{
  const huge = Array.from({ length: 5000 }, (_, i) => ({ x: i * 10, y: 0 }))
  const capped = S.samplePoints(huge)
  check('点数上限生效（≤2000）', capped.length <= 2000, `${capped.length} 点`)
}

/* ============================ ⑧ 曲线插点 ============================ */
console.log('\n=== ⑧ 曲线插点 ===')
const base = [{ x: 0, y: 0 }, { x: 100, y: 0 }]
{
  // 点在 (30, 20)：投影到线段上应是 (30, 0)，不是中点 (50,0)
  const inserted = S.insertPointOnSegment(base, 0, { x: 30, y: 20 })
  check('插点数量 +1', inserted.length === 3)
  check('★ 插在"点击位置的投影"处（30），不是中点（50）', inserted[1].x === 30, `插在 x=${inserted[1].x}`)
  check('插点后前后顺序正确', inserted[0].x === 0 && inserted[2].x === 100)
  check('原数组未被修改（纯函数）', base.length === 2)
}
check('段索引越界时原样返回', S.insertPointOnSegment(base, 5, { x: 50, y: 0 }).length === 2)
check('插在中部（t≈0.5）', Math.abs(S.insertPointOnSegment(base, 0, { x: 50, y: 99 })[1].x - 50) < 1e-9)

/* ============================ ⑨ 命中 ============================ */
console.log('\n=== ⑨ 命中判断 ===')
check('线段命中', S.hitSegment(base, { x: 50, y: 2 }, 6)?.index === 0)
check('离得太远不命中', S.hitSegment(base, { x: 50, y: 50 }, 6) === null)
check('控制点命中', S.hitControlPoint(base, { x: 1, y: 1 }, 5) === 0)
check('控制点未命中', S.hitControlPoint(base, { x: 50, y: 50 }, 5) === null)
check('几何图形内部命中', S.hitShape({ kind: 'rect', x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50 }))
check('几何图形外部不命中', !S.hitShape({ kind: 'rect', x: 0, y: 0, w: 100, h: 100 }, { x: 150, y: 50 }))
check('线类按距离命中', S.hitShape({ kind: 'line', points: base }, { x: 50, y: 3 }, 6))
check('线类远离不命中', !S.hitShape({ kind: 'line', points: base }, { x: 50, y: 30 }, 6))

/* ============================ ⑩ 构造 ============================ */
console.log('\n=== ⑩ 图形构造 ===')
{
  const r = S.makeBoxShape('a', 'rect', 'blue', { x: 100, y: 100 }, { x: 220, y: 180 })
  check('拖拽出矩形（x/y/w/h 正确）', r.x === 100 && r.y === 100 && r.w === 120 && r.h === 80, JSON.stringify(r))
  const rev = S.makeBoxShape('b', 'rect', 'blue', { x: 220, y: 180 }, { x: 100, y: 100 })
  check('反向拖拽归一到左上角', rev.x === 100 && rev.y === 100, JSON.stringify(rev))
  const click = S.makeBoxShape('c', 'rect', 'blue', { x: 500, y: 500 }, { x: 502, y: 501 })
  check('只点一下 → 用默认尺寸 120×80', click.w === 120 && click.h === 80, `${click.w}×${click.h}`)
  check('只点一下 → 以点击处为中心', click.x === 500 - 60 && click.y === 500 - 40, `x=${click.x} y=${click.y}`)
  const sq = S.makeBoxShape('d', 'rect', 'blue', { x: 0, y: 0 }, { x: 100, y: 40 }, true)
  check('Shift 等比 → 正方形 100×100', sq.w === 100 && sq.h === 100, `${sq.w}×${sq.h}`)
}
{
  const l = S.makeLineShape('e', 'line', 'blue', { x: 0, y: 0 }, { x: 100, y: 0 })
  check('直线构造（2 点）', l !== null && l.points.length === 2 && l.points[1].x === 100)
  check('太短返回 null（误操作）', S.makeLineShape('f', 'line', 'blue', { x: 0, y: 0 }, { x: 2, y: 0 }) === null)
  const snapped = S.makeLineShape('g', 'arrow', 'blue', { x: 0, y: 0 }, { x: 100, y: 12 }, true)
  check('Shift 吸附到水平（dy 归零）', snapped.points[1].y === 0, JSON.stringify(snapped.points[1]))
  const s45 = S.snapTo45({ x: 0, y: 0 }, { x: 100, y: 96 })
  check('45° 吸附', Math.abs(s45.x - s45.y) < 1e-6, JSON.stringify(s45))
}
{
  // 点间距 1（小于采样阈值 2.5）→ 应明显抽稀
  const dense = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0 }))
  const f = S.makeFreeShape('h', 'green', dense)
  check('自由绘制构造成功', f !== null && f.kind === 'free' && f.points.length > 5, f === null ? 'null' : `${f.points.length} 点`)
  check('自由绘制点数已抽稀（间距 1 < 阈值 2.5）', f.points.length < 50, `${f.points.length} < 50`)
  check('太短的自由绘制返回 null', S.makeFreeShape('i', 'green', [{ x: 0, y: 0 }, { x: 1, y: 0 }]) === null)
}

/* ============================ ⑪ 归一化（挡住 AI 写坏数据） ============================ */
console.log('\n=== ⑪ 归一化 ===')
const gen = () => 'gen-id'
check('合法图形通过', S.normalizeShape({ kind: 'rect', color: 'blue', x: 1, y: 2, w: 3, h: 4 }, gen) !== null)
check('中文 kind 被接受', S.normalizeShape({ kind: '三角形' }, gen)?.kind === 'triangle')
check('未知 kind → null（丢弃）', S.normalizeShape({ kind: '星形' }, gen) === null)
check('非对象 → null', S.normalizeShape('rect', gen) === null)
check('缺 id 自动补', S.normalizeShape({ kind: 'rect' }, gen)?.id === 'gen-id')
check('缺 color 默认 default', S.normalizeShape({ kind: 'rect' }, gen)?.color === 'default')
check('几何图形补齐默认尺寸', S.normalizeShape({ kind: 'rect' }, gen)?.w === 120)
check('尺寸为负取绝对值', S.normalizeShape({ kind: 'rect', w: -50, h: -60 }, gen)?.w === 50)
check('尺寸过小提到最小值 8', S.normalizeShape({ kind: 'rect', w: 1, h: 2 }, gen)?.w === 8)
check('线类点数不足 2 → null', S.normalizeShape({ kind: 'line', points: [{ x: 0, y: 0 }] }, gen) === null)
check('线类坐标非数字被过滤', S.normalizeShape({ kind: 'line', points: [{ x: 0, y: 0 }, { x: 'a', y: 1 }, { x: 5, y: 5 }] }, gen)?.points.length === 2)
check('batch: 非数组 → 空', S.normalizeShapes('nope', gen).length === 0)
check('batch: 逐条过滤坏的', S.normalizeShapes([
  { kind: 'rect' }, { kind: '星形' }, { kind: '箭头', points: [{ x: 0, y: 0 }, { x: 9, y: 9 }] }, null
], gen).length === 2)

/* ============================ 汇总 ============================ */
const failed = results.filter((r) => !r.ok)
console.log(`\n=== 汇总 ===\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.n}：${f.d}`)
process.exit(failed.length === 0 ? 0 : 1)
