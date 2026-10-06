/**
 * 大库性能测试：往库副本里造出成百上千篇笔记，量一量"打开面板要多久 / 列目录要多久"。
 *
 * 用户关心的是"使用体验不受阻"，所以这里给的是**数字**，不是感觉。
 *
 *   node tools/smoke-perf.mjs [笔记数]      # 默认 600
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createEnv, wait } from './jsdom-env.mjs'

const COUNT = Number(process.argv[2] ?? 600)
const FOLDERS = 20

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`)
}

console.log(`造数据：${COUNT} 篇笔记，分布在 ${FOLDERS} 个笔记夹里…`)
const t0 = Date.now()
const env = await createEnv({
  prepare(libDir) {
    const notes = join(libDir, 'notes')
    for (let i = 0; i < COUNT; i++) {
      const dir = join(notes, '压测夹' + String(i % FOLDERS).padStart(2, '0'))
      mkdirSync(dir, { recursive: true })
      const id = 'note_perf' + String(i).padStart(6, '0')
      const body = [
        '---',
        `id: ${id}`,
        `title: 压测笔记 ${i}`,
        `created: 2026-10-01T00:00:${String(i % 60).padStart(2, '0')}`,
        `updated: 2026-10-01T00:00:${String(i % 60).padStart(2, '0')}`,
        '---',
        '',
        `# 压测笔记 ${i}`,
        '',
        '这是一篇用于性能测试的笔记。'.repeat(6),
        ''
      ].join('\n')
      writeFileSync(join(dir, `压测笔记 ${i}.md`), body, 'utf8')
    }
  }
})
const { container, rt } = env
console.log(`  副本就绪，造数据耗时 ${Date.now() - t0}ms\n`)

// ---------- 1. 宿主侧：列目录 / 统计 ----------
const t1 = Date.now()
const tree = await rt.invoke('note:tree', [])
const treeMs = Date.now() - t1
const countNodes = (list) => (list ?? []).reduce((n, x) => n + 1 + countNodes(x.children), 0)
const total = countNodes(tree?.value)
check('note:tree 返回全部笔记', total >= COUNT, `${total} 个节点，耗时 ${treeMs}ms`)
check('列目录耗时在可接受范围（< 3000ms）', treeMs < 3000, `${treeMs}ms`)

const t2 = Date.now()
const stats = await rt.invoke('library:stats', [])
const statsMs = Date.now() - t2
check('library:stats 准确', (stats?.value?.notes ?? 0) >= COUNT, `${stats?.value?.notes} 篇，耗时 ${statsMs}ms`)

// ---------- 2. 前端侧：挂载到"树渲染出来" ----------
const t3 = Date.now()
env.mount(container)
let rendered = 0
for (let i = 0; i < 60; i++) {
  await wait(250)
  rendered = container.querySelectorAll('.tree-node').length
  if (rendered > 0) break
}
const mountMs = Date.now() - t3
check('面板挂载并渲染出笔记树', rendered > 0, `首屏 ${rendered} 个树节点，耗时 ${mountMs}ms`)
check('首屏渲染耗时在可接受范围（< 8000ms）', mountMs < 8000, `${mountMs}ms`)
check('首屏没有把上千节点全渲染出来（虚拟/折叠生效）', rendered <= total, `${rendered} / ${total}`)

// 切到 Todolist 再切回来，量一次"区域切换"
const { window } = env
const H = (await import('./jsdom-env.mjs')).domHelpers(window)
const railBtns = () => [...container.querySelectorAll('.rail-btn')]
const todoBtn = railBtns().find((b) => (b.getAttribute('title') ?? '') === 'Todolist')
const notesBtn = railBtns().find((b) => (b.getAttribute('title') ?? '').includes('笔记库'))
const t4 = Date.now()
H.click(todoBtn)
await wait(400)
H.click(notesBtn)
await wait(700)
const switchMs = Date.now() - t4
check('区域来回切换流畅（< 2500ms）', switchMs < 2500, `${switchMs}ms`)

console.log('\n=== 数字汇总 ===')
console.log(`笔记数            ${COUNT}（+ 原有 12 篇）`)
console.log(`note:tree         ${treeMs}ms`)
console.log(`library:stats     ${statsMs}ms`)
console.log(`首屏挂载+渲染      ${mountMs}ms`)
console.log(`区域切换往返       ${switchMs}ms`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
process.exit(failed.length === 0 ? 0 : 1)
