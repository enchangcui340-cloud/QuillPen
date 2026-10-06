/**
 * 最终全流程一条龙（一二三挡合并的"用户旅程"验收）。
 *
 * 从**空库**开始，把三挡功能按用户的真实顺序走一遍，并全程统计：
 *   · 接口连通性 —— 每次宿主通道调用是否成功
 *   · 图片/文件访问载入 —— 附件能否通过 /quill-user/attachment 真的取到（HTTP 200 + 字节一致）
 *   · 云目录 —— 接入 / 上传 / 下载（真服务器）
 *   · 错误率 —— 全程错误提示数、通道失败数
 *   · 耗时 —— 每一段的实际耗时
 *
 *   node tools/smoke-fullflow.mjs
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { createEnv, wait, domHelpers } from './jsdom-env.mjs'
import { ROOT, packageDirName } from './paths.mjs'

const results = []
const skips = []
const errors = new Set()
const timings = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`)
}
/** 环境不满足导致的"跳过"（例如云目录是服务器上的真实资源，被清空后无法验证） */
function skip(name, reason) {
  skips.push({ name, reason })
  console.log(`[SKIP] ${name}${reason ? ' -- ' + reason : ''}`)
}
async function stage(name, fn) {
  const t = Date.now()
  await fn()
  const ms = Date.now() - t
  timings.push([name, ms])
  console.log(`      ⏱  ${name}：${ms}ms`)
}

// ---------- 准备：空库（模拟"刚装上软件"） ----------
const emptySrc = join(join(ROOT, '.tmp'), 'empty-lib-' + Date.now())
mkdirSync(join(emptySrc, 'notes'), { recursive: true })
mkdirSync(join(emptySrc, 'data'), { recursive: true })
/*
 * 放一张最小合法 PNG 当作"库里的图片"。
 * 为什么必须自己造：后面的"导入图片"步骤要从本库 `_attachments` 里取一张图，
 * 而这个库是**空库**（模拟刚装上软件）。之前只建了空目录 → 那一步必然报错
 * 「测试库的 notes/_attachments 里没有图片」。
 * 1×1 透明 PNG，67 字节，不依赖任何外部素材。
 */
mkdirSync(join(emptySrc, 'notes', '_attachments'), { recursive: true })
const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)
writeFileSync(join(emptySrc, 'notes', '_attachments', '夹具图片.png'), FIXTURE_PNG)

const env = await createEnv({ libSrc: emptySrc })
const { window, container, libDir, calls, rt } = env
const H = domHelpers(window)
const NOTES = join(libDir, 'notes')
const DATA = join(libDir, 'data')

const sweepErrors = () => {
  for (const t of container.querySelectorAll('.toast')) {
    const text = (t.textContent ?? '').trim()
    if (text !== '' && (t.className.includes('error') || /失败|错误|出错|异常/.test(text))) errors.add(text)
  }
  const body = container.textContent ?? ''
  for (const bad of ['面板渲染出错', '应用启动失败']) if (body.includes(bad)) errors.add(bad)
}
const lastModal = () => [...container.querySelectorAll('.modal')].at(-1) ?? null
const closeAllModals = async () => {
  for (let i = 0; i < 8; i++) {
    const modals = [...container.querySelectorAll('.modal')]
    if (modals.length === 0) return
    const btn = modals[modals.length - 1].querySelector('[title="关闭"]')
    if (btn === null) return
    H.click(btn)
    await wait(250)
  }
}
const rail = (keyword) => [...container.querySelectorAll('.rail-btn')].find((b) => (b.getAttribute('title') ?? '').includes(keyword))
const listMd = (dir = NOTES, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === '_attachments') continue
    const abs = join(dir, e.name)
    if (e.isDirectory()) listMd(abs, out)
    else if (/\.md$/i.test(e.name)) out.push(abs)
  }
  return out
}

console.log('=== 最终全流程 ===\n')
// 空库会被程序塞入一篇欢迎笔记（「关于这个笔记库」），这是正常行为，不是脏数据
check('空库准备完毕（只有程序自带的欢迎笔记）', listMd().length <= 1, `${listMd().length} 篇：${listMd().map((p) => p.slice(NOTES.length + 1)).join(', ')}`)

// ---------- 0. 面板挂载（接口连通） ----------
await stage('面板挂载', async () => {
  env.mount(container)
  await wait(1500)
})
check('面板渲染出根容器', container.querySelector('#dsh-quill-user-root') !== null, '')
const callsAtMount = calls.length
check('挂载即完成初始接口调用', callsAtMount >= 5, `${callsAtMount} 次调用`)

// ---------- 1. 笔记：新建夹 → 新建笔记 → 改名 → 编辑落盘 ----------
const notesRail = rail('笔记库')
H.click(notesRail)
await wait(800)
await stage('新建笔记夹 + 改名', async () => {
  H.click(H.byTitle(container, '新建笔记夹'))
  await wait(500)
  const renameInput = container.querySelector('input.tree-rename')
  if (renameInput) { H.setInput(renameInput, '旅程夹'); H.pressKey(renameInput, 'Enter') }
  await wait(700)
})
check('磁盘上出现新笔记夹', existsSync(join(NOTES, '旅程夹')), '')

await stage('新建笔记 + 改名', async () => {
  H.click(H.byTitle(container, '新建笔记'))
  await wait(600)
  const renameInput = container.querySelector('input.tree-rename')
  if (renameInput) { H.setInput(renameInput, '旅程笔记'); H.pressKey(renameInput, 'Enter') }
  await wait(800)
})
const journeyNote = listMd().find((p) => p.endsWith('旅程笔记.md'))
check('磁盘上出现新笔记', journeyNote !== undefined, journeyNote?.slice(NOTES.length + 1) ?? '')

await stage('在编辑器里插入分割线（自动保存）', async () => {
  const editor = container.querySelector('.cm-content') ?? container.querySelector('.cm-editor')
  if (editor) {
    H.contextMenu(editor)
    await wait(500)
    const item = [...container.querySelectorAll('.ctx-item')].find((e) => (e.textContent ?? '').includes('插入分割线'))
    if (item) { H.click(item); await wait(2200) }
  }
})
check('笔记内容已落盘', journeyNote !== undefined && /\n---\n/.test(readFileSync(journeyNote, 'utf8')), '')

// ---------- 2. 白板：新建 → 加卡片 → 保存 ----------
await stage('新建白板 + 加卡片 + 保存', async () => {
  H.click(H.byTitle(container, '新建白板'))
  await wait(600)
  const renameInput = container.querySelector('input.tree-rename')
  if (renameInput) { H.setInput(renameInput, '旅程白板'); H.pressKey(renameInput, 'Enter') }
  await wait(800)
  const boardNode = [...container.querySelectorAll('.tree-node')].find((n) => (n.textContent ?? '').includes('旅程白板'))
  if (boardNode) { H.click(boardNode); await wait(900) }
  const addText = H.byText(container, '+ 文本卡片')
  if (addText) { H.click(addText); await wait(600) }
  const saveBtn = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '保存')
  if (saveBtn) { H.click(saveBtn); await wait(1000) }
})
const boardFile = readdirSync(NOTES).find((f) => f.includes('旅程白板'))
check('白板卡片已落盘', boardFile !== undefined && (JSON.parse(readFileSync(join(NOTES, boardFile), 'utf8')).nodes ?? []).length > 0,
  boardFile ?? '找不到白板文件')

// ---------- 2b. 卡片颜色：右键 →「卡片颜色」子菜单（栏中栏）→ 选色 → 落盘 ----------
await stage('卡片颜色子菜单（栏中栏）', async () => {
  const card = container.querySelector('.board-node')
  if (card === null) return
  H.contextMenu(card)               // 右键卡片
  await wait(400)
})

check('右键菜单里有「卡片颜色」父项', container.querySelector('.ctx-item.has-sub') !== null,
  (container.querySelector('.ctx-item.has-sub')?.textContent ?? '').trim().slice(0, 30))

// 悬停父项 → 展开子菜单（React 的 onMouseEnter 由 mouseover 冒泡触发）
{
  const parent = container.querySelector('.ctx-item.has-sub')
  if (parent !== null) {
    parent.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }))
    await wait(300)
  }
}
const swatches = [...container.querySelectorAll('.ctx-swatch')]
// 当前色会带一个对勾「✓」，比对顺序时要先把它剥掉
const subLabels = swatches.map((s) => (s.parentElement?.textContent ?? '').replace(/[✓▸]/g, '').trim())
check('子菜单里出现 6 个色块', swatches.length === 6, subLabels.join(' / '))
check('色块顺序是 原色/粉色/蓝色/绿色/黄色/紫色',
  subLabels.join(',') === '原色,粉色,蓝色,绿色,黄色,紫色', subLabels.join(','))

// 回归护栏：子菜单必须**真的算过位置**。曾经因为"父项序号含分隔线、DOM 次序不含"导致锚点取错 →
// 定位一直没算出来 → position:fixed 没有 left/top 就落到窗口左上角（用户截图里那个现象）。
{
  const panel = [...container.querySelectorAll('.ctx-menu')].find((m) => m.querySelector('.ctx-swatch') !== null)
  const hasLeft = panel !== undefined && panel.style.left !== ''
  const hasTop = panel !== undefined && panel.style.top !== ''
  check('子菜单有明确的定位（不会飘到窗口左上角）', hasLeft && hasTop,
    panel === undefined ? '没找到子菜单面板' : `left=${panel.style.left || '(空)'} top=${panel.style.top || '(空)'}`)
}

// 点「粉色」→ 断言磁盘上的卡片颜色真的变了
{
  const pinkBtn = swatches.find((s) => (s.parentElement?.textContent ?? '').trim() === '粉色')?.parentElement
  if (pinkBtn !== null && pinkBtn !== undefined) {
    H.click(pinkBtn)
    await wait(400)
    const saveBtn2 = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '保存')
    if (saveBtn2) { H.click(saveBtn2); await wait(1000) }
  }
}
{
  const file = readdirSync(NOTES).find((f) => f.includes('旅程白板'))
  const nodes = file === undefined ? [] : (JSON.parse(readFileSync(join(NOTES, file), 'utf8')).nodes ?? [])
  check('点「粉色」后卡片颜色已写入文件（#fbd9e6）', nodes.some((n) => String(n.color).toLowerCase() === '#fbd9e6'),
    nodes.map((n) => n.color).join(', '))
  const painted = container.querySelector('.board-node')
  check('卡片元素带上了 data-card-color（渲染由主题变量接管）',
    painted?.getAttribute('data-card-color') !== null && painted?.getAttribute('data-card-color') !== undefined,
    String(painted?.getAttribute('data-card-color')))
  check('色板内的卡片不再写内联 background（避免压过主题色）',
    painted === null || (painted.getAttribute('style') ?? '').includes('background') === false,
    (painted?.getAttribute('style') ?? '').slice(0, 60))
}

// ---------- 3. 待办：新建任务 → 勾选 → 新建标签 ----------
const todoRail = rail('Todolist')
H.click(todoRail)
await wait(800)
await stage('新建任务 + 勾选完成', async () => {
  const newTask = H.byText(container, '+ 新建任务')
  if (newTask) {
    H.click(newTask)
    await wait(600)
    const dlg = lastModal()
    const nameInput = dlg?.querySelector('input.input')
    if (nameInput) { H.setInput(nameInput, '旅程任务'); await wait(200) }
    const saveBtn = [...(dlg?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('保存'))
    if (saveBtn) { H.click(saveBtn); await wait(900) }
    const row = [...container.querySelectorAll('.task-item')].find((n) => (n.textContent ?? '').includes('旅程任务'))
    const box = row?.querySelector('.check')
    if (box) { H.click(box); await wait(900) }
  }
})
const tasks = JSON.parse(readFileSync(join(DATA, 'tasks.json'), 'utf8'))
const journeyTask = tasks.find((t) => t.name === '旅程任务')
check('任务已创建并标记完成', journeyTask?.done === true, `done=${journeyTask?.done}`)

await stage('新建标签', async () => {
  H.click(H.byTitle(container, '新建顶层标签'))
  await wait(600)
  const input = container.querySelector('input.tree-rename') ?? container.querySelector('.tag-panel input')
  if (input) { H.setInput(input, '旅程标签'); H.pressKey(input, 'Enter') }
  await wait(800)
})
check('标签已落盘', JSON.parse(readFileSync(join(DATA, 'tags.json'), 'utf8')).some((t) => t.name === '旅程标签'), '')

// ---------- 4. 图片：导入 → 库内 → HTTP 可访问 ----------
let importedRel = ''
await stage('导入图片（客户端文件框 + 宿主拷贝）', async () => {
  const outside = join(env.work, '旅程图片.png')
  // 图片从**当前测试库**的 _attachments 里取（夹具库自带一张 1×1 PNG）。
  // 之前写死指向本机真实库快照 —— 开源用户没有那个目录。
  const donor = join(libDir, 'notes', '_attachments')
  const firstImage = readdirSync(donor).find((f) => /\.(png|jpg|jpeg)$/i.test(f))
  if (firstImage === undefined) throw new Error('测试库的 notes/_attachments 里没有图片，无法验证导入')
  copyFileSync(join(donor, firstImage), outside)
  globalThis.__DSH_PICK_FILE_HOOK__ = async () => ({ path: outside, name: '旅程图片.png', dataUrl: '' })

  H.click(notesRail)
  await wait(700)
  const boardNode = [...container.querySelectorAll('.tree-node')].find((n) => (n.textContent ?? '').includes('旅程白板'))
  if (boardNode) { H.click(boardNode); await wait(900) }
  const addImage = H.byText(container, '+ 图片')
  if (addImage) { H.click(addImage); await wait(1500) }
  const saveBtn = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '保存')
  if (saveBtn) { H.click(saveBtn); await wait(1000) }
  delete globalThis.__DSH_PICK_FILE_HOOK__
})
{
  const board = JSON.parse(readFileSync(join(NOTES, boardFile), 'utf8'))
  const imageNode = (board.nodes ?? []).find((n) => n.type === 'image' && n.src)
  importedRel = imageNode?.src ?? ''
  check('白板里有图片卡片且指向库内', importedRel.startsWith('_attachments/'), importedRel || '(无)')
}
// 用真实的外壳 HTTP 路由取这张图（这正是生产里 <img src> 走的那条路）
await stage('HTTP 取图（/quill-user/attachment）', async () => {
  const shell = await import('../packages/' + packageDirName() + '/lib/index.js')
  let handler = null
  shell.apply(
    { webServer: { register: (r) => { handler = r.handler; return () => undefined } }, connection: { requestRejection: () => undefined }, effect: (f) => f() },
    { libraryRoot: libDir, dataDir: join(env.work, 'shell-data') }
  )
  const req = Readable.from([])
  req.method = 'GET'
  req.url = '/quill-user/attachment?rel=' + encodeURIComponent(importedRel)
  req.headers = { host: '127.0.0.1:19387' }
  const res = new (class extends Writable {
    constructor() { super(); this.chunks = []; this.status = 0; this.headers = {} }
    writeHead(s, h) { this.status = s; this.headers = { ...h }; return this }
    _write(c, _e, cb) { this.chunks.push(Buffer.from(c)); cb() }
  })()
  await new Promise((resolve, reject) => { res.on('finish', resolve); res.on('error', reject); void handler(req, res).catch(reject) })
  const body = Buffer.concat(res.chunks)
  const diskBytes = readFileSync(join(NOTES, importedRel))
  check('HTTP 200 且类型正确', res.status === 200 && String(res.headers['content-type']).startsWith('image/'), `${res.status} ${res.headers['content-type']}`)
  check('返回字节数与磁盘文件一致', body.length === diskBytes.length && body.length > 0, `${body.length} 字节（磁盘 ${diskBytes.length}）`)
})

// ---------- 5. 文档：插入本地文件链接 ----------
await stage('插入本地文件链接（PDF）', async () => {
  const doc = join(env.work, '旅程手册.pdf')
  writeFileSync(doc, '%PDF-1.4\n% fullflow\n', 'utf8')
  globalThis.__DSH_PICK_FILE_HOOK__ = async () => ({ path: doc, name: '旅程手册.pdf', dataUrl: '' })
  const notesRail2 = rail('笔记库')
  if (notesRail2) { H.click(notesRail2); await wait(700) }
  const node = [...container.querySelectorAll('.tree-node')].find((n) => (n.textContent ?? '').includes('旅程笔记'))
  if (node) { H.click(node); await wait(1200) }
  const editor = container.querySelector('.cm-content') ?? container.querySelector('.cm-editor')
  if (editor) {
    H.contextMenu(editor)
    await wait(500)
    const item = [...container.querySelectorAll('.ctx-item')].find((e) => (e.textContent ?? '').includes('插入链接'))
    if (item) {
      H.click(item)
      await wait(600)
      const dlg = lastModal()
      const pickBtn = [...(dlg?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('选择文件'))
      if (pickBtn) { H.click(pickBtn); await wait(700) }
      const insertBtn = [...(dlg?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').trim() === '插入')
      if (insertBtn) { H.click(insertBtn); await wait(2200) }
    }
  }
  delete globalThis.__DSH_PICK_FILE_HOOK__
})
check('笔记里写入了文件链接', journeyNote !== undefined && readFileSync(journeyNote, 'utf8').includes('旅程手册'), '')

// ---------- 6. 回收站：删除 → 恢复 ----------
await stage('删除笔记 → 回收站 → 恢复', async () => {
  const node = [...container.querySelectorAll('.tree-node')].find((n) => (n.textContent ?? '').includes('旅程笔记'))
  const delBtn = node === undefined ? undefined : [...node.querySelectorAll('[title]')].find((b) => b.getAttribute('title') === '删除')
  if (delBtn) {
    H.click(delBtn)
    await wait(600)
    const ok = [...(lastModal()?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').trim() === '确定')
    if (ok) { H.click(ok); await wait(1000) }
  }
  const trashRail = rail('回收站')
  if (trashRail) {
    H.click(trashRail)
    await wait(800)
    const dlg = lastModal()
    const noteTab = [...(dlg?.querySelectorAll('button.tab') ?? [])].find((b) => (b.textContent ?? '').includes('笔记回收站'))
    if (noteTab) { H.click(noteTab); await wait(500) }
    const row = [...(dlg?.querySelectorAll('div, li, tr') ?? [])].find((r) => (r.textContent ?? '').includes('旅程笔记') && r.querySelector('input[type=checkbox]'))
    const box = row?.querySelector('input[type=checkbox]')
    if (box) { H.click(box); await wait(300) }
    const restore = [...(dlg?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('恢复'))
    if (restore) { H.click(restore); await wait(1000) }
    await closeAllModals()
  }
})
check('笔记已从回收站恢复', listMd().some((p) => p.endsWith('旅程笔记.md')), '')

// ---------- 7. 设置：切深色主题 ----------
await stage('切换深色主题', async () => {
  const settingsRail = rail('设置')
  if (settingsRail) { H.click(settingsRail); await wait(800) }
  const dlg = lastModal()
  const select = dlg?.querySelector('select')
  if (select) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
    if (setter) setter.call(select, 'dark'); else select.value = 'dark'
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    await wait(300)
    const save = [...(dlg?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('保存'))
    if (save) { H.click(save); await wait(900) }
  }
})
check('根容器已切深色', container.querySelector('#dsh-quill-user-root')?.getAttribute('data-theme') === 'dark', '')
check('宿主 documentElement 未被污染', window.document.documentElement.dataset.theme === undefined, '')

// ---------- 8. 多库：新建 → 切换 → 切回 ----------
await stage('新建第二个库并切换', async () => {
  const settingsRail = rail('设置')
  if (settingsRail) { H.click(settingsRail); await wait(800) }
  const dlg = lastModal()
  const createBtn = [...(dlg?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('新建…'))
  if (createBtn) {
    H.click(createBtn)
    await wait(700)
    const cdlg = lastModal()
    const inputs = [...(cdlg?.querySelectorAll('input.input') ?? [])]
    if (inputs.length >= 2) {
      H.setInput(inputs[0], join(env.work, 'lib2'))
      H.setInput(inputs[1], '旅程第二库')
      await wait(200)
      const ok = [...(cdlg?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('创建并切换'))
      if (ok) { H.click(ok); await wait(2500) }
    }
  }
})
check('第二库结构已生成', existsSync(join(env.work, 'lib2', 'notes')), '')
const libs = await rt.invoke('libraries:list', [])
check('注册表里有 2 个库', (libs?.value?.items ?? []).length === 2, (libs?.value?.items ?? []).map((i) => i.name).join(', '))
await stage('切回原库', async () => {
  const settingsRail = rail('设置')
  if (settingsRail) { H.click(settingsRail); await wait(800) }
  const dlg = lastModal()
  const rows = [...(dlg?.querySelectorAll('div, li, tr') ?? [])]
  const myRow = rows.find((r) => (r.textContent ?? '').includes(libDir) && r.querySelector('button'))
  const sw = [...(myRow?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').trim() === '切换')
  if (sw) { H.click(sw); await wait(2500) }
})
const libs2 = await rt.invoke('libraries:list', [])
const active2 = (libs2?.value?.items ?? []).find((i) => i.id === libs2?.value?.activeId)
check('已切回原库', (active2?.dir ?? '').replace(/\\/g, '/').toLowerCase() === libDir.replace(/\\/g, '/').toLowerCase(), active2?.dir ?? '')

// ---------- 9. 云目录：接入 → 上传 → 下载 ----------
// 云目录是服务器上的真实资源：夹具不存在（测试目录已删/已清理）时**如实跳过**。
// 之前这里是直接 readFileSync，文件不在就抛未捕获异常，**整个进程会挂住不退出**（踩过）。
if (!existsSync(join(ROOT, 'tools/fixtures/cloud-dir.json'))) {
  skip('云目录：接入 + 上传 + 下载', '没有 tools/fixtures/cloud-dir.json（测试云目录已清理）')
} else
await stage('云目录：接入 + 上传 + 下载', async () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'tools/fixtures/cloud-dir.json'), 'utf8'))
  const privateKey = Buffer.from(fixture.privateKeyB64, 'base64').toString('utf8')
  const payload = { v: 1, h: fixture.host, p: fixture.port, u: fixture.user, id: fixture.id, n: fixture.name, k: privateKey }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const key = `QC1-${payload.id}-${body}-${createHash('sha256').update(body).digest('hex').slice(0, 6)}`

  const connect = await rt.invoke('cloud:connect-key', [key, 'download'])
  const value = await connect
  if (value?.ok !== true) {
    // 云目录是**服务器上的真实资源**：用户清空过服务器之后，这份夹具就指不到东西了。
    // 这种情况要如实报"跳过"，而不是算失败 —— 也不能偷偷重建目录（会占用户服务器的配额）。
    // 想恢复这段覆盖：拿一个新的云目录 key 更新 tools/fixtures/cloud-dir.json 即可。
    skip('云目录：接入 + 上传 + 下载', `云目录不可用（${String(value?.error)}）`)
    return
  }
  const cloudDir = value.value.dir
  // 用程序自己的方式建笔记（直接往库里塞裸 md 会被"收养"并补 frontmatter，基准就不准了）
  const created = await (await rt.invoke('note:create', [{ dir: '', kind: 'md', title: '旅程云端笔记' }]))
  const noteRel = 'notes/' + (created?.value?.fileName ?? '旅程云端笔记.md')
  const localFile = join(cloudDir, noteRel)
  check('云端目录里建出了笔记', existsSync(localFile), noteRel)
  const before = readFileSync(localFile, 'utf8')
  const upload = await (await rt.invoke('cloud:upload2', [value.value.id]))
  check('云目录上传成功', upload?.ok === true, upload?.ok ? `${upload.value.uploaded} 个文件 / ${upload.value.bytes} 字节` : String(upload?.error))
  const status = await (await rt.invoke('cloud:status2', [value.value.id]))
  check('云目录状态可读', status?.ok === true, `设备 ${status?.value?.devices?.length ?? '?'}`)
  // 把本机内容改脏，验证下载确实用云端内容覆盖回来
  writeFileSync(localFile, 'LOCAL-DIRTY', 'utf8')
  const download = await (await rt.invoke('cloud:download2', [value.value.id]))
  check('云目录下载成功', download?.ok === true, download?.ok ? `${download.value.files ?? '?'} 个文件` : String(download?.error))
  const after = existsSync(localFile) ? readFileSync(localFile, 'utf8') : '(文件不存在)'
  check('云端内容往返一致（本地脏内容被云端覆盖）', after === before, after === before ? `${after.length} 字节一致` : `前 ${JSON.stringify(before.slice(0, 40))} / 后 ${JSON.stringify(after.slice(0, 40))}`)
})

// ---------- 10. 总账 ----------
sweepErrors()
await wait(500)
sweepErrors()
const failedCalls = calls.filter((c) => !c.ok)
const chapters = calls.length
check('接口连通：所有通道调用成功', failedCalls.length === 0, `${chapters} 次调用，失败 ${failedCalls.length} 次${failedCalls.length ? '：' + [...new Set(failedCalls.map((c) => c.channel))].join(',') : ''}`)
check('错误率：全程零错误提示', errors.size === 0, errors.size === 0 ? '没有任何报错弹窗' : [...errors].slice(0, 4).join('；'))

console.log('\n=== 全流程总账 ===')
console.log(`通道调用        ${chapters} 次（失败 ${failedCalls.length}）`)
console.log(`错误提示        ${errors.size} 条`)
console.log('分段耗时：')
for (const [name, ms] of timings) console.log(`  ${name.padEnd(28)} ${ms}ms`)
console.log(`全流程总耗时    ${timings.reduce((n, [, ms]) => n + ms, 0)}ms`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过${skips.length > 0 ? `（另有 ${skips.length} 段跳过）` : ''}`)
for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
for (const s of skips) console.log(`  ~ 跳过：${s.name}（${s.reason}）`)
process.exit(failed.length === 0 ? 0 : 1)
