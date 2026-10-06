/**
 * 交互冒烟测试 —— 在 jsdom 里**真的点**，并断言**磁盘上的文件真的变了**。
 *
 * 这是一挡"全部做完后统一后台测一遍"的主力工具。它覆盖：
 *   新建笔记夹 / 新建笔记 / 内联改名 / 打开笔记（CodeMirror 挂载）
 *   / 新建任务 / 完成任务 / 删除笔记进回收站
 *
 * 全部在**库的副本**上跑，绝不碰真实笔记库。
 *
 *   node tools/smoke-interact.mjs
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createEnv, wait, domHelpers } from './jsdom-env.mjs'
import { REAL_LIBRARY } from './paths.mjs'

const env = await createEnv()
const { window, container, libDir, calls, mount } = env
const H = domHelpers(window)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`)
}

const NOTES = join(libDir, 'notes')
const DATA = join(libDir, 'data')
const listMd = (dir = NOTES, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === '_attachments') continue
    const abs = join(dir, e.name)
    if (e.isDirectory()) listMd(abs, out)
    else if (/\.md$/i.test(e.name)) out.push(abs)
  }
  return out
}
const listDirs = (dir = NOTES, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === '_attachments') continue
    if (e.isDirectory()) { const abs = join(dir, e.name); out.push(abs); listDirs(abs, out) }
  }
  return out
}
const treeText = () => (container.textContent ?? '')

// ---------- 真实数据护栏：测试前后对用户真实目录做快照比对 ----------
const REAL_PATHS = [
  REAL_LIBRARY,
  join(process.env.APPDATA ?? '', 'workapp')
]
function snapshotTree(root) {
  const map = new Map()
  const walk = (dir, prefix) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const rel = prefix === '' ? e.name : prefix + '/' + e.name
      const abs = join(dir, e.name)
      if (e.isDirectory()) { walk(abs, rel); continue }
      try { const st = statSync(abs); map.set(rel, `${st.size}:${st.mtimeMs}`) } catch { /* 读不到就跳过 */ }
    }
  }
  walk(root, '')
  return map
}
const realBefore = REAL_PATHS.map((p) => [p, snapshotTree(p)])
console.log('  真实数据快照：' + realBefore.map(([p, m]) => `${p.split(/[\\/]/).slice(-2).join('/')}(${m.size})`).join('  '))

// ---------- 挂载 ----------
mount(container)
await wait(1200)
check('面板挂载', container.querySelector('#dsh-quill-user-root') !== null, '')
check('笔记库区域默认可见（Todolist 为默认区域）', container.querySelector('.rail') !== null, '')

// 切到「笔记库」
const notesRailBtn = [...container.querySelectorAll('.rail-btn')].find((b) => (b.getAttribute('title') ?? '').includes('笔记库'))
check('找到「笔记库」入口', notesRailBtn !== undefined, notesRailBtn?.getAttribute('title') ?? '')
if (notesRailBtn) { H.click(notesRailBtn); await wait(800) }
check('笔记树已渲染', container.querySelector('.tree-node') !== null, `${container.querySelectorAll('.tree-node').length} 个节点`)

const mdBefore = listMd().length
const dirsBefore = listDirs().length

// ---------- 1. 新建笔记夹（会立刻进入内联改名） ----------
const newFolderBtn = H.byTitle(container, '新建笔记夹')
check('找到「新建笔记夹」按钮', newFolderBtn !== undefined, '')
if (newFolderBtn) {
  H.click(newFolderBtn)
  await wait(500)
  const renameInput = container.querySelector('input.tree-rename') ?? container.querySelector('.tree-node input')
  check('内联改名输入框出现', renameInput !== null, '')
  if (renameInput) {
    H.setInput(renameInput, '交互冒烟夹')
    H.pressKey(renameInput, 'Enter')
    await wait(700)
  }
  const dirs = listDirs()
  check('磁盘上出现新笔记夹', dirs.length > dirsBefore && dirs.some((d) => d.endsWith('交互冒烟夹')), dirs.map((d) => d.slice(NOTES.length + 1)).join(', '))
}

// ---------- 2. 新建笔记 + 改名 ----------
const newNoteBtn = H.byTitle(container, '新建笔记')
check('找到「新建笔记」按钮', newNoteBtn !== undefined, '')
let newNotePath = null
if (newNoteBtn) {
  H.click(newNoteBtn)
  await wait(600)
  const renameInput = container.querySelector('input.tree-rename') ?? container.querySelector('.tree-node input')
  if (renameInput) {
    H.setInput(renameInput, '交互冒烟笔记')
    H.pressKey(renameInput, 'Enter')
    await wait(800)
  }
  const md = listMd()
  check('磁盘上出现新笔记', md.length > mdBefore, `${mdBefore} → ${md.length}`)
  newNotePath = md.find((p) => p.endsWith('交互冒烟笔记.md')) ?? null
  check('新笔记文件名与改名一致', newNotePath !== null, newNotePath === null ? md.map((p) => p.slice(NOTES.length + 1)).join(', ') : newNotePath.slice(NOTES.length + 1))
  if (newNotePath !== null) {
    const raw = readFileSync(newNotePath, 'utf8')
    check('新笔记带 frontmatter（id/title/created/updated）', /^---[\s\S]*?^id:\s*\S+/m.test(raw) && raw.includes('title: 交互冒烟笔记'), raw.split('\n').slice(0, 5).join(' | '))
  }
}

// ---------- 3. 打开笔记（CodeMirror 应挂载） ----------
if (newNotePath !== null) {
  const node = [...container.querySelectorAll('.tree-node')].find((n) => (n.textContent ?? '').includes('交互冒烟笔记'))
  check('树里能找到这篇笔记', node !== undefined, '')
  if (node) {
    H.click(node)
    await wait(1200)
  }
  const cm = container.querySelector('.cm-editor') ?? container.querySelector('.cm-content')
  check('编辑器已挂载（CodeMirror）', cm !== null, cm === null ? '未找到 .cm-editor' : 'ok')
  check('标题栏显示笔记名', treeText().includes('交互冒烟笔记'), '')
}

// ---------- 3.5 在编辑器里真改内容并落盘（右键菜单 → 插入分割线 → 自动保存） ----------
const bodyOf = (raw) => {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw)
  return m === null ? raw : raw.slice(m[0].length)
}
if (newNotePath !== null) {
  const beforeRaw = readFileSync(newNotePath, 'utf8')
  const editor = container.querySelector('.cm-content') ?? container.querySelector('.cm-editor')
  check('编辑器内容区可定位', editor !== null, '')
  if (editor) {
    H.contextMenu(editor)
    await wait(500)
    const menuItem = [...container.querySelectorAll('.menu-item, [class*="menu"] div, [class*="menu"] button')]
      .find((e) => (e.textContent ?? '').includes('插入分割线'))
    check('右键菜单出现且含「插入分割线」', menuItem !== undefined, '')
    if (menuItem) {
      H.click(menuItem)
      await wait(2200) // 自动保存是 1.2s 防抖
    }
  }
  const afterRaw = readFileSync(newNotePath, 'utf8')
  const grew = afterRaw.length > beforeRaw.length
  const hasRule = /(^|\n)---(\n|$)/.test(bodyOf(afterRaw))
  check('编辑后文件被自动保存（正文变了）', grew && hasRule, `${beforeRaw.length} → ${afterRaw.length} 字节，正文含分割线=${hasRule}`)
  const idKept = (afterRaw.match(/^id:\s*(\S+)/m) ?? [])[1] === (beforeRaw.match(/^id:\s*(\S+)/m) ?? [])[1]
  check('保存后 frontmatter id 不变', idKept, '')
}

// ---------- 3.6 插入本地文件链接（第三挡「文档导入」的用户路径） ----------
if (newNotePath !== null) {
  const outsideDoc = join(env.work, '课程手册.pdf')
  writeFileSync(outsideDoc, '%PDF-1.4\n% 冒烟测试用的假 PDF\n', 'utf8')
  globalThis.__DSH_PICK_FILE_HOOK__ = async () => ({ path: outsideDoc, name: '课程手册.pdf', dataUrl: '' })

  const editor = container.querySelector('.cm-content') ?? container.querySelector('.cm-editor')
  if (editor) {
    H.contextMenu(editor)
    await wait(500)
    const menuItem = [...container.querySelectorAll('.ctx-item')].find((e) => (e.textContent ?? '').includes('插入链接'))
    check('编辑器菜单有「插入链接 / 本地文件…」', menuItem !== undefined, '')
    if (menuItem) {
      H.click(menuItem)
      await wait(600)
      const dlg = [...container.querySelectorAll('.modal')].at(-1)
      check('链接对话框已打开', (dlg?.textContent ?? '').includes('插入链接 / 本地文件'), '')
      const pickBtn = [...(dlg?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('选择文件'))
      check('对话框有「选择文件…」按钮', pickBtn !== undefined, '')
      if (pickBtn) {
        H.click(pickBtn)
        await wait(700)
        const inputs = [...(dlg?.querySelectorAll('input.input') ?? [])]
        check('选中的文件路径已填进对话框', (inputs[0]?.value ?? '').includes('课程手册.pdf'), inputs[0]?.value ?? '(空)')
        const insertBtn = [...(dlg?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').trim() === '插入')
        if (insertBtn) { H.click(insertBtn); await wait(2200) }
      }
    }
  }
  const raw = existsSync(newNotePath) ? readFileSync(newNotePath, 'utf8') : ''
  check('笔记里写入了本地文件链接', raw.includes('课程手册'), raw.split('\n').filter((l) => l.includes('课程手册')).join(' ').slice(0, 120))
  delete globalThis.__DSH_PICK_FILE_HOOK__
}

// ---------- 4. 新建任务 + 完成 ----------
const todoRailBtn = [...container.querySelectorAll('.rail-btn')].find((b) => (b.getAttribute('title') ?? '').includes('Todolist'))
if (todoRailBtn) { H.click(todoRailBtn); await wait(700) }
const tasksBefore = JSON.parse(readFileSync(join(DATA, 'tasks.json'), 'utf8'))
const newTaskBtn = H.byText(container, '+ 新建任务')
check('找到「+ 新建任务」按钮', newTaskBtn !== undefined, '')
if (newTaskBtn) {
  H.click(newTaskBtn)
  await wait(600)
  // 任务对话框：第一个文本输入框是任务名
  const dialog = container.querySelector('.modal')
  check('任务对话框已打开', dialog !== null, '')
  const nameInput = dialog?.querySelector('input.input') ?? dialog?.querySelector('input')
  if (nameInput) {
    H.setInput(nameInput, '交互冒烟任务')
    await wait(300)
  }
  const saveBtn = [...(dialog?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('保存'))
  check('找到对话框「保存」按钮', saveBtn !== undefined, '')
  if (saveBtn) { H.click(saveBtn); await wait(900) }
  const tasksAfter = JSON.parse(readFileSync(join(DATA, 'tasks.json'), 'utf8'))
  const created = tasksAfter.find((t) => t.name === '交互冒烟任务')
  check('tasks.json 新增了任务', tasksAfter.length > tasksBefore.length && created !== undefined, `${tasksBefore.length} → ${tasksAfter.length}`)

  // 勾选完成
  if (created) {
    const row = [...container.querySelectorAll('.task-item')].find((n) => (n.textContent ?? '').includes('交互冒烟任务'))
    check('任务出现在列表里', row !== undefined, '')
    const checkEl = row?.querySelector('.check')
    if (checkEl) {
      H.click(checkEl)
      await wait(900)
      const done = JSON.parse(readFileSync(join(DATA, 'tasks.json'), 'utf8')).find((t) => t.id === created.id)
      check('勾选后 tasks.json 里 done=true', done?.done === true, `done=${done?.done}`)
    }
  }
}

// ---------- 5. 删除笔记 → 回收站 ----------
if (newNotePath !== null) {
  if (notesRailBtn) { H.click(notesRailBtn); await wait(700) }
  const node = [...container.querySelectorAll('.tree-node')].find((n) => (n.textContent ?? '').includes('交互冒烟笔记'))
  const delBtn = node === undefined ? undefined : [...node.querySelectorAll('[title]')].find((b) => b.getAttribute('title') === '删除')
  check('找到树上的「删除」按钮', delBtn !== undefined, '')
  const trashBefore = JSON.parse(readFileSync(join(DATA, 'trash-notes.json'), 'utf8')).length
  if (delBtn) {
    H.click(delBtn)
    await wait(600)
    // DSH 版把 window.confirm 换成了应用内对话框：这里必须点「确定」
    const confirmDlg = container.querySelector('.modal')
    check('删除弹出应用内确认框（替代 window.confirm）', confirmDlg !== null && (confirmDlg.textContent ?? '').includes('回收站'), (confirmDlg?.textContent ?? '').slice(0, 40))
    const okBtn = [...(confirmDlg?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').trim() === '确定')
    if (okBtn) { H.click(okBtn); await wait(900) }
  }
  check('笔记文件已从 notes/ 移走', !existsSync(newNotePath), newNotePath.slice(NOTES.length + 1))
  const trashFiles = existsSync(join(libDir, '.trash')) ? readdirSync(join(libDir, '.trash')) : []
  check('文件进了 .trash', trashFiles.some((f) => f.includes('交互冒烟笔记')), `${trashFiles.length} 个文件在回收站`)
  const trashAfter = JSON.parse(readFileSync(join(DATA, 'trash-notes.json'), 'utf8')).length
  check('trash-notes.json 记录增加', trashAfter > trashBefore, `${trashBefore} → ${trashAfter}`)
}

// ---------- 6. 新建白板 ----------
if (notesRailBtn) { H.click(notesRailBtn); await wait(600) }
const boardsBefore = readdirSync(NOTES).filter((f) => f.endsWith('.canvas.json')).length
const newBoardBtn = H.byTitle(container, '新建白板')
check('找到「新建白板」按钮', newBoardBtn !== undefined, '')
if (newBoardBtn) {
  H.click(newBoardBtn)
  await wait(600)
  const renameInput = container.querySelector('input.tree-rename') ?? container.querySelector('.tree-node input')
  if (renameInput) {
    H.setInput(renameInput, '交互冒烟白板')
    H.pressKey(renameInput, 'Enter')
    await wait(800)
  }
  const boards = readdirSync(NOTES).filter((f) => f.endsWith('.canvas.json'))
  check('磁盘上出现新白板', boards.length > boardsBefore && boards.some((f) => f.includes('交互冒烟白板')), boards.join(', '))
  const boardFile = join(NOTES, boards.find((f) => f.includes('交互冒烟白板')) ?? '')
  if (existsSync(boardFile)) {
    let parsed = null
    try { parsed = JSON.parse(readFileSync(boardFile, 'utf8')) } catch { /* 下面断言会失败 */ }
    check('白板 JSON 合法且带 board id', parsed !== null && typeof parsed.id === 'string' && parsed.type === 'whiteboard', parsed === null ? '解析失败' : `id=${parsed.id} nodes=${parsed.nodes?.length}`)
  }
  // 打开白板（应进入白板视图）
  const boardNode = [...container.querySelectorAll('.tree-node')].find((n) => (n.textContent ?? '').includes('交互冒烟白板'))
  if (boardNode) { H.click(boardNode); await wait(900) }
  check('白板视图已渲染', container.querySelector('.board-viewport') !== null || container.querySelector('[class*="board"]') !== null, '')
}

// ---------- 6.5 白板加卡片并保存落盘 ----------
if (notesRailBtn) { H.click(notesRailBtn); await wait(600) }
let boardFile = null
const boardNode2 = [...container.querySelectorAll('.tree-node')].find((n) => (n.textContent ?? '').includes('交互冒烟白板'))
if (boardNode2) {
  H.click(boardNode2)
  await wait(900)
  boardFile = join(NOTES, readdirSync(NOTES).find((f) => f.includes('交互冒烟白板')) ?? '')
  const before = existsSync(boardFile) ? JSON.parse(readFileSync(boardFile, 'utf8')) : { nodes: [] }
  const addTextBtn = H.byText(container, '+ 文本卡片')
  check('找到「+ 文本卡片」按钮', addTextBtn !== undefined, '')
  if (addTextBtn) {
    // 诊断：把「索引里的 mtime」和「磁盘实际 mtime」摊开看
    const treeNow = await env.rt.invoke('note:tree', [])
    const boardNode3 = (function find(nodes) {
      for (const n of nodes ?? []) {
        if (n.type === 'note' && (n.name ?? '').includes('交互冒烟白板')) return n
        const hit = find(n.children)
        if (hit) return hit
      }
      return null
    })(treeNow?.value)
    if (boardNode3?.id) {
      const read = await env.rt.invoke('note:read', [boardNode3.id])
      const diskMtime = statSync(boardFile).mtimeMs
      console.log('    诊断：索引 note.fileMtimeMs=' + read?.value?.note?.fileMtimeMs + '  磁盘 mtimeMs=' + diskMtime
        + '  差=' + (diskMtime - (read?.value?.note?.fileMtimeMs ?? 0)).toFixed(1) + 'ms')
    }
    H.click(addTextBtn)
    await wait(600)
    const saveBtns = [...container.querySelectorAll('button')].filter((b) => (b.textContent ?? '').trim() === '保存')
    check('白板「保存」按钮可用（dirty）', saveBtns.length > 0 && saveBtns.every((b) => b.disabled === false), `${saveBtns.length} 个「保存」按钮，disabled=${saveBtns.map((b) => b.disabled).join(',')}`)
    const beforeCalls = calls.length
    if (saveBtns.length > 0) { H.click(saveBtns[0]); await wait(1200) }
    const newCalls = calls.slice(beforeCalls)
    console.log('    诊断：保存前后新增通道调用 = ' + JSON.stringify(newCalls.map((c) => c.channel)))
    for (const c of newCalls) {
      if (c.channel === 'board:save') {
        const sent = c.args?.[1] ?? {}
        console.log('    诊断：发给宿主的白板 nodes=' + (sent.nodes?.length ?? '(无)') + ' title=' + sent.title
          + ' baseMtimeMs=' + c.args?.[2]
          + ' 宿主返回=' + JSON.stringify(c.inner))
      }
    }
    const after = JSON.parse(readFileSync(boardFile, 'utf8'))
    check('白板卡片已落盘', (after.nodes?.length ?? 0) > (before.nodes?.length ?? 0), `${before.nodes?.length ?? 0} → ${after.nodes?.length ?? 0} 个节点`)
  }
}

// ---------- 6.6 导入图片（第二挡：客户端文件框 + 宿主拷贝） ----------
if (boardNode2 && boardFile !== null && boardFile !== NOTES) {
  const attachDir = join(NOTES, '_attachments')
  const existing = existsSync(attachDir) ? readdirSync(attachDir).filter((f) => /\.(png|jpg|jpeg|gif|webp)$/i.test(f)) : []
  if (existing.length === 0) {
    check('导入图片（前置：库里有可复制的图片）', false, '库里没有图片')
  } else {
    // 造一个"库外"的图片文件，模拟用户从别处选一张图
    const outside = join(env.work, 'import-test.png')
    copyFileSync(join(attachDir, existing[0]), outside)
    const beforeCount = readdirSync(attachDir).length

    // 测试接缝：让"文件框"直接返回这张库外图片
    globalThis.__DSH_PICK_FILE_HOOK__ = async () => ({ path: outside, name: 'import-test.png', dataUrl: '' })
    const addImageBtn = H.byText(container, '+ 图片')
    check('找到「+ 图片」按钮', addImageBtn !== undefined, '')
    if (addImageBtn) {
      const beforeCalls2 = calls.length
      H.click(addImageBtn)
      await wait(1500)
      console.log('    诊断：导入图片新增调用 = ' + JSON.stringify(calls.slice(beforeCalls2).map((c) => c.channel + (c.ok ? '' : '(失败)'))))
      for (const c of calls.slice(beforeCalls2)) {
        if (!c.ok || (c.inner && c.inner.ok === false)) {
          console.log('    诊断：' + c.channel + ' 失败 error=' + (c.error ?? JSON.stringify(c.inner)) + ' args=' + JSON.stringify(c.args).slice(0, 200))
        }
      }
      const afterCount = readdirSync(attachDir).length
      check('图片被拷进库内 _attachments', afterCount > beforeCount, `${beforeCount} → ${afterCount}`)
      // 保存白板后应有 image 节点
      const saveBtn = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '保存')
      if (saveBtn) { H.click(saveBtn); await wait(1000) }
      const boardNow = JSON.parse(readFileSync(boardFile, 'utf8'))
      const imageNodes = (boardNow.nodes ?? []).filter((n) => n.type === 'image' && n.src)
      check('白板里有带 src 的图片卡片', imageNodes.length > 0, `图片节点 ${imageNodes.length} 个，src=${imageNodes[0]?.src ?? '（无）'}`)
      check('图片 src 指向库内相对路径', (imageNodes[0]?.src ?? '').startsWith('_attachments/'), imageNodes[0]?.src ?? '')
      check('附件名没有重复扩展名', !/\.(png|jpg|jpeg|gif|webp)\.(png|jpg|jpeg|gif|webp)$/i.test(imageNodes[0]?.src ?? ''), imageNodes[0]?.src ?? '')
    }
    delete globalThis.__DSH_PICK_FILE_HOOK__
  }
}

// ---------- 6.8 新建标签 ----------
if (todoRailBtn) { H.click(todoRailBtn); await wait(700) }
const tagsBefore = JSON.parse(readFileSync(join(DATA, 'tags.json'), 'utf8')).length
const newTagBtn = H.byTitle(container, '新建顶层标签')
check('找到「新建顶层标签」按钮', newTagBtn !== undefined, '')
if (newTagBtn) {
  H.click(newTagBtn)
  await wait(600)
  const renameInput = container.querySelector('input.tree-rename') ?? container.querySelector('.tag-panel input')
  if (renameInput) {
    H.setInput(renameInput, '交互冒烟标签')
    H.pressKey(renameInput, 'Enter')
    await wait(800)
  }
  const tagsAfter = JSON.parse(readFileSync(join(DATA, 'tags.json'), 'utf8'))
  check('tags.json 新增标签', tagsAfter.length > tagsBefore && tagsAfter.some((t) => t.name === '交互冒烟标签'), `${tagsBefore} → ${tagsAfter.length}`)
}

// ---------- 6.9 主题切换（写到插件根容器，不动宿主 documentElement） ----------
const settingsBtn = [...container.querySelectorAll('.rail-btn')].find((b) => (b.getAttribute('title') ?? '').includes('设置'))
check('找到「设置」入口', settingsBtn !== undefined, '')
if (settingsBtn) {
  H.click(settingsBtn)
  await wait(700)
  const dialog = container.querySelector('.modal')
  const themeSelect = dialog?.querySelector('select.select') ?? dialog?.querySelector('select')
  check('设置里有主题下拉', themeSelect !== null && themeSelect !== undefined, '')
  if (themeSelect) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
    if (setter) setter.call(themeSelect, 'dark'); else themeSelect.value = 'dark'
    themeSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
    await wait(300)
    const saveBtn = [...(dialog?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('保存'))
    if (saveBtn) { H.click(saveBtn); await wait(900) }
  }
  const root = container.querySelector('#dsh-quill-user-root')
  check('根容器 data-theme=dark', root?.getAttribute('data-theme') === 'dark', `data-theme=${root?.getAttribute('data-theme')}`)
  check('宿主 documentElement 未被改动', window.document.documentElement.dataset.theme === undefined, `documentElement data-theme=${window.document.documentElement.dataset.theme}`)
  const darkRules = container.innerHTML.includes("[data-theme='dark']") || container.innerHTML.includes('[data-theme="dark"]')
  check('深色样式规则在册', darkRules, '')
}

// ---------- 7. 回收站还原 ----------
if (notesRailBtn) { H.click(notesRailBtn); await wait(500) }
const trashRailBtn = [...container.querySelectorAll('.rail-btn')].find((b) => (b.getAttribute('title') ?? '').includes('回收站'))
check('找到「回收站」入口', trashRailBtn !== undefined, '')
if (trashRailBtn) {
  H.click(trashRailBtn)
  await wait(800)
  const dialog = container.querySelector('.modal')
  check('回收站弹窗已打开', dialog !== null, '')
  // 弹窗默认停在「任务回收站」，要先切到「笔记回收站」
  const noteTab = [...(dialog?.querySelectorAll('button.tab, button') ?? [])].find((b) => (b.textContent ?? '').includes('笔记回收站'))
  check('找到「笔记回收站」标签页', noteTab !== undefined, noteTab?.textContent?.trim() ?? '')
  if (noteTab) { H.click(noteTab); await wait(500) }
  const trashText = dialog?.textContent ?? ''
  check('回收站里能看到刚删的笔记', trashText.includes('交互冒烟笔记'), '')
  const restoreBtn = [...(dialog?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('恢复'))
  check('找到「恢复」按钮', restoreBtn !== undefined, '')
  if (restoreBtn) {
    // 先选中那一行（列表通常需要勾选再点恢复）
    const row = [...(dialog?.querySelectorAll('tr, .list-row, li, div') ?? [])].find((r) => (r.textContent ?? '').includes('交互冒烟笔记') && r.querySelector('input[type=checkbox]'))
    const box = row?.querySelector('input[type=checkbox]')
    if (box) { H.click(box); await wait(300) }
    H.click(restoreBtn)
    await wait(1000)
  }
  const back = listMd().some((p) => p.endsWith('交互冒烟笔记.md'))
  check('还原后文件回到 notes/', back, back ? '已恢复' : '未恢复')
}

// ---------- 8. 多库管理：新建一个库 → 切过去 → 切回来 ----------
const modalTitle = (m) => (m?.querySelector('.modal-head .grow')?.textContent ?? '').trim()
/** 关掉所有叠加的弹窗（前面的步骤可能留下回收站/设置弹窗） */
const closeAllModals = async () => {
  for (let i = 0; i < 8; i++) {
    const modals = [...container.querySelectorAll('.modal')]
    if (modals.length === 0) return
    const closeBtn = modals[modals.length - 1].querySelector('[title="关闭"]')
    if (closeBtn === null) return
    H.click(closeBtn)
    await wait(300)
  }
}
const lastModal = () => [...container.querySelectorAll('.modal')].at(-1) ?? null
const openSettings = async () => {
  await closeAllModals()
  const btn = [...container.querySelectorAll('.rail-btn')].find((b) => (b.getAttribute('title') ?? '').includes('设置'))
  if (btn) { H.click(btn); await wait(800) }
  return lastModal()
}
const countTreeNotes = () => container.querySelectorAll('.tree-node').length

{
  const newLibDir = join(env.work, 'lib2')
  let dlg = await openSettings()
  check('设置弹窗已打开', modalTitle(dlg) === '设置', modalTitle(dlg))
  const createBtn = [...(dlg?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('新建…'))
  check('设置里有「新建…」库入口', createBtn !== undefined, '')
  if (createBtn) {
    H.click(createBtn)
    await wait(700)
    dlg = lastModal()
    check('新建数据目录对话框在最上层', modalTitle(dlg) === '新建数据目录', modalTitle(dlg))
    const inputs = [...(dlg?.querySelectorAll('input.input') ?? [])]
    check('对话框里有目录与名称两个输入框', inputs.length === 2, `${inputs.length} 个，占位符=${JSON.stringify(inputs.map((i) => i.placeholder))}`)
    if (inputs.length >= 2) {
      H.setInput(inputs[0], newLibDir)
      H.setInput(inputs[1], '冒烟第二库')
      await wait(200)
      const okBtn = [...(dlg?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('创建并切换'))
      check('找到「创建并切换」按钮', okBtn !== undefined, '')
      if (okBtn) { H.click(okBtn); await wait(2500) }
      const toasts = [...container.querySelectorAll('.toast')].map((t) => (t.textContent ?? '').trim())
      if (toasts.length > 0) console.log('    诊断：提示 = ' + JSON.stringify(toasts))
    }
  }
  // 新库结构
  check('新库出现 notes/ 目录', existsSync(join(newLibDir, 'notes')), newLibDir)
  check('新库出现 data/ 目录', existsSync(join(newLibDir, 'data')), '')
  check('新库有 quill-library.json 标记', existsSync(join(newLibDir, 'quill-library.json')), '')

  // 注册表里应有 2 个库，且激活的是新的
  const libs = await env.rt.invoke('libraries:list', [])
  const items = libs?.value?.items ?? []
  check('注册表里有 2 个数据目录', items.length >= 2, items.map((i) => i.name).join(', '))
  const active = items.find((i) => i.id === libs?.value?.activeId)
  check('当前激活的是新库', (active?.dir ?? '').replace(/\\/g, '/').toLowerCase() === newLibDir.replace(/\\/g, '/').toLowerCase(), active?.dir ?? '')

  // 界面应已切到空库（切库走的是 quill:reload 重挂载，不是整页刷新）
  const notesRail = [...container.querySelectorAll('.rail-btn')].find((b) => (b.getAttribute('title') ?? '').includes('笔记库'))
  if (notesRail) { H.click(notesRail); await wait(900) }
  check('切库后面板重挂载并显示空库', countTreeNotes() === 0, `${countTreeNotes()} 个树节点`)

  // 切回测试自己的库（只点属于本次测试副本的那一行，绝不碰真实库）
  dlg = await openSettings()
  const rows = [...(dlg?.querySelectorAll('div, li, tr') ?? [])]
  const myRow = rows.find((r) => (r.textContent ?? '').includes(libDir) && r.querySelector('button'))
  const switchBtns = [...(myRow?.querySelectorAll('button') ?? [])].filter((b) => (b.textContent ?? '').trim() === '切换')
  check('设置里能看到测试库的「切换」按钮', switchBtns.length >= 1, `${switchBtns.length} 个`)
  if (switchBtns.length >= 1) {
    H.click(switchBtns[0])
    await wait(2500)
  }
  const libs2 = await env.rt.invoke('libraries:list', [])
  const active2 = (libs2?.value?.items ?? []).find((i) => i.id === libs2?.value?.activeId)
  check('已切回原库', (active2?.dir ?? '').replace(/\\/g, '/').toLowerCase() === libDir.replace(/\\/g, '/').toLowerCase(), active2?.dir ?? '')
  const notesRail2 = [...container.querySelectorAll('.rail-btn')].find((b) => (b.getAttribute('title') ?? '').includes('笔记库'))
  if (notesRail2) { H.click(notesRail2); await wait(900) }
  check('切回后重新看到原来的笔记', countTreeNotes() > 0, `${countTreeNotes()} 个树节点`)
}

// ---------- 真实数据零改动 ----------
{
  const diffs = []
  for (const [root, before] of realBefore) {
    const after = snapshotTree(root)
    for (const [rel, sig] of after) {
      const old = before.get(rel)
      if (old === undefined) diffs.push(`新增 ${root}\\${rel}`)
      else if (old !== sig) diffs.push(`改动 ${root}\\${rel}`)
    }
    for (const rel of before.keys()) if (!after.has(rel)) diffs.push(`删除 ${root}\\${rel}`)
  }
  check('用户真实数据零改动', diffs.length === 0, diffs.length === 0 ? '快照完全一致' : diffs.slice(0, 6).join('；'))
}

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok)
console.log(`\n=== 汇总 ===\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
console.log(`通道调用 ${calls.length} 次，失败 ${calls.filter((c) => !c.ok).length} 次`)
if (calls.some((c) => !c.ok)) console.log('  失败通道：' + [...new Set(calls.filter((c) => !c.ok).map((c) => c.channel))].join(', '))
console.log('库副本：' + libDir)
process.exit(failed.length === 0 ? 0 : 1)
