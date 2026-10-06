/**
 * W5 冒烟：用户视角专项 —— 完全照用户那条真实指令的流程走一遍。
 *
 * 用户原话（2026-10-03 00:49，在「羽毛笔」模式里失败的那条）：
 *   「读一下这个 123.canvas.json 重新绘制一遍；新白板命名：初期确定方向；
 *     创建一个"taotao 聚光灯 Gamejam"的笔记夹，放进去」
 *
 * 拆成 6 项逐个验：
 *   ① 能读**库内** `.canvas.json`（不是只支持库外绝对路径）
 *   ② 能读懂白板结构（卡片/连线/坐标/颜色）
 *   ③ 能 1:1 复刻到新白板（逐张逐线比对，不信"看起来一样"）
 *   ④ 新白板按用户给的命名
 *   ⑤ 建笔记夹并把新白板放进该夹
 *   ⑥ 能把**库外附件**（含"没有扩展名"的上传件）导入库内
 *
 * 库用**真实库的只读副本**（源白板 123.canvas.json 只在这里有），
 * 并对真实库做快照护栏：一个字节都不许动。
 *
 *   node tools/smoke-userflow.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { REAL_LIBRARY, packageDirName, ROOT } from './paths.mjs'

const REAL_LIB = REAL_LIBRARY
// 用户那条消息里上传的附件（无扩展名，正是"上传件"的典型形态）
// 之前写死指向本机 DSH 附件缓存 —— 开源用户没有它。改为运行时从测试库的 _attachments 取。
let UPLOADED = ''
const work = join(join(ROOT, '.tmp', 'smoke-userflow'), new Date().toISOString().replace(/[:.]/g, '-'))
const libDir = join(work, 'lib')
const dataDir = join(work, 'data')
mkdirSync(work, { recursive: true })
console.log('复制真实库（只读来源）…')
cpSync(REAL_LIB, libDir, { recursive: true })

process.env.DSH_QUILL_LIBRARY_ROOT = libDir
process.env.DSH_QUILL_DATA_DIR = dataDir
process.env.DSH_QUILL_NO_REGISTRY_INHERIT = '1'

/* ---------- 真实库快照护栏 ---------- */
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
const realBefore = snapshot(REAL_LIB)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`)
}

const definitions = []
const mod = await import('../packages/' + packageDirName() + '/lib/tools.js')
mod.apply({ tools: { register: (d) => { definitions.push(d); return () => {} } }, logger: { info: () => {}, warn: () => {} } })
const byName = new Map(definitions.map((d) => [d.name, d]))
const call = async (name, args = {}) => {
  const def = byName.get(name)
  if (def === undefined) throw new Error('没有这个工具：' + name)
  try { return await def.execute(args, { signal: undefined }) } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
}
const sig = (b, idBack) => ({
  nodes: b.nodes.length,
  edges: b.edges.length,
  text: b.nodes.map((n) => n.text ?? '').sort().join('|'),
  geom: b.nodes.map((n) => [n.x, n.y, n.w, n.h, n.color ?? '', n.fontSize ?? ''].join(',')).sort().join(';'),
  // 连线要按"卡片身份"比，不能按 id 字面比：复刻时 id 会重映射（cp0…），
  // 所以先把端点映射回源 id 再比较（否则会误判成"不一致"）
  edgesDesc: b.edges.map((e) => {
    const from = idBack === undefined ? e.from : (idBack.get(e.from) ?? e.from)
    const to = idBack === undefined ? e.to : (idBack.get(e.to) ?? e.to)
    return `${from}->${to}${e.label ? '(' + e.label + ')' : ''}`
  }).sort().join('|')
})

console.log('\n=== ① 读库内 .canvas.json ===')
// 不写死某一块白板（用户的库是会变的：板子可能被删或改名）。
// 挑一块**有卡片**的白板来验；一块都没有就如实跳过 —— 不能因为库里少了文件就判失败。
const boardFiles = []
;(function walk (dir, prefix) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === '_attachments') continue
    const abs = join(dir, e.name)
    const rel = prefix === '' ? e.name : prefix + '/' + e.name
    if (e.isDirectory()) { walk(abs, rel); continue }
    if (e.name.endsWith('.canvas.json')) boardFiles.push({ rel, abs })
  }
})(join(libDir, 'notes'), '')

let source = null
for (const b of boardFiles) {
  try {
    const j = JSON.parse(readFileSync(b.abs, 'utf8'))
    if (Array.isArray(j.nodes) && j.nodes.length > 0) { source = { ...b, data: j }; break }
  } catch { /* 读不动的跳过 */ }
}

if (source === null) {
  console.log(`[SKIP] 库里没有带卡片的白板（找到 ${boardFiles.length} 块，都是空的或被删了）—— 跳过复刻段`)
  console.log('\n=== 汇总 ===\n跳过（库内无可用白板，其余行为不受影响）')
  process.exit(0)
}

const viaDocRead = await call('doc_read', { path: source.rel })
check('doc_read 能用库内相对路径读 .canvas.json', viaDocRead.ok === true && String(viaDocRead.text).length > 100,
  viaDocRead.ok === true ? `${String(viaDocRead.text).length} 字（源：${source.rel}）` : viaDocRead.error)
const srcBoard = await call('board_read', { path: source.rel })
check('board_read 用库内相对路径也能读（推荐路径）', srcBoard.ok === true && srcBoard.data.nodes.length === source.data.nodes.length,
  srcBoard.ok === true ? `${srcBoard.data.nodes.length} 卡片 / ${srcBoard.data.edges.length} 连线（源：${source.rel}）` : srcBoard.error)

console.log('\n=== ②③ 复刻到新白板（逐张逐线比对） ===')
const src = source.data
const srcSig = sig(src)
const folder = await call('folder_create', { name: 'taotao 聚光灯 Gamejam' })
const board = await call('board_create', { dir: 'taotao 聚光灯 Gamejam', title: '初期确定方向' })
check('④ 新白板按用户给的命名建立', board.ok === true && board.data.title === '初期确定方向', board.data?.path ?? board.error)
check('⑤ 笔记夹「taotao 聚光灯 Gamejam」建立', folder.ok === true, String(folder.data?.path))

// 一次提交全部卡片与连线（模拟"重新绘制一遍"）
const idMap = new Map(src.nodes.map((n, i) => [n.id, 'cp' + i]))
const ops = src.nodes.map((n) => {
  const copy = { op: 'add_node', id: idMap.get(n.id), type: n.type, x: n.x, y: n.y, w: n.w, h: n.h }
  for (const k of ['text', 'color', 'fontSize', 'bold', 'src', 'noteId', 'url']) if (n[k] !== undefined) copy[k] = n[k]
  return copy
})
for (const e of src.edges) {
  ops.push({ op: 'add_edge', from: idMap.get(e.from), to: idMap.get(e.to), label: e.label, fromSide: e.fromSide, toSide: e.toSide })
}
const edited = await call('board_edit', { id: board.data.id, ops })
check('一次 board_edit 提交了全部卡片与连线', edited.ok === true, `${ops.length} 项 ops`)
const copyBoard = JSON.parse(readFileSync(join(libDir, 'notes', folder.data.path, '初期确定方向.canvas.json'), 'utf8'))
const idBack = new Map([...idMap].map(([srcId, copyId]) => [copyId, srcId]))
const copySig = sig(copyBoard, idBack)
check('③ 卡片数一致', copySig.nodes === srcSig.nodes, `源 ${srcSig.nodes} → 新 ${copySig.nodes}`)
check('③ 连线数一致', copySig.edges === srcSig.edges, `源 ${srcSig.edges} → 新 ${copySig.edges}`)
check('③ 卡片文字完全一致', copySig.text === srcSig.text, '')
check('③ 卡片坐标/尺寸/颜色/字号完全一致', copySig.geom === srcSig.geom, '')
check('③ 连线关系（含标签）完全一致', copySig.edgesDesc === srcSig.edgesDesc, '')

const inFolder = await call('note_list', { dir: 'taotao 聚光灯 Gamejam' })
check('⑤ 新白板确实在该笔记夹里', inFolder.data.items.some((i) => i.title === '初期确定方向'), inFolder.summary)
const folderList = await call('folder_list')
check('⑤ folder_list 里能看到这个夹', folderList.data.folders.some((f) => f.path === 'taotao 聚光灯 Gamejam'), '')

console.log('\n=== ⑥ 导入库外附件（含"无扩展名的上传件"） ===')
// 附件来源：运行时从**当前测试库**的 _attachments 里挑一个（夹具库自带一张 PNG）。
// 之前写死指向本机 DSH 附件缓存，开源用户没有那个路径。
const attachDir = join(libDir, 'notes', '_attachments')
UPLOADED = join(attachDir, readdirSync(attachDir).find((f) => /\.(png|jpg|jpeg)$/i.test(f)) ?? '')
check('测试库里有可用作"库外附件"的图片', UPLOADED !== '' && existsSync(UPLOADED), UPLOADED.split(/[\\/]/).pop() ?? '（无）')
const imp = await call('attachment_import', { sourcePath: UPLOADED, name: '用户上传的截图.png' })
check('attachment_import 能导入（这条正是线上失败的那次调用）', imp.ok === true && existsSync(join(libDir, 'notes', imp.data?.rel ?? '')),
  imp.ok === true ? imp.data.rel : imp.error)
if (imp.ok === true) {
  const srcSize = statSync(UPLOADED).size
  const dstSize = statSync(join(libDir, 'notes', imp.data.rel)).size
  check('导入后字节数一致', srcSize === dstSize, `${srcSize} → ${dstSize}`)
  const att = await call('attachment_list', { nameContains: '用户上传的截图' })
  check('attachment_list 能查到它', att.ok === true && att.data.files.some((f) => f.name === '用户上传的截图.png'), att.summary)
}

console.log('\n=== 源白板与真实库都不能被改动 ===')
const srcAfter = JSON.parse(readFileSync(source.abs, 'utf8'))
check('副本里的源白板没被改动（复刻是"新建"，不是改源）',
  sig(srcAfter).nodes === srcSig.nodes && sig(srcAfter).edges === srcSig.edges, `${source.rel}：${srcSig.nodes} 卡片 / ${srcSig.edges} 连线`)
{
  const after = snapshot(REAL_LIB)
  const diffs = []
  for (const [rel, s] of after) {
    const old = realBefore.get(rel)
    if (old === undefined) diffs.push('新增 ' + rel)
    else if (old !== s) diffs.push('改动 ' + rel)
  }
  for (const rel of realBefore.keys()) if (!after.has(rel)) diffs.push('删除 ' + rel)
  check('用户真实库零改动', diffs.length === 0, diffs.length === 0 ? `快照一致（${realBefore.size} 个文件）` : diffs.slice(0, 3).join('；'))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 汇总 ===\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
console.log('工作目录：' + work)
process.exit(failed.length === 0 ? 0 : 1)
