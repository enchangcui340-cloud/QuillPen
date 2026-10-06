/**
 * 测试用路径收口。
 *
 * 以前每个测试脚本都写死 `D:/DSH/test01/quill-dsh`（47 处 / 23 个文件），
 * 一旦复制成第二份插件就全错。这里统一从「本文件所在的仓库根」推出来：
 *   仓库根 = path.dirname(paths.mjs 所在目录)
 * 于是 dev 版、用户版各跑各的，测试脚本本身不用改。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（含 build.mjs / packages / src-client 的那个目录） */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 插件包目录名（用户版会不同） */
export function packageDirName() {
  const base = join(ROOT, 'packages')
  const hit = existsSync(base)
    ? readdirSync(base, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.startsWith('dsh-quill'))
    : undefined
  return hit === undefined ? 'dsh-quill' : hit.name
}

export const PKG = join(ROOT, 'packages', packageDirName())
export const PKG_JSON = join(PKG, 'package.json')
export const TOOLS = join(ROOT, 'tools')
export const CLIENT = join(ROOT, 'src-client')
export const HOST = join(ROOT, 'src-host')
export const SHARED = join(ROOT, 'shared')

/** 构建产物 */
export const HOST_BUNDLE = join(PKG, 'lib', 'host.js')
export const CLIENT_BUNDLE = join(PKG, 'lib', 'client.js')
export const STYLES_GENERATED = join(CLIENT, 'styles.generated.ts')

/**
 * 测试用的外部依赖与库夹具：**都不写死本机路径**，找不到就回退到仓库自带夹具。
 *
 * 开源用户可以：
 *   · `pnpm install`（esbuild/postcss/jsdom/ajv 都有），或
 *   · 设 `DSH_QUILL_TEST_MODULES=<含这些包的 node_modules>`，
 *   · 或什么都不做 —— 用仓库自带的 `tools/fixtures/mini-library` 跑测试。
 */

/**
 * 找一个**真正能解析到测试依赖**（jsdom / ajv / esbuild / postcss）的 package.json。
 *
 * 注意：不能只看"文件存在"——包目录的 package.json 一定存在，但它下面未必装了 ajv。
 * 所以逐个候选**实际 resolve 一次**，谁成功用谁；都失败就回退到仓库根（并给出可操作的报错）。
 */
export function depsRequireBase() {
  const candidates = []
  if (process.env.DSH_QUILL_TEST_MODULES) {
    candidates.push(join(process.env.DSH_QUILL_TEST_MODULES, '..', 'package.json'))
  }
  candidates.push(join(ROOT, 'package.json'), join(ROOT, 'packages', packageDirName(), 'package.json'))
  for (const c of candidates) {
    if (!existsSync(c)) continue
    const req = createRequire(c)
    try { req.resolve('ajv') } catch { continue }
    return c
  }
  // 都没解析到：返回仓库根（调用方拿到的是清晰的 MODULE_NOT_FOUND）
  return join(ROOT, 'package.json')
}

/** 兼容旧名（有些脚本用它 createRequire 取 ajv/jsdom） */
export const WORKAPP_PKG_JSON = depsRequireBase()

/**
 * 装着测试/构建依赖的 node_modules 目录。
 * 之前多处写死 `D:/DSH/test01/workapp/node_modules` —— 开源用户没有那个目录，
 * 而且写死会让 esbuild 从别处解析出**第二份 React**（症状：Invalid hook call）。
 */
export const DEPS_MODULES = join(dirname(WORKAPP_PKG_JSON), 'node_modules')

/**
 * 测试用的笔记库。
 *
 * 优先用环境变量 `DSH_QUILL_TEST_LIBRARY` 指定的库（开发机可指向真实库的**副本**）；
 * 否则用仓库自带的迷你夹具（开源用户零配置可跑）。
 *
 * 夹具必须**结构完整**，否则依赖"库里有笔记"的测试会假失败（曾经只造了 notes/ 目录没造索引，
 * smoke-render 的「笔记树已渲染」就挂了）。这里按 Quill 的真实结构生成：
 *   quill-library.json（库标识）+ data/notes.json（笔记索引）+ data/tasks.json + notes/ 下的实际文件
 */
export const FIXTURE_LIBRARY = join(ROOT, 'tools', 'fixtures', 'mini-library')

function ensureMiniLibrary() {
  if (existsSync(join(FIXTURE_LIBRARY, 'quill-library.json')) && existsSync(join(FIXTURE_LIBRARY, 'data', 'notes.json'))) {
    return FIXTURE_LIBRARY
  }
  mkdirSync(join(FIXTURE_LIBRARY, 'notes', '示例笔记夹'), { recursive: true })
  mkdirSync(join(FIXTURE_LIBRARY, 'data'), { recursive: true })
  // 按真实库补齐这些目录：库引导/回收站/收件箱/附件都会用到，
  // 缺了会让"笔记树已渲染"之类的断言假失败（踩过）。
  for (const d of ['notes/_attachments', '.trash', '_收件箱', 'docs', 'data/backups']) {
    mkdirSync(join(FIXTURE_LIBRARY, d), { recursive: true })
  }

  const notes = [
    {
      // 插件首次打开库时会自动生成这个说明文件（library.ts 的 ensureReadme）。
      // 夹具必须**预置并登记进索引** —— 这样才等价于"一个已用过的库"；
      // 否则它会在测试过程中被生成出来却不入索引，导致"磁盘/索引/树"三处数字对不上（踩过）。
      id: 'note_fixture0000', kind: 'md', fileName: '关于这个笔记库.md', dir: '', title: '关于这个笔记库',
      createdAt: '2026-01-01T09:55:00', updatedAt: '2026-01-01T09:55:00',
      fileMtimeMs: Date.parse('2026-01-01T09:55:00'), trashed: false, originPath: null, aiTouched: false
    },
    {
      id: 'note_fixture0001', kind: 'md', fileName: '欢迎.md', dir: '', title: '欢迎',
      createdAt: '2026-01-01T10:00:00', updatedAt: '2026-01-01T10:00:00',
      fileMtimeMs: Date.parse('2026-01-01T10:00:00'), trashed: false, originPath: null, aiTouched: false
    },
    {
      id: 'note_fixture0002', kind: 'md', fileName: '示例笔记.md', dir: '示例笔记夹', title: '示例笔记',
      createdAt: '2026-01-01T10:05:00', updatedAt: '2026-01-01T10:05:00',
      fileMtimeMs: Date.parse('2026-01-01T10:05:00'), trashed: false, originPath: null, aiTouched: false
    },
    {
      id: 'board_fixture001', kind: 'whiteboard', fileName: '示例白板.canvas.json', dir: '', title: '示例白板',
      createdAt: '2026-01-01T10:10:00', updatedAt: '2026-01-01T10:10:00',
      fileMtimeMs: Date.parse('2026-01-01T10:10:00'), trashed: false, originPath: null, aiTouched: false
    }
  ]

  writeFileSync(
    join(FIXTURE_LIBRARY, 'quill-library.json'),
    JSON.stringify({ id: 'lib_fixture0001', name: '测试夹具库', createdAt: '2026-01-01T10:00:00.000Z', schema: 1, app: 'Quill' }, null, 2),
    'utf8'
  )
  writeFileSync(join(FIXTURE_LIBRARY, 'data', 'notes.json'), JSON.stringify(notes, null, 2), 'utf8')
  // 待办与标签也必须非空：界面**默认停在待办区**，夹具 tasks 为空时待办区渲染不出 .tree-node，
  // 会让「笔记树已渲染」这条断言假失败（踩过 —— 用真实库能过、用夹具不能过）。
  writeFileSync(join(FIXTURE_LIBRARY, 'data', 'tags.json'), JSON.stringify([
    { id: 'tag_fixture0001', name: '示例标签', parentId: null, createdAt: '2026-01-01T10:00:00' }
  ], null, 2), 'utf8')
  writeFileSync(join(FIXTURE_LIBRARY, 'data', 'tasks.json'), JSON.stringify([
    {
      id: 'task_fixture0001', name: '示例待办', tagIds: ['tag_fixture0001'], priority: 'minor',
      ddl: null, ddlInferred: false, done: false, doneAt: null, noteId: null, origin: 'manual',
      createdAt: '2026-01-01T10:00:00', updatedAt: '2026-01-01T10:00:00'
    }
  ], null, 2), 'utf8')
  // 插件首次打开库会自动生成这个说明文件（library.ts 的 ensureReadme）。夹具预置它，
  // 才能等价于"一个已经用过的库"；否则它会在测试中途被生成出来却不入索引，
  // 导致"磁盘 / 索引 / 树"三处数字对不上（踩过）。
  writeFileSync(
    join(FIXTURE_LIBRARY, 'notes', '关于这个笔记库.md'),
    ['---', 'title: 关于这个笔记库', '---', '', '# 关于这个笔记库', '', '（测试夹具：占位说明文件。）', ''].join('\n'),
    'utf8'
  )
  writeFileSync(join(FIXTURE_LIBRARY, 'notes', '欢迎.md'), '# 欢迎\n\n这是测试夹具笔记。\n', 'utf8')
  writeFileSync(join(FIXTURE_LIBRARY, 'notes', '示例笔记夹', '示例笔记.md'), '# 示例笔记\n\n正文示例 abc。\n', 'utf8')
  writeFileSync(
    join(FIXTURE_LIBRARY, 'notes', '示例白板.canvas.json'),
    // 必须带 type/version/title —— 缺了 type 插件就不认这是白板，文件会"凭空消失"（正是回归断言要防的）
    JSON.stringify({
      id: 'board_fixture001',
      type: 'whiteboard',
      version: 1,
      title: '示例白板',
      nodes: [{ id: 'n1', x: 0, y: 0, w: 200, h: 100, text: '示例卡片', color: null, noteId: null }],
      edges: []
    }, null, 2),
    'utf8'
  )
  // 附件：有些测试要"从库里复制一张图片"，夹具里必须有真图片，否则那几步会假失败
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  writeFileSync(join(FIXTURE_LIBRARY, 'notes', '_attachments', '示例图片.png'), png)
  return FIXTURE_LIBRARY
}

/** 真实笔记库（只读参考；开源环境下退化为夹具） */
export const REAL_LIBRARY = process.env.DSH_QUILL_TEST_LIBRARY ?? ensureMiniLibrary()
/** 测试副本的来源：默认就是上面那个（开发机可用环境变量指向自己的快照） */
export const LIBRARY_SNAPSHOT = process.env.DSH_QUILL_TEST_LIBRARY ?? ensureMiniLibrary()

/** 当前包名（用于断言 patch 里的引用） */
export function packageName() {
  return JSON.parse(readFileSync(PKG_JSON, 'utf8')).name
}
