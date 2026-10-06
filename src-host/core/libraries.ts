import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { writeTextAtomic } from './paths'

/**
 * 多数据目录（库）注册表。
 *
 * 一个"库"就是一个自包含文件夹：
 *   <库>/quill-library.json   身份标识（能被程序认出来）
 *   <库>/notes/               笔记与白板
 *   <库>/data/                待办、标签、回收站、备份
 *   <库>/_收件箱/  .trash/
 *
 * 注册表存在应用数据目录（跟着便携版文件夹走），记录所有已知的库与当前激活的那个。
 */
export const LIBRARY_MARKER = 'quill-library.json'

export interface CloudConfig {
  host: string
  port: number
  user: string
  /** 私钥文件（相对应用数据目录） */
  keyFile: string
  /** 服务器上的目录（chroot 内相对路径） */
  remoteDir: string
  /** 云目录的 key（含私钥）；本地库没有这一项 */
  key?: string
  /** 服务器上的云目录 ID */
  cloudId?: string
  /** 已知的云端时间码版本（用来判断"云数据目录已更新"） */
  knownStampVersion?: number
  /** 上一次上传成功的时间 */
  lastUploadAt?: string
  /** 上一次下载成功的时间 */
  lastDownloadAt?: string
}

export interface LibraryEntry {
  id: string
  name: string
  kind: 'local' | 'cloud'
  /** 本地库路径；便携库存相对路径（相对软件文件夹），其它为绝对路径 */
  path: string
  createdAt: string
  lastUsedAt: string
  /** 仅云端库 */
  cloud?: CloudConfig
}

export interface LibraryRegistry {
  version: 1
  activeId: string
  items: LibraryEntry[]
}

export function emptyRegistry(): LibraryRegistry {
  return { version: 1, activeId: '', items: [] }
}

/**
 * 库 ID。
 * 注意：要与 ipc/validate.ts 的 id 校验规则（^[a-z]+_[0-9a-z]{10,}$）保持一致，
 * 否则切换/重命名会被校验拦下，报"id 不合法"。
 */
export function newLibraryId(name: string): string {
  const hash = createHash('sha1').update(name + '|' + randomUUID()).digest('hex').slice(0, 12)
  return 'lib_' + hash
}

/** 读注册表（文件不存在/损坏都返回空表，不抛错） */
export function loadRegistry(file: string): LibraryRegistry {
  try {
    if (!existsSync(file)) return emptyRegistry()
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<LibraryRegistry>
    const items = Array.isArray(raw.items) ? raw.items.filter((i): i is LibraryEntry => !!i && typeof i.id === 'string') : []
    const activeId = items.some((i) => i.id === raw.activeId) ? String(raw.activeId) : (items[0]?.id ?? '')
    return { version: 1, activeId, items }
  } catch {
    return emptyRegistry()
  }
}

export function saveRegistry(file: string, reg: LibraryRegistry): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeTextAtomic(file, JSON.stringify(reg, null, 2))
}

/**
 * 修正历史遗留的非法 ID（早期版本生成的 ID 太短，会被校验器拒绝）。
 * 每次读取注册表时顺手修一遍，用户无感。
 */
export function repairRegistryIds(reg: LibraryRegistry): boolean {
  let changed = false
  for (const item of reg.items) {
    if (!/^[a-z]+_[0-9a-z]{10,}$/.test(item.id)) {
      const old = item.id
      item.id = newLibraryId(item.name || 'lib')
      if (reg.activeId === old) reg.activeId = item.id
      changed = true
    }
  }
  return changed
}

/** 便携库（在软件文件夹内部）存相对路径；否则存绝对路径 */
export function toStoredLibraryDir(abs: string, installDir: string | null): string {
  if (!installDir) return abs
  const rel = abs.startsWith(installDir) ? abs.slice(installDir.length).replace(/^[\\/]+/, '') : ''
  return rel && !rel.startsWith('..') ? rel : abs
}

export function resolveLibraryDir(stored: string, installDir: string | null): string {
  if (!stored) return ''
  if (isAbsolute(stored)) return resolve(stored)
  return resolve(join(installDir ?? process.cwd(), stored))
}

/** 数一下库里有几篇笔记（.md + 白板），用于界面展示 */
export function countNotes(dir: string): number {
  const notesDir = join(dir, 'notes')
  if (!existsSync(notesDir)) return 0
  let n = 0
  const walk = (d: string): void => {
    let entries: Dirent[]
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) { if (e.name !== '_attachments') walk(p); continue }
      if (e.name.endsWith('.md') || e.name.endsWith('.canvas.json')) n++
    }
  }
  walk(notesDir)
  return n
}

/** 这个文件夹是不是一个库（有标记文件或 notes 目录） */
/**
 * 整理用户手输/粘贴的路径。
 * 常见问题：从别处复制来的路径带引号、末尾多一个反斜杠 —— 都要处理掉，
 * 否则会被当成"相对路径"拼到软件文件夹后面，报一个看不懂的 mkdir 错误。
 */
export function normalizeDirInput(raw: string): string {
  let s = (raw ?? '').trim()
  // 去掉成对的引号（中英文都有可能）
  while (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) || (s.startsWith('“') && s.endsWith('”')))) {
    s = s.slice(1, -1).trim()
  }
  // 去掉末尾多余的斜杠（保留盘符根目录 C:\ 的情况）
  s = s.replace(/[\\/]+$/, (m) => (/^[a-zA-Z]:$/.test(s.slice(0, -m.length)) ? '\\' : ''))
  return s
}

export function looksLikeLibrary(dir: string): boolean {
  return existsSync(join(dir, LIBRARY_MARKER)) || existsSync(join(dir, 'notes'))
}

/** 在指定文件夹生成一个可用的数据目录（已存在则不覆盖任何东西） */
export function createLibraryAt(dir: string, name: string): { dir: string; created: boolean } {
  const abs = resolve(dir)
  const created = !looksLikeLibrary(abs)
  for (const sub of ['notes', 'data', '_收件箱', '.trash', join('data', 'backups')]) {
    mkdirSync(join(abs, sub), { recursive: true })
  }
  const marker = join(abs, LIBRARY_MARKER)
  if (!existsSync(marker)) {
    const meta = {
      id: newLibraryId(name || basename(abs)),
      name: name || basename(abs),
      createdAt: new Date().toISOString(),
      schema: 1,
      app: 'Quill'
    }
    writeTextAtomic(marker, JSON.stringify(meta, null, 2))
  }
  return { dir: abs, created }
}

/** 库的一些统计信息（界面展示用） */
export function libraryStats(dir: string): { notes: number; sizeBytes: number; updatedAt: number } {
  let notes = 0
  let size = 0
  let updatedAt = 0
  const notesDir = join(dir, 'notes')
  if (existsSync(notesDir)) {
    const walk = (d: string): void => {
      let entries: Dirent[]
      try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const p = join(d, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (e.name.endsWith('.md') || e.name.endsWith('.canvas.json')) notes++
        try { size += statSync(p).size; updatedAt = Math.max(updatedAt, statSync(p).mtimeMs) } catch { /* 忽略 */ }
      }
    }
    walk(notesDir)
  }
  return { notes, sizeBytes: size, updatedAt }
}
