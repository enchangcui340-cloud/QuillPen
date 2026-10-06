import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import type { NoteKind, TrashNote, WhiteboardFile } from '@shared/types'
import { nowIso } from '../core/dates'
import { newId } from '../core/id'
import { readJson, writeJsonAtomic, writeTextAtomic } from '../core/paths'
import type { Store } from '../core/store'

const MD_EXT = '.md'
const BOARD_EXT = '.canvas.json'
const ORIGIN_FILE = 'origins.json'

export interface NoteFileMeta {
  id: string
  kind: NoteKind
  fileName: string
  dir: string
  title: string
  createdAt: string
  updatedAt: string
  fileMtimeMs: number
  trashed: boolean
  originPath: string | null
  aiTouched: boolean
}

interface DiskEntry { rel: string; mtimeMs: number; size: number }

/** 笔记库与笔记回收站。文本笔记与白板共用同一套文件管理。 */
export class NoteService {
  private index = new Map<string, NoteFileMeta>()
  private trash: TrashNote[] = []
  private byPath = new Map<string, string>()

  constructor(private store: Store) {
    this.reload()
  }

  private abs(rel: string): string {
    return resolve(this.store.paths.notesDir, rel)
  }

  private rel(absPath: string): string {
    return relative(this.store.paths.notesDir, absPath).split(sep).join('/')
  }

  private isInsideNotes(absPath: string): boolean {
    const root = resolve(this.store.paths.notesDir)
    const target = resolve(absPath)
    return target === root || target.startsWith(root + sep)
  }

  // ---------------- 索引 ----------------
  reload(): void {
    this.index.clear()
    this.byPath.clear()
    const stored = readJson<NoteFileMeta[]>(this.store.paths.notesIndexFile, [])
    const storedById = new Map(stored.map((n) => [n.id, n]))
    const origins = readJson<Record<string, string>>(join(this.store.paths.dataDir, ORIGIN_FILE), {})

    for (const file of this.walkFiles()) {
      const parsed = this.parseFile(file.rel)
      if (!parsed) continue
      const prev = storedById.get(parsed.id)
      const meta: NoteFileMeta = {
        id: parsed.id,
        kind: parsed.kind,
        fileName: basename(file.rel),
        dir: file.rel.includes('/') ? file.rel.slice(0, file.rel.lastIndexOf('/')) : '',
        title: parsed.title,
        createdAt: prev?.createdAt ?? nowIso(),
        updatedAt: prev?.updatedAt ?? nowIso(),
        fileMtimeMs: file.mtimeMs,
        trashed: false,
        originPath: origins[parsed.id] ?? prev?.originPath ?? null,
        aiTouched: prev?.aiTouched ?? false
      }
      this.index.set(meta.id, meta)
      this.byPath.set(file.rel, meta.id)
    }
    this.importedDirs = new Map(Object.entries(readJson<Record<string, string>>(join(this.store.paths.dataDir, 'import-dirs.json'), {})))
    this.trash = readJson<TrashNote[]>(this.store.paths.trashNotesFile, [])
    this.persistIndex()
  }

  private walkFiles(dir = this.store.paths.notesDir, out: DiskEntry[] = []): DiskEntry[] {
    if (!existsSync(dir)) return out
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '_attachments') continue
        this.walkFiles(abs, out)
      } else if (entry.isFile()) {
        const rel = this.rel(abs)
        if (!this.isNoteFile(rel)) continue
        const st = statSync(abs)
        out.push({ rel, mtimeMs: st.mtimeMs, size: st.size })
      }
    }
    return out
  }

  private isNoteFile(relPath: string): boolean {
    return relPath.endsWith(BOARD_EXT) || relPath.endsWith(MD_EXT)
  }

  kindOf(relPath: string): NoteKind | null {
    if (relPath.endsWith(BOARD_EXT)) return 'whiteboard'
    if (relPath.endsWith(MD_EXT)) return 'md'
    return null
  }

  private parseFile(relPath: string): { id: string; kind: NoteKind; title: string } | null {
    const absPath = this.abs(relPath)
    const kind = this.kindOf(relPath)
    if (!kind) return null
    try {
      const raw = readFileSync(absPath, 'utf8')
      if (kind === 'whiteboard') {
        const data = JSON.parse(stripFrontmatterForJson(raw)) as Partial<WhiteboardFile>
        return { id: data.id || this.mintId(absPath, kind), kind, title: data.title || stripExt(basename(relPath)) }
      }
      const fm = parseFrontmatter(raw)
      return { id: fm.id || this.mintId(absPath, kind), kind, title: fm.title || stripExt(basename(relPath)) }
    } catch {
      return null
    }
  }

  /** 外部文件没有稳定 ID：补写一次 ID，之后引用不再依赖路径。 */
  private mintId(absPath: string, kind: NoteKind): string {
    const id = newId(kind === 'md' ? 'note' : 'board')
    try {
      const raw = readFileSync(absPath, 'utf8')
      if (kind === 'md') {
        writeTextAtomic(absPath, upsertFrontmatter(raw, { id }))
      } else {
        const data = raw.trim() ? (JSON.parse(stripFrontmatterForJson(raw)) as WhiteboardFile) : emptyBoard('未命名白板')
        data.id = id
        writeJsonAtomic(absPath, data)
      }
    } catch { /* 无法写入时退化为仅内存 ID */ }
    return id
  }

  private persistIndex(): void {
    writeJsonAtomic(this.store.paths.notesIndexFile, [...this.index.values()])
    writeJsonAtomic(this.store.paths.trashNotesFile, this.trash)
    const origins: Record<string, string> = {}
    for (const n of this.index.values()) if (n.originPath) origins[n.id] = n.originPath
    for (const t of this.trash) if (t.originPath) origins[t.id] = t.originPath
    writeJsonAtomic(join(this.store.paths.dataDir, ORIGIN_FILE), origins)
  }

  // ---------------- 查询 ----------------
  list(): NoteFileMeta[] { return [...this.index.values()] }

  get(id: string): NoteFileMeta | undefined { return this.index.get(id) }

  findByName(title: string): NoteFileMeta | undefined {
    const t = title.trim().replace(/\.md$/i, '')
    return this.list().find((n) => n.title === t)
  }

  mtimeOf(id: string): number {
    const n = this.index.get(id)
    if (!n) return 0
    const p = this.abs(join(n.dir, n.fileName))
    return existsSync(p) ? statSync(p).mtimeMs : 0
  }

  read(id: string): { note: NoteFileMeta; content: string } {
    const n = this.index.get(id)
    if (!n) throw new Error('笔记不存在')
    const content = readFileSync(this.abs(join(n.dir, n.fileName)), 'utf8')
    return { note: n, content }
  }

  readBoard(id: string): WhiteboardFile {
    const n = this.index.get(id)
    if (!n || n.kind !== 'whiteboard') throw new Error('白板不存在')
    const abs = this.abs(join(n.dir, n.fileName))
    /*
     * ⚠️ 读不出来时**必须抛错**，绝不能静默返回空板。
     *
     * 这里原来写的是 `catch { return 空板 }`，后果非常严重：
     * 任何一次读取失败（文件被改名/搬走/外部删掉/JSON 损坏）都会被伪装成一个"空板"，
     * 而调用方（界面自动保存、AI 的 board_edit）拿到之后会把它**写回磁盘** ——
     * 用户的卡片与连线就被永久清空了。
     * 「白板重命名后内容全部消失」那次事故，就是 rename() 拿旧文件名读不到文件，
     * 被这个 catch 变成空板、又被写回新文件造成的。
     *
     * 原则：**宁可报错让调用方中止，也不能交出一个"看起来正常、其实是空的"白板。**
     */
    if (!existsSync(abs)) {
      const where = n.dir === '' ? n.fileName : n.dir + '/' + n.fileName
      throw new Error(`白板文件不存在：${where}（笔记索引与实际文件不一致，请刷新笔记库）`)
    }
    let data: WhiteboardFile
    try {
      data = JSON.parse(readFileSync(abs, 'utf8')) as WhiteboardFile
    } catch (e) {
      const where = n.dir === '' ? n.fileName : n.dir + '/' + n.fileName
      throw new Error(`白板文件读不出来（可能已损坏）：${where} —— ${(e as Error).message}`)
    }
    // ⚠️ 这里是"重建对象"写法：**必须显式带上 shapes**，
    // 否则用户画的图形一读就没，而且之后任何一次保存都会把它从文件里抹掉。
    return {
      id: n.id, type: 'whiteboard', version: 1, title: data.title || n.title,
      nodes: data.nodes || [], edges: data.edges || [], shapes: data.shapes || []
    }
  }

  // ---------------- 变更 ----------------
  create(dir: string, kind: NoteKind, title: string): NoteFileMeta {
    const safeDir = this.normalizeDir(dir)
    mkdirSync(this.abs(safeDir), { recursive: true })
    const id = newId(kind === 'md' ? 'note' : 'board')
    const ext = kind === 'md' ? MD_EXT : BOARD_EXT
    const cleanTitle = title.trim() || '未命名'
    const name = this.uniqueFileName(safeDir, cleanTitle, ext)
    const absPath = this.abs(join(safeDir, name))
    if (kind === 'md') {
      writeTextAtomic(absPath, '---\n' + 'id: ' + id + '\n' + 'title: ' + cleanTitle + '\n' + 'created: ' + nowIso() + '\n' + 'updated: ' + nowIso() + '\n---\n\n')
    } else {
      writeJsonAtomic(absPath, { ...emptyBoard(cleanTitle), id })
    }
    const meta: NoteFileMeta = {
      id, kind, fileName: name, dir: safeDir, title: cleanTitle,
      createdAt: nowIso(), updatedAt: nowIso(), fileMtimeMs: statSync(absPath).mtimeMs,
      trashed: false, originPath: null, aiTouched: false
    }
    this.index.set(id, meta)
    this.byPath.set(join(safeDir, name), id)
    this.persistIndex()
    return meta
  }

  createFolder(dir: string, name: string): string {
    const clean = sanitizeName(name) || '新建笔记夹'
    const parent = this.normalizeDir(dir)
    mkdirSync(this.abs(parent), { recursive: true })
    // 同名时自动追加序号，保证「新建即成功」，用户随后可改名
    let target = clean
    let i = 2
    while (existsSync(this.abs(join(parent, target)))) { target = clean + ' (' + i + ')'; i++ }
    mkdirSync(this.abs(join(parent, target)), { recursive: true })
    return parent ? parent + '/' + target : target
  }

  /** 重命名笔记夹（保留内部结构与所有笔记）。 */
  renameFolder(dir: string, newName: string): string {
    const clean = this.normalizeDir(dir)
    if (!clean) throw new Error('不能重命名根目录')
    const name = sanitizeName(newName)
    if (!name) throw new Error('笔记夹名称不能为空')
    const parent = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : ''
    const fromAbs = this.abs(clean)
    const toAbs = this.abs(join(parent, name))
    if (!existsSync(fromAbs)) throw new Error('笔记夹不存在')
    if (resolve(fromAbs) === resolve(toAbs)) return clean
    if (existsSync(toAbs)) throw new Error('同级下已存在同名笔记夹')
    renameSync(fromAbs, toAbs)
    this.reload()
    return parent ? parent + '/' + name : name
  }

  /** 列出笔记库中所有笔记夹（含空的），让空笔记夹也能在界面上显示。 */
  listFolders(): string[] {
    const out: string[] = []
    const walk = (abs: string): void => {
      if (!existsSync(abs)) return
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') || entry.name === '_attachments') continue
        const child = join(abs, entry.name)
        out.push(this.rel(child))
        walk(child)
      }
    }
    walk(this.store.paths.notesDir)
    return out.sort()
  }

  saveNote(id: string, content: string, baseMtimeMs: number): { ok: true } | { ok: false; conflict: true; current: string } {
    const n = this.index.get(id)
    if (!n) throw new Error('笔记不存在')
    const absPath = this.abs(join(n.dir, n.fileName))
    if (baseMtimeMs > 0 && existsSync(absPath) && Math.abs(statSync(absPath).mtimeMs - baseMtimeMs) > 1) {
      return { ok: false, conflict: true, current: readFileSync(absPath, 'utf8') }
    }
    // 兜住 id：万一界面传来的内容缺了文件头，也不能让笔记在下次重载时换 ID
    writeTextAtomic(absPath, upsertFrontmatter(content, { id: n.id }))
    n.fileMtimeMs = statSync(absPath).mtimeMs
    n.updatedAt = nowIso()
    const fm = parseFrontmatter(readFileSync(absPath, 'utf8'))
    if (fm.title) n.title = fm.title
    this.persistIndex()
    return { ok: true }
  }

  /** 冲突场景下由上层确认后用最新内容覆盖写入。 */
  saveNoteForced(id: string, content: string): { fileMtimeMs: number } {
    const n = this.index.get(id)
    if (!n) throw new Error('笔记不存在')
    const absPath = this.abs(join(n.dir, n.fileName))
    writeTextAtomic(absPath, upsertFrontmatter(content, { id: n.id }))
    n.fileMtimeMs = statSync(absPath).mtimeMs
    n.updatedAt = nowIso()
    const fm = parseFrontmatter(readFileSync(absPath, 'utf8'))
    if (fm.title) n.title = fm.title
    this.persistIndex()
    return { fileMtimeMs: n.fileMtimeMs }
  }

  /**
   * 把没能保存的内容另存一份到 data/backups/，返回文件路径。
   * 用于"保存冲突"或退出时写入失败的兜底：宁可多一个备份文件，也不能让用户白写。
   */
  backupDraft(id: string, content: string): string {
    const n = this.index.get(id)
    const name = (n?.title || id).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    mkdirSync(this.store.paths.backupDir, { recursive: true })
    const target = join(this.store.paths.backupDir, name + '-' + stamp + '.md')
    writeTextAtomic(target, content)
    return target
  }

  saveBoard(id: string, board: WhiteboardFile, baseMtimeMs: number): { ok: true; fileMtimeMs: number } | { ok: false; conflict: true } {
    const n = this.index.get(id)
    if (!n || n.kind !== 'whiteboard') throw new Error('白板不存在')
    const absPath = this.abs(join(n.dir, n.fileName))
    if (baseMtimeMs > 0 && existsSync(absPath) && Math.abs(statSync(absPath).mtimeMs - baseMtimeMs) > 1) {
      return { ok: false, conflict: true }
    }
    return this.writeBoard(n, board, absPath)
  }

  saveBoardForced(id: string, board: WhiteboardFile): void {
    const n = this.index.get(id)
    if (!n) throw new Error('白板不存在')
    this.writeBoard(n, board, this.abs(join(n.dir, n.fileName)))
  }

  private writeBoard(n: NoteFileMeta, board: WhiteboardFile, absPath: string): { ok: true; fileMtimeMs: number } {
    const data: WhiteboardFile = { ...board, id: n.id, type: 'whiteboard', version: 1, title: board.title || n.title }
    writeJsonAtomic(absPath, data)
    n.title = data.title
    n.fileMtimeMs = statSync(absPath).mtimeMs
    n.updatedAt = nowIso()
    this.persistIndex()
    return { ok: true, fileMtimeMs: n.fileMtimeMs }
  }

  /** 改名：文件名与文档内标题一起更新，引用按 ID 保持有效。 */
  rename(id: string, newTitle: string): NoteFileMeta {
    const n = this.index.get(id)
    if (!n) throw new Error('笔记不存在')
    const title = (newTitle || '').trim()
    if (!title) throw new Error('名称不能为空')
    const ext = n.kind === 'md' ? MD_EXT : BOARD_EXT
    const oldAbs = this.abs(join(n.dir, n.fileName))
    // 名字里的非法字符要被清掉，并和最终文件名保持一致：
    // 否则会出现"文件叫 重名 (2).md，标题却还是 重名"这种界面与磁盘对不上的情况。
    const safeTitle = sanitizeName(title) || '未命名'
    const newName = this.uniqueFileName(n.dir, safeTitle, ext, n.fileName)
    // 同名冲突时会加序号，标题要跟着文件名走，否则列表里两条看起来一模一样
    const finalTitle = stripExt(newName)
    const newAbs = this.abs(join(n.dir, newName))

    /*
     * ⚠️ 内容必须在**改名之前**读出来（这里是曾经丢数据的地方）。
     *
     * 出过的事故：改名分支原先在 `renameSync` 之后才调 `this.readBoard(id)`，
     * 而 `readBoard` 是按 `n.fileName` 拼路径读文件的 —— 那个字段要到本函数末尾才更新。
     * 于是它拿着**旧文件名**去读一个已经被搬走的文件：
     *   readFileSync 抛错 → readBoard 的 catch 静默返回**空板** → 紧接着把这个空板
     *   写进新文件 → **白板的卡片与连线被清空，且不可逆**。
     * md 分支当时用的是 newAbs，所以只有白板中招。
     *
     * 现在统一"先读内容、再改名、最后写标题"，两条分支都不再依赖 `n.fileName` 的更新时机。
     */
    const payload = n.kind === 'md'
      ? (existsSync(oldAbs) ? readFileSync(oldAbs, 'utf8') : '')
      : this.readBoard(id)

    if (newAbs === oldAbs) {
      // 名字没变：只把标题写回去
      if (n.kind === 'md') writeTextAtomic(oldAbs, upsertFrontmatter(payload as string, { title: finalTitle }))
      else writeJsonAtomic(oldAbs, { ...(payload as WhiteboardFile), title: finalTitle })
    } else {
      renameSync(oldAbs, newAbs)
      this.byPath.delete(join(n.dir, n.fileName))
      this.byPath.set(join(n.dir, newName), id)
      if (n.kind === 'md') writeTextAtomic(newAbs, upsertFrontmatter(payload as string, { title: finalTitle }))
      else writeJsonAtomic(newAbs, { ...(payload as WhiteboardFile), title: finalTitle })
    }
    n.title = finalTitle
    n.fileName = newName
    n.updatedAt = nowIso()
    n.fileMtimeMs = existsSync(newAbs) ? statSync(newAbs).mtimeMs : 0
    this.persistIndex()
    return n
  }

  move(id: string, dir: string): NoteFileMeta {
    const n = this.index.get(id)
    if (!n) throw new Error('笔记不存在')
    const targetDir = this.normalizeDir(dir)
    if (targetDir === n.dir) return n
    mkdirSync(this.abs(targetDir), { recursive: true })
    const ext = n.kind === 'md' ? MD_EXT : BOARD_EXT
    const newName = this.uniqueFileName(targetDir, stripExt(n.fileName), ext)
    const oldAbs = this.abs(join(n.dir, n.fileName))
    const newAbs = this.abs(join(targetDir, newName))
    renameSync(oldAbs, newAbs)
    this.byPath.delete(join(n.dir, n.fileName))
    this.byPath.set(join(targetDir, newName), id)
    n.dir = targetDir
    n.fileName = newName
    n.updatedAt = nowIso()
    this.persistIndex()
    return n
  }

  moveFolder(fromDir: string, toDir: string): void {
    const from = this.normalizeDir(fromDir)
    const to = this.normalizeDir(toDir)
    if (!from) throw new Error('不能移动根目录')
    if (to === from || to.startsWith(from + '/')) throw new Error('不能移动到自身或其子目录')
    const fromAbs = this.abs(from)
    const toAbs = this.abs(join(to, basename(from)))
    if (!existsSync(fromAbs)) throw new Error('源笔记夹不存在')
    if (existsSync(toAbs)) throw new Error('目标位置已存在同名笔记夹')
    mkdirSync(this.abs(to), { recursive: true })
    renameSync(fromAbs, toAbs)
    this.reload()
  }

  /** 删除到笔记回收站；不删除引用它的任务。 */
  remove(id: string): void {
    const n = this.index.get(id)
    if (!n) throw new Error('笔记不存在')
    const absPath = this.abs(join(n.dir, n.fileName))
    const item: TrashNote = {
      id: n.id, kind: n.kind, fileName: n.fileName, originalDir: n.dir, title: n.title,
      deletedAt: nowIso(), createdAt: n.createdAt,
      attachments: this.referencedAttachments(absPath, n.kind),
      originPath: n.originPath
    }
    if (existsSync(absPath)) {
      mkdirSync(this.store.paths.trashDir, { recursive: true })
      renameSync(absPath, join(this.store.paths.trashDir, n.id + '__' + n.fileName))
    }
    this.index.delete(id)
    this.byPath.delete(join(n.dir, n.fileName))
    this.trash = this.trash.filter((t) => t.id !== id)
    this.trash.push(item)
    this.persistIndex()
  }

  /** 删除笔记夹：其中每个笔记作为独立回收站条目，恢复时保留内部层级。 */
  removeFolder(dir: string): void {
    const clean = this.normalizeDir(dir)
    if (!clean) throw new Error('不能删除根目录')
    const affected = this.list().filter((n) => n.dir === clean || n.dir.startsWith(clean + '/'))
    for (const n of affected) {
      const absPath = this.abs(join(n.dir, n.fileName))
      this.trash = this.trash.filter((x) => x.id !== n.id)
      this.trash.push({
        id: n.id, kind: n.kind, fileName: n.fileName, originalDir: n.dir, title: n.title,
        deletedAt: nowIso(), createdAt: n.createdAt,
        attachments: this.referencedAttachments(absPath, n.kind),
        originPath: n.originPath
      })
      if (existsSync(absPath)) {
        mkdirSync(this.store.paths.trashDir, { recursive: true })
        renameSync(absPath, join(this.store.paths.trashDir, n.id + '__' + n.fileName))
      }
      this.index.delete(n.id)
      this.byPath.delete(join(n.dir, n.fileName))
    }
    const folderAbs = this.abs(clean)
    if (existsSync(folderAbs)) rmSync(folderAbs, { recursive: true, force: true })
    this.persistIndex()
  }

  /** 提取笔记/白板引用的附件相对路径。 */
  referencedAttachments(absPath: string, kind: NoteKind): string[] {
    if (!existsSync(absPath)) return []
    try {
      const raw = readFileSync(absPath, 'utf8')
      if (kind === 'whiteboard') {
        const b = JSON.parse(raw) as WhiteboardFile
        return [...new Set((b.nodes || []).filter((n) => n.type === 'image' && n.src).map((n) => n.src as string))]
      }
      const out: string[] = []
      const re = /!\[[^\]]*\]\(([^)]+)\)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(raw))) out.push(normalizeRel(m[1]))
      const htmlRe = /<img[^>]+src=["']([^"']+)["']/gi
      while ((m = htmlRe.exec(raw))) out.push(normalizeRel(m[1]))
      return [...new Set(out)]
    } catch {
      return []
    }
  }

  // ---------------- 回收站 ----------------
  trashList(): TrashNote[] {
    return this.trash.slice().sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  }

  /**
   * 恢复：原父文件夹可用则回原位置，否则回笔记库根目录；不重建已不存在的父文件夹；
   * 不覆盖同名文件；批量恢复按目录层级从浅到深处理。
   */
  trashRestore(ids: string[]): { restored: string[]; renamed: { id: string; name: string }[] } {
    const items = this.trash.filter((t) => ids.includes(t.id))
    items.sort((a, b) => a.originalDir.split('/').length - b.originalDir.split('/').length)
    const restored: string[] = []
    const renamed: { id: string; name: string }[] = []
    for (const item of items) {
      const src = join(this.store.paths.trashDir, item.id + '__' + item.fileName)
      if (!existsSync(src)) continue
      const dirUsable = item.originalDir === '' || existsSync(this.abs(item.originalDir))
      const targetDir = dirUsable ? item.originalDir : ''
      mkdirSync(this.abs(targetDir), { recursive: true })
      const ext = item.kind === 'md' ? MD_EXT : BOARD_EXT
      const name = this.uniqueFileName(targetDir, stripExt(item.fileName), ext)
      if (name !== item.fileName) renamed.push({ id: item.id, name })
      const dest = this.abs(join(targetDir, name))
      renameSync(src, dest)
      this.index.set(item.id, {
        id: item.id, kind: item.kind, fileName: name, dir: targetDir, title: item.title,
        createdAt: item.createdAt, updatedAt: nowIso(), fileMtimeMs: statSync(dest).mtimeMs,
        trashed: false, originPath: item.originPath, aiTouched: false
      })
      this.byPath.set(join(targetDir, name), item.id)
      restored.push(item.id)
    }
    this.trash = this.trash.filter((t) => !restored.includes(t.id))
    this.persistIndex()
    return { restored, renamed }
  }

  /** 永久删除：仅当附件不再被任何存活笔记或回收站项目引用时才真正删除。 */
  trashPurge(ids: string[]): void {
    for (const id of ids) {
      const item = this.trash.find((t) => t.id === id)
      if (!item) continue
      const file = join(this.store.paths.trashDir, item.id + '__' + item.fileName)
      try { if (existsSync(file)) unlinkSync(file) } catch { /* 被占用时忽略 */ }
    }
    this.trash = this.trash.filter((t) => !ids.includes(t.id))
    for (const id of ids) void id
    this.persistIndex()
    this.cleanupOrphanAttachments()
  }

  /**
   * 删除不再被任何笔记或白板引用的附件。
   *
   * ⚠️ 注意它的**作用范围是整个库**，不是"某一次删除涉及的附件"：
   * 只要库里存在没有任何笔记引用的附件（历史粘贴、随笔集时代留下的图等），
   * 一次"彻底删除"就会把它们**全部物理删除**。
   * 所以 DSH 版加了 `dryRun`：先只列出会被删掉的文件，让调用方（界面 / 羽毛笔）
   * 能把这件事**摆到用户面前**再决定。
   */
  cleanupOrphanAttachments(dryRun = false): string[] {
    const dir = this.store.paths.attachmentsDir
    if (!existsSync(dir)) return []
    const referenced = new Set<string>()
    for (const n of this.index.values()) {
      for (const a of this.referencedAttachments(this.abs(join(n.dir, n.fileName)), n.kind)) referenced.add(normalizeRel(a))
    }
    for (const t of this.trash) for (const a of t.attachments) referenced.add(normalizeRel(a))
    const removed: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const relPath = '_attachments/' + entry.name
      if (referenced.has(relPath)) continue
      if (dryRun) { removed.push(relPath); continue }
      try { unlinkSync(join(dir, entry.name)); removed.push(relPath) } catch { /* ignore */ }
    }
    return removed
  }

  /** 只查不删：列出"一旦彻底删除就会被连带清理"的附件（DSH 版新增，供知情确认用）。 */
  listOrphanAttachments(): string[] {
    return this.cleanupOrphanAttachments(true)
  }

  /** 仍被引用的附件数量（永久删除前的提示用）。 */
  countAttachmentRefs(relPath: string): number {
    const target = normalizeRel(relPath)
    let count = 0
    for (const n of this.index.values()) {
      if (this.referencedAttachments(this.abs(join(n.dir, n.fileName)), n.kind).some((a) => normalizeRel(a) === target)) count++
    }
    for (const t of this.trash) if (t.attachments.some((a) => normalizeRel(a) === target)) count++
    return count
  }

  importAttachment(sourceAbs: string, hintName?: string): { rel: string; name: string } {
    // DSH 版：原来是函数内 `require('node:fs')`，在 esbuild 的 ESM 产物里会抛
    // "Dynamic require of node:fs is not supported" —— 改成顶层 import。
    const buffer = readFileSync(sourceAbs)
    return this.saveAttachmentFromBuffer(buffer, hintName || basename(sourceAbs))
  }

  saveAttachmentFromBuffer(buf: Buffer, hintName: string): { rel: string; name: string } {
    mkdirSync(this.store.paths.attachmentsDir, { recursive: true })
    const clean = sanitizeName(hintName) || 'file.bin'
    // 注意：这里要用 basename(name, extname(name)) 去掉扩展名，
    // 不能用 stripExt()（它只认 .md / .canvas.json，会把 "photo.jpg" 留成 "photo.jpg"，
    // 再拼上 .jpg 就变成 "photo.jpg.jpg"）。
    const ext = extname(clean) || '.bin'
    const target = this.uniqueFileName('_attachments', basename(clean, ext), ext)
    writeFileSync(this.abs(join('_attachments', target)), buf)
    return { rel: '_attachments/' + target, name: target }
  }

  attachmentAbs(relPath: string): string | null {
    const p = resolve(this.store.paths.notesDir, relPath)
    return this.isInsideNotes(p) ? p : null
  }

  /** 把笔记移回导入前的原始位置（撤销误操作）。 */
  restoreOrigin(id: string): { moved: boolean; dir: string } {
    const n = this.index.get(id)
    if (!n) throw new Error('笔记不存在')
    const origin = n.originPath
    if (!origin || !existsSync(origin)) return { moved: false, dir: n.dir }
    const originAbs = resolve(origin)
    // 原位置在库内：回到该目录；原位置在库外：回到导入时保持的相对层级（通常就是当前层级的顶层）。
    const targetDir = this.isInsideNotes(originAbs)
      ? this.rel(dirname(originAbs))
      : this.importedDirOf(id)
    const targetName = basename(originAbs)
    if (targetDir === n.dir && targetName === n.fileName) return { moved: false, dir: n.dir }
    if (targetDir === n.dir) {
      // 已在目标目录，只需恢复原文件名
      const oldPath = this.abs(join(n.dir, n.fileName))
      const desired = this.abs(join(n.dir, targetName))
      const finalPath = existsSync(desired)
        ? this.abs(join(n.dir, this.uniqueFileName(n.dir, stripExt(targetName), extname(targetName))))
        : desired
      renameSync(oldPath, finalPath)
      this.byPath.delete(join(n.dir, n.fileName))
      n.fileName = basename(finalPath)
      this.byPath.set(join(n.dir, n.fileName), id)
      n.updatedAt = nowIso()
      this.persistIndex()
      return { moved: true, dir: n.dir }
    }
    const oldAbs = this.abs(join(n.dir, n.fileName))
    const desiredAbs = this.abs(join(targetDir, targetName))
    mkdirSync(this.abs(targetDir), { recursive: true })
    const finalAbs = existsSync(desiredAbs) ? this.abs(join(targetDir, this.uniqueFileName(targetDir, stripExt(targetName), extname(targetName)))) : desiredAbs
    renameSync(oldAbs, finalAbs)
    this.byPath.delete(join(n.dir, n.fileName))
    n.dir = this.rel(dirname(finalAbs))
    n.fileName = basename(finalAbs)
    this.byPath.set(join(n.dir, n.fileName), id)
    n.updatedAt = nowIso()
    this.persistIndex()
    return { moved: true, dir: n.dir }
  }

  /** 标记外部导入位置，供“回到原位置”使用。 */
  setOriginPath(id: string, originFile: string): void {
    const n = this.index.get(id)
    if (!n) return
    n.originPath = originFile
    this.importedDirs.set(id, n.dir)
    this.persistImportedDirs()
    this.persistIndex()
  }

  /** 库外导入时使用的相对层级，用于“回到原位置”。 */
  private importedDirs = new Map<string, string>()

  private persistImportedDirs(): void {
    writeJsonAtomic(join(this.store.paths.dataDir, 'import-dirs.json'), Object.fromEntries(this.importedDirs))
  }

  private importedDirOf(id: string): string {
    const n = this.index.get(id)
    return this.importedDirs.get(id) ?? (n ? n.dir : '')
  }

  uniqueFileName(dir: string, base: string, ext: string, ignoreRel?: string): string {
    const cleanBase = sanitizeName(base) || '未命名'
    const exists = (name: string): boolean => {
      const relPath = dir ? dir + '/' + name : name
      if (ignoreRel && relPath === ignoreRel) return false
      return existsSync(this.abs(relPath))
    }
    let candidate = cleanBase + ext
    let i = 2
    while (exists(candidate)) { candidate = cleanBase + ' (' + i + ')' + ext; i++ }
    return candidate
  }

  normalizeDir(dir: string): string {
    const d = (dir || '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '')
    if (!d) return ''
    const p = resolve(this.store.paths.notesDir, d)
    if (!this.isInsideNotes(p)) throw new Error('路径超出笔记库范围')
    return d
  }

  pathExists(relPath: string): boolean { return existsSync(this.abs(relPath)) }
}

export function parseFrontmatter(raw: string): { id?: string; title?: string; created?: string; updated?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { body: raw }
  const out: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return { id: out.id, title: out.title, created: out.created, updated: out.updated, body: raw.slice(m[0].length) }
}

/**
 * 白板文件被写入 frontmatter 时（历史上出现过：AI 建的白板文件带了一段 YAML 头），
 * `JSON.parse` 会抛错，外层 catch 又把整块白板从索引里丢掉 —— 表现为"白板在界面上凭空消失"。
 * 这里先剥掉可能存在的 YAML 头再解析。
 */
export function stripFrontmatterForJson(raw: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw)
  return m === null ? raw : raw.slice(m[0].length)
}

export function upsertFrontmatter(raw: string, values: Record<string, string>): string {
  const fm = parseFrontmatter(raw)
  const merged: Record<string, string> = {
    id: fm.id || '',
    title: fm.title || '',
    created: fm.created || nowIso(),
    updated: nowIso()
  }
  for (const [k, v] of Object.entries(values)) merged[k] = v
  const lines = Object.entries(merged).filter(([, v]) => v !== '').map(([k, v]) => k + ': ' + v)
  const body = fm.body.startsWith('\n') ? fm.body : '\n' + fm.body
  return '---\n' + lines.join('\n') + '\n---\n' + body
}

function stripExt(name: string): string {
  return name.replace(/\.canvas\.json$/i, '').replace(/\.md$/i, '')
}

function sanitizeName(name: string): string {
  return (name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
}

function normalizeRel(p: string): string {
  return decodeURI(p || '').replace(/\\/g, '/').replace(/^\.\//, '')
}

function emptyBoard(title: string): WhiteboardFile {
  return { id: '', type: 'whiteboard', version: 1, title, nodes: [], edges: [] }
}

export { MD_EXT, BOARD_EXT }
