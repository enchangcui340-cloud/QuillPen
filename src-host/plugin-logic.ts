/**
 * DSH 版宿主逻辑入口。
 *
 * 职责：把 Quill 原 `index.ts` 的 90 个 IPC 通道初始化成一张可调用的通道表，
 * 供插件外壳（lib/index.js）里的 HTTP 路由使用。
 *
 * 设计要点：
 *  1. **不改写** Quill 的业务代码：`bootstrap()` 建服务，`registerIpc()` 注册通道。
 *  2. 目录隔离：把 shim 的 `appData`/`exe` 指到插件自己的数据目录，于是原代码算出来的
 *     `userData` 落在插件目录里，不会写到 Quill 的 `%APPDATA%\workapp`。
 *  3. ⚠️ 这里必须用**动态 import**：原 `index.ts` 的顶层会立刻执行
 *     `resolveInstallData(dirname(app.getPath('exe')), app.getPath('appData'))` 并据此算出 userData。
 *     如果写成静态 import，ESM 会把它提升到本文件所有语句之前 —— 目录还没来得及设置，
 *     userData 就会指回真实的 `%APPDATA%\workapp`（实测：注册表列出来的是用户 Quill 的库，
 *     而且会往那边写文件）。动态 import 才能保证"先设目录、再执行原顶层"。
 *  4. 首次运行把 Quill 的库注册表**只读复制**过来，这样多数据目录列表能继承过来。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { app, channelNames, invokeChannel, setDialogHandler, setShellHandler } from './electron-shim'
// 纯模块（无副作用），可以静态引入：用它生成合法的库 ID / 注册表结构
import { newLibraryId, type LibraryRegistry } from './core/libraries'

export interface RuntimeOptions {
  /** 插件自己的数据目录（配置、库注册表、日志都落这里） */
  dataDir: string
  /** 笔记库根目录 */
  libraryRoot: string
}

export interface QuillRuntime {
  /** 已注册的通道名（诊断用） */
  channels: string[]
  /** 当前使用的库根目录 */
  libraryRoot(): string
  /** 调用一个通道；通道不存在时返回 undefined */
  invoke(channel: string, args: unknown[]): Promise<unknown> | undefined
  /** 附件绝对路径（越界返回 undefined） */
  attachmentAbs(rel: string): string | undefined
  /** 设置系统文件/目录选择器的真实实现 */
  setDialogHandler(handler: Parameters<typeof setDialogHandler>[0]): void
  /** 设置系统集成（打开链接 / 在资源管理器中显示）的实现；测试用它避免真的弹资源管理器 */
  setShellHandler(handler: Parameters<typeof setShellHandler>[0]): void
}

/**
 * 准备库注册表（`<userData>/libraries.json`）。
 *
 * 为什么必须做：
 *  原版 `loadLibraries()` 只在"注册表为空 + config.libraryPath 有值"时才登记第一个库。
 *  插件是零配置接管的（注册表空、config 也空），于是**当前库根本不会被登记** ——
 *  界面里"数据目录"列表只有后来新建的那个，用户没有按钮切回原来的库。
 *
 * 策略：
 *  1. 首次运行：如果 Quill 自己的 `%APPDATA%\workapp\libraries.json` 存在，**只读复制**过来，
 *     这样用户原来的多库列表直接继承（只读，不写 Quill 的目录）。
 *  2. 无论继承与否，确保「当前库」在列表里并处于激活状态。
 */
function prepareLibraryRegistry(dataDir: string, libraryRoot: string): void {
  const userData = join(dataDir, 'workapp') // = resolveInstallData(dirname(exe), dataDir).userData
  mkdirSync(userData, { recursive: true })
  const file = join(userData, 'libraries.json')

  let registry: LibraryRegistry = { version: 1, activeId: '', items: [] }
  let source = '空注册表'
  if (existsSync(file)) {
    try {
      registry = JSON.parse(readFileSync(file, 'utf8')) as LibraryRegistry
      source = '已有注册表'
    } catch {
      registry = { version: 1, activeId: '', items: [] }
    }
  } else {
    // 测试隔离：自动化测试不继承真实库列表，避免"点错切换"跑到用户真实库里去
    const inherit = process.env.DSH_QUILL_NO_REGISTRY_INHERIT !== '1'
    const quillFile = join(process.env.APPDATA ?? '', 'workapp', 'libraries.json')
    if (inherit && existsSync(quillFile)) {
      try {
        registry = JSON.parse(readFileSync(quillFile, 'utf8')) as LibraryRegistry
        source = '继承 Quill 的库列表'
      } catch {
        registry = { version: 1, activeId: '', items: [] }
      }
    }
  }
  if (!Array.isArray(registry.items)) registry.items = []

  const abs = resolve(libraryRoot)
  const hit = registry.items.find((i) => resolve(i.path) === abs)
  if (hit !== undefined) {
    registry.activeId = hit.id
  } else {
    const entry = {
      id: newLibraryId(basename(abs) || '工作区'),
      name: basename(abs) || '工作区',
      kind: 'local' as const,
      path: abs,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString()
    }
    registry.items.push(entry)
    registry.activeId = entry.id
  }
  writeFileSync(file, JSON.stringify(registry, null, 2), 'utf8')
  console.log(`[dsh-quill] 库注册表就绪（${source}）：${registry.items.length} 个库，激活 ${basename(abs)}`)
}

export async function createRuntime(options: RuntimeOptions): Promise<QuillRuntime> {
  // 目录隔离：必须在载入原 index.ts 之前设置（它的顶层会据此算 userData）
  mkdirSync(options.dataDir, { recursive: true })
  app.setPath('appData', options.dataDir)
  app.setPath('exe', join(options.dataDir, 'quill-runtime.exe'))
  prepareLibraryRegistry(options.dataDir, options.libraryRoot)

  // 动态 import：保证上面两行先执行（写成静态 import 会被 ESM 提升，见文件头说明）
  const quill: typeof import('./index.js') = await import('./index.js')

  quill.bootstrap(options.libraryRoot)
  quill.registerIpc()

  const runtime = quill.quillRuntime()
  return {
    channels: channelNames(),
    libraryRoot: () => runtime.store.paths.root,
    invoke: (channel, args) => invokeChannel(channel, args),
    attachmentAbs: (rel) => runtime.notes.attachmentAbs(rel),
    setDialogHandler,
    setShellHandler
  }
}
