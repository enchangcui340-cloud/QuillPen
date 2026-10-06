import { app } from 'electron'
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { writeTextAtomic } from '../core/paths'
import type { Store } from '../core/store'
import type { NoteService } from './notes'
import type { WhiteboardFile } from '@shared/types'

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.log'])

export interface ScanCandidate {
  absPath: string
  name: string
  kind: 'md' | 'whiteboard' | 'image' | 'other'
  inNotesDir: boolean
  relDir: string | null
  size: number
}

/** 打开一个既有文件夹作为笔记库：扫描内容、按原层级导入、记录原始位置。 */
export interface LibraryCandidate {
  path: string
  /** 笔记与白板数量 */
  notes: number
  attachments: number
  /** 数据目录最后修改时间（用来判断新旧） */
  updatedAt: number
  current: boolean
}

export class LibraryService {
  /** 最近一次扫描的根目录，用于保留源文件夹内的相对层级。 */
  scanRootPath = ''

  constructor(private store: Store, private notes: NoteService) {}

  /**
   * 扫描磁盘上"像笔记库"的目录。
   * 用途：工作区被误改/文件夹被改名后，帮用户把笔记找回来。
   * 判定依据是库的标准结构（notes 目录，或 data/notes.json）。
   */
  scanCandidates(extraRoots: string[] = []): LibraryCandidate[] {
    const current = resolve(this.store.paths.root)
    const roots: string[] = []
    try {
      // 测试环境里没有 electron 的 app，这里兜一下
      if (app && typeof app.getPath === 'function') {
        roots.push(app.getPath('documents'), app.getPath('desktop'), app.getPath('home'))
      }
    } catch { /* 忽略 */ }
    roots.push(...extraRoots, dirname(current))

    const seen = new Set<string>()
    const out: LibraryCandidate[] = []
    const skip = /(^|[\\/])(node_modules|.git|resources|locales|out|dist|\$RECYCLE.BIN)([\\/]|$)/i

    const consider = (dir: string): void => {
      const abs = resolve(dir)
      if (seen.has(abs) || skip.test(abs)) return
      seen.add(abs)
      const notesDir = join(abs, 'notes')
      const indexFile = join(abs, 'data', 'notes.json')
      if (!existsSync(notesDir) && !existsSync(indexFile)) return
      let notes = 0
      let attachments = 0
      if (existsSync(notesDir)) {
        const walk = (d: string): void => {
          for (const e of readdirSync(d, { withFileTypes: true })) {
            if (e.name.startsWith('.')) continue
            const p = join(d, e.name)
            if (e.isDirectory()) {
              if (e.name === '_attachments') {
                attachments += readdirSync(p).length
                continue
              }
              walk(p)
              continue
            }
            if (e.name.endsWith('.md') || e.name.endsWith('.canvas.json')) notes++
          }
        }
        try { walk(notesDir) } catch { /* 权限问题跳过 */ }
      }
      let updatedAt = 0
      for (const f of [join(abs, 'data', 'tasks.json'), indexFile, notesDir]) {
        try { if (existsSync(f)) updatedAt = Math.max(updatedAt, statSync(f).mtimeMs) } catch { /* 忽略 */ }
      }
      out.push({ path: abs, notes, attachments, updatedAt, current: abs === current })
    }

    const scan = (root: string, depth: number): void => {
      if (!existsSync(root)) return
      consider(root)
      if (depth <= 0) return
      let entries: Dirent[]
      try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue
        if (skip.test(e.name)) continue
        scan(join(root, e.name), depth - 1)
      }
    }

    for (const r of roots) scan(r, 2)
    return out
      .filter((c) => c.notes > 0 || c.current)
      .sort((a, b) => (b.notes - a.notes) || (b.updatedAt - a.updatedAt))
  }

  /** 切换到另一个笔记库（调用方负责让界面重新加载） */
  switchTo(path: string): string {
    const abs = resolve(path)
    if (!existsSync(abs)) throw new Error('这个位置不存在：' + abs)
    const notesDir = join(abs, 'notes')
    const indexFile = join(abs, 'data', 'notes.json')
    if (!existsSync(notesDir) && !existsSync(indexFile)) throw new Error('这里不像是笔记库（没有 notes 文件夹）')
    this.store.setLibrary(abs)
    this.store.ensureLibrary()
    return abs
  }

  scanFolder(folder: string, depth = 0, out: ScanCandidate[] = []): ScanCandidate[] {
    if (!existsSync(folder) || depth > 6) return out
    if (depth === 0) this.scanRootPath = folder
    const notesRoot = resolve(this.store.paths.notesDir)
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (entry.name === 'node_modules') continue
      const absPath = join(folder, entry.name)
      if (entry.isDirectory()) {
        this.scanFolder(absPath, depth + 1, out)
        continue
      }
      if (!entry.isFile()) continue
      const lower = entry.name.toLowerCase()
      let kind: ScanCandidate['kind'] = 'other'
      if (lower.endsWith('.canvas.json')) kind = 'whiteboard'
      else if (lower.endsWith('.md') || lower.endsWith('.markdown')) kind = 'md'
      else if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lower)) kind = 'image'
      else if (TEXT_EXT.has('.' + lower.split('.').pop())) kind = 'other'
      const isInsideNotes = resolve(absPath).startsWith(notesRoot + sep)
      out.push({
        absPath,
        name: entry.name,
        kind,
        inNotesDir: isInsideNotes,
        relDir: isInsideNotes ? null : this.suggestDir(absPath, notesRoot, this.scanRootPath),
        size: statSync(absPath).size
      })
    }
    return out
  }

  /**
   * 计算导入后的目标目录：库内文件返回其所在目录；库外文件只保留源文件夹内的相对层级，
   * 不把源路径的绝对结构带进笔记库。
   */
  private suggestDir(absPath: string, notesRoot: string, scanRoot?: string): string {
    const parent = resolve(absPath, '..')
    if (parent.startsWith(notesRoot + sep)) {
      return parent.slice(notesRoot.length + 1).split(sep).join('/')
    }
    if (scanRoot) {
      const rootAbs = resolve(scanRoot)
      if (parent === rootAbs) return ''
      if (parent.startsWith(rootAbs + sep)) {
        return parent.slice(rootAbs.length + 1).split(sep).join('/')
      }
    }
    return ''
  }

  /**
   * 导入一个文件：保持原名，记录原始位置；之后可改名或移动而引用不断。
   * 已位于笔记库内的文件不搬动，只补写稳定 ID。
   */
  importFile(candidate: ScanCandidate): { id: string | null; skipped: boolean } {
    if (candidate.inNotesDir) return { id: null, skipped: true }
    if (candidate.kind === 'other') {
      const text = this.readTextSafe(candidate.absPath)
      if (text === null) return { id: null, skipped: true }
      const rel = candidate.relDir || ''
      const created = this.notes.create(rel, 'md', stripExt(candidate.name))
      this.notes.saveNoteForced(created.id, this.withFrontmatter(text, created.id, created.title))
      this.notes.setOriginPath(created.id, candidate.absPath)
      return { id: created.id, skipped: false }
    }
    const rel = candidate.relDir || ''
    const kind = candidate.kind === 'whiteboard' ? 'whiteboard' : 'md'
    const created = this.notes.create(rel, kind, stripExt(candidate.name))
    if (kind === 'whiteboard') {
      const board = this.readBoardSafe(candidate.absPath, created.title)
      this.notes.saveBoardForced(created.id, { ...board, id: created.id })
    } else {
      const raw = readFileSync(candidate.absPath, 'utf8')
      this.notes.saveNoteForced(created.id, this.withFrontmatter(raw, created.id, created.title))
    }
    this.notes.setOriginPath(created.id, candidate.absPath)
    return { id: created.id, skipped: false }
  }

  private withFrontmatter(raw: string, id: string, title: string): string {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
    if (m) {
      const lines = m[1].split(/\r?\n/)
      const has = (k: string): boolean => lines.some((l) => l.trim().startsWith(k + ':'))
      if (!has('id')) lines.unshift('id: ' + id)
      if (!has('title')) lines.splice(1, 0, 'title: ' + title)
      return raw.replace(m[0], '---\n' + lines.join('\n') + '\n---')
    }
    return '---\nid: ' + id + '\ntitle: ' + title + '\n---\n\n' + raw
  }

  private readTextSafe(absPath: string): string | null {
    try {
      const st = statSync(absPath)
      if (st.size > 8 * 1024 * 1024) return null
      const buf = readFileSync(absPath)
      if (buf.includes(0)) return null
      return buf.toString('utf8')
    } catch {
      return null
    }
  }

  private readBoardSafe(absPath: string, title: string): WhiteboardFile {
    try {
      const data = JSON.parse(readFileSync(absPath, 'utf8'))
      // ⚠️ 重建对象时必须带上 shapes（理由见 notes.ts 的同名注释）
      return {
        id: '', type: 'whiteboard', version: 1, title: data.title || title,
        nodes: data.nodes || [], edges: data.edges || [], shapes: data.shapes || []
      }
    } catch {
      return { id: '', type: 'whiteboard', version: 1, title, nodes: [], edges: [], shapes: [] }
    }
  }

  /** 首次打开时生成说明文件。 */
  ensureReadme(): void {
    const file = join(this.store.paths.notesDir, '关于这个笔记库.md')
    if (existsSync(file)) return
    writeTextAtomic(file, [
      '---',
      'title: 关于这个笔记库',
      '---',
      '',
      '# 关于这个笔记库',
      '',
      '- 这里就是你自己的文件夹，笔记以 Markdown 保存，白板以 JSON 保存，随时可以用其他软件打开。',
      '- 在软件里改名或移动笔记不会破坏任务关联与白板引用（引用按内部标识记录，不依赖路径）。',
      '- 误把笔记移进软件后，可以使用「回到原位置」放回它原本所在的文件夹。',
      '- 附件保存在 notes/_attachments/。',
      '',
      '（此文件可以自由修改或删除。）',
      ''
    ].join('\n'))
  }

  summary(): { folders: number; files: number } {
    let folders = 0
    let files = 0
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue
        if (e.isDirectory()) { folders++; walk(join(dir, e.name)) } else files++
      }
    }
    walk(this.store.paths.notesDir)
    return { folders, files }
  }
}

function stripExt(name: string): string {
  return name.replace(/\.canvas\.json$/i, '').replace(/\.(md|markdown|txt|json|csv|log)$/i, '')
}
