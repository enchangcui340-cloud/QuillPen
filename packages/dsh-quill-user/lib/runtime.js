/**
 * 共享运行时（面板外壳 与 羽毛笔工具层 共用同一份）。
 *
 * 为什么必须共享：
 *   · host.js 里的服务与通道表是**模块级**的（bootstrap 会整体换代），
 *     一个进程里同时存在两份 runtime 只会互相顶掉 ——
 *     也就是"两个索引抢写同一个库"，绝对要避免；
 *   · 所以这里做**进程级单例**：谁先要谁创建，之后所有人拿到同一个对象；
 *     切库不重建它（切库是调用 library:switch / libraries:activate 通道，
 *     由宿主内部的 bootstrap 换代服务，runtime 句柄通过 getter 保持活引用）。
 *
 * 另一个职责：**host.js 的热重载** —— 每次取用前比对 mtime，变了就 `?t=` 破缓存重新 import，
 * 于是"改服务层代码 → 刷新页面"即可生效，不必重启 DSH。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOGIC = join(HERE, 'host.js')

/**
 * 进程级共享槽。挂在 globalThis 上而不是模块作用域：
 * 面板外壳（dsh-quill）与工具入口（dsh-quill/tools）可能被 Loader 加载成不同的模块实例，
 * 模块级变量不共享；挂 globalThis 才能保证全进程只有一份 runtime。
 */
const slot = (globalThis.__dshQuillRuntime ??= { loaded: null, runtime: null, dataDir: '' })

/** 读插件配置：库路径、数据目录。优先级：插件 config > 环境变量 > Quill 配置 > 兜底 */
export function resolveOptions(config) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const envDataDir = typeof process.env.DSH_QUILL_DATA_DIR === 'string' ? process.env.DSH_QUILL_DATA_DIR.trim() : ''
  const envLibrary = typeof process.env.DSH_QUILL_LIBRARY_ROOT === 'string' ? process.env.DSH_QUILL_LIBRARY_ROOT.trim() : ''

  const dataDir = typeof config?.dataDir === 'string' && config.dataDir.trim() !== ''
    ? resolve(config.dataDir.trim())
    : (envDataDir !== '' ? resolve(envDataDir) : join(dshHome, 'quill-plugin-user'))

  let libraryRoot = typeof config?.libraryRoot === 'string' ? config.libraryRoot.trim() : ''
  if (libraryRoot === '') libraryRoot = envLibrary
  // 用户版：**不继承** Quill 原来的配置 —— 首次使用就是一个干净的新库（用户要求）。
  // （dev 版会读 %APPDATA%\workapp\config.json 的 libraryPath 来"零配置接管旧库"；用户版故意不这么做。）
  // 想指定已有目录：在插件配置里写 libraryRoot，或设环境变量 DSH_QUILL_LIBRARY_ROOT。
  if (libraryRoot === '') libraryRoot = join(homedir(), 'Documents', 'QuillNotes')

  return { dataDir, libraryRoot: resolve(libraryRoot) }
}

/** 载入宿主逻辑；host.js 变了就换一份（开发期免重启的关键） */
async function loadLogic() {
  const mtimeMs = statSync(LOGIC).mtimeMs
  if (slot.loaded !== null && slot.loaded.mtimeMs === mtimeMs) return slot.loaded.mod
  const mod = await import(pathToFileURL(LOGIC).href + '?t=' + mtimeMs)
  slot.loaded = { mtimeMs, mod }
  slot.runtime = null // 逻辑换代 → 重建
  return mod
}

/**
 * 拿到共享 runtime（没有就创建）。
 * 第二次调用如果 dataDir 变了（配置改动），会重建 —— 因为数据目录是进程级身份，
 * 不能两个 dataDir 混用；库路径变化不算，那种情况走切库通道。
 */
export async function ensureRuntime(config) {
  const options = resolveOptions(config)
  if (slot.runtime !== null && slot.dataDir === options.dataDir) return slot.runtime
  const mod = await loadLogic()
  const runtime = await mod.createRuntime(options)
  slot.runtime = runtime
  slot.dataDir = options.dataDir
  return runtime
}

/** 直接调一个宿主通道；返回 `{ ok, value }` / `{ ok:false, error }` 信封 */
export async function callChannel(config, channel, args = []) {
  const runtime = await ensureRuntime(config)
  const fn = runtime.invoke(channel, args)
  if (fn === undefined) return { ok: false, error: '未知通道：' + channel }
  return await fn
}

/** 与 callChannel 相同，但失败时直接抛错（工具层用，让错误变成工具错误） */
export async function callOrThrow(config, channel, args = []) {
  const result = await callChannel(config, channel, args)
  if (result === null || typeof result !== 'object' || result.ok !== true) {
    throw new Error(String(result?.error ?? '通道 ' + channel + ' 调用失败'))
  }
  return result.value
}

/** 当前库根目录（活引用） */
export async function currentLibraryRoot(config) {
  const runtime = await ensureRuntime(config)
  return runtime.libraryRoot()
}
