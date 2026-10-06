/**
 * 从 Quill 的 preload 源码生成 DSH 版客户端桥（src-client/bridge.ts）。
 *
 * 为什么用生成而不是手写：preload 里有 73 个方法，手抄必然出错；
 * 而它除了"传输方式"以外（ipcRenderer.invoke → fetch），其余语义我们想 100% 保留。
 *
 *   node tools/make-bridge.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const SRC = 'D:/DSH/test01/workapp/src/preload/index.ts'
const OUT = join(ROOT, 'src-client/bridge.ts')

const lines = readFileSync(SRC, 'utf8').split(/\r?\n/)
const start = lines.findIndex((l) => l.includes('const api: Api = {'))
const end = lines.findIndex((l) => l.includes("contextBridge.exposeInMainWorld('api', api)"))
if (start < 0 || end < 0 || end <= start) {
  console.error('未能在 preload 源码里定位 api 对象（start=%d end=%d）', start, end)
  process.exit(1)
}

const apiBody = lines
  .slice(start, end)
  .join('\n')
  .replace(/webUtils\.getPathForFile\(file\)/g, 'hostPathFor(file)')
  // 剪贴板：宿主进程写不了浏览器剪贴板，这里改成前端实现
  .replace(
    /copyText: \(text\) => call<boolean>\(CH\.copyText, text\),/,
    `copyText: async (text) => {
    try {
      await navigator.clipboard.writeText(String(text ?? ''))
      return true
    } catch {
      return false
    }
  },`,
  )
  // 文件选择：宿主是 Node，弹不出系统文件框 —— 改由页面自己弹
  .replace(
    /attachmentImport: \(sourcePath, hintName\) => call\(CH\.attachmentImport, sourcePath, hintName\),/,
    `attachmentImport: async (sourcePath, hintName) => {
    // 有现成路径（拖入/粘贴）直接交给宿主拷贝
    if (typeof sourcePath === 'string' && sourcePath !== '') {
      return call<{ rel: string; name: string }>(CH.attachmentImport, sourcePath, hintName)
    }
    // 没有路径 = 用户点了"插入图片"：由页面弹文件框
    const picked = await pickLocalFile('image/*')
    if (picked === null) return null as never
    if (picked.path !== '') return call<{ rel: string; name: string }>(CH.attachmentImport, picked.path, hintName ?? picked.name)
    // 网页版拿不到真实路径：退化成把内容存成附件
    return call<{ rel: string; name: string }>(CH.attachmentFromData, picked.dataUrl, hintName ?? picked.name)
  },`,
  )
  .replace(
    /pickFile: \(\) => call<string \| null>\(CH\.pickFile\),/,
    `pickFile: async () => {
    const picked = await pickLocalFile()
    return picked === null ? null : (picked.path !== '' ? picked.path : null)
  },`,
  )
  .replace(
    /libraryPickFolder: \(\) => call<string \| null>\(CH\.libraryPickFolder\),/,
    `libraryPickFolder: async () => {
    // 桌面端 preload 直接给了目录选择器；没有就回退到宿主通道
    const bridge = (globalThis as { __DSH_DIRECTORY_PICKER__?: { pick?: () => Promise<string> } }).__DSH_DIRECTORY_PICKER__
    if (typeof bridge?.pick === 'function') {
      try {
        const dir = await bridge.pick()
        return typeof dir === 'string' && dir !== '' ? dir : null
      } catch {
        return null
      }
    }
    return call<string | null>(CH.libraryPickFolder)
  },`,
  )

const header = `// ⚠️ 本文件由 tools/make-bridge.mjs 从 workapp/src/preload/index.ts 生成，请勿手改。
//
// DSH 版与 Electron 版的唯一区别就是"传输方式"：
//   Electron: ipcRenderer.invoke(channel, ...args)
//   DSH     : POST /quill-user/api  { channel, args }  →  { ok, value | error }
// 方法名、参数、返回结构、错误文案全部与 Quill 保持一致，所以渲染层一行都不用改。
import { CH } from '@shared/ipc'
import type { AppConfig, HistoryEntry, Note, Tag, Task, TrashNote, TrashTask, WhiteboardFile, TreeNode } from '@shared/types'
import type { Api, CandidateTask, ConversationItem, NoteContent, PendingConfirm, PickedAttachment, TaskView } from '@shared/api'
import { ROOT } from './paths.mjs'
import { join } from 'node:path'

/** 取拖入文件的绝对路径：DSH 桌面端 preload 暴露了 __DSH_HOST_PATHS__（等价的 webUtils.getPathForFile） */
function hostPathFor(file: File): string {
  const bridge = (globalThis as { __DSH_HOST_PATHS__?: { pathFor?: (f: File) => string } }).__DSH_HOST_PATHS__
  try {
    return typeof bridge?.pathFor === 'function' ? String(bridge.pathFor(file) ?? '') : ''
  } catch {
    return ''
  }
}

/**
 * 让用户选一个本地文件。
 *
 * 为什么由页面来做：宿主半边跑在 Node 里，弹不出系统文件框（原版靠 Electron 的 dialog）。
 * 页面里的 <input type=file> 能弹，再用 __DSH_HOST_PATHS__.pathFor 拿到真实路径。
 *
 * ⚠️ 测试接缝：globalThis.__DSH_PICK_FILE_HOOK__ 存在时优先使用（自动化测试用它注入文件），
 * 生产环境不会设置这个变量。
 */
function pickLocalFile(accept?: string): Promise<{ path: string; name: string; dataUrl: string } | null> {
  const hook = (globalThis as {
    __DSH_PICK_FILE_HOOK__?: (accept?: string) => Promise<{ path: string; name: string; dataUrl: string } | null>
  }).__DSH_PICK_FILE_HOOK__
  if (typeof hook === 'function') return hook(accept)

  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept !== undefined) input.accept = accept
    input.style.display = 'none'
    document.body.append(input)
    let settled = false
    const finish = (value: { path: string; name: string; dataUrl: string } | null): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(value)
    }
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file === undefined) { finish(null); return }
      const reader = new FileReader()
      reader.onload = () => finish({ path: hostPathFor(file), name: file.name, dataUrl: String(reader.result ?? '') })
      reader.onerror = () => finish({ path: hostPathFor(file), name: file.name, dataUrl: '' })
      reader.readAsDataURL(file)
    })
    input.addEventListener('cancel', () => finish(null))
    input.click()
  })
}

/** 统一的宿主调用入口（原 preload 里是 ipcRenderer.invoke + 信封解包） */async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await fetch('/quill-user/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, args })
  })
  if (!res.ok) throw new Error('本地服务返回 ' + res.status)
  const payload = (await res.json()) as { ok: boolean; value?: T; error?: string }
  if (payload && payload.ok) return payload.value as T
  throw new Error(payload?.error || '操作失败')
}

/** 兼容层：AI 相关订阅在 DSH 版里是空实现（宿主侧的 AI 服务是桩） */
const ipcRenderer = {
  on: (_channel: string, _handler: unknown): void => undefined,
  removeListener: (_channel: string, _handler: unknown): void => undefined
}

`

const footer = `

export default api
`

writeFileSync(OUT, header + apiBody + footer, 'utf8')
console.log('已生成 ' + OUT)
console.log('  api 方法数：' + (apiBody.match(/^\s{2}[a-zA-Z]+:/gm) ?? []).length)
