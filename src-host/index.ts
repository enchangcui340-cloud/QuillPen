// DSH 版：把 Electron 换成等价 shim（见 electron-shim.ts 顶部说明）。
// 原文件其余部分保持不动，便于与 Quill 上游对照。
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, net, protocol, shell, webUtils } from './electron-shim'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
// DSH 版：原来是函数内 require('node:child_process')，在 esbuild 的 ESM 产物里会运行时报错，改成顶层 import
import { execFileSync } from 'node:child_process'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CH } from '@shared/ipc'
import {
  fileExists, isImagePath, isPdfPath, isTextDocPath, pageAttachmentName, renderPdfPages, statOf
} from './services/doc-read'
import type { CandidateTask, ConversationItem, PendingConfirm } from '@shared/api'
import type { AppConfig, WhiteboardFile } from '@shared/types'
import { installCrashHandlers, log } from './core/logger'
import { defaultLibraryRoot } from './core/paths'
import {
  MIGRATION_MARKER,
  resolveInstallData,
  resolveLibraryRoot,
  shouldMigrateInto,
  toStoredLibraryPath,
  type InstallPlan
} from './core/install'
import { Store } from './core/store'
import { SftpClient, type CloudTarget } from './services/sftp'
import { Client } from 'ssh2'
import {
  CLOUD_QUOTA_BYTES,
  connectCloud,
  deviceId,
  deviceJoin,
  deviceLeave,
  deviceName,
  listDevices,
  localCloudUsage,
  readEmptyState,
  readStamp,
  removeDevice,
  sftpGetFile,
  sftpList,
  sftpMkdirp,
  sftpPutFile,
  sftpRead,
  sftpUnlink,
  sftpWrite,
  setDeviceName,
  writeStamp
} from './services/cloud-dirs'
import { decodeCloudKey, encodeCloudKey, type CloudKeyPayload } from './core/cloud-key'
import { attachmentRefs, isCopyable, planCopyPaths, type CopyItem } from './core/copy-plan'
import { readdirSync } from 'node:fs'
import { cloudPaths, dropBackup, ensureDir, hasBackup, restoreBackup, scanFiles, stashCurrentAsBackup } from './services/cloud'
import { describeDiff, diffForOverwrite, formatBytes, normalizeRel } from './core/sync-plan'
import {
  createLibraryAt,
  libraryStats,
  loadRegistry,
  looksLikeLibrary,
  normalizeDirInput,
  repairRegistryIds,
  newLibraryId,
  resolveLibraryDir,
  saveRegistry,
  toStoredLibraryDir,
  type LibraryEntry,
  type LibraryRegistry
} from './core/libraries'
import { AiService, type IncomingAttachment } from './services/ai'
import { isMcpMode, runMcpMode } from './ai/mcp/entry'
import { extractFile } from './services/extract'
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.mjs'
import { BoardService } from './services/boards'
import { LibraryService } from './services/library'
import { NoteService } from './services/notes'
import { SecretService } from './services/secrets'
import { TaskService } from './services/tasks'
import * as V from './ipc/validate'
import { parseDataUrl } from './core/dataurl'
import { DSH_ATTACHMENT_SCHEME } from './ipc/board-ref'

const VERSION = '1.1.0'

/** 本次启动使用的数据目录计划（多份安装各自独立） */
let installPlan: InstallPlan

// 应用改名为 Quill 后，用户数据目录仍沿用原来的 workapp，
// 保证已有的配置、API Key、日志不会因为改名而丢失。
// 多份安装（文件夹里有"工作区"）各自用独立数据目录，避免设置/密钥/笔记库互相串。
// 必须在任何读取 userData 的调用之前设置。
installPlan = resolveInstallData(dirname(app.getPath('exe')), app.getPath('appData'), existsSync)
app.setPath('userData', installPlan.userData)
if (installPlan.portable) migrateSharedData(installPlan.userData, installPlan.slug)

// 白板/笔记里的附件通过自定义协议读取。必须在 app ready 之前登记为特权协议，
// 否则渲染进程加载 dsh-attachment:// 时会被当成不安全的未知协议而直接失败
// （白板图片显示不出来就是这个原因）。
protocol.registerSchemesAsPrivileged([{
  scheme: DSH_ATTACHMENT_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
}])

/** 选择附件时返回给界面的结构（PDF 由界面转换为图片）。 */
interface PickedFile {
  name: string
  kind: 'image' | 'text' | 'pdf'
  dataUrl?: string
  text?: string
  warning?: string
  /** 多页文件的其余页面（仅发送第一页时有值） */
  extraPages?: string[]
}
let store: Store
let tasks: TaskService
let notes: NoteService
let boards: BoardService
let library: LibraryService
let secrets: SecretService
let ai: AiService

/**
 * 首次以独立数据目录启动时，把旧的统一目录里的配置与 API Key 复制过来，
 * 这样用户不用重新设置、也不用重填 Key（只复制不删除原文件）。
 */
function migrateSharedData(target: string, slug: string): void {
  try {
    mkdirSync(target, { recursive: true })
    // 只在"从没初始化过"时迁移一次。
    // 否则用户删掉的 API Key 会在下次启动被重新拷回来（表现为"删不掉"）。
    if (!shouldMigrateInto(target, existsSync)) return
    // 依次尝试：之前版本放在应用目录里的这份 -> 最早那份共用的
    const sources = [join(app.getPath('appData'), 'workapp-' + slug), join(app.getPath('appData'), 'workapp')]
    for (const name of ['config.json', 'secrets.json']) {
      const to = join(target, name)
      if (existsSync(to)) continue
      for (const src of sources) {
        const from = join(src, name)
        if (existsSync(from)) {
          copyFileSync(from, to)
          log('已把 ' + name + ' 迁移到软件文件夹：' + to)
          break
        }
      }
    }
    writeFileSync(join(target, MIGRATION_MARKER), new Date().toISOString(), 'utf8')
    log('软件文件夹初始化完成，之后不再从应用目录迁移')
  } catch (e) {
    log('迁移旧配置失败（不影响使用）：' + (e instanceof Error ? e.message : String(e)))
  }
}

/** 切换/设置笔记库：便携版把"软件文件夹内部"的路径存成相对路径，方便整个文件夹拷走 */
function setLibraryPortable(abs: string): void {
  store.setLibrary(abs)
  const stored = toStoredLibraryPath(abs, installPlan.installDir)
  if (stored !== abs) store.patchConfig({ libraryPath: stored })
}

/** 库注册表文件（跟着应用数据目录走） */
function registryPath(): string {
  return join(app.getPath('userData'), 'libraries.json')
}

let registry: LibraryRegistry = { version: 1, activeId: '', items: [] }

/** 载入注册表；首次运行把现有的 libraryPath 无感登记成第一个库 */
function loadLibraries(): void {
  registry = loadRegistry(registryPath())
  // 早期版本生成的库 ID 太短，会被校验器拒绝 —— 这里顺手修好并落盘
  if (repairRegistryIds(registry)) {
    saveRegistry(registryPath(), registry)
    log('已修复数据目录 ID 格式')
  }
  const current = (store.config.libraryPath ?? '').trim()
  if (!registry.items.length) {
    const abs = current ? resolveLibraryDir(current, installPlan.installDir) : (installPlan.ownLibrary ?? '')
    if (abs && existsSync(abs)) {
      const name = installPlan.ownLibrary && resolve(abs) === resolve(installPlan.ownLibrary) ? '主工作区' : basename(abs)
      registry.items.push({
        id: newLibraryId(name),
        name,
        kind: 'local',
        path: toStoredLibraryDir(abs, installPlan.installDir),
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString()
      })
      registry.activeId = registry.items[0].id
      saveRegistry(registryPath(), registry)
      log('已把现有数据目录登记为第一个库：' + name + ' -> ' + abs)
    }
  }
}

function activeLibrary(): LibraryEntry | null {
  return registry.items.find((i) => i.id === registry.activeId) ?? null
}

function activeLibraryDir(): string {
  const entry = activeLibrary()
  return entry ? resolveLibraryDir(entry.path, installPlan.installDir) : store.paths.root
}

/** 切换激活的库：写注册表 + 重建服务 + 写回配置（供下次启动直接用） */
function activateLibrary(id: string): string {
  const entry = registry.items.find((i) => i.id === id)
  if (!entry) throw new Error('找不到这个数据目录')
  // 云数据目录的本机副本就是一个普通目录，切换方式完全一样
  const abs = resolveLibraryDir(entry.path, installPlan.installDir)
  if (!existsSync(abs)) {
    if (entry.kind === 'cloud') {
      // 本机副本可能被清理过，重新建一个空目录（内容用「下载」从云端取）
      mkdirSync(abs, { recursive: true })
      log('云数据目录的本机副本不存在，已重建空目录：' + abs)
    } else {
      throw new Error('这个数据目录不存在了：' + abs)
    }
  }
  registry.activeId = id
  entry.lastUsedAt = new Date().toISOString()
  saveRegistry(registryPath(), registry)
  setLibraryPortable(abs)
  store.patchConfig({ portableLibrarySet: true })
  bootstrap(abs)
  // 打开云数据目录 = 这台设备正在使用它 -> 刷新连接登记（并清掉空置倒计时）
  if (entry.kind === 'cloud') void refreshCloudPresence(entry)
  log('切换数据目录：' + entry.name + ' -> ' + abs)
  return abs
}

/**
 * 刷新"本机正在使用这个云目录"的登记。
 *
 * 什么时机算在用：**打开（切换到）云数据目录时**。
 * 这样只要打开过，服务器上的空置倒计时就会归零；
 * 而切到本地目录、关闭软件都不影响这个登记（那是上一次的坑）。
 * 失败不打扰用户（比如离线时），只在日志里记一笔。
 */
async function refreshCloudPresence(entry: LibraryEntry): Promise<void> {
  if (entry.kind !== 'cloud' || !entry.cloud?.key) return
  try {
    const dec = decodeCloudKey(entry.cloud.key)
    if (!dec.ok) return
    const conn = await connectCloud(dec.payload)
    try {
      await deviceJoin(conn, app.getPath('userData'), dec.payload.id)
      log('已刷新本机在云目录上的连接登记：' + entry.name)
    } finally { conn.close() }
  } catch (e) {
    log('刷新云目录连接登记失败（离线或网络问题，不影响使用）：' + (e instanceof Error ? e.message : String(e)))
  }
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function bootstrap(libraryRoot?: string): void {
  store = new Store(configPath())
  if (!registry.items.length) loadLibraries()
  const activeDir = registry.items.length ? activeLibraryDir() : ''
  const storedLibrary = (store.config.libraryPath ?? '').trim()
  if (libraryRoot) setLibraryPortable(libraryRoot)
  else if (activeDir && existsSync(activeDir)) {
    // 用注册表里当前激活的那个库（多数据目录的主路径）
    store.attachLibrary(activeDir)
    // 启动时如果用的就是云目录，同样刷新一次"本机在用"的登记
    const cur = activeLibrary()
    if (cur?.kind === 'cloud') setTimeout(() => { void refreshCloudPresence(cur) }, 1500)
  } else if (installPlan.ownLibrary && (!storedLibrary || !store.config.portableLibrarySet)) {
    // 便携版：默认用自己文件夹里的「工作区」，并写成相对路径（只自动设一次，之后尊重用户设置）
    setLibraryPortable(installPlan.ownLibrary)
    store.patchConfig({ portableLibrarySet: true })
    log('便携版安装，笔记库：' + installPlan.ownLibrary)
  } else if (storedLibrary) {
    // 相对路径要按当前软件文件夹解析（拷到别的盘/别的电脑也能对）
    store.attachLibrary(resolveLibraryRoot(storedLibrary, installPlan.installDir))
    log('笔记库（按相对路径解析）：' + store.paths.root)
  } else {
    setLibraryPortable(defaultLibraryRoot())
  }
  store.ensureLibrary()
  tasks = new TaskService(store)
  notes = new NoteService(store)
  boards = new BoardService(notes)
  library = new LibraryService(store, notes)
  secrets = new SecretService(store)
  ai = new AiService(store, secrets, tasks, notes)
  ai.attachBoards(boards)
  // 内嵌 harness 引擎：运行时随包放在 resources/engine，Quill 自己当 MCP 服务器
  {
    const resDir = app.isPackaged ? process.resourcesPath : app.getAppPath()
    // ⚠️ 必须在 node_modules 这一层之下 —— Node 靠 node_modules 目录找兄弟包，
    // 少了这层就会 ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-app-boot
    const dshBin = join(resDir, 'engine', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(dshBin)) {
      const mcpEntry = join(resDir, 'engine', 'mcp-entry.js')
      ai.attachEngineInfo({ dshBin, selfExe: process.execPath, mcpEntry, home: join(app.getPath('userData'), 'engine') })
      log('内嵌引擎就绪：' + dshBin)
    } else {
      log('内嵌引擎未随包（' + dshBin + '），将使用内置引擎')
    }
  }
  // AI 自己写的经验（docs/ai/rules.md）会追加到上下文里，让它"越用越懂这套软件"
  ai.attachRulesReader(() => {
    try {
      const f = join(store.paths.root, 'docs', 'ai', 'rules.md')
      return existsSync(f) ? readFileSync(f, 'utf8') : ''
    } catch { return '' }
  })
  ai.attachDangerNotifier((what, detail) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ai:danger-ask', { what, detail })
  })
  library.ensureReadme()
  tasks.purgeExpired()
}

function rebuild(): void {
  tasks = new TaskService(store)
  notes = new NoteService(store)
  boards = new BoardService(notes)
  library = new LibraryService(store, notes)
  ai = new AiService(store, secrets, tasks, notes)
  ai.attachBoards(boards)
}

/** 包装所有 IPC：错误统一转成可读信息返回界面，不静默失败。 */
function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_e, ...args: any[]) => {
    try {
      const value = await fn(...args)
      return { ok: true, value }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // 敏感信息不进入普通日志
      console.error('[ipc:' + channel + ']', message)
      return { ok: false, error: message }
    }
  })
}

function unwrap<T>(res: { ok: boolean; value?: T; error?: string }): T {
  if (!res.ok) throw new Error(res.error || '操作失败')
  return res.value as T
}

function registerIpc(): void {
  // 基础
  handle(CH.appInfo, () => ({ version: VERSION, libraryPath: store.paths.root, platform: process.platform }))
  handle(CH.configGet, () => store.config)
  handle(CH.configSet, (patch: Partial<AppConfig>) => {
    const clean: Partial<AppConfig> = {}
    if (patch.model !== undefined) clean.model = V.str(patch.model, '模型名', 100)
    if (patch.baseUrl !== undefined) clean.baseUrl = V.str(patch.baseUrl, '接口地址', 300)
    if (patch.showNetworkNotice !== undefined) clean.showNetworkNotice = V.bool(patch.showNetworkNotice, '网络提示')
    if (patch.lastArea !== undefined) clean.lastArea = patch.lastArea
    if (patch.theme !== undefined) clean.theme = patch.theme
    if (patch.libraryPath !== undefined && patch.libraryPath !== store.config.libraryPath) {
      const target = V.str(patch.libraryPath, '库路径', 500)
      if (target && !existsSync(target)) throw new Error('文件夹不存在：' + target)
      clean.libraryPath = target
    }
    const next = store.patchConfig(clean)
    if (clean.libraryPath !== undefined) {
      // 便携版：把相对路径还原成绝对路径再设置
      const abs = resolveLibraryRoot(clean.libraryPath, installPlan.installDir)
      clean.libraryPath = toStoredLibraryPath(abs, installPlan.installDir)
      rebuild()
      library.ensureReadme()
    }
    return next
  })
  handle(CH.libraryCandidates, () => library.scanCandidates())
  // ---- 多数据目录 ----
  handle(CH.librariesList, () => ({
    activeId: registry.activeId,
    items: registry.items.map((i) => {
      const dir = resolveLibraryDir(i.path, installPlan.installDir)
      const st = libraryStats(dir)
      return { ...i, dir, notes: st.notes, sizeBytes: st.sizeBytes, exists: existsSync(dir), isActive: i.id === registry.activeId }
    })
  }))
  handle(CH.libraryCreate, (dir: string, name: string) => {
    const rawInput = V.str(dir, '文件夹', 1000)
    const cleaned = normalizeDirInput(rawInput)
    if (!cleaned) throw new Error('请填写或选择一个文件夹')
    if (!isAbsolute(cleaned)) {
      throw new Error('请填完整的路径（例如 C:\\我的笔记），现在填的是：' + cleaned)
    }
    const target = cleaned
    const created = createLibraryAt(target, V.str(name || '', '名称', 60) || basename(target))
    const stored = toStoredLibraryDir(target, installPlan.installDir)
    const existing = registry.items.find((i) => resolveLibraryDir(i.path, installPlan.installDir) === target)
    if (existing) {
      activateLibrary(existing.id)
      return { id: existing.id, dir: target, created }
    }
    const entry: LibraryEntry = {
      id: newLibraryId(basename(target)),
      name: V.str(name || '', '名称', 60) || basename(target),
      kind: 'local',
      path: stored,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString()
    }
    registry.items.push(entry)
    registry.activeId = entry.id
    saveRegistry(registryPath(), registry)
    setLibraryPortable(target)
    bootstrap(target)
    log('新建数据目录：' + entry.name + ' -> ' + target)
    return { id: entry.id, dir: target, created }
  })
  handle(CH.libraryActivate, (id: string) => activateLibrary(V.id(id)))
  handle(CH.libraryRename, (id: string, name: string) => {
    const entry = registry.items.find((i) => i.id === V.id(id))
    if (!entry) throw new Error('找不到这个数据目录')
    const n = V.str(name, '名称', 60).trim()
    if (!n) throw new Error('名称不能为空')
    entry.name = n
    saveRegistry(registryPath(), registry)
    return true
  })
  handle(CH.libraryRemove, (id: string, deleteFiles: boolean) => {
    const idx = registry.items.findIndex((i) => i.id === V.id(id))
    if (idx < 0) throw new Error('找不到这个数据目录')
    if (registry.items.length <= 1) throw new Error('至少要保留一个数据目录')
    const entry = registry.items[idx]
    // 只从列表移除；deleteFiles 明确为 true 时才动文件（界面里默认 false）
    if (deleteFiles) throw new Error('为避免误删，程序不提供删除文件的功能，请手动删除文件夹')
    registry.items.splice(idx, 1)
    if (registry.activeId === entry.id) {
      registry.activeId = registry.items[0].id
      activateLibrary(registry.activeId)
    } else {
      saveRegistry(registryPath(), registry)
    }
    return true
  })
  // ---- 云数据目录：上传 / 下载 / 恢复备份 ----
  const cloudOf = (id: string): { entry: LibraryEntry; paths: ReturnType<typeof cloudPaths> } => {
    const entry = registry.items.find((i) => i.id === V.id(id))
    if (!entry) throw new Error('找不到这个数据目录')
    if (entry.kind !== 'cloud' || !entry.cloud) throw new Error('这不是云端数据目录')
    return { entry, paths: cloudPaths(app.getPath('userData'), entry.id) }
  }

  const targetOf = (entry: LibraryEntry): CloudTarget => {
    const keyFile = join(app.getPath('userData'), entry.cloud!.keyFile)
    if (!existsSync(keyFile)) throw new Error('找不到连接密钥：' + keyFile)
    return {
      host: entry.cloud!.host,
      port: entry.cloud!.port,
      user: entry.cloud!.user,
      privateKey: readFileSync(keyFile, 'utf8'),
      remoteDir: entry.cloud!.remoteDir
    }
  }

  const withSftp = async <T>(entry: LibraryEntry, fn: (c: SftpClient) => Promise<T>): Promise<T> => {
    const client = await SftpClient.connect(targetOf(entry))
    try { return await fn(client) } finally { client.close() }
  }

  handle(CH.cloudConnect, async (name: string, mode: string) => {
    // 连接云端数据目录：用本机已有的同步密钥连上去；本机副本放 data\cloud\<id>
    const keyFile = join(app.getPath('userData'), 'cloud', 'id_ed25519')
    if (!existsSync(keyFile)) {
      throw new Error('还没有同步密钥。请先完成密钥安装（把公钥加到服务器），再连接。')
    }
    const id = newLibraryId(V.str(name, '名称', 60) || '云端库')
    const paths = cloudPaths(app.getPath('userData'), id)
    ensureDir(paths.dir)
    const entry: LibraryEntry = {
      id,
      name: V.str(name, '名称', 60).trim() || '云端库',
      kind: 'cloud',
      path: paths.dir,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      // 服务器地址**不写死在源码里**（开源时不该暴露管理员的服务器）：
      // 这条通道（cloud:connect，用本机已有的同步密钥连云端）靠环境变量提供地址与账号；
      // 常规用法是 cloud:connect-key（地址/账号/私钥都在 key 里），不受这里影响。
      cloud: {
        host: process.env.DSH_QUILL_CLOUD_HOST ?? '',
        port: Number(process.env.DSH_QUILL_CLOUD_PORT ?? 22) || 22,
        user: process.env.DSH_QUILL_CLOUD_USER ?? '',
        keyFile: join('cloud', 'id_ed25519'),
        remoteDir: 'main'
      }
    }
    // 立刻连一次，确认密钥和目录都正常
    const client = await SftpClient.connect(targetOf(entry))
    client.close()
    registry.items.push(entry)
    registry.activeId = id
    saveRegistry(registryPath(), registry)
    log('已连接云端数据目录：' + entry.name)
    if (mode === 'download') {
      // 首次连接并把云端内容拉下来
      const c = await SftpClient.connect(targetOf(entry))
      try {
        const remote = await c.listFiles('')
        for (const f of Object.values(remote)) await c.fastGet(f.path, join(paths.dir, f.path))
      } finally { c.close() }
    }
    activateLibrary(id)
    return { id, dir: paths.dir }
  })
  // ---- 云数据目录（key 制） ----
  const cloudEntryOf = (id: string): LibraryEntry => {
    const e = registry.items.find((i) => i.id === V.id(id))
    if (!e) throw new Error('找不到这个数据目录')
    if (e.kind !== 'cloud' || !e.cloud?.key) throw new Error('这不是云端数据目录')
    return e
  }
  const payloadOf = (e: LibraryEntry): CloudKeyPayload => decodeCloudKey(e.cloud!.key!).ok
    ? (decodeCloudKey(e.cloud!.key!) as { ok: true; payload: CloudKeyPayload }).payload
    : (() => { throw new Error('这个云数据目录的 key 已损坏，请重新连接') })()
  const localDirOf = (e: LibraryEntry): string => resolveLibraryDir(e.path, installPlan.installDir)

  /** 创建钥匙（内置在应用里，服务端只允许它创建目录） */
  
  /**
   * 连接云目录的互斥锁（防止连点造成重复连接）。
   *
   * 事故：连接流程要联网好几秒（连接 → 登记设备 → 读状态）。用户在界面上连点 N 次，
   * N 个请求**并发**进入，每个都还没看到 registry 里已写入的条目，于是各自 push 一个 ——
   * 同一个云目录在库列表里出现 N 条。
   *
   * 这里把整个流程串行化：后来的请求等前一个结束，再走一遍（此时就能命中"已连接过"的复用分支）。
   */
  let cloudConnectChain: Promise<unknown> = Promise.resolve()
  const serializeCloudConnect = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = cloudConnectChain.then(fn, fn)
    // 链上只保留"是否结束"，不传播错误（否则一次失败会毒化整条链）
    cloudConnectChain = next.then(() => undefined, () => undefined)
    return next
  }

  handle(CH.cloudConnectKey, async (keyText: string, mode: string) => serializeCloudConnect(async () => {
    const dec = decodeCloudKey(V.str(keyText, 'key', 20000))
    if (!dec.ok) throw new Error(dec.reason)
    const payload = dec.payload

    // 情况一：这个云目录已经连接过 —— 直接切过去，不要断开重连
    //（否则会先注销设备登记、再走"复用"分支，导致设备凭空消失）
    const same = registry.items.find((i) => i.kind === 'cloud' && i.cloud?.cloudId === payload.id)
    if (same) {
      const conn = await connectCloud(payload)
      try {
        await deviceJoin(conn, app.getPath('userData'), payload.id)
        const stamp0 = await readStamp(conn)
        same.cloud!.key = keyText
        same.lastUsedAt = new Date().toISOString()
        if (mode === 'download') {
          const remote0 = await listRemoteFiles(conn)
          const dir0 = localDirOf(same)
          for (const rel of remote0) await sftpGetFile(conn, rel, join(dir0, rel))
        }
        if (stamp0) same.cloud!.knownStampVersion = stamp0.version
      } finally { conn.close() }
      registry.activeId = same.id
      saveRegistry(registryPath(), registry)
      log('这个云目录已经连接过，直接切过去：' + same.name)
      activateLibrary(same.id)
      return { id: same.id, dir: localDirOf(same), reused: true, name: same.name }
    }

    // 情况二：换成另一个云目录 —— 现在才算"离开"旧的（每台设备同时只连一个）
    const existing = registry.items.find((i) => i.kind === 'cloud' && i.cloud)
    if (existing) {
      try {
        const conn = await connectCloud(payloadOf(existing))
        await deviceLeave(conn, app.getPath('userData'), existing.id)
        conn.close()
      } catch (e) {
        log('断开旧云目录失败（继续）：' + (e instanceof Error ? e.message : String(e)))
      }
    }
    // 连一次验证 key 有效
    const conn = await connectCloud(payload)
    const dirName = payload.n || payload.id
    const id = newLibraryId('cloud_' + payload.id)
    const dir = cloudPaths(app.getPath('userData'), id).dir
    ensureDir(dir)
    // 首次连接：把云端内容拉下来（如果选了 download）
    let files = 0
    if (mode === 'download') {
      const remote = await listRemoteFiles(conn)
      for (const rel of remote) {
        await sftpGetFile(conn, rel, join(dir, rel))
        files++
      }
    }
    const entry: LibraryEntry = {
      id,
      name: V.str(dirName, '名称', 60) || '云端库',
      kind: 'cloud',
      path: dir,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      cloud: { host: payload.h, port: payload.p, user: payload.u, keyFile: '', remoteDir: '.', key: keyText, cloudId: payload.id }
    }
    // 登记本机在线 + 读状态
    await deviceJoin(conn, app.getPath('userData'), payload.id)
    const stamp = await readStamp(conn)
    const empty = await readEmptyState(conn)
    const devices = await listDevices(conn)
    const usage = localCloudUsage(dir)
    conn.close()
    registry.items.push(entry)
    registry.activeId = id
    saveRegistry(registryPath(), registry)
    log('已连接云数据目录：' + entry.name)
    activateLibrary(id)
    return { id, dir, name: entry.name, files, stamp, emptySince: empty.emptySince, devices, usage, quota: CLOUD_QUOTA_BYTES }
  }))

  /** 递归列出云端文件（相对路径） */
  async function listRemoteFiles(conn: Awaited<ReturnType<typeof connectCloud>>, rel = '', prefix = ''): Promise<string[]> {
    const names = await sftpList(conn, rel || '.')
    const out: string[] = []
    for (const n of names) {
      if (n === '.quill') continue
      const child = prefix ? prefix + '/' + n : n
      const childRel = rel ? rel + '/' + n : n
      const isDir = await new Promise<boolean>((res) => conn.sftp.stat(childRel, (e, st) => res(!e && !!st && st.isDirectory())))
      if (isDir) out.push(...await listRemoteFiles(conn, childRel, child))
      else out.push(child)
    }
    return out
  }

  handle(CH.cloudStatus2, async (id: string) => {
    const e = cloudEntryOf(id)
    const dir = localDirOf(e)
    const usage = localCloudUsage(dir)
    const conn = await connectCloud(payloadOf(e))
    try {
      const stamp = await readStamp(conn)
      const devices = await listDevices(conn)
      const empty = await readEmptyState(conn)
      const selfId = deviceId(app.getPath('userData'))
      const { backupDir } = cloudPaths(app.getPath('userData'), e.id)
      return {
        usage, quota: CLOUD_QUOTA_BYTES, stamp, devices, emptySince: empty.emptySince,
        selfId, deviceName: deviceName(app.getPath('userData')),
        hasBackup: existsSync(backupDir),
        localChanged: false,
        lastUploadAt: e.cloud?.lastUploadAt ?? null,
        lastDownloadAt: e.cloud?.lastDownloadAt ?? null,
        knownStampVersion: e.cloud?.knownStampVersion ?? 0
      }
    } finally { conn.close() }
  })

  handle(CH.cloudUpload2, async (id: string) => {
    const e = cloudEntryOf(id)
    const dir = localDirOf(e)
    const files = scanFiles(dir)
    if (!Object.keys(files).length) throw new Error('本机这个云目录还没有内容')
    const totalBytes = Object.values(files).reduce((n, f) => n + f.size, 0)
    if (totalBytes > CLOUD_QUOTA_BYTES) {
      throw new Error('超出 1.5 GB 上限，还差 ' + formatBytes(totalBytes - CLOUD_QUOTA_BYTES) + '，请先删一些内容')
    }
    const conn = await connectCloud(payloadOf(e))
    try {
      const remote = await listRemoteFiles(conn)
      for (const rel of Object.keys(files)) {
        const seg = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
        if (seg) await sftpMkdirp(conn, seg)
        try {
          await sftpPutFile(conn, join(dir, rel), rel)
        } catch (err) {
          // 只说 "Permission denied" 用户根本不知道是哪个文件、也不知道为什么。
          // 实测：云目录根目录由 root 拥有（只有 notes/ data/ _收件箱/ .trash/ .quill/ 属于用户），
          // 所以放在库根的 quill-library.json 之类是传不上去的。
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(
            '上传「' + rel + '」失败：' + msg +
            (seg === '' ? '（云目录根目录不能写：服务器上只有 notes/、data/、_收件箱/、.trash/ 属于你的账号）' : '')
          )
        }
      }
      // 云端多出来的文件删掉（整体覆盖）
      let removed = 0
      for (const rel of remote) {
        if (!files[rel]) { await sftpUnlink(conn, rel); removed++ }
      }
      const stamp = await writeStamp(conn, app.getPath('userData'), Object.keys(files).length, totalBytes)
      e.cloud!.lastUploadAt = new Date().toISOString()
      e.cloud!.knownStampVersion = stamp.version
      saveRegistry(registryPath(), registry)
      log('云上传完成：' + Object.keys(files).length + ' 个文件，删除 ' + removed + ' 个')
      return { uploaded: Object.keys(files).length, removed, bytes: totalBytes, stamp }
    } finally { conn.close() }
  })

  handle(CH.cloudDownload2, async (id: string) => {
    const e = cloudEntryOf(id)
    const dir = localDirOf(e)
    const conn = await connectCloud(payloadOf(e))
    try {
      const remote = await listRemoteFiles(conn)
      if (!remote.length) throw new Error('云端还是空的，先上传一次')
      // 下载前：本机内容改名成备份（只留最近一份，可一键恢复）
      const { backupDir } = cloudPaths(app.getPath('userData'), e.id)
      rmSync(backupDir, { recursive: true, force: true })
      if (existsSync(dir)) renameSync(dir, backupDir)
      ensureDir(dir)
      let bytes = 0
      try {
        for (const rel of remote) {
          await sftpGetFile(conn, rel, join(dir, rel))
        }
        const usage = localCloudUsage(dir)
        bytes = usage.bytes
      } catch (err) {
        // 失败就还原，绝不留半吊子状态
        rmSync(dir, { recursive: true, force: true })
        if (existsSync(backupDir)) renameSync(backupDir, dir)
        throw err
      }
      const stamp = await readStamp(conn)
      e.cloud!.lastDownloadAt = new Date().toISOString()
      e.cloud!.knownStampVersion = stamp?.version ?? 0
      saveRegistry(registryPath(), registry)
      log('云下载完成：' + remote.length + ' 个文件')
      rebuild()
      return { files: remote.length, bytes, stamp }
    } finally { conn.close() }
  })

  handle(CH.cloudRestore2, (id: string) => {
    const e = cloudEntryOf(id)
    const { dir, backupDir } = cloudPaths(app.getPath('userData'), e.id)
    if (!existsSync(backupDir)) throw new Error('还没有备份（每次下载前会自动留一份）')
    rmSync(dir, { recursive: true, force: true })
    renameSync(backupDir, dir)
    rebuild()
    log('已恢复到上一次下载前的版本')
    return true
  })

  handle(CH.cloudDevices2, async (id: string) => {
    const e = cloudEntryOf(id)
    const conn = await connectCloud(payloadOf(e))
    try {
      return { devices: await listDevices(conn), selfId: deviceId(app.getPath('userData')) }
    } finally { conn.close() }
  })

  /**
   * 断开云数据目录（真正的"断链"）。
   * 做三件事：注销本机在服务器上的登记 -> 从数据目录列表移除 -> 切回一个本地库。
   * 本机副本目录保留在磁盘上（里面可能有还没上传的改动），日志里会写出路径。
   */
  handle(CH.cloudDisconnect, async (id: string) => {
    const e = cloudEntryOf(id)
    const dir = localDirOf(e)
    let wasLast = false
    let others: unknown[] = []
    try {
      const conn = await connectCloud(payloadOf(e))
      try {
        const r = await deviceLeave(conn, app.getPath('userData'), e.cloud!.cloudId ?? e.id)
        wasLast = r.wasLast
        others = r.others
      } finally { conn.close() }
    } catch (err) {
      // 离线也要允许断开，只是服务器上的登记会留到下次
      log('断开时注销设备失败（离线？）：' + (err instanceof Error ? err.message : String(err)))
    }
    const idx = registry.items.findIndex((i) => i.id === e.id)
    if (idx >= 0) registry.items.splice(idx, 1)
    const next = registry.items.find((i) => i.kind === 'local') ?? registry.items[0]
    if (next) {
      registry.activeId = next.id
      saveRegistry(registryPath(), registry)
      activateLibrary(next.id)
    } else {
      saveRegistry(registryPath(), registry)
    }
    log('已断开云数据目录：' + e.name + '（本机副本保留在 ' + dir + '）')
    return { wasLast, others: others.length, next: next?.name ?? null, localCopy: dir }
  })

  handle(CH.cloudRemoveDevice, async (id: string, deviceIdToRemove: string) => {
    const e = cloudEntryOf(id)
    const conn = await connectCloud(payloadOf(e))
    try { await removeDevice(conn, V.str(deviceIdToRemove, '设备', 64)); return true } finally { conn.close() }
  })

  handle(CH.cloudTestKey, async (keyText: string) => {
    const dec = decodeCloudKey(V.str(keyText, 'key', 20000))
    if (!dec.ok) throw new Error(dec.reason)
    const conn = await connectCloud(dec.payload)
    try {
      const stamp = await readStamp(conn)
      const devices = await listDevices(conn)
      const remote = await listRemoteFiles(conn)
      return { name: dec.payload.n, id: dec.payload.id, host: dec.payload.h, user: dec.payload.u, files: remote.length, stamp, devices }
    } finally { conn.close() }
  })

  /** 把云目录另存为一个独立的本地数据目录（手动备份） */
  handle(CH.librarySaveAsLocal, async (id: string, targetDir: string) => {
    const e = cloudEntryOf(id)
    const src = localDirOf(e)
    const raw = V.str(targetDir, '文件夹', 1000)
    const cleaned = normalizeDirInput(raw)
    if (!isAbsolute(cleaned)) throw new Error('请填完整路径')
    if (resolve(cleaned) === resolve(src)) throw new Error('不能存到云目录的本机副本里，请换一个文件夹')
    // 复制内容
    mkdirSync(cleaned, { recursive: true })
    cpSync(src, cleaned, { recursive: true, force: false, errorOnExist: false })
    // 登记成一个本地库
    const stored = toStoredLibraryDir(cleaned, installPlan.installDir)
    const entry: LibraryEntry = {
      id: newLibraryId('local_' + basename(cleaned)),
      name: basename(cleaned),
      kind: 'local',
      path: stored,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString()
    }
    registry.items.push(entry)
    saveRegistry(registryPath(), registry)
    log('云目录已另存为本机库：' + cleaned)
    return { id: entry.id, dir: cleaned }
  })

  /** 断开/离开云目录：返回是否"最后一个设备"（界面据此弹警告） */
  handle(CH.cloudLeave, async (id: string) => {
    const e = cloudEntryOf(id)
    const conn = await connectCloud(payloadOf(e))
    try {
      const r = await deviceLeave(conn, app.getPath('userData'), e.cloud!.cloudId ?? e.id)
      return { wasLast: r.wasLast, others: r.others }
    } finally { conn.close() }
  })

  // ---- 跨库复制笔记 / 笔记夹（只复制，源库不动） ----
  handle(CH.libraryTargets, () => ({
    activeId: registry.activeId,
    items: registry.items.map((i) => ({
      id: i.id,
      name: i.name,
      kind: i.kind,
      isActive: i.id === registry.activeId
    }))
  }))

  handle(CH.libraryCopy, (fromRel: string, toLibraryId: string) => {
    const srcDir = activeLibraryDir()
    const target = registry.items.find((i) => i.id === V.id(toLibraryId))
    if (!target) throw new Error('找不到目标数据目录')
    if (target.id === registry.activeId) throw new Error('源和目标不能是同一个数据目录')
    const dstDir = resolveLibraryDir(target.path, installPlan.installDir)
    if (!existsSync(dstDir)) throw new Error('目标数据目录不存在：' + dstDir)

    const rel = normalizeRel(V.str(fromRel, '来源', 800))
    const srcAbs = join(srcDir, rel)
    if (!existsSync(srcAbs)) throw new Error('找不到要复制的内容：' + rel)

    // 1) 收集要复制的文件
    const items: CopyItem[] = []
    const collect = (abs: string, r: string): void => {
      const st = statSync(abs)
      if (st.isDirectory()) {
        for (const e of readdirSync(abs, { withFileTypes: true })) {
          if (e.name.startsWith('.')) continue
          collect(join(abs, e.name), r + '/' + e.name)
        }
        return
      }
      if (isCopyable(r)) items.push({ rel: r, size: st.size })
    }
    collect(srcAbs, rel)
    if (!items.length) throw new Error('这里没有可复制的笔记或笔记夹')

    // 2) 把笔记引用的附件也带上（源库里存在的话）
    const extra = new Set<string>()
    for (const it of items) {
      if (!it.rel.endsWith('.md')) continue
      try {
        const content = readFileSync(join(srcDir, it.rel), 'utf8')
        for (const ref of attachmentRefs(content)) {
          if (!items.some((x) => x.rel === ref) && existsSync(join(srcDir, ref))) extra.add(ref)
        }
      } catch { /* 跳过读不到的文件 */ }
    }
    for (const ref of extra) {
      items.push({ rel: ref, size: statSync(join(srcDir, ref)).size })
    }

    // 3) 安排落点（重名自动加序号）
    const existingIn = (candidate: string): boolean => existsSync(join(dstDir, candidate))
    const plan = planCopyPaths(items, existingIn)

    // 4) 复制（先写 .tmp 再改名，避免复制一半留下坏文件）
    let copied = 0
    const copiedNotes: string[] = []
    for (const p of plan) {
      const from = join(srcDir, p.from)
      const to = join(dstDir, p.to)
      mkdirSync(join(to, '..'), { recursive: true })
      const tmp = to + '.tmp-copy'
      copyFileSync(from, tmp)
      renameSync(tmp, to)
      copied++
      if (p.to.endsWith('.md') || p.to.endsWith('.canvas.json')) copiedNotes.push(p.to)
    }

    // 5) 目标库重建索引（扫描 notes 目录）
    rebuildTargetLibrary(dstDir)
    log('跨库复制：' + rel + ' → ' + target.name + '（' + copied + ' 个文件）')
    return {
      copied,
      target: target.name,
      targetKind: target.kind,
      files: copiedNotes.slice(0, 20),
      dir: dstDir
    }
  })

  /**
   * 复制完让目标库的索引跟上（它可能不是当前激活库）。
   * 注意：要显式把库根指到目标目录再重扫，不能依赖 Store 的构造（它会读当前激活库的配置）。
   */
  function rebuildTargetLibrary(dstDir: string): void {
    try {
      const store2 = new Store(configPath())
      store2.attachLibrary(dstDir)          // 直接改路径，不动配置
      const notes2 = new NoteService(store2)
      notes2.reload()                       // 从磁盘重扫，把新复制进来的笔记收进索引
      log('目标库索引已重建：' + dstDir + '（' + notes2.list().length + ' 篇）')
    } catch (e) {
      log('目标库索引重建失败（下次打开会自动修正）：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  handle(CH.cloudStatus, (id: string) => {
    const { entry, paths } = cloudOf(id)
    const local = scanFiles(paths.dir)
    return {
      dir: paths.dir,
      hasBackup: hasBackup(paths),
      localFiles: Object.keys(local).length,
      localBytes: Object.values(local).reduce((n, f) => n + f.size, 0),
      lastUploadAt: entry.cloud?.lastUploadAt ?? null,
      lastDownloadAt: entry.cloud?.lastDownloadAt ?? null
    }
  })

  handle(CH.cloudUpload, async (id: string) => {
    const { entry, paths } = cloudOf(id)
    const local = scanFiles(paths.dir)
    if (!Object.keys(local).length) throw new Error('本机这个云目录里还没有内容，先写点东西再上传')
    return withSftp(entry, async (c) => {
      const remote = await c.listFiles('')
      const diff = diffForOverwrite(local, remote)
      if (!diff.upload.length && !diff.remove.length) return { uploaded: 0, removed: 0, bytes: 0, message: '已经和云端一致，无需上传' }
      // 上传：先全部传上去，再删云端多余的（顺序反了会误删还没传的）
      for (const f of diff.upload) {
        const abs = join(paths.dir, f.path)
        const remotePath = normalizeRel(f.path)
        const dir = remotePath.includes('/') ? remotePath.slice(0, remotePath.lastIndexOf('/')) : ''
        if (dir) await c.mkdirp(dir)
        await c.fastPut(abs, remotePath)
      }
      for (const p of diff.remove) await c.unlink(p)
      entry.cloud!.lastUploadAt = new Date().toISOString()
      saveRegistry(registryPath(), registry)
      log('云上传完成：' + diff.upload.length + ' 个文件 / ' + formatBytes(diff.totalBytes))
      return { uploaded: diff.upload.length, removed: diff.remove.length, bytes: diff.totalBytes, message: describeDiff('upload', diff) + '（已完成）' }
    })
  })

  handle(CH.cloudDownload, async (id: string) => {
    const { entry, paths } = cloudOf(id)
    return withSftp(entry, async (c) => {
      const remote = await c.listFiles('')
      if (!Object.keys(remote).length) throw new Error('云端还没有内容，先上传一次再下载')
      // 下载前：现有内容改名成备份（只保留这一份，可一键恢复）
      const stashed = stashCurrentAsBackup(paths)
      try {
        for (const f of Object.values(remote)) {
          await c.fastGet(f.path, join(paths.dir, f.path))
        }
      } catch (e) {
        // 失败就还原，保证本机不会变成半吊子状态
        if (stashed) restoreBackup(paths)
        throw e
      }
      // 注意：备份要留着，供「恢复上一次下载前」（下一次下载会覆盖它，所以始终只保留一份）
      entry.cloud!.lastDownloadAt = new Date().toISOString()
      saveRegistry(registryPath(), registry)
      log('云下载完成：' + Object.keys(remote).length + ' 个文件')
      return { files: Object.keys(remote).length, bytes: Object.values(remote).reduce((n, f) => n + f.size, 0) }
    })
  })

  handle(CH.cloudRestoreBackup, (id: string) => {
    const { paths } = cloudOf(id)
    const ok = restoreBackup(paths)
    if (!ok) throw new Error('还没有备份可以恢复（备份会在每次下载前自动生成）')
    rebuild()
    return true
  })

  handle(CH.libraryPickFolder, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })
  handle(CH.librarySwitch, (dir: string) => {
    const abs = V.str(dir, '目录', 1000)
    const next = library.switchTo(abs)
    // 便携版：库在软件文件夹内就存相对路径
    const stored = toStoredLibraryPath(next, installPlan.installDir)
    if (stored !== next) store.patchConfig({ libraryPath: stored })
    // 关键：光改配置不够，必须重建各服务，否则界面还在读旧库
    bootstrap(next)
    log('切换数据目录：' + next)
    return next
  })
  handle(CH.libraryStats, () => ({
    tasks: tasks.list().filter((t) => !t.done).length,
    notes: notes.list().length,
    trashTasks: tasks.trashList().length,
    trashNotes: notes.trashList().length
  }))

  // 任务
  handle(CH.taskList, () => {
    const all = [...tasks.sorted(null), ...tasks.doneSorted(null)]
    return all.map((t) => ({
      ...t,
      tagPaths: t.tagIds.map((id) => tasks.tagPath(id)).filter(Boolean),
      noteTitle: t.noteId ? (notes.get(t.noteId)?.title ?? null) : null,
      noteMissing: !!t.noteId && !notes.get(t.noteId)
    }))
  })
  handle(CH.taskCreate, (input: any) => tasks.create({
    name: V.str(input.name, '任务名称', 300),
    tagIds: Array.isArray(input.tagIds) ? input.tagIds.map((x: unknown) => V.id(x, 'tag')) : [],
    priority: input.priority,
    ddl: input.ddl ?? null,
    noteId: input.noteId ? V.id(input.noteId, '笔记') : null
  }))
  handle(CH.taskUpdate, (id: string, patch: any) => {
    const clean: Record<string, unknown> = {}
    if (patch.name !== undefined) clean.name = V.str(patch.name, '任务名称', 300)
    if (patch.tagIds !== undefined) clean.tagIds = (patch.tagIds as unknown[]).map((x) => V.id(x, 'tag'))
    if (patch.priority !== undefined) clean.priority = patch.priority
    if (patch.ddl !== undefined) clean.ddl = patch.ddl
    if (patch.noteId !== undefined) clean.noteId = patch.noteId ? V.id(patch.noteId, '笔记') : null
    return tasks.update(V.id(id), clean)
  })
  handle(CH.taskComplete, (id: string) => tasks.complete(V.id(id)))
  handle(CH.taskDelete, (id: string) => { tasks.remove(V.id(id)); return true })

  // tag
  handle(CH.tagList, () => tasks.tagList().map((t) => ({ ...t, path: tasks.tagPath(t.id) })))
  handle(CH.tagCreate, (name: string, parentId: string | null) => tasks.createTag(V.str(name, 'tag 名称', 60), parentId ? V.id(parentId, 'tag') : null))
  handle(CH.tagRename, (id: string, name: string) => tasks.renameTag(V.id(id), V.str(name, 'tag 名称', 60)))
  handle(CH.tagDelete, (id: string) => { tasks.deleteTag(V.id(id)); return true })
  handle(CH.tagMove, (id: string, parentId: string | null) => tasks.moveTag(V.id(id), parentId ? V.id(parentId, 'tag') : null))

  // 任务回收站
  handle(CH.trashTaskList, () => tasks.trashList())
  handle(CH.trashTaskRestore, (id: string) => { tasks.trashRestore(V.id(id)); return true })
  handle(CH.trashTaskPurge, (id: string) => { tasks.trashPurge(V.id(id)); return true })
  handle(CH.historyList, () => tasks.historyList())

  // 笔记
  handle(CH.noteTree, () => buildTree())
  handle(CH.noteRead, (id: string) => {
    const key = V.id(id)
    const note = notes.get(key)
    if (!note) throw new Error('笔记不存在')
    if (note.kind === 'whiteboard') return { note, content: '', inlinedImages: {}, whiteboard: boards.read(key) }
    const { content } = notes.read(key)
    const inlined: Record<string, string> = {}
    const withImages = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (whole, alt, src) => {
      const rel = decodeURIComponent(String(src))
      if (/^https?:/i.test(rel) || rel.startsWith('data:')) return whole
      const abs = notes.attachmentAbs(rel)
      if (!abs || !existsSync(abs)) return whole
      try {
        const data = readFileSync(abs).toString('base64')
        const url = 'data:' + mimeOf(abs) + ';base64,' + data
        inlined[rel] = url
        return '![' + alt + '](' + url + ')'
      } catch { return whole }
    })
    return { note, content: withImages, inlinedImages: inlined }
  })
  handle(CH.noteForceSave, (id: string, content: string) => {
    const key = V.id(id)
    const r = notes.saveNoteForced(key, V.str(content, '内容', 20_000_000))
    return { ...r, note: notes.get(key) }
  })
  handle(CH.noteBackup, (id: string, content: string) => notes.backupDraft(V.id(id), V.str(content, '内容')))
  // 打开链接 / 本地文件 / 文件夹：一个入口，按目标类型分发
  handle(CH.openTarget, async (target: string) => {
    const raw = V.str(target, '目标', 2000).trim()
    if (!raw) throw new Error('链接是空的')
    if (/^(https?:|mailto:)/i.test(raw)) {
      await shell.openExternal(raw)
      return true
    }
    let abs = raw
    if (/^file:\/\//i.test(raw)) {
      abs = fileURLToPath(raw)
    } else if (!isAbsolute(raw)) {
      const inside = notes.attachmentAbs(raw)
      if (!inside) throw new Error('找不到文件：' + raw)
      abs = inside
    }
    if (!existsSync(abs)) throw new Error('文件不存在：' + abs)
    const err = await shell.openPath(abs)
    if (err) throw new Error('打开失败：' + err)
    return true
  })
  handle(CH.pickFile, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'] })
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })
  handle(CH.noteSave, (id: string, content: string, baseMtimeMs: number) => {
    const key = V.id(id)
    const text = V.str(content, '笔记内容', 20_000_000)
    const restored = text.replace(/!\[([^\]]*)\]\((data:[^)]+)\)/g, (whole, alt, dataUrl) => {
      const rel = dataUrlToRel(String(dataUrl))
      return rel ? '![' + alt + '](' + rel + ')' : whole
    })
    const result = notes.saveNote(key, restored, V.num(baseMtimeMs, '版本号'))
    if (!result.ok) return { ok: false as const, conflict: true as const, current: stripInlineImages(result.current) }
    return { ok: true as const, note: notes.get(key) }
  })
  handle(CH.noteCreate, (input: any) => notes.create(
    V.str(input.dir ?? '', '目录', 500),
    input.kind === 'whiteboard' ? 'whiteboard' : 'md',
    V.str(input.title, '标题', 200)
  ))

  handle(CH.noteRename, (id: string, title: string) => notes.rename(V.id(id), V.str(title, '标题', 200)))
  handle(CH.noteMove, (id: string, dir: string) => notes.move(V.id(id), V.str(dir, '目录', 500)))
  handle(CH.noteDelete, (id: string) => { notes.remove(V.id(id)); return true })
  handle(CH.folderCreate, (dir: string, name: string) => notes.createFolder(V.str(dir, '目录', 500), V.str(name, '文件夹名', 100)))
  handle(CH.folderRename, (dir: string, name: string) => notes.renameFolder(V.str(dir, '目录', 500), V.str(name, '文件夹名', 100)))
  handle(CH.folderMove, (from: string, to: string) => { notes.moveFolder(V.str(from, '源笔记夹', 500), V.str(to, '目标笔记夹', 500)); return true })
  handle(CH.folderDelete, (dir: string) => { notes.removeFolder(V.str(dir, '目录', 500)); return true })
  handle(CH.noteRestoreOrigin, (id: string) => notes.restoreOrigin(V.id(id)))
  handle(CH.trashNoteList, () => notes.trashList())
  handle(CH.trashNoteRestore, (ids: unknown) => notes.trashRestore(V.idList(ids)))
  handle(CH.trashNotePurge, (ids: unknown) => { notes.trashPurge(V.idList(ids)); return true })

  handle(CH.attachmentFromData, (dataUrl: string, name: string) => {
    const parsed = parseDataUrl(V.str(dataUrl, '图片数据', 80_000_000))
    return notes.saveAttachmentFromBuffer(parsed.buffer, V.str(name || '粘贴的图片', '文件名', 200))
  })
  handle(CH.attachmentImport, async (sourcePath?: string, hintName?: string) => {
    // 从资源管理器复制粘贴/拖进来的文件直接给路径，省得再弹一次选择框
    if (sourcePath) {
      const abs = V.str(sourcePath, '文件路径', 2000)
      if (!existsSync(abs)) throw new Error('文件不存在：' + abs)
      return notes.importAttachment(abs, hintName ? V.str(hintName, '文件名', 200) : undefined)
    }
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }] })
    if (result.canceled || !result.filePaths.length) return null
    return notes.importAttachment(result.filePaths[0])
  })
  handle(CH.attachmentUrl, () => '')
  // 附件按需转成 data URL：白板图片在自定义协议不可用时作为兜底
  handle(CH.attachmentData, (rel: string) => {
    const abs = notes.attachmentAbs(V.str(rel, '附件路径', 500))
    if (!abs || !existsSync(abs)) return null
    const ext = extname(abs).toLowerCase()
    const mime = ext === '.png' ? 'image/png'
      : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
      : ext === '.gif' ? 'image/gif'
      : ext === '.webp' ? 'image/webp'
      : ext === '.bmp' ? 'image/bmp'
      : ext === '.svg' ? 'image/svg+xml'
      : 'application/octet-stream'
    return { dataUrl: 'data:' + mime + ';base64,' + readFileSync(abs).toString('base64'), text: '' }
  })

  // DSH 版新增：只查不删 —— 列出"没有任何笔记/白板/回收站项引用"的附件。
  // 为什么要它：`trashNote:purge` 会调用 cleanupOrphanAttachments()，
  // 而那个清理是**全库范围**的 —— 一次"彻底删除"可能顺手把一堆毫不相干的附件物理删掉。
  // 有了这个只读通道，界面/羽毛笔就能先把清单摆给用户看。
  handle(CH.attachmentOrphans, () => {
    const files = notes.listOrphanAttachments()
    return { count: files.length, files }
  })

  /**
   * 文档保真读取（DSH 版新增，「羽毛笔」用）。
   *
   * 三条路：
   *   · PDF → 逐页渲染成 PNG 存进 `_attachments/`（**纯图片/扫描件也能读**，模型再用读图能力看），
   *            顺便抽取文本层（有就给，没有就空着）；
   *   · Office / HTML / CSV / 文本 → 交给 services/extract（原 Quill 的实现）；
   *   · 图片 → 库外的先拷进库内，返回可直接引用的库内相对路径。
   * 页图按"内容哈希+页码"命名，同一份 PDF 重复读不会反复生成新文件。
   */
  handle(CH.docRead, async (filePath: unknown, options?: unknown) => {
    const raw = V.str(filePath, '文件路径', 2000).trim()
    if (!raw) throw new Error('文件路径是空的')
    // 支持绝对路径与库内相对路径（相对路径先按库根、再按 notes/ 解析）
    let abs = raw
    if (!isAbsolute(raw)) {
      const byRoot = resolve(store.paths.root, raw)
      const byNotes = resolve(store.paths.notesDir, raw)
      abs = existsSync(byRoot) ? byRoot : byNotes
    }
    if (!existsSync(abs)) throw new Error('文件不存在：' + abs + '（可以给绝对路径，也可以给库内相对路径）')
    const { size } = statOf(abs)
    const name = basename(abs)
    if (size > 300 * 1024 * 1024) throw new Error(`文件太大（${(size / 1024 / 1024).toFixed(0)}MB），请先拆分再读`)
    const opts = options !== null && typeof options === 'object' ? options as Record<string, unknown> : {}
    const scale = Math.min(3, Math.max(1, Number(opts.scale ?? 2)))
    const maxPages = Math.min(500, Math.max(1, Number(opts.maxPages ?? 100)))
    const wanted = Array.isArray(opts.pages) ? (opts.pages as unknown[]).map((n) => Number(n)) : undefined

    if (isPdfPath(abs)) {
      const { totalPages, rendered, warning } = await renderPdfPages(abs, { scale, pages: wanted, maxPages })
      const pages: Array<{ page: number; rel: string; bytes: number; chars: number }> = []
      for (const item of rendered) {
        const fileName = pageAttachmentName(abs, item.page, scale)
        const rel = '_attachments/' + fileName
        const already = notes.attachmentAbs(rel)
        if (already && existsSync(already)) {
          pages.push({ page: item.page, rel, bytes: existsSync(already) ? statSync(already).size : item.png.length, chars: item.text.length })
        } else {
          const saved = notes.saveAttachmentFromBuffer(item.png, fileName)
          pages.push({ page: item.page, rel: saved.rel, bytes: item.png.length, chars: item.text.length })
        }
      }
      const text = rendered.map((r) => r.text).join('\n').trim()
      const scanned = text.length === 0
      return {
        kind: 'pdf' as const,
        path: abs,
        name,
        size,
        totalPages,
        pages,
        text: text.slice(0, 200_000),
        note: scanned
          ? `这份 PDF 没有文本层（纯图片/扫描件），已把 ${pages.length} 页渲染成图片存进库内，请用读图能力逐页查看`
          : `已渲染 ${pages.length} 页图片，并抽取到 ${text.length} 字文本层`,
        warning
      }
    }

    if (isImagePath(abs)) {
      const inside = notes.attachmentAbs('_attachments/' + name)
      let rel = ''
      if (inside && existsSync(inside) && statSync(inside).size === size) {
        rel = '_attachments/' + name
      } else {
        // 库外（或同名不同内容）→ 拷进库内，便于引用与复用
        const saved = notes.saveAttachmentFromBuffer(readFileSync(abs), name)
        rel = saved.rel
      }
      return { kind: 'image' as const, path: abs, name, size, rel, note: '这是一张图片，直接用读图能力看它（也可以用这个库内路径引用）' }
    }

    if (isTextDocPath(abs) || !extname(abs)) {
      const result = await extractFile(abs)
      return {
        kind: 'text' as const,
        path: abs,
        name,
        size,
        text: String(result.text ?? '').slice(0, 400_000),
        note: result.note ?? '已抽取文本'
      }
    }

    // 兜底：其它类型当纯文本读（读不出二进制就给个说明）
    try {
      const text = readFileSync(abs, 'utf8')
      return { kind: 'text' as const, path: abs, name, size, text: text.slice(0, 400_000), note: '按纯文本读取' }
    } catch {
      throw new Error('这种文件读不了（不是 PDF / Office / 图片 / 文本）：' + name)
    }
  })

  // 白板
  handle(CH.boardRead, (id: string) => boards.read(V.id(id)))
  handle(CH.boardSave, (id: string, board: WhiteboardFile, baseMtimeMs: number) => boards.save(V.id(id), board, V.num(baseMtimeMs, '版本号')))

  // 外部
  /**
   * 把界面传来的路径解析成"真实存在的绝对路径"。
   *
   * 坑（上游原版就有）：界面调用处写的是 `note.dir + '/' + note.fileName`，
   * 于是**库根目录**下的笔记会变成 `/笔记.md` 这种带前导斜杠的串；
   * 而 Windows 上 `path.isAbsolute('/笔记.md')` 是 **true** —— 原实现会直接把它当绝对路径，
   * 结果 existsSync 失败、报「文件不存在」（实测日志里就出现过一次）。
   *
   * 所以这里统一：先去掉前导斜杠按"库内相对路径"解析（先 notes/ 再库根），
   * 都不存在时才退回"真的绝对路径"，最后才报错。
   */
  const resolveExistingPath = (raw: string): string => {
    const trimmed = raw.replace(/^[\\/]+/, '')
    const notesDir = store.paths.notesDir
    const candidates = [
      resolve(notesDir, trimmed),
      resolve(store.paths.root, trimmed)
    ]
    for (const cand of candidates) {
      if (existsSync(cand)) return cand
    }
    if (isAbsolute(raw) && existsSync(raw)) return raw
    throw new Error(
      '文件不存在（可能已被移动或删除）：' + raw +
      '（已尝试：' + candidates.join('、') + '）'
    )
  }
  handle(CH.revealPath, (p: string) => {
    const raw = V.str(p, '路径', 1000).trim()
    if (!raw) throw new Error('路径是空的')
    shell.showItemInFolder(resolveExistingPath(raw))
    return true
  })
  // 复制到剪贴板：用 Electron 自己的 API（渲染层的 navigator.clipboard 会因权限/焦点失败）
  handle(CH.copyText, (text: string) => {
    clipboard.writeText(V.str(text, '文本', 500000))
    return true
  })
  handle(CH.openExternal, async (url: string) => {
    const target = V.str(url, '链接', 2000)
    if (!/^https?:\/\//i.test(target)) throw new Error('只允许打开 http/https 链接')
    await shell.openExternal(target)
    return true
  })

  // AI
  handle(CH.aiStatus, () => ai.status())
  handle(CH.aiSetKey, (key: string) => {
    secrets.setKey(V.str(key, 'API Key', 500))
    return { ok: true, message: '已保存（本机加密存储）' }
  })
  handle(CH.aiClearKey, () => { secrets.clear(); return { ok: true } })
  handle(CH.aiConverseList, () => { syncConversationFromDisk(); return ai.list() })
  handle(CH.aiPendingList, () => ai.pendingList())
  handle(CH.aiSend, async (input: any) => {
    const text = V.str(input.text ?? '', '消息', 20000)
    const files = Array.isArray(input.files) ? input.files.slice(0, 10).map((f: any) => ({
      name: V.str(f.name ?? 'file', '文件名', 200),
      kind: f.kind === 'image' ? 'image' as const : 'text' as const,
      dataUrl: typeof f.dataUrl === 'string' ? f.dataUrl : undefined,
      text: typeof f.text === 'string' ? f.text : undefined,
      warning: typeof f.warning === 'string' ? f.warning : undefined
    })) : []
    const noteIds = Array.isArray(input.noteIds) ? input.noteIds.map((x: unknown) => V.id(x, '笔记')) : []
    await ai.send(text, files, noteIds)
    return true
  })
  handle(CH.aiConfirm, (pendingId: string, candidates: unknown) => {
    const list = (Array.isArray(candidates) ? candidates : []) as CandidateTask[]
    return ai.confirm(V.id(pendingId, 'pending'), list)
  })
  handle(CH.aiCancel, (pendingId: string) => { ai.cancel(V.id(pendingId, 'pending')); return true })
  /** 内嵌引擎开关与状态 */
  handle(CH.aiEngineGet, () => ai.engineStatus?.() ?? { running: false, mode: false })
  handle(CH.aiEngineSet, (on: boolean) => { ai.setEngineMode(!!on); return ai.engineStatus() })
  /** AI 危险操作确认：主进程推给界面，界面回传结果 */
  handle(CH.aiDangerAnswer, (allow: boolean, allowAll: boolean) => ai.answerDanger(!!allow, !!allowAll))
  /** AI 任务：停止 / 撤销本次改动 / 查看步骤 */
  handle(CH.aiStop, () => ai.stop())
  handle(CH.aiUndo, () => ai.undo())
  handle(CH.aiSteps, () => ai.steps())
  handle(CH.aiApplyNoteEdits, () => ({ applied: [], failed: [] }))
  handle(CH.aiAbort, () => { ai.abort(); return true })
  handle(CH.aiPickFiles, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (result.canceled) return []
    const out: PickedFile[] = []
    for (const filePath of result.filePaths.slice(0, 10)) {
      out.push(await readAttachment(filePath))
    }
    return out
  })
}

/** 白板与笔记引用由 ID 维护，因此树只用于展示。 */
function buildTree(): unknown[] {
  interface Node { name: string; path: string; folders: Map<string, Node>; notes: { id: string; name: string; kind: string }[] }
  const root: Node = { name: '', path: '', folders: new Map(), notes: [] }
  const ensure = (dir: string): Node => {
    if (!dir) return root
    let node = root
    let acc = ''
    for (const part of dir.split('/')) {
      acc = acc ? acc + '/' + part : part
      if (!node.folders.has(part)) node.folders.set(part, { name: part, path: acc, folders: new Map(), notes: [] })
      node = node.folders.get(part)!
    }
    return node
  }
  // 先按磁盘上的真实文件夹建树，保证「空文件夹」也能显示出来
  for (const dir of notes.listFolders()) ensure(dir)
  for (const note of notes.list()) {
    ensure(note.dir).notes.push({ id: note.id, name: note.fileName, kind: note.kind })
  }
  const toJson = (node: Node): unknown => ({
    type: 'folder',
    name: node.name,
    path: node.path,
    children: [
      ...[...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh')).map(toJson),
      ...node.notes.sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((n) => ({ type: 'note', name: n.name, path: node.path ? node.path + '/' + n.name : n.name, id: n.id, kind: n.kind }))
    ]
  })
  const shaped = toJson(root) as { children?: unknown[] }
  return shaped.children ?? []
}

function mimeOf(file: string): string {
  const ext = extname(file).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.bmp') return 'image/bmp'
  return 'image/jpeg'
}

function dataUrlToRel(dataUrl: string): string | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
  if (!m) return null
  const { rel } = notes.saveAttachmentFromBuffer(Buffer.from(m[2], 'base64'), 'pasted.' + (m[1].split('/')[1] || 'png'))
  return rel
}

function stripInlineImages(content: string): string {
  return content.replace(/!\[([^\]]*)\]\(data:[^)]+\)/g, '![$1](图片)')
}

/**
 * 读取附件：
 * - 图片：直接返回 data URL（官方接口支持图片输入）
 * - PDF：返回原始字节交给渲染进程逐页转图片，同时附带已提取的文本层
 * - 其它：本地提取文本
 */
async function readAttachment(filePath: string): Promise<PickedFile> {
  const name = basename(filePath)
  const ext = extname(filePath).toLowerCase()
  const size = statSync(filePath).size
  if (size > 200 * 1024 * 1024) return { name, kind: 'text', warning: '文件超过 200MB，请拆分后再发送' }

  // 图片：直接走多模态（不经过提取器）
  if (/\.(png|jpe?g|gif|webp|bmp)$/.test(ext)) {
    if (size > 32 * 1024 * 1024) return { name, kind: 'text', warning: '图片超过 32MB，官方接口限制，请压缩后再发送' }
    const data = readFileSync(filePath).toString('base64')
    const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp'
      : ext === '.bmp' ? 'image/bmp' : 'image/jpeg'
    return { name, kind: 'image', dataUrl: 'data:' + mime + ';base64,' + data }
  }

  // 其余全部交给统一提取器（docx/pptx/xlsx/pdf/html/csv/txt…）
  // 双通道：文字优先；扫描件或自检失败会自动附上页面图片（多模态）
  try {
    const r = await extractFile(filePath, {
      renderPdfPage: (buf, pageNumber, maxEdge) => renderPdfPageToDataUrl(buf, pageNumber, maxEdge)
    })
    const imgs = r.pages ?? []
    if (imgs.length) {
      // 有图片：返回图片 + 文字说明（渲染层会把图片一起发给模型）
      return {
        name,
        kind: 'image',
        dataUrl: imgs[0],
        text: r.text ? '【' + name + '（' + r.note + '）】\n' + r.text : '【' + name + '】' + r.note,
        warning: imgs.length > 1 ? '这份文件共 ' + imgs.length + ' 页图，只发送了第 1 页；如需全部请分页发送' : undefined,
        extraPages: imgs.slice(1)
      }
    }
    return { name, kind: 'text', text: '【' + name + '（' + r.note + '）】\n' + r.text, warning: r.issues.length ? r.issues.join('；') : undefined }
  } catch (e) {
    return { name, kind: 'text', text: '（读取失败：' + (e as Error).message + '）', warning: '解析出错' }
  }
}

/** 用 pdfjs 把 PDF 某页渲染成 JPEG dataURL（扫描件走多模态用） */
async function renderPdfPageToDataUrl(buf: Buffer, pageNumber: number, maxEdge: number): Promise<string> {
  const pdfjs = pdfjsModule
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useWorkerFetch: false, useSystemFonts: false } as never).promise
  const page = await doc.getPage(pageNumber)
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(maxEdge / Math.max(base.width, base.height), 2)
  const viewport = page.getViewport({ scale })
  // 主进程没有 DOM canvas，简单地把文字层转成 PNG 不可行；
  // 这里返回 SVG 包装的文本渲染（保留可读性，体积小）
  const content = await page.getTextContent()
  const lines = (content.items as Array<{ str?: string; transform?: number[] }>).filter((i) => i.str && i.transform)
  const svgLines = lines.map((i) => {
    const x = i.transform![4] * scale
    const y = (base.height - i.transform![5]) * scale
    const s = String(i.str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" font-size="' + (12 * scale).toFixed(1) + '" font-family="sans-serif">' + s + '</text>'
  })
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.round(viewport.width) + '" height="' + Math.round(viewport.height) + '">' +
    '<rect width="100%" height="100%" fill="white"/>' + svgLines.join('') + '</svg>'
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64')
}

/** 官方接口不接受 Word/Excel/PDF，这里在本地提取文本。 */
function extractText(filePath: string, ext: string): string {
  try {
    const buf = readFileSync(filePath)
    if (['.txt', '.md', '.markdown', '.csv', '.log', '.json'].includes(ext)) return buf.toString('utf8').slice(0, 60000)
    if (ext === '.docx') return extractDocx(filePath)
    if (ext === '.xlsx') return extractXlsx(filePath)
    if (ext === '.pdf') return extractPdf(buf)
    return '（暂不支持解析该格式，请把内容粘贴到消息中）'
  } catch (e) {
    return '（读取失败：' + (e as Error).message + '）'
  }
}

/** docx/xlsx 都是 zip：直接用 PowerShell 解压读取，避免引入额外依赖。 */
function extractDocx(filePath: string): string {
  const tmp = join(app.getPath('temp'), 'dsh-docx-' + Date.now())
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', filePath, tmp], { windowsHide: true, timeout: 30000 })
    const xml = readFileSync(join(tmp, 'word', 'document.xml'), 'utf8')
    return xml.replace(/<w:p[ >]/g, '\n<w:p ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').slice(0, 60000)
  } catch (e) {
    return '（Word 文档解析失败：' + (e as Error).message + '）'
  }
}

function extractXlsx(filePath: string): string {
  const tmp = join(app.getPath('temp'), 'dsh-xlsx-' + Date.now())
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', filePath, tmp], { windowsHide: true, timeout: 30000 })
    const shared = existsSync(join(tmp, 'xl', 'sharedStrings.xml')) ? readFileSync(join(tmp, 'xl', 'sharedStrings.xml'), 'utf8') : ''
    const strings = [...shared.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''))
    const sheet = readFileSync(join(tmp, 'xl', 'worksheets', 'sheet1.xml'), 'utf8')
    const rows: string[] = []
    for (const row of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = []
      for (const cell of row[1].matchAll(/<c[^>]*?(?:t="(\w+)")?[^>]*>(?:<v>([^<]*)<\/v>)?/g)) {
        if (cell[2] === undefined) { cells.push(''); continue }
        cells.push(cell[1] === 's' ? (strings[Number(cell[2])] ?? '') : cell[2])
      }
      rows.push(cells.join('\t'))
    }
    return rows.join('\n').slice(0, 60000)
  } catch (e) {
    return '（Excel 解析失败：' + (e as Error).message + '）'
  }
}

/** PDF：优先提取文本层；扫描件无法提取时明确告知，不假装已读取。 */
function extractPdf(buf: Buffer): string {
  try {
    const raw = buf.toString('latin1')
    const parts = [...raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)].map((m) => m[1])
    const texts: string[] = []
    for (const part of parts) {
      for (const t of part.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)) texts.push(unescapePdf(t[1]))
      for (const tj of part.matchAll(/\[((?:[^\][]|\\.)*)\]\s*TJ/g)) {
        const inner = [...tj[1].matchAll(/\(((?:\\.|[^\\()])*)\)/g)].map((m) => unescapePdf(m[1])).join('')
        if (inner) texts.push(inner)
      }
    }
    const text = texts.join(' ').replace(/\s+/g, ' ').trim()
    if (text.length < 20) return '（该 PDF 没有可提取的文本层，可能是扫描件；请把页面截图后作为图片发送）'
    return text.slice(0, 60000)
  } catch {
    return '（PDF 解析失败）'
  }
}

function unescapePdf(s: string): string {
  const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }
  return s.replace(/\\([nrtbf()\\])/g, (_m, c: string) => map[c] ?? c)
}

function syncConversationFromDisk(): void {
  // 界面重新打开时刷新磁盘上的会话（AI 服务只在启动时读一次）
  if (!ai) return
}

function createWindow(): void {
  log('createWindow: 开始创建窗口')
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 680,
    // 直接显示窗口：不依赖 ready-to-show。
    // 若渲染进程因任何原因没有画出首帧，ready-to-show 不会触发，窗口就会永远不可见
    // （表现为「双击没反应、任务栏也没有图标」）。
    show: true,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f9',
    title: 'Quill',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => {
    log('createWindow: ready-to-show 已触发')
    if (!win.isVisible()) win.show()
  })

  // 兜底：无论渲染如何，3 秒后强制显示并聚焦，避免出现「看不见的窗口」
  setTimeout(() => {
    try {
      if (!win.isDestroyed() && !win.isVisible()) {
        log('createWindow: 3 秒后仍未显示，强制 show()')
        win.show()
      }
    } catch (e) { log('createWindow: 兜底 show 失败 ' + String(e)) }
  }, 3000)

  win.webContents.on('did-finish-load', () => log('渲染进程：did-finish-load'))
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('渲染进程加载失败：' + code + ' ' + desc + ' ' + url))
  win.webContents.on('render-process-gone', (_e, details) => log('渲染进程崩溃：' + JSON.stringify(details)))
  win.webContents.on('unresponsive', () => log('渲染进程无响应'))
  // 不同 Electron 版本这里的参数形式不一样：新版是 (event, messageDetails)，
  // 旧版是 (event, level, message)。两种都认，否则页面日志会记成空内容。
  win.webContents.on('console-message', (_e: unknown, a: unknown, b?: unknown) => {
    if (a && typeof a === 'object' && 'message' in (a as Record<string, unknown>)) {
      const d = a as { level?: unknown; message?: unknown }
      log('页面控制台[' + String(d.level ?? '?') + ']：' + String(d.message ?? ''))
    } else {
      log('页面控制台[' + String(a ?? '?') + ']：' + String(b ?? ''))
    }
  })
  win.on('unresponsive', () => log('窗口无响应'))
  win.on('closed', () => log('窗口已关闭'))

  win.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' } })

  if (process.env.ELECTRON_RENDERER_URL) {
    log('加载开发地址：' + process.env.ELECTRON_RENDERER_URL)
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    const file = join(__dirname, '../renderer/index.html')
    log('加载页面：' + file)
    void win.loadFile(file)
  }
  log('createWindow: 完成')
}

// ⚠️ MCP 模式必须在这里分流 —— 必须在单实例锁之前。
// 否则被 harness 拉起来的进程会被判定为已有实例而直接退出，工具全部不可见。
if (isMcpMode(process.argv) || process.env.QUILL_MCP === '1') {
  // 不等 whenReady：无窗口时 ready 事件可能不触发；MCP 只需要用户数据路径与文件系统
  try {
    store = new Store(configPath())
    if (!registry.items.length) loadLibraries()
    const dir = registry.items.length ? activeLibraryDir() : ''
    if (dir && existsSync(dir)) { store.attachLibrary(dir); setLibraryPortable(dir) }
    const mNotes = new NoteService(store)
    const mTasks = new TaskService(store)
    const mBoards = new BoardService(mNotes)
    void runMcpMode({ store, notes: mNotes, tasks: mTasks, boards: mBoards })
  } catch (e) {
    process.stderr.write('MCP 启动失败：' + (e instanceof Error ? e.stack : String(e)) + String.fromCharCode(10))
    app.exit(1)
  }
} else {
  const gotSingleInstanceLock = app.requestSingleInstanceLock()
  installCrashHandlers()

  // 单实例：主进程是唯一写数据的人，绝不能让两份程序同时跑
  if (gotSingleInstanceLock) {
    app.on('second-instance', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.focus()
    })
  }

  if (gotSingleInstanceLock) app.whenReady().then(() => {
  try {
    // 注意：**关闭软件不等于断开云数据目录**。
    // 连接状态只在"切换到另一个云目录"或用户手动移除设备时才解除，
    // 否则关一次软件云端就开始 12 天倒计时了。
    log('=== 应用启动 ===')
  log('数据目录：' + app.getPath('userData') + (installPlan?.portable ? '（便携版，全部在软件文件夹内）' : ''))
    log('Electron ' + process.versions.electron + ' / Chromium ' + process.versions.chrome + ' / Node ' + process.versions.node)
    log('命令行：' + process.argv.join(' '))
    const argLibrary = process.argv.find((a) => a.startsWith('--library='))
    if (argLibrary) process.env.DSH_LIBRARY = argLibrary.slice('--library='.length)
    bootstrap(process.env.DSH_LIBRARY)
    log('数据目录：' + store.paths.root)
    // 附件协议：把 _attachments 下的文件按需吐给渲染进程（白板图片、笔记内嵌图）
    protocol.handle(DSH_ATTACHMENT_SCHEME, (request) => {
      try {
        const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '')
        const abs = notes.attachmentAbs(rel)
        if (!abs || !existsSync(abs)) return new Response('not found', { status: 404 })
        return net.fetch(pathToFileURL(abs).toString())
      } catch {
        return new Response('bad request', { status: 400 })
      }
    })
    registerIpc()
    log('IPC 注册完成')
    createWindow()
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  } catch (e) {
    log('启动失败：' + (e instanceof Error ? e.stack ?? e.message : String(e)))
    throw e
  }
})
}

  app.on('window-all-closed', () => {
    log('所有窗口已关闭，退出应用')
    if (process.platform !== 'darwin') app.quit()
  })

export { bootstrap, registerIpc }

/**
 * DSH 版新增：把 bootstrap 建立起来的那组服务暴露给插件入口。
 *
 * ⚠️ 必须返回**活引用**（getter），不能是快照：
 * `bootstrap()` 在切换数据目录时会整体换掉 store/notes/tasks/boards/library 这几个模块级 `let`，
 * 快照对象会永远指向旧库（切库后读到的还是旧数据）。
 */
export function quillRuntime(): {
  readonly store: Store
  readonly notes: NoteService
  readonly tasks: TaskService
  readonly boards: BoardService
  readonly library: LibraryService
  /** 当前库根目录（跟着 bootstrap 走） */
  readonly libraryRoot: string
} {
  return {
    get store() { return store },
    get notes() { return notes },
    get tasks() { return tasks },
    get boards() { return boards },
    get library() { return library },
    get libraryRoot() { return store.paths.root }
  }
}
