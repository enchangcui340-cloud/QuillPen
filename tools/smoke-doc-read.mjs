/**
 * P4 冒烟：文档保真读取（doc_read）。
 *
 * 重点验证"**纯图片 PDF** 也能读"：
 *   · 逐页渲染成 PNG 落到库内 `_attachments/`；
 *   · 页图**真的含内容**（做像素校验：白底之外要有墨迹、要有那个蓝色圆圈）——
 *     否则"渲染出来了"可能只是几张白纸；
 *   · 重复读不重复生成（按内容哈希命名）；
 *   · Office（docx/xlsx）抽文本、图片给库内路径。
 *
 * 夹具由 tools/make-doc-fixtures.py 生成（扫描件/文字版 PDF、docx、xlsx、png）。
 * 全程对用户真实库做快照比对。
 *
 *   node tools/smoke-doc-read.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT, LIBRARY_SNAPSHOT, REAL_LIBRARY, packageDirName } from './paths.mjs'

const SRC_LIB = LIBRARY_SNAPSHOT
/**
 * 造 .docx 测试夹具用的 Python。
 * **不写死本机路径**：按顺序找（环境变量 → PATH 里的 python/py → 常见安装位置），
 * 找不到就跳过"需要造 .docx"的那几步（其余断言照跑）。
 */
const PYTHON = (() => {
  const cands = [
    process.env.DSH_TEST_PYTHON,
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe') : undefined,
    join(process.env.USERPROFILE ?? '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python', 'python3', 'py'
  ].filter((p) => typeof p === 'string' && p !== '')
  for (const c of cands) {
    if (c.includes('/') || c.includes('\\')) { if (existsSync(c)) return c; continue }
    try { execFileSync(c, ['-c', 'print(1)'], { stdio: 'ignore', timeout: 15000 }); return c } catch { /* 试下一个 */ }
  }
  return undefined
})()
const work = join(join(ROOT, '.tmp', 'smoke-doc-read'), new Date().toISOString().replace(/[:.]/g, '-'))
const libDir = join(work, 'lib')
const dataDir = join(work, 'data')
const fixtures = join(work, 'fixtures')
mkdirSync(work, { recursive: true })
mkdirSync(fixtures, { recursive: true })
cpSync(SRC_LIB, libDir, { recursive: true })

// 现场生成夹具（可复现；不依赖仓库里存二进制）
console.log('生成夹具…')
execFileSync(PYTHON, [join(join(ROOT, 'tools/make-doc-fixtures.py')), fixtures], { stdio: 'ignore' })
const SCAN_PDF = join(fixtures, '扫描件.pdf')
const TEXT_PDF = join(fixtures, '文字版.pdf')
const DOCX = join(fixtures, '报告.docx')
const XLSX = join(fixtures, '表格.xlsx')
const PNG = join(fixtures, '图.png')

process.env.DSH_QUILL_LIBRARY_ROOT = libDir
process.env.DSH_QUILL_DATA_DIR = dataDir
process.env.DSH_QUILL_NO_REGISTRY_INHERIT = '1'

/* ---------- 真实数据护栏 ---------- */
const REAL = REAL_LIBRARY
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
const realBefore = snapshot(REAL)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`)
}

/* ---------- 收集工具并调用 ---------- */
const definitions = []
const mod = await import('../packages/' + packageDirName() + '/lib/tools.js')
mod.apply({ tools: { register: (d) => { definitions.push(d); return () => {} } }, logger: { info: () => {} } })
const byName = new Map(definitions.map((d) => [d.name, d]))
const call = async (name, args = {}) => {
  const def = byName.get(name)
  if (def === undefined) throw new Error('没有这个工具：' + name)
  try {
    return await def.execute(args, { signal: undefined })
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}
const attDir = join(libDir, 'notes', '_attachments')
const attCount = () => (existsSync(attDir) ? readdirSync(attDir).length : 0)

console.log(`\n=== 工具注册（共 ${definitions.length} 个） ===`)
check('doc_read 已注册', byName.has('doc_read'))
check('工具数量 = 42（只读/系统 14 + 写入 28）', definitions.length === 42, `实际 ${definitions.length}`)

/* ---------- 1. 纯图片 PDF：逐页渲染 ---------- */
console.log('\n=== 纯图片 PDF（扫描件） ===')
const before = attCount()
const pdf = await call('doc_read', { path: SCAN_PDF })
check('doc_read 识别为 PDF 并读到页数', pdf.ok === true && pdf.data.kind === 'pdf' && pdf.data.totalPages === 3,
  pdf.ok === true ? `${pdf.data.totalPages} 页` : pdf.error)
check('3 页都渲染成了图片', pdf.ok === true && pdf.data.pages.length === 3, pdf.ok === true ? pdf.data.pages.map((p) => p.rel).join(', ') : '')
const pageFilesOk = pdf.ok === true && pdf.data.pages.every((p) => existsSync(join(libDir, 'notes', p.rel)) && statSync(join(libDir, 'notes', p.rel)).size > 20000)
check('页图都真的写进了 _attachments（每张 >20KB）', pageFilesOk,
  pdf.ok === true ? pdf.data.pages.map((p) => `${p.page}:${(p.bytes / 1024).toFixed(0)}KB`).join(' ') : '')
check('纯图片 PDF 的文本层为空（证明只能靠渲染）', pdf.ok === true && pdf.data.pages.every((p) => p.chars === 0), pdf.ok === true ? `文本层字数 ${pdf.data.chars}` : '')
check('提示里说明了"无文本层，请用读图能力"', pdf.ok === true && String(pdf.text).includes('无文本层'), '')
check('附件目录新增了 3 个文件', attCount() === before + 3, `${before} → ${attCount()}`)

/* ---------- 2. 像素校验：页图不是白纸 ---------- */
console.log('\n=== 页图像素校验（不是白纸） ===')
{
  const require = createRequire(join(ROOT, 'packages/' + packageDirName() + '/package.json'))
  const { loadImage, createCanvas } = require('@napi-rs/canvas')
  const rel = pdf.data.pages[0].rel
  const img = await loadImage(join(libDir, 'notes', rel))
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const { data } = ctx.getImageData(0, 0, img.width, img.height)
  let ink = 0
  let blue = 0
  const total = img.width * img.height
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    if (r < 200 || g < 200 || b < 200) ink++
    if (b > r + 20 && b > 120) blue++
  }
  check('页图有足够墨迹（不是空白页）', ink / total > 0.02, `墨迹像素占比 ${(ink / total * 100).toFixed(1)}%`)
  check('页图里画的那个蓝色圆圈确实被渲染出来了', blue > 500, `蓝色像素 ${blue} 个`)
  check('页图尺寸达到渲染倍率（scale=2 → 宽度 >1000）', img.width > 1000, `${img.width}×${img.height}`)
}

/* ---------- 3. 重复读不重复生成 ---------- */
console.log('\n=== 重复读（幂等） ===')
const again = await call('doc_read', { path: SCAN_PDF })
check('重复读得到同样的页图路径', again.ok === true && again.data.pages.map((p) => p.rel).join() === pdf.data.pages.map((p) => p.rel).join(), '')
check('重复读没有再新增附件', attCount() === before + 3, `仍是 ${attCount()} 个`)

/* ---------- 4. 只读指定页 ---------- */
const onlyPage2 = await call('doc_read', { path: SCAN_PDF, pages: [2] })
check('pages 参数只渲染指定页', onlyPage2.ok === true && onlyPage2.data.pages.length === 1 && onlyPage2.data.pages[0].page === 2,
  onlyPage2.ok === true ? `第 ${onlyPage2.data.pages[0].page} 页` : onlyPage2.error)

/* ---------- 5. 有文本层的 PDF ---------- */
console.log('\n=== 有文本层的 PDF ===')
if (existsSync(TEXT_PDF)) {
  const tp = await call('doc_read', { path: TEXT_PDF })
  check('文字版 PDF 能抽到文本层', tp.ok === true && String(tp.data.chars) > 0 && String(tp.data.rel ?? '') === '',
    tp.ok === true ? `文本 ${tp.data.chars} 字` : tp.error)
  const txt = (await call('doc_read', { path: TEXT_PDF }))
  check('文本层内容包含关键字', txt.ok === true && String(txt.text).includes('TEXT-LAYER-2029'), String(txt.text).split('\n').slice(0, 3).join(' / ').slice(0, 100))
} else {
  check('文字版 PDF 夹具存在', false, '（无头浏览器没生成成功）')
}

/* ---------- 6. Office / 图片 ---------- */
console.log('\n=== Office 与图片 ===')
const docx = await call('doc_read', { path: DOCX })
check('docx 抽到正文与关键字', docx.ok === true && docx.data.kind === 'text' && docx.data.chars > 0 && String(docx.text).includes('DOCX-MARKER-2030'),
  docx.ok === true ? `${docx.data.chars} 字` : docx.error)
check('docx 抽到了表格内容', docx.ok === true && String(docx.text).includes('42'), '')
const xlsx = await call('doc_read', { path: XLSX })
check('xlsx 抽到单元格内容', xlsx.ok === true && String(xlsx.text).includes('XLSX-MARKER-2031') && String(xlsx.text).includes('12345'),
  xlsx.ok === true ? `${xlsx.data.chars} 字` : xlsx.error)
const png = await call('doc_read', { path: PNG })
check('图片返回库内可引用路径', png.ok === true && png.data.kind === 'image' && existsSync(join(libDir, 'notes', png.data.rel)),
  png.ok === true ? png.data.rel : png.error)
const byRel = await call('doc_read', { path: png.data.rel })
check('也能用库内相对路径读', byRel.ok === true && byRel.data.kind === 'image', byRel.ok === true ? byRel.data.rel : byRel.error)

/* ---------- 7. 负向 ---------- */
console.log('\n=== 负向 ===')
const missing = await call('doc_read', { path: join(fixtures, '不存在的.pdf') })
check('不存在的文件给出可读错误', missing.ok === false && String(missing.error).includes('文件不存在'), String(missing.error).slice(0, 70))
const noPath = await call('doc_read', {})
check('缺 path 报错', noPath.ok === false && String(noPath.error).includes('path'), String(noPath.error).slice(0, 70))

/* ---------- 8. 渲染产物与"孤儿附件"的关系（说明性检查） ---------- */
const orphans = await call('attachment_orphans')
const rendered = pdf.data.pages.map((p) => p.rel)
check('渲染出来的页图会被列为"无人引用附件"（提醒：可被 note_write 引用后再也不孤立）',
  orphans.ok === true && rendered.every((rel) => orphans.data.files.includes(rel)),
  `孤儿 ${orphans.data.count} 个，其中页图 ${rendered.length} 个`)

/* ---------- 9. 真实数据零改动 ---------- */
{
  const after = snapshot(REAL)
  const diffs = []
  for (const [rel, sig] of after) {
    const old = realBefore.get(rel)
    if (old === undefined) diffs.push('新增 ' + rel)
    else if (old !== sig) diffs.push('改动 ' + rel)
  }
  for (const rel of realBefore.keys()) if (!after.has(rel)) diffs.push('删除 ' + rel)
  check('用户真实数据零改动', diffs.length === 0, diffs.length === 0 ? '快照完全一致' : diffs.slice(0, 4).join('；'))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 汇总 ===\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
console.log('工作目录：' + work)
process.exit(failed.length === 0 ? 0 : 1)
