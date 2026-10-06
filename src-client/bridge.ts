// ⚠️ 本文件由 tools/make-bridge.mjs 从 workapp/src/preload/index.ts 生成，请勿手改。
//
// DSH 版与 Electron 版的唯一区别就是"传输方式"：
//   Electron: ipcRenderer.invoke(channel, ...args)
//   DSH     : POST /quill/api  { channel, args }  →  { ok, value | error }
// 方法名、参数、返回结构、错误文案全部与 Quill 保持一致，所以渲染层一行都不用改。
import { CH } from '@shared/ipc'
import type { AppConfig, HistoryEntry, Note, Tag, Task, TrashNote, TrashTask, WhiteboardFile, TreeNode } from '@shared/types'
import type { Api, CandidateTask, ConversationItem, NoteContent, PendingConfirm, PickedAttachment, TaskView } from '@shared/api'

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

const api: Api = {
  appInfo: () => call(CH.appInfo),
  configGet: () => call<AppConfig>(CH.configGet),
  configSet: (patch) => call<AppConfig>(CH.configSet, patch),
  librariesList: () => call<{ activeId: string; items: import('@shared/api').LibraryListItem[] }>(CH.librariesList),
  libraryCreate: (dir, name) => call<{ id: string; dir: string; created: boolean }>(CH.libraryCreate, dir, name),
  libraryActivate: (id) => call<string>(CH.libraryActivate, id),
  libraryRename: (id, name) => call<boolean>(CH.libraryRename, id, name),
  libraryRemove: (id) => call<boolean>(CH.libraryRemove, id, false),
  cloudConnectKey: (key, mode) => call<{ id: string; dir: string; name: string; files: number }>(CH.cloudConnectKey, key, mode),
  cloudTestKey: (key) => call<import('@shared/api').CloudTestResult>(CH.cloudTestKey, key),
  cloudStatus2: (id) => call<import('@shared/api').CloudStatus>(CH.cloudStatus2, id),
  cloudUpload2: (id) => call<{ uploaded: number; removed: number; bytes: number; stamp: import('@shared/api').CloudStamp }>(CH.cloudUpload2, id),
  cloudDownload2: (id) => call<{ files: number; bytes: number; stamp: import('@shared/api').CloudStamp | null }>(CH.cloudDownload2, id),
  cloudRestore2: (id) => call<boolean>(CH.cloudRestore2, id),
  cloudDevices2: (id) => call<{ devices: import('@shared/api').CloudDevice[]; selfId: string }>(CH.cloudDevices2, id),
  cloudRemoveDevice: (id, devId) => call<boolean>(CH.cloudRemoveDevice, id, devId),
  libraryTargets: () => call<{ activeId: string; items: { id: string; name: string; kind: string; isActive: boolean }[] }>(CH.libraryTargets),
  libraryCopy: (fromRel, toLibraryId) => call<{ copied: number; target: string; targetKind: string; files: string[]; dir: string }>(CH.libraryCopy, fromRel, toLibraryId),
  /**
   * 取拖进来文件的绝对路径。
   *
   * ⚠️ 必须在**预加载/渲染进程**调用 webUtils.getPathForFile —— 放到主进程是错的：
   * File 对象经 IPC 会被序列化成普通对象，拿不到真实路径（实测会变成 [object Object]）。
   */
  filePath: (file: File): string => {
    try {
      const p = hostPathFor(file)
      return typeof p === 'string' ? p : ''
    } catch { return '' }
  },
  copyText: async (text) => {
    try {
      await navigator.clipboard.writeText(String(text ?? ''))
      return true
    } catch {
      return false
    }
  },
  cloudDisconnect: (id) => call<{ wasLast: boolean; others: number; next: string | null; localCopy: string }>(CH.cloudDisconnect, id),
  cloudLeave: (id) => call<{ wasLast: boolean; others: import('@shared/api').CloudDevice[] }>(CH.cloudLeave, id),
  librarySaveAsLocal: (id, targetDir) => call<{ id: string; dir: string }>(CH.librarySaveAsLocal, id, targetDir),
  cloudConnect: (name, mode) => call<{ id: string; dir: string }>(CH.cloudConnect, name, mode),
  cloudStatus: (id) => call<{ dir: string; hasBackup: boolean; localFiles: number; localBytes: number; lastUploadAt: string | null; lastDownloadAt: string | null }>(CH.cloudStatus, id),
  cloudUpload: (id) => call<{ uploaded: number; removed: number; bytes: number; message: string }>(CH.cloudUpload, id),
  cloudDownload: (id) => call<{ files: number; bytes: number }>(CH.cloudDownload, id),
  cloudRestoreBackup: (id) => call<boolean>(CH.cloudRestoreBackup, id),
  libraryPickFolder: async () => {
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
  },
  libraryCandidates: () => call<{ path: string; notes: number; attachments: number; updatedAt: number; current: boolean }[]>(CH.libraryCandidates),
  librarySwitch: (path) => call<string>(CH.librarySwitch, path),
  libraryStats: () => call(CH.libraryStats),

  taskList: () => call<TaskView[]>(CH.taskList),
  taskCreate: (input) => call<Task>(CH.taskCreate, input),
  taskUpdate: (id, patch) => call<Task>(CH.taskUpdate, id, patch),
  taskComplete: (id) => call<Task>(CH.taskComplete, id),
  taskDelete: (id) => call<void>(CH.taskDelete, id),
  tagList: () => call<(Tag & { path: string })[]>(CH.tagList),
  tagCreate: (name, parentId) => call<Tag>(CH.tagCreate, name, parentId),
  tagRename: (id, name) => call<Tag>(CH.tagRename, id, name),
  tagDelete: (id) => call<void>(CH.tagDelete, id),
  tagMove: (id, parentId) => call<Tag>(CH.tagMove, id, parentId),
  trashTaskList: () => call<TrashTask[]>(CH.trashTaskList),
  trashTaskRestore: (id) => call<void>(CH.trashTaskRestore, id),
  trashTaskPurge: (id) => call<void>(CH.trashTaskPurge, id),
  historyList: () => call<HistoryEntry[]>(CH.historyList),

  noteTree: () => call<TreeNode[]>(CH.noteTree),
  noteRead: (id) => call<NoteContent>(CH.noteRead, id),
  noteForceSave: (id, content) => call<{ fileMtimeMs: number; note: Note }>(CH.noteForceSave, id, content),
  noteBackup: (id, content) => call<string>(CH.noteBackup, id, content),
  openTarget: (target) => call<boolean>(CH.openTarget, target),
  pickFile: async () => {
    const picked = await pickLocalFile()
    return picked === null ? null : (picked.path !== '' ? picked.path : null)
  },
  noteSave: (id, content, baseRevisionMtimeMs) => call(CH.noteSave, id, content, baseRevisionMtimeMs),
  noteCreate: (input) => call<Note>(CH.noteCreate, input),
  noteRename: (id, title) => call<Note>(CH.noteRename, id, title),
  noteMove: (id, dir) => call<Note>(CH.noteMove, id, dir),
  noteDelete: (id) => call<void>(CH.noteDelete, id),
  folderCreate: (dir, name) => call<string>(CH.folderCreate, dir, name),
  folderRename: (dir, name) => call<string>(CH.folderRename, dir, name),
  folderMove: (from, to) => call<void>(CH.folderMove, from, to),
  folderDelete: (dir) => call<void>(CH.folderDelete, dir),
  noteRestoreOrigin: (id) => call(CH.noteRestoreOrigin, id),
  trashNoteList: () => call<TrashNote[]>(CH.trashNoteList),
  trashNoteRestore: (ids) => call(CH.trashNoteRestore, ids),
  trashNotePurge: (ids) => call<void>(CH.trashNotePurge, ids),
  attachmentFromData: (dataUrl, name) => call<{ rel: string; name: string }>(CH.attachmentFromData, dataUrl, name),
  pathForFile: (file) => {
    try { return hostPathFor(file) } catch { return '' }
  },
  attachmentImport: async (sourcePath, hintName) => {
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
  },
  attachmentUrl: (url) => call<string>(CH.attachmentUrl, url),
  attachmentData: (rel: string) => call<{ dataUrl: string; text: string } | null>(CH.attachmentData, rel),

  boardRead: (id) => call<WhiteboardFile>(CH.boardRead, id),
  boardSave: (id, board, baseRevisionMtimeMs) => call(CH.boardSave, id, board, baseRevisionMtimeMs),

  revealPath: (path) => call<void>(CH.revealPath, path),
  openExternal: (url) => call<void>(CH.openExternal, url),

  aiStatus: () => call(CH.aiStatus),
  aiSetKey: (key) => call(CH.aiSetKey, key),
  aiClearKey: () => call(CH.aiClearKey),
  aiConverseList: () => call<ConversationItem[]>(CH.aiConverseList),
  aiPendingList: () => call<PendingConfirm[]>(CH.aiPendingList),
  aiSend: (input) => call<void>(CH.aiSend, input),
  aiConfirm: (pendingId, candidates: CandidateTask[]) => call(CH.aiConfirm, pendingId, candidates),
  aiStop: () => call<boolean>(CH.aiStop),
  aiUndo: () => call<{ undone: number; failed: string[] }>(CH.aiUndo),
  aiEngineGet: () => call<{ running: boolean; mode: boolean }>(CH.aiEngineGet),
  aiEngineSet: (on) => call<{ running: boolean; mode: boolean }>(CH.aiEngineSet, on),
  aiDangerAnswer: (allow, allowAll) => call<boolean>(CH.aiDangerAnswer, allow, allowAll),
  /** 订阅"AI 想做删除操作"的请求（主进程推过来） */
  onAiDanger: (fn: (payload: { what: string; detail: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { what: string; detail: string }): void => fn(payload)
    ipcRenderer.on('ai:danger-ask', handler)
    return () => { ipcRenderer.removeListener('ai:danger-ask', handler) }
  },
  aiSteps: () => call<import('@shared/api').AgentStepInfo[]>(CH.aiSteps),
  aiCancel: (pendingId) => call<void>(CH.aiCancel, pendingId),
  aiPickFiles: () => call<PickedAttachment[]>(CH.aiPickFiles),
  aiApplyNoteEdits: (pendingId, edits) => call(CH.aiApplyNoteEdits, pendingId, edits),
  aiAbort: () => call<void>(CH.aiAbort)
}


export default api
