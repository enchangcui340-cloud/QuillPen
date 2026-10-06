/**
 * DSH 版 electron shim。
 *
 * 为什么需要它：Quill 的宿主半边（`index.ts` + services）只通过 Electron 做三件事 ——
 * 拿目录、弹系统对话框、注册自定义协议；剩下的全是纯 Node 文件操作。
 * 与其把 1500 行的 index.ts 改写一遍，不如在这里提供同名 API，
 * 让原文件几乎不需要改动（只改第 1 行的 import 来源）。
 *
 * 与真实 Electron 的差异（按本插件需要裁剪）：
 *  - `ipcMain.handle(ch, fn)` 不再走 IPC，而是存进本模块的通道表，由 /quill/api 路由调用；
 *  - `dialog.showOpenDialog` 默认返回"已取消"，由插件入口注入真实实现（走前端选择器）；
 *  - `protocol.*` / `net.*` / `clipboard.*` 是空实现：附件改走 HTTP 路由；
 *  - 单实例锁恒为 true（桌面端本身已保证单实例）。
 */

type DialogResult = { canceled: boolean; filePaths: string[] }
type DialogHandler = (options: unknown) => Promise<DialogResult>

import { spawn } from 'node:child_process'

/**
 * 以"不阻塞、不接管父进程"的方式拉起一个系统程序。
 * `cmd /c start "" <url>` 是 Windows 下用默认程序打开链接/文件的标准姿势；
 * 先 `unref()` 再 `spawn`，避免这个临时进程拖住 DSH 宿主不退出。
 */
function spawnDetached(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    /* 打不开就静默失败：调用方（界面）本来也没有反馈通道 */
  }
}

/** 由插件入口注入的真实对话框实现（前端选择器 → 宿主） */
let dialogHandler: DialogHandler | undefined
export function setDialogHandler(handler: DialogHandler | undefined): void {
  dialogHandler = handler
}

/**
 * 系统集成的可注入实现。
 *
 * 生产环境走真实的 `cmd /c start` / `explorer /select,`；
 * 测试注入一个"记下来但不真开窗口"的替身 —— 否则跑一次测试就会在用户桌面上弹资源管理器。
 */
export interface ShellHandler {
  openExternal?(url: string): void
  openPath?(target: string): void
  showItemInFolder?(target: string): void
}
let shellHandler: ShellHandler | undefined
export function setShellHandler(handler: ShellHandler | undefined): void {
  shellHandler = handler
}

/** 通道表：channel → 已被 handle() 包好信封的异步函数 */
const channels = new Map<string, (...args: unknown[]) => Promise<unknown>>()
/**
 * 调用一个通道。
 *
 * ⚠️ 必须补一个"事件"占位参数：`index.ts` 里的 `handle()` 是
 * `ipcMain.handle(channel, async (_event, ...args) => fn(...args))`，
 * 也就是说表里存的函数第一个形参是 IPC 事件对象。
 * 直接 `fn(...args)` 会让所有参数左移一位 —— 表现为"无参通道全好、带参通道全报参数类型错"。
 */
export function invokeChannel(channel: string, args: unknown[]): Promise<unknown> | undefined {
  const fn = channels.get(channel)
  return fn === undefined ? undefined : fn(undefined, ...args)
}
export function channelNames(): string[] {
  return [...channels.keys()].sort()
}

const paths: Record<string, string> = {}
let userDataDir = ''

function osPaths(): Record<string, string> {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  return {
    home,
    appData: process.env.APPDATA ?? home,
    temp: process.env.TEMP ?? process.env.TMP ?? home,
    documents: `${home}\\Documents`,
    desktop: `${home}\\Desktop`,
    exe: process.execPath
  }
}

export const app = {
  isPackaged: false,
  getAppPath: () => process.cwd(),
  /** 只支持 Quill 用到的几个名字；其余回落到 os 推断 */
  getPath(name: string): string {
    if (name === 'userData') return userDataDir
    return paths[name] ?? osPaths()[name] ?? ''
  },
  setPath(name: string, value: string): void {
    if (name === 'userData') userDataDir = value
    else paths[name] = value
  },
  /**
   * 刻意永不 resolve：原 `index.ts` 顶层有 `app.whenReady().then(() => { bootstrap(); registerIpc(); createWindow() })`，
   * 那是 Electron 的启动流程。DSH 版由插件入口显式调用 `bootstrap()` + `registerIpc()`，
   * 让这个 then 永不触发，就能"原文件一行不改"地关掉自动启动。
   */
  whenReady: () => new Promise<never>(() => undefined),
  on: () => app,
  once: () => app,
  quit: () => undefined,
  exit: () => undefined,
  requestSingleInstanceLock: () => true,
  relaunch: () => undefined
}

export const ipcMain = {
  handle(channel: string, fn: (...args: unknown[]) => Promise<unknown>): void {
    channels.set(channel, fn)
  },
  removeHandler(channel: string): void {
    channels.delete(channel)
  },
  on: () => undefined
}

export const dialog = {
  async showOpenDialog(options: unknown): Promise<DialogResult> {
    if (dialogHandler === undefined) return { canceled: true, filePaths: [] }
    return dialogHandler(options)
  }
}

export const shell = {
  /** 用系统默认程序打开 URL（等价 Electron shell.openExternal） */
  openExternal: async (url: string): Promise<void> => {
    if (typeof url !== 'string' || url.trim() === '') return
    if (shellHandler?.openExternal !== undefined) { shellHandler.openExternal(url); return }
    spawnDetached('cmd', ['/c', 'start', '', url])
  },
  /** 用系统默认程序打开文件或文件夹 */
  openPath: async (target: string): Promise<string> => {
    if (typeof target !== 'string' || target.trim() === '') return ''
    if (shellHandler?.openPath !== undefined) { shellHandler.openPath(target); return '' }
    spawnDetached('cmd', ['/c', 'start', '', target])
    return ''
  },
  /** 在资源管理器中定位到某个文件 */
  showItemInFolder: (target: string): void => {
    if (typeof target !== 'string' || target.trim() === '') return
    if (shellHandler?.showItemInFolder !== undefined) { shellHandler.showItemInFolder(target); return }
    spawnDetached('explorer.exe', ['/select,' + target])
  }
}

export const clipboard = {
  /** 宿主进程写不了浏览器剪贴板；前端桥会把 copyText 改成 navigator.clipboard */
  writeText: (): void => undefined,
  readText: (): string => ''
}

export const protocol = {
  registerSchemesAsPrivileged: (): void => undefined,
  handle: (): void => undefined
}

export const net = {
  fetch: (...args: Parameters<typeof fetch>): Promise<Response> => fetch(...args)
}

export const nativeImage = {
  createFromPath: () => ({ isEmpty: () => true })
}

export const webUtils = {
  getPathForFile: (): string => ''
}

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
  webContents = { send: (): void => undefined }
  isDestroyed(): boolean {
    return true
  }
  loadURL(): Promise<void> {
    return Promise.resolve()
  }
}

export default { app, ipcMain, dialog, shell, clipboard, protocol, net, nativeImage, webUtils, BrowserWindow }
