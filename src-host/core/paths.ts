import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 数据根目录之外的所有路径都由这里统一计算，避免各处拼错。 */
export interface LibraryPaths {
  root: string
  notesDir: string
  attachmentsDir: string
  dataDir: string
  trashDir: string
  inboxDir: string
  tasksFile: string
  tagsFile: string
  notesIndexFile: string
  trashTasksFile: string
  trashNotesFile: string
  historyFile: string
  configFile: string
  secretsFile: string
  aiDir: string
  conversationFile: string
  pendingFile: string
  backupDir: string
}

export function makeLibraryPaths(root: string): LibraryPaths {
  const r = resolve(root)
  const dataDir = join(r, 'data')
  return {
    root: r,
    notesDir: join(r, 'notes'),
    attachmentsDir: join(r, 'notes', '_attachments'),
    dataDir,
    trashDir: join(r, '.trash'),
    inboxDir: join(r, '_收件箱'),
    tasksFile: join(dataDir, 'tasks.json'),
    tagsFile: join(dataDir, 'tags.json'),
    notesIndexFile: join(dataDir, 'notes.json'),
    trashTasksFile: join(dataDir, 'trash-tasks.json'),
    trashNotesFile: join(dataDir, 'trash-notes.json'),
    historyFile: join(dataDir, 'deleted-history.md'),
    configFile: join(r, 'config.json'),
    secretsFile: join(r, 'secrets.bin'),
    aiDir: join(dataDir, 'ai'),
    conversationFile: join(dataDir, 'ai', 'conversation.json'),
    pendingFile: join(dataDir, 'ai', 'pending.json'),
    backupDir: join(dataDir, 'backups')
  }
}

/**
 * API Key 的保存位置：放在应用数据目录（%APPDATA%\workapp）而不是笔记库里。
 * 之前存在库里的问题：换工作区、改文件夹名之后密钥就"消失"了，每次都要重新填。
 */
export function appSecretsFile(): string {
  try {
    // 测试环境里没有 electron 的 app，这里兜一下
    const ud = app?.getPath?.('userData')
    if (ud) return join(ud, 'secrets.json')
  } catch { /* 忽略 */ }
  return join(process.cwd(), '.quill-secrets.json')
}

export function defaultLibraryRoot(): string {
  return join(app.getPath('documents'), 'Quill')
}

export function ensureDirs(p: LibraryPaths): void {
  for (const d of [p.root, p.notesDir, p.attachmentsDir, p.dataDir, p.trashDir, p.inboxDir, p.aiDir, p.backupDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    const raw = readFileSync(file, 'utf8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw) as T
  } catch (e) {
    // 损坏时保留现场，返回兜底值，避免整个应用无法启动
    try { renameSync(file, file + '.corrupt-' + Date.now()) } catch { /* ignore */ }
    return fallback
  }
}

/** 原子写：先写临时文件再重命名，避免半完成文件。 */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  try {
    renameSync(tmp, file)
  } catch (e) {
    try { unlinkSync(file) } catch { /* ignore */ }
    renameSync(tmp, file)
  }
}

export function writeTextAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (e) {
    try { unlinkSync(file) } catch { /* ignore */ }
    renameSync(tmp, file)
  }
}
