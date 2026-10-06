import type {
  AppConfig, HistoryEntry, Note, Priority, Tag, Task, TrashNote, TrashTask, WhiteboardFile, TreeNode
} from './types'

/** 选择附件后返回的内容；PDF 会在界面侧转换成图片再发送。 */
export interface PickedAttachment {
  name: string
  kind: 'image' | 'text' | 'pdf'
  dataUrl?: string
  text?: string
  warning?: string
}

export interface ConversationItem {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  at: string
  attachments?: { name: string; note?: string }[]
  noteEdits?: { noteId: string; title: string; applied: boolean; error?: string }[]
  error?: boolean
}

export interface CandidateTask {
  id: string
  name: string
  tagNames: string[]
  priority: Priority
  ddl: string | null
  ddlInferred: boolean
  createNote: boolean
  noteTitle?: string
  noteBrief?: string
  replacesTaskId?: string | null
  warning?: string
}

export interface PendingConfirm {
  id: string
  kind: 'create' | 'replace'
  candidates: CandidateTask[]
  createdAt: string
}

export interface CloudTestResult { name: string; id: string; host: string; user: string; files: number; stamp: CloudStamp | null; devices: CloudDevice[] }
export interface CloudStatus {
  usage: { files: number; bytes: number }
  quota: number
  stamp: CloudStamp | null
  devices: CloudDevice[]
  emptySince: string | null
  selfId: string
  deviceName: string
  /** 是否存在"下载前的备份"（可恢复） */
  hasBackup: boolean
  /** 本机自上次同步后是否有改动（用于"未上传"提示） */
  localChanged: boolean
  lastUploadAt: string | null
  lastDownloadAt: string | null
  knownStampVersion: number
}

export interface AgentStepInfo { index: number; tool: string; ok: boolean; summary: string }

export interface CloudStamp { version: number; updatedAt: string; updatedBy: string; files: number; bytes: number }
export interface CloudDevice { id: string; name: string; since: string }

export interface LibraryListItem {
  id: string
  name: string
  kind: 'local' | 'cloud'
  path: string
  dir: string
  notes: number
  sizeBytes: number
  exists: boolean
  isActive: boolean
  createdAt: string
  lastUsedAt: string
  cloud?: {
    host: string
    port: number
    user: string
    keyFile: string
    remoteDir: string
    key?: string
    cloudId?: string
    knownStampVersion?: number
    lastUploadAt?: string
    lastDownloadAt?: string
  }
}

export interface NoteContent {
  note: Note
  content: string
  inlinedImages: Record<string, string>
  whiteboard?: WhiteboardFile
}

export interface TaskView extends Task {
  tagPaths: string[]
  noteTitle?: string | null
  noteMissing?: boolean
}

export interface Api {
  appInfo(): Promise<{ version: string; libraryPath: string; platform: string }>
  configGet(): Promise<AppConfig>
  configSet(patch: Partial<AppConfig>): Promise<AppConfig>
  /**
   * 扫描磁盘上"像笔记库"的目录（误换工作区后找回笔记用）。
   * 返回结果按笔记数量排序。
   */
  /** 列出所有数据目录（含统计信息与当前激活项） */
  librariesList(): Promise<{
    activeId: string
    items: (LibraryListItem)[]
  }>
  /** 在指定文件夹创建（或登记）一个数据目录，并切换过去 */
  libraryCreate(dir: string, name: string): Promise<{ id: string; dir: string; created: boolean }>
  /** 切换当前使用的数据目录 */
  libraryActivate(id: string): Promise<string>
  libraryRename(id: string, name: string): Promise<boolean>
  /** 从列表移除（不动文件） */
  libraryRemove(id: string): Promise<boolean>
  /** 弹系统文件夹选择框 */
  libraryPickFolder(): Promise<string | null>
  /** 云数据目录：状态 / 上传（本地覆盖云端）/ 下载（云端覆盖本地）/ 恢复下载前的备份 */
  /** 连接云端数据目录（mode: 空 = 保持本机为空 / download = 先把云端拉下来） */
  /** 创建一个新的云数据目录，返回它的 key */
  /** 用 key 连接云数据目录（mode: 'download' 表示先把云端内容拉下来） */
  cloudConnectKey(key: string, mode: string): Promise<{ id: string; dir: string; name: string; files: number }>
  /** 只测试 key 是否可用，不建立连接 */
  cloudTestKey(key: string): Promise<{ name: string; id: string; host: string; user: string; files: number; stamp: CloudStamp | null; devices: CloudDevice[] }>
  cloudStatus2(id: string): Promise<CloudStatus>
  cloudUpload2(id: string): Promise<{ uploaded: number; removed: number; bytes: number; stamp: CloudStamp }>
  cloudDownload2(id: string): Promise<{ files: number; bytes: number; stamp: CloudStamp | null }>
  cloudRestore2(id: string): Promise<boolean>
  cloudDevices2(id: string): Promise<{ devices: CloudDevice[]; selfId: string }>
  cloudRemoveDevice(id: string, deviceId: string): Promise<boolean>
  /** 断开/离开云目录；wasLast=true 表示本机是最后一个设备（界面需要警告 12 天后删除） */
  /** 可以作为复制目标的数据目录 */
  libraryTargets(): Promise<{ activeId: string; items: { id: string; name: string; kind: string; isActive: boolean }[] }>
  /** 把当前库里的某个笔记/笔记夹复制到另一个数据目录（源文件不动） */
  libraryCopy(fromRel: string, toLibraryId: string): Promise<{ copied: number; target: string; targetKind: string; files: string[]; dir: string }>
  cloudLeave(id: string): Promise<{ wasLast: boolean; others: CloudDevice[] }>
  /** 复制文本到系统剪贴板（主进程实现，稳定可靠） */
  copyText(text: string): Promise<boolean>
  /** 取拖进来文件的绝对路径（在预加载进程用 webUtils，同步返回） */
  filePath(file: File): string
  /**
   * 断开云数据目录（断链）：注销本机登记 + 从列表移除，并切回一个本地数据目录。
   * wasLast 表示本机是最后一个设备（界面据此提示 12 天后云端会被删除）。
   */
  cloudDisconnect(id: string): Promise<{ wasLast: boolean; others: number; next: string | null; localCopy: string }>
  /** 把云目录另存为一个独立的本地数据目录（手动备份） */
  librarySaveAsLocal(id: string, targetDir: string): Promise<{ id: string; dir: string }>
  cloudConnect(name: string, mode: string): Promise<{ id: string; dir: string }>
  cloudStatus(id: string): Promise<{ dir: string; hasBackup: boolean; localFiles: number; localBytes: number; lastUploadAt: string | null; lastDownloadAt: string | null }>
  cloudUpload(id: string): Promise<{ uploaded: number; removed: number; bytes: number; message: string }>
  cloudDownload(id: string): Promise<{ files: number; bytes: number }>
  cloudRestoreBackup(id: string): Promise<boolean>
  libraryCandidates(): Promise<{ path: string; notes: number; attachments: number; updatedAt: number; current: boolean }[]>
  /** 切换笔记库，切换后界面需要重新加载 */
  librarySwitch(path: string): Promise<string>
  libraryStats(): Promise<{ tasks: number; notes: number; trashTasks: number; trashNotes: number }>

  taskList(): Promise<TaskView[]>
  taskCreate(input: { name: string; tagIds?: string[]; priority?: Priority; ddl?: string | null; noteId?: string | null }): Promise<Task>
  taskUpdate(id: string, patch: Partial<Pick<Task, 'name' | 'tagIds' | 'priority' | 'ddl' | 'noteId'>>): Promise<Task>
  taskComplete(id: string): Promise<Task>
  taskDelete(id: string): Promise<void>
  tagList(): Promise<(Tag & { path: string })[]>
  tagCreate(name: string, parentId: string | null): Promise<Tag>
  tagRename(id: string, name: string): Promise<Tag>
  tagDelete(id: string): Promise<void>
  tagMove(id: string, parentId: string | null): Promise<Tag>
  trashTaskList(): Promise<TrashTask[]>
  trashTaskRestore(id: string): Promise<void>
  trashTaskPurge(id: string): Promise<void>
  historyList(): Promise<HistoryEntry[]>

  noteTree(): Promise<TreeNode[]>
  noteRead(id: string): Promise<NoteContent>
  noteForceSave(id: string, content: string): Promise<{ fileMtimeMs: number; note: Note | undefined }>
  /** 把未保存内容另存到 data/backups/，返回文件路径 */
  noteBackup(id: string, content: string): Promise<string>
  /**
   * 打开目标：http/https 走浏览器，本地文件走系统默认程序，文件夹打开资源管理器。
   * 库内相对路径（如 _attachments/x.png）会自动按笔记库解析。
   */
  openTarget(target: string): Promise<boolean>
  /** 系统文件选择框；取消返回 null */
  pickFile(): Promise<string | null>
  noteSave(id: string, content: string, baseRevisionMtimeMs: number): Promise<{ ok: true; note: Note } | { ok: false; conflict: true; current: string }>
  noteCreate(input: { dir: string; kind: 'md' | 'whiteboard'; title: string }): Promise<Note>
  noteRename(id: string, title: string): Promise<Note>
  noteMove(id: string, dir: string): Promise<Note>
  noteDelete(id: string): Promise<void>
  folderCreate(dir: string, name: string): Promise<string>
  folderRename(dir: string, name: string): Promise<string>
  folderMove(fromDir: string, toDir: string): Promise<void>
  folderDelete(dir: string): Promise<void>
  noteRestoreOrigin(id: string): Promise<{ moved: boolean; dir: string }>
  trashNoteList(): Promise<TrashNote[]>
  trashNoteRestore(ids: string[]): Promise<{ restored: string[]; renamed: { id: string; name: string }[] }>
  trashNotePurge(ids: string[]): Promise<void>
  /** 不传参数则弹系统选择框；传路径则直接导入该文件（复制粘贴/拖拽用） */
  attachmentImport(sourcePath?: string, hintName?: string): Promise<{ rel: string; name: string } | null>
  /**
   * 把一段图片数据（data URL）存进笔记库的附件目录，返回库内相对路径。
   * 用于"复制粘贴图片"和"把图片拖进笔记"。
   */
  attachmentFromData(dataUrl: string, name: string): Promise<{ rel: string; name: string }>
  /** 取出拖进来的系统文件的真实路径（Electron 新版不再直接给 File.path） */
  pathForFile(file: File): string
  attachmentUrl(url: string): Promise<string>
  attachmentData(rel: string): Promise<{ dataUrl: string; text: string } | null>

  boardRead(id: string): Promise<WhiteboardFile>
  boardSave(id: string, board: WhiteboardFile, baseRevisionMtimeMs: number): Promise<{ ok: true; fileMtimeMs: number } | { ok: false; conflict: true }>

  revealPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>

  aiStatus(): Promise<{ hasKey: boolean; model: string; baseUrl: string; noteCount: number; taskCount: number }>
  aiSetKey(key: string): Promise<{ ok: boolean; message: string }>
  aiClearKey(): Promise<{ ok: boolean }>
  aiConverseList(): Promise<ConversationItem[]>
  aiPendingList(): Promise<PendingConfirm[]>
  aiSend(input: {
    text: string
    files: { name: string; kind: 'image' | 'text'; dataUrl?: string; text?: string; warning?: string }[]
    noteIds: string[]
  }): Promise<void>
  aiConfirm(pendingId: string, candidates: CandidateTask[]): Promise<{ created: number; replaced: number; notes: number }>
  aiCancel(pendingId: string): Promise<void>
  /** 停止当前 AI 任务 */
  aiStop(): Promise<boolean>
  /** 撤销本次会话里 AI 的全部改动 */
  aiUndo(): Promise<{ undone: number; failed: string[] }>
  /** 最近一次任务执行的步骤（界面显示"AI 做了什么"） */
  aiSteps(): Promise<AgentStepInfo[]>
  /** 内嵌引擎（harness）状态与开关 */
  aiEngineGet(): Promise<{ running: boolean; mode: boolean }>
  aiEngineSet(on: boolean): Promise<{ running: boolean; mode: boolean }>
  /** 回答"AI 要删东西"的确认（allowAll=true 表示本次会话内都允许） */
  aiDangerAnswer(allow: boolean, allowAll: boolean): Promise<boolean>
  /** 订阅 AI 的删除确认请求 */
  onAiDanger(fn: (payload: { what: string; detail: string }) => void): () => void
  aiPickFiles(): Promise<PickedAttachment[]>
  aiApplyNoteEdits(pendingId: string, edits: { noteId: string; newContent: string }[]): Promise<{ applied: string[]; failed: { noteId: string; error: string }[] }>
  aiAbort(): Promise<void>
}
