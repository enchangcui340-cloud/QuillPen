/**
 * 白板重命名不能丢内容（数据丢失护栏）。
 *
 *   node tools/check-rename-safe.mjs
 *
 * 背景（真实事故）：`rename()` 里改名分支原先在 `renameSync` **之后**才调 `readBoard(id)`，
 * 而 `readBoard` 按 `n.fileName` 拼路径 —— 那个字段要到函数末尾才更新。
 * 于是它拿旧文件名去读一个已被搬走的文件 → readFileSync 抛错 → readBoard 的 catch
 * **静默返回空板** → 空板被写进新文件 → 用户的卡片与连线被清空且不可逆。
 * md 分支当时用的是 newAbs，所以只有白板中招。
 *
 * 这个套件把四种改名情形都钉住，防止回归。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:/DSH/test01/quill-dsh'
const work = join(ROOT, '.tmp', 'rename-safe')
rmSync(work, { recursive: true, force: true })
mkdirSync(join(work, 'lib', 'notes'), { recursive: true })
mkdirSync(join(work, 'data'), { recursive: true })
process.env.DSH_QUILL_LIBRARY_ROOT = join(work, 'lib')
process.env.DSH_QUILL_DATA_DIR = join(work, 'data')
process.env.DSH_QUILL_NO_REGISTRY_INHERIT = '1'

const host = await import('file:///' + join(ROOT, 'packages', 'dsh-quill', 'lib', 'host.js').replace(/\\/g, '/'))
const rt = await host.createRuntime({ dataDir: process.env.DSH_QUILL_DATA_DIR, libraryRoot: process.env.DSH_QUILL_LIBRARY_ROOT })

const results = []
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d ? ' -- ' + d : ''}`) }

const NOTES = join(work, 'lib', 'notes')
const FIXTURE = {
  nodes: [
    { id: 'n1', type: 'text', x: 0, y: 0, w: 210, h: 120, text: '卡片一' },
    { id: 'n2', type: 'text', x: 270, y: 0, w: 210, h: 120, text: '卡片二' },
    { id: 'n3', type: 'text', x: 0, y: 300, w: 210, h: 120, text: '卡片三' }
  ],
  edges: [
    { id: 'e1', from: 'n1', to: 'n2', fromSide: 'right', toSide: 'left' },
    { id: 'e2', from: 'n1', to: 'n3', fromSide: 'bottom', toSide: 'top' }
  ],
  shapes: [{ id: 's1', kind: 'rect', color: 'blue', x: -50, y: -50, w: 600, h: 500 }]
}
const counts = (b) => ({ n: b.nodes?.length ?? 0, e: b.edges?.length ?? 0, s: b.shapes?.length ?? 0 })
const expectFull = (b) => counts(b).n === 3 && counts(b).e === 2 && counts(b).s === 1

/** 造一块有内容的白板，返回 { id, file } */
async function seedBoard(title) {
  const created = await rt.invoke('note:create', [{ dir: '', kind: 'whiteboard', title }])
  const id = created?.value?.id
  const file = join(NOTES, title + '.canvas.json')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...raw, ...FIXTURE, title }, null, 2), 'utf8')
  await rt.invoke('board:read', [id])   // 刷新 mtime 缓存
  return { id, file }
}

/* ============================ ① 白板改成一个全新名字 ============================ */
console.log('=== ① 白板改名（内容必须完整保留） ===')
{
  const { id, file } = await seedBoard('旧名字一')
  check('改名前的基线与夹具一致', expectFull((await rt.invoke('board:read', [id]))?.value))
  await rt.invoke('note:rename', [id, '新名字一'])
  const newFile = join(NOTES, '新名字一.canvas.json')
  check('文件确实改名了', !existsSync(file) && existsSync(newFile))
  const disk = JSON.parse(readFileSync(newFile, 'utf8'))
  check('★ 磁盘上新文件内容完整（这是曾经被清空的地方）', expectFull(disk),
    `n=${counts(disk).n} e=${counts(disk).e} s=${counts(disk).s}`)
  check('★ 重新打开内容完整', expectFull((await rt.invoke('board:read', [id]))?.value))
  check('标题已更新', disk.title === '新名字一', disk.title)
}

/* ============================ ② 改成已存在的名字（触发加序号） ============================ */
console.log('\n=== ② 改成重名（会加序号，内容仍要完整） ===')
{
  const a = await seedBoard('撞名')
  const b = await seedBoard('另一个')
  await rt.invoke('note:rename', [b.id, '撞名'])   // 与 a 同名
  const files = ['撞名.canvas.json', '撞名 (2).canvas.json']
  const hit = files.map((f) => join(NOTES, f)).filter((f) => existsSync(f))
  check('重名时生成了带序号的文件', hit.length === 2, hit.map((f) => f.split('\\').pop()).join(', '))
  let allFull = true
  for (const f of hit) {
    const d = JSON.parse(readFileSync(f, 'utf8'))
    if (!expectFull(d)) allFull = false
  }
  check('★ 两个同名文件内容都完整（没被互相清空）', allFull)
  check('被改名那块重新打开也完整', expectFull((await rt.invoke('board:read', [b.id]))?.value))
  void a
}

/* ============================ ③ 改成同一个名字（不该动内容） ============================ */
console.log('\n=== ③ 改成与现在完全相同的名字 ===')
{
  const { id, file } = await seedBoard('不变的名字')
  await rt.invoke('note:rename', [id, '不变的名字'])
  check('文件仍在原处', existsSync(file))
  check('★ 内容完整', expectFull(JSON.parse(readFileSync(file, 'utf8'))))
}

/* ============================ ④ 带非法字符的名字 ============================ */
console.log('\n=== ④ 名字含非法字符（要清洗，内容仍完整） ===')
{
  const { id } = await seedBoard('待清洗')
  await rt.invoke('note:rename', [id, 'a/b:c*d?'])
  check('★ 清洗后内容完整', expectFull((await rt.invoke('board:read', [id]))?.value))
}

/* ============================ ⑤ 移动笔记夹后再改名 ============================ */
console.log('\n=== ⑤ 先移动到子夹、再改名 ===')
{
  const { id } = await seedBoard('要搬家的')
  await rt.invoke('note:mkdir', ['子夹'])
  await rt.invoke('note:move', [id, '子夹'])
  await rt.invoke('note:rename', [id, '搬完改名'])
  const f = join(NOTES, '子夹', '搬完改名.canvas.json')
  check('文件在新夹里', existsSync(f))
  check('★ 移动+改名后内容完整', expectFull(JSON.parse(readFileSync(f, 'utf8'))))
}

/* ============================ ⑥ 对照：md 笔记也不能丢 ============================ */
console.log('\n=== ⑥ 对照组：md 笔记改名 ===')
{
  const md = await rt.invoke('note:create', [{ dir: '', kind: 'md', title: '原笔记' }])
  const mdId = md?.value?.id
  await rt.invoke('note:save', [mdId, '# 标题\n\n这是很重要的正文，改名后必须还在。\n', 0])
  await rt.invoke('note:rename', [mdId, '改过的笔记'])
  const raw = readFileSync(join(NOTES, '改过的笔记.md'), 'utf8')
  check('md 正文仍在', raw.includes('这是很重要的正文'), raw.includes('这是很重要的正文') ? '' : raw.slice(0, 50))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n重命名安全：${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.n}：${f.d}`)
process.exit(failed.length === 0 ? 0 : 1)
