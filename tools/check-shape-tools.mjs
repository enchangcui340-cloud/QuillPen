/**
 * 阶段 6 验证：AI 能不能画图形。
 *
 *   node tools/check-shape-tools.mjs
 *
 * 验的事：
 *   ① board_read 能看到已有图形（AI 看不见就会把卡片排到图形上）
 *   ② board_edit 的 add_shape 能画 8 种图形，中文别名可用
 *   ③ update_shape 能改位置与颜色（AI 允许改色）
 *   ④ remove_shape 能删
 *   ⑤ 校验：未知 kind / 未知颜色 / 点数不足 / 坐标非法都要**报错**而不是静默写坏
 *   ⑥ ★ 最要紧的：AI 改完白板后，**用户已有的图形不会消失**
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:/DSH/test01/quill-dsh'
const PKG = join(ROOT, 'packages', 'dsh-quill')

const results = []
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d ? ' -- ' + d : ''}`) }

const work = join(ROOT, '.tmp', 'shape-tools')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
// 环境变量必须在 import 工具层**之前**设好（决定它用哪个库）
process.env.DSH_QUILL_DATA_DIR = join(work, 'data')
process.env.DSH_QUILL_LIBRARY_ROOT = join(work, 'lib')
process.env.DSH_QUILL_NO_REGISTRY_INHERIT = '1'
// 库目录得先存在（工具层会直接用它）
mkdirSync(join(work, 'lib', 'notes'), { recursive: true })
mkdirSync(join(work, 'data'), { recursive: true })

/* ---------- 收集工具定义 ----------
   工具层（tools.js / tools-write.js）是**独立模块**，靠 `ctx.tools.register` 上报定义，
   运行时通过内置 runtime 走宿主通道。所以：
     ① 先设好 DSH_QUILL_* 环境变量（决定用哪个库），
     ② 再用假 ctx 收集定义，
     ③ 用 `def.execute(args, {signal})` 调用（与 tools/smoke-tools.mjs 同一套路）。
   注意：这套工具跑的是**内置 runtime**，不需要 createRuntime（那是宿主进程用的）。 */
const definitions = []
const fakeCtx = { tools: { register: (d) => { definitions.push(d); return () => undefined } }, logger: { info() {}, warn() {}, error() {} } }
const toolsMod = await import('file:///' + join(PKG, 'lib', 'tools.js').replace(/\\/g, '/'))
toolsMod.apply(fakeCtx)

const byName = new Map(definitions.map((d) => [d.name, d]))
check('工具层已注册', byName.size > 0, `${byName.size} 个工具`)
check('有 board_read', byName.has('board_read'))
check('有 board_edit', byName.has('board_edit'))

const callTool = async (name, args) => {
  const def = byName.get(name)
  if (def === undefined) throw new Error('没有工具 ' + name)
  // 用 execute（工具类会自己跑 validate）。工具抛错就原样冒出来，负向测试靠它。
  return await def.execute(args, { signal: undefined })
}

/* ---------- 造一块白板 ---------- */
const created = await callTool('board_create', { title: 'AI 画图测试' })
const boardId = created?.data?.id ?? created?.data?.note?.id
check('白板已创建', typeof boardId === 'string' && boardId !== '', `${String(boardId)} | ${created.summary ?? ''}`)

/* ============================ ① add_shape：8 种 + 中文别名 ============================ */
console.log('\n=== ① add_shape：8 种图形 + 中文别名 ===')
{
  const r = await callTool('board_edit', {
    id: boardId,
    ops: [
      { op: 'add_shape', kind: '矩形', color: '蓝色', x: 0, y: 0, w: 160, h: 90 },
      { op: 'add_shape', kind: '椭圆', color: '粉色', x: 200, y: 0, w: 120, h: 120 },
      { op: 'add_shape', kind: '三角形', color: '绿色', x: 400, y: 0, w: 140, h: 100 },
      { op: 'add_shape', kind: '菱形', color: '黄色', x: 600, y: 0, w: 140, h: 100 },
      { op: 'add_shape', kind: '直线', color: '紫色', points: [{ x: 0, y: 200 }, { x: 300, y: 260 }] },
      { op: 'add_shape', kind: '箭头', points: [{ x: 0, y: 300 }, { x: 300, y: 360 }] },
      { op: 'add_shape', kind: '曲线', points: [{ x: 0, y: 400 }, { x: 150, y: 460 }, { x: 320, y: 410 }] },
      { op: 'add_shape', kind: '涂鸦', points: [{ x: 0, y: 600 }, { x: 60, y: 620 }, { x: 120, y: 590 }] }
    ]
  })
  check('一次加 8 个图形成功', r.ok === true, r.summary ?? r.error)
  check('返回里图形数 = 8', r.data?.shapes === 8, String(r.data?.shapes))
}
{
  const read = await callTool('board_read', { id: boardId })
  check('board_read 能看到 8 个图形', read.data?.shapes?.length === 8, `${read.data?.shapes?.length}`)
  check('board_read 的文本里列出图形（含 id 与种类）',
    /矩形/.test(read.text) === false && /\[rect\]/.test(read.text) && /\[arrow\]/.test(read.text),
    read.text.split('\n').filter((l) => l.includes('[')).slice(-3).join(' | '))
  check('board_read 报告图形数量', read.summary.includes('8 个图形'), read.summary)
  const kinds = (read.data.shapes ?? []).map((s) => s.kind).sort().join(',')
  check('8 种种类齐全', kinds === 'arrow,curve,diamond,ellipse,free,line,rect,triangle', kinds)
  const colors = (read.data.shapes ?? []).map((s) => s.color)
  check('中文颜色别名被正确解析', colors.includes('blue') && colors.includes('pink') && colors.includes('purple'), colors.join(','))
}

/* ============================ ② 颜色默认值与 hex ============================ */
console.log('\n=== ② 颜色处理 ===')
{
  await callTool('board_edit', { id: boardId, ops: [{ op: 'add_shape', kind: 'rect', x: 900, y: 0, w: 100, h: 60 }] })
  let read = await callTool('board_read', { id: boardId })
  const noColor = read.data.shapes.find((s) => s.x === 900)
  check('不给颜色时默认 default', noColor?.color === 'default', noColor?.color)

  await callTool('board_edit', { id: boardId, ops: [{ op: 'add_shape', kind: 'rect', color: '#FF8800', x: 1000, y: 0, w: 100, h: 60 }] })
  read = await callTool('board_read', { id: boardId })
  const hex = read.data.shapes.find((s) => s.x === 1000)
  check('允许自定义 hex 颜色', hex?.color === '#ff8800', hex?.color)
}

/* ============================ ③ update_shape（含改色） ============================ */
console.log('\n=== ③ update_shape：改位置与颜色 ===')
{
  const read0 = await callTool('board_read', { id: boardId })
  const target = read0.data.shapes.find((s) => s.kind === 'rect' && s.x === 0)
  await callTool('board_edit', {
    id: boardId,
    ops: [{ op: 'update_shape', id: target.id, x: -50, y: -30, color: '红色'.replace('红色', '黄色') }]
  })
  const read1 = await callTool('board_read', { id: boardId })
  const after = read1.data.shapes.find((s) => s.id === target.id)
  check('位置已改', after?.x === -50 && after?.y === -30, `x=${after?.x} y=${after?.y}`)
  check('★ AI 可以改颜色（你确认过允许）', after?.color === 'yellow', after?.color)
  check('宽高未被误改（只改指定字段）', after?.w === 160 && after?.h === 90, `${after?.w}×${after?.h}`)
}

/* ============================ ④ from/to 简写 ============================ */
console.log('\n=== ④ 线类可用 from/to 简写 ===')
{
  const r = await callTool('board_edit', {
    id: boardId,
    ops: [{ op: 'add_shape', kind: 'arrow', from: [10, 10], to: [210, 110] }]
  })
  check('from/to 简写可用', r.ok === true, r.summary ?? r.error)
  const read = await callTool('board_read', { id: boardId })
  const arrow = read.data.shapes.filter((s) => s.kind === 'arrow').find((s) => s.points?.[0]?.x === 10)
  check('点数正确（2 点）', arrow?.points?.length === 2, JSON.stringify(arrow?.points))
}

/* ============================ ⑤ remove_shape ============================ */
console.log('\n=== ⑤ remove_shape ===')
{
  const read0 = await callTool('board_read', { id: boardId })
  const before = read0.data.shapes.length
  const victim = read0.data.shapes[0]
  const r = await callTool('board_edit', { id: boardId, ops: [{ op: 'remove_shape', id: victim.id }] })
  check('删除成功', r.ok === true, r.summary ?? r.error)
  const read1 = await callTool('board_read', { id: boardId })
  check('图形数 -1', read1.data.shapes.length === before - 1, `${before} → ${read1.data.shapes.length}`)
  check('删的是指定那个', !read1.data.shapes.some((s) => s.id === victim.id))
}

/* ============================ ⑥ 校验：写坏的数据要报错 ============================ */
console.log('\n=== ⑥ 校验（挡住 AI 写坏文件） ===')
const expectFail = async (name, ops, keyword) => {
  try {
    await callTool('board_edit', { id: boardId, ops })
    check(name, false, '本该报错却成功了')
  } catch (e) {
    const msg = String(e.message ?? e)
    check(name, keyword === undefined || msg.includes(keyword), msg.slice(0, 90))
  }
}
await expectFail('未知图形种类要报错', [{ op: 'add_shape', kind: '五角星' }], '不认识的图形种类')
await expectFail('未知颜色要报错', [{ op: 'add_shape', kind: 'rect', color: '土豪金' }], '不认识的图形颜色')
await expectFail('线类点数不足要报错', [{ op: 'add_shape', kind: 'line', points: [{ x: 0, y: 0 }] }], '至少需要 2 个点')
await expectFail('坐标非数字要报错', [{ op: 'add_shape', kind: 'line', points: [{ x: 'a', y: 0 }, { x: 1, y: 1 }] }], '坐标必须是数字')
await expectFail('改不存在的图形要报错', [{ op: 'update_shape', id: 'no_such_shape', x: 1 }], '没有图形')
await expectFail('删不存在的图形要报错', [{ op: 'remove_shape', id: 'no_such_shape' }], '没有图形')
await expectFail('未知 op 要报错', [{ op: 'draw_circle' }], '不认识的 op')
{
  // 坐标超范围要被 clamp（不是报错，但也不能写出去）
  const r = await callTool('board_edit', { id: boardId, ops: [{ op: 'add_shape', kind: 'rect', x: 999999, y: -999999, w: 100, h: 100 }] })
  const read = await callTool('board_read', { id: boardId })
  const far = read.data.shapes.find((s) => s.w === 100 && s.h === 100 && Math.abs(s.x) > 10000)
  check('超范围坐标被 clamp 到世界内', far === undefined ? false : (far.x <= 21000 && far.y >= -14000),
    far === undefined ? '没找到该图形' : `x=${far.x} y=${far.y}`)
}

/* ============================ ⑦ ★ 最要紧：用户画的图形不会丢 ============================ */
console.log('\n=== ⑦ ★ AI 改白板后，用户已有的图形不能消失 ===')
{
  const read0 = await callTool('board_read', { id: boardId })
  const before = read0.data.shapes.length
  // 模拟 AI 只加卡片、不动图形
  await callTool('board_edit', {
    id: boardId,
    ops: [
      { op: 'add_node', type: 'text', text: 'AI 加的卡片', x: -600, y: -600 },
      { op: 'set_title', title: 'AI 改过标题' }
    ]
  })
  const read1 = await callTool('board_read', { id: boardId })
  check('★ 只加卡片时图形一个不少', read1.data.shapes.length === before, `${before} → ${read1.data.shapes.length}`)
  check('标题已改', read1.data.title === 'AI 改过标题', read1.data.title)
  // 再从磁盘直接读，确认不是内存里的假象
  const idx = JSON.parse(readFileSync(join(work, 'lib', 'notes', 'AI 画图测试.canvas.json'), 'utf8'))
  check('★ 磁盘文件里 shapes 也在', Array.isArray(idx.shapes) && idx.shapes.length === before, `磁盘 ${idx.shapes?.length}`)
}

/* ============================ ⑧ 旧白板（无 shapes）兼容 ============================ */
console.log('\n=== ⑧ 旧白板没有 shapes 字段时也能正常改 ===')
{
  /*
   * 做法：不手工改磁盘（那样会让**索引里的 mtime 缓存**与磁盘不一致，
   * saveBoard 会（正确地）报「保存冲突」——那是防覆盖别人改动的保护，不是 bug）。
   * 这里直接问：一块刚建、从来没人画过图形的白板，add_shape 能不能正常工作。
   * 它的 canvas.json 本来就没有 shapes 字段，等价于"旧白板"。
   */
  const old = await callTool('board_create', { title: '老白板' })
  const oldId = old?.data?.id ?? old?.data?.note?.id
  const oldFile = join(work, 'lib', 'notes', '老白板.canvas.json')
  const before = JSON.parse(readFileSync(oldFile, 'utf8'))
  check('新白板本来就没有 shapes 字段（等价旧文件）', before.shapes === undefined, JSON.stringify(before.shapes))

  const r = await callTool('board_edit', { id: oldId, ops: [{ op: 'add_shape', kind: 'rect', x: 0, y: 0, w: 100, h: 60 }] })
  check('旧白板上加图形成功（无 shapes 字段也不报错）', r.ok === true, r.summary ?? r.error)
  const read = await callTool('board_read', { id: oldId })
  check('读回来有 1 个图形', read.data.shapes?.length === 1, String(read.data.shapes?.length))
  const onDisk = JSON.parse(readFileSync(oldFile, 'utf8'))
  check('磁盘上已补出 shapes 字段', Array.isArray(onDisk.shapes) && onDisk.shapes.length === 1, `磁盘 ${onDisk.shapes?.length}`)
}

/* ============================ ⑨ 连线取边：算好写死 + 永不改变 ============================ */
console.log('\n=== ⑨ 连线：创建时定死边，之后不再变 ===')
{
  const b = await callTool('board_create', { title: '连线测试' })
  const bid = b?.data?.id ?? b?.data?.note?.id
  const bfile = join(work, 'lib', 'notes', '连线测试.canvas.json')

  // 三张卡：A 在原点、B 在正右、C 在右下（两种需要不同取边的相对位置）
  await callTool('board_edit', {
    id: bid,
    ops: [
      { op: 'add_node', id: 'A', type: 'text', x: 0, y: 0, w: 210, h: 120, text: 'A' },
      { op: 'add_node', id: 'B', type: 'text', x: 400, y: 0, w: 210, h: 120, text: 'B' },
      { op: 'add_node', id: 'C', type: 'text', x: 0, y: 300, w: 210, h: 120, text: 'C' }
    ]
  })

  // ① AI 不给 side → 工具必须自己算好写进去
  const r1 = await callTool('board_edit', { id: bid, ops: [{ op: 'add_edge', from: 'A', to: 'B' }] })
  check('不给 side 也能加连线', r1.ok === true, r1.summary ?? r1.error)
  let disk = JSON.parse(readFileSync(bfile, 'utf8'))
  let e = disk.edges.find((x) => x.from === 'A' && x.to === 'B')
  check('★ A→B（正右）自动存成 right → left', e?.fromSide === 'right' && e?.toSide === 'left',
    `${e?.fromSide} → ${e?.toSide}`)

  await callTool('board_edit', { id: bid, ops: [{ op: 'add_edge', from: 'A', to: 'C' }] })
  disk = JSON.parse(readFileSync(bfile, 'utf8'))
  e = disk.edges.find((x) => x.from === 'A' && x.to === 'C')
  check('★ A→C（正下）自动存成 bottom → top', e?.fromSide === 'bottom' && e?.toSide === 'top',
    `${e?.fromSide} → ${e?.toSide}`)

  // ② 冻结验证：把 C 挪到完全不同的方位，重新读取 —— side 必须一字不变
  const sideBefore = { from: e.fromSide, to: e.toSide }
  await callTool('board_edit', { id: bid, ops: [{ op: 'update_node', id: 'C', x: -600, y: -500 }] })
  const readAfter = await callTool('board_read', { id: bid })
  const eAfter = readAfter.data.edges.find((x) => x.from === 'A' && x.to === 'C')
  check('★★ 移动卡片后连线的边**完全不变**（这是用户最在意的）',
    eAfter?.fromSide === sideBefore.from && eAfter?.toSide === sideBefore.to,
    `${sideBefore.from}→${sideBefore.to} 变成了 ${eAfter?.fromSide}→${eAfter?.toSide}`)
  disk = JSON.parse(readFileSync(bfile, 'utf8'))
  const eDisk = disk.edges.find((x) => x.from === 'A' && x.to === 'C')
  check('★★ 磁盘上也确实没变（不是内存假象）',
    eDisk?.fromSide === sideBefore.from && eDisk?.toSide === sideBefore.to,
    `${eDisk?.fromSide} → ${eDisk?.toSide}`)

  // ③ AI 显式指定的 side 要被尊重（并原样存盘）
  await callTool('board_edit', { id: bid, ops: [{ op: 'add_edge', from: 'B', to: 'C', fromSide: 'left', toSide: 'bottom' }] })
  disk = JSON.parse(readFileSync(bfile, 'utf8'))
  const eBC = disk.edges.find((x) => x.from === 'B' && x.to === 'C')
  check('AI 显式给的 side 被原样采用', eBC?.fromSide === 'left' && eBC?.toSide === 'bottom',
    `${eBC?.fromSide} → ${eBC?.toSide}`)

  // ④ 非法 side 必须报错（以前是静默 String() 存进去，渲染时画错很难查）
  for (const badVal of ['右', 'RIGHT', 'east', 'up']) {
    let threw = false
    let msg = ''
    try {
      await callTool('board_edit', { id: bid, ops: [{ op: 'add_edge', from: 'A', to: 'B', fromSide: badVal }] })
    } catch (err) { threw = true; msg = String(err.message ?? err) }
    check(`非法 fromSide「${badVal}」被拒绝`, threw, threw ? msg.slice(0, 60) : '本该报错却成功了')
  }

  // ⑤ 改动记录里回显最终定下的边（便于 AI 自查）
  const r5 = await callTool('board_edit', { id: bid, ops: [{ op: 'add_edge', from: 'C', to: 'B' }] })
  check('改动记录里回显了取边结果', /（(top|right|bottom|left) → (top|right|bottom|left)）/.test(r5.text ?? ''),
    (r5.text ?? '').split('\n').filter((l) => l.includes('连线')).pop() ?? '(无)')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n阶段 6：${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.n}：${f.d}`)
process.exit(failed.length === 0 ? 0 : 1)
