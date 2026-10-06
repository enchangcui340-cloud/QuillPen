import { PRIORITY_ORDER, type HistoryEntry, type Priority, type Task, type Tag, type TrashTask } from '@shared/types'
import { compactNow, isOverdue, localIsoToDate, nowIso } from '../core/dates'
import { newId } from '../core/id'
import { readJson, writeJsonAtomic } from '../core/paths'
import type { Store } from '../core/store'

export interface TaskInput {
  name: string
  tagIds?: string[]
  priority?: Priority
  ddl?: string | null
  ddlInferred?: boolean
  noteId?: string | null
  origin?: 'manual' | 'ai'
}

/** 按“单一写入者”原则，任务数据只能通过本服务变更。 */
export class TaskService {
  private tasks: Task[] = []
  private tags: Tag[] = []
  private trash: TrashTask[] = []
  private history: HistoryEntry[] = []

  constructor(private store: Store) {
    this.reload()
  }

  reload(): void {
    const p = this.store.paths
    this.tasks = readJson<Task[]>(p.tasksFile, [])
    this.tags = readJson<Tag[]>(p.tagsFile, [])
    this.trash = readJson<TrashTask[]>(p.trashTasksFile, [])
    this.history = readJson<HistoryEntry[]>(p.historyFile ? p.historyFile.replace(/\.md$/, '.json') : '', [])
  }

  private persist(): void {
    const p = this.store.paths
    writeJsonAtomic(p.tasksFile, this.tasks)
    writeJsonAtomic(p.tagsFile, this.tags)
    writeJsonAtomic(p.trashTasksFile, this.trash)
    writeJsonAtomic(p.historyFile.replace(/\.md$/, '.json'), this.history)
    this.writeHistoryMarkdown()
  }

  /** 永久删除的任务在后台 Markdown 中保留简短历史记录。 */
  private writeHistoryMarkdown(): void {
    const lines: string[] = [
      '# 已永久删除的任务（历史记录）',
      '',
      '> 仅保留必要任务信息，不含笔记正文或附件，不能用于恢复。',
      ''
    ]
    for (const h of this.history) lines.push(`- ${h.when} | ${h.summary}`)
    writeJsonAtomic(this.store.paths.historyFile.replace(/\.json$/, '.md.md'), JSON.stringify(lines))
  }

  // ---------- 查询 ----------
  list(): Task[] { return this.tasks }

  get(id: string): Task | undefined { return this.tasks.find(t => t.id === id) }

  tagList(): Tag[] { return this.tags }

  tag(id: string): Tag | undefined { return this.tags.find(t => t.id === id) }

  /** 直接 tag 及其全部后代 id。 */
  descendantTagIds(id: string): string[] {
    const out = [id]
    const walk = (pid: string): void => {
      for (const t of this.tags) if (t.parentId === pid) { out.push(t.id); walk(t.id) }
    }
    walk(id)
    return out
  }

  tagPath(id: string): string {
    const parts: string[] = []
    let cur = this.tag(id)
    let guard = 0
    while (cur && guard++ < 32) { parts.unshift(cur.name); cur = cur.parentId ? this.tag(cur.parentId) : undefined }
    return parts.join('/')
  }

  /** 任务的重排/分组键。分组：0 逾期、1 未逾期有 ddl、2 无 ddl。 */
  sortKey(t: Task, now: Date = new Date()) {
    const ddlMs = t.ddl ? localIsoToDate(t.ddl).getTime() : null
    const group: 0 | 1 | 2 = t.done ? 2 : t.ddl ? (isOverdue(t.ddl, now) ? 0 : 1) : 2
    return { group, ddlMs, priorityRank: PRIORITY_ORDER.indexOf(t.priority), createdAtMs: localIsoToDate(t.createdAt).getTime(), id: t.id }
  }

  /** 未完成任务：逾期 → 有 ddl → 无 ddl；组内有 ddl 按时间升序、再按优先级；无 ddl 按优先级。 */
  sorted(filterTagId: string | null = null, now: Date = new Date()): Task[] {
    let list = this.tasks.filter(t => !t.done)
    if (filterTagId) {
      const ids = new Set(this.descendantTagIds(filterTagId))
      list = list.filter(t => t.tagIds.some(id => ids.has(id)))
    }
    const cmp = (a: Task, b: Task): number => {
      const ka = this.sortKey(a, now); const kb = this.sortKey(b, now)
      if (ka.group !== kb.group) return ka.group - kb.group
      if (ka.group === 1 && ka.ddlMs !== kb.ddlMs) return (ka.ddlMs ?? 0) - (kb.ddlMs ?? 0)
      if (ka.group === 0 && ka.ddlMs !== kb.ddlMs) return (ka.ddlMs ?? 0) - (kb.ddlMs ?? 0)
      if (ka.priorityRank !== kb.priorityRank) return ka.priorityRank - kb.priorityRank
      if (ka.createdAtMs !== kb.createdAtMs) return ka.createdAtMs - kb.createdAtMs
      return ka.id < kb.id ? -1 : 1
    }
    return list.slice().sort(cmp)
  }

  /** 已完成任务：按完成时间倒序，列表末尾单独展示。 */
  doneSorted(filterTagId: string | null = null): Task[] {
    let list = this.tasks.filter(t => t.done)
    if (filterTagId) {
      const ids = new Set(this.descendantTagIds(filterTagId))
      list = list.filter(t => t.tagIds.some(id => ids.has(id)))
    }
    return list.slice().sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '') || (a.id < b.id ? -1 : 1))
  }

  // ---------- 变更 ----------
  create(input: TaskInput): Task {
    const name = (input.name ?? '').trim()
    if (!name) throw new Error('任务名称不能为空')
    if (!input.priority || !PRIORITY_ORDER.includes(input.priority)) throw new Error('优先级不合法')
    const now = nowIso()
    const t: Task = {
      id: newId('task'),
      name,
      tagIds: [...new Set(input.tagIds ?? [])].filter(id => this.tag(id)),
      priority: input.priority,
      ddl: input.ddl ?? null,
      ddlInferred: !!input.ddlInferred,
      done: false,
      doneAt: null,
      noteId: input.noteId ?? null,
      origin: input.origin ?? 'manual',
      createdAt: now,
      updatedAt: now
    }
    this.tasks.push(t)
    this.persist()
    return t
  }

  /** 手动修改：直接更新原任务，不产生新任务。 */
  update(id: string, patch: Partial<Pick<Task, 'name' | 'tagIds' | 'priority' | 'ddl' | 'noteId' | 'ddlInferred'>>): Task {
    const t = this.get(id)
    if (!t) throw new Error('任务不存在')
    if (t.done) throw new Error('已完成任务不可修改')
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) throw new Error('任务名称不能为空')
      t.name = name
    }
    if (patch.priority !== undefined) {
      if (!PRIORITY_ORDER.includes(patch.priority)) throw new Error('优先级不合法')
      t.priority = patch.priority
    }
    if (patch.tagIds !== undefined) t.tagIds = [...new Set(patch.tagIds)].filter(tid => this.tag(tid))
    if (patch.ddl !== undefined) t.ddl = patch.ddl
    if (patch.ddlInferred !== undefined) t.ddlInferred = patch.ddlInferred
    if (patch.noteId !== undefined) t.noteId = patch.noteId
    t.updatedAt = nowIso()
    this.persist()
    return t
  }

  /** 完成不可撤销。 */
  complete(id: string): Task {
    const t = this.get(id)
    if (!t) throw new Error('任务不存在')
    if (t.done) throw new Error('任务已完成，完成状态不可撤销')
    t.done = true
    t.doneAt = nowIso()
    t.updatedAt = t.doneAt
    this.persist()
    return t
  }

  /** 删除任务：进入任务回收站，不影响任何笔记。 */
  remove(id: string): void {
    const idx = this.tasks.findIndex(t => t.id === id)
    if (idx < 0) throw new Error('任务不存在')
    const [t] = this.tasks.splice(idx, 1)
    this.trash.push({ task: t, deletedAt: nowIso() })
    this.persist()
  }

  // ---------- tag ----------
  /**
   * 新建 tag。
   * 同名不再报错，而是自动加序号：「工作」→「工作（2）」→「工作（3）」…
   * （同级下比较；用户明确要求"即使重名也继续新加"）
   */
  createTag(name: string, parentId: string | null): Tag {
    const n = (name ?? '').trim()
    if (!n) throw new Error('tag 名称不能为空')
    if (parentId && !this.tag(parentId)) throw new Error('父 tag 不存在')
    const finalName = this.uniqueTagName(n, parentId)
    const tag: Tag = { id: newId('tag'), name: finalName, parentId, createdAt: nowIso() }
    this.tags.push(tag)
    this.persist()
    return tag
  }

  /** 同级下不重名：重名就依次尝试（2）（3）… */
  uniqueTagName(base: string, parentId: string | null): string {
    const taken = (candidate: string): boolean =>
      this.tags.some((t) => t.parentId === parentId && t.name === candidate)
    if (!taken(base)) return base
    for (let i = 2; i < 1000; i++) {
      const candidate = base + '（' + i + '）'
      if (!taken(candidate)) return candidate
    }
    return base + '（' + Date.now() + '）'
  }

  renameTag(id: string, name: string): Tag {
    const t = this.tag(id)
    if (!t) throw new Error('tag 不存在')
    const n = (name ?? '').trim()
    if (!n) throw new Error('tag 名称不能为空')
    // 重名同样自动加序号，不打断用户操作
    const taken = (candidate: string): boolean =>
      this.tags.some((o) => o.id !== id && o.parentId === t.parentId && o.name === candidate)
    let finalName = n
    if (taken(n)) {
      for (let i = 2; i < 1000; i++) {
        if (!taken(n + '（' + i + '）')) { finalName = n + '（' + i + '）'; break }
      }
    }
    t.name = finalName
    this.persist()
    return t
  }

  /**
   * 移动 tag 到新的父级（拖拽整理用）。
   * 不允许移动到自身或其后代下，避免形成环；同级同名会被拒绝。
   */
  moveTag(id: string, newParentId: string | null): Tag {
    const tag = this.tag(id)
    if (!tag) throw new Error('tag 不存在')
    if (newParentId === id) throw new Error('不能移动到自身下')
    if (newParentId) {
      if (!this.tag(newParentId)) throw new Error('目标 tag 不存在')
      if (this.descendantTagIds(id).includes(newParentId)) throw new Error('不能移动到自己的子标签下')
      if (this.tags.some((t) => t.id !== id && t.parentId === newParentId && t.name === tag.name)) {
        throw new Error('同级下已存在同名标签')
      }
    } else if (this.tags.some((t) => t.id !== id && t.parentId === null && t.name === tag.name)) {
      throw new Error('已存在同名顶层标签')
    }
    tag.parentId = newParentId
    this.persist()
    return tag
  }

  /** 删除 tag：仅解除任务上的引用，不删除任务。 */
  deleteTag(id: string): void {
    const ids = new Set(this.descendantTagIds(id))
    this.tags = this.tags.filter(t => !ids.has(t.id))
    let changed = false
    for (const task of this.tasks) {
      const next = task.tagIds.filter(tid => !ids.has(tid))
      if (next.length !== task.tagIds.length) { task.tagIds = next; task.updatedAt = nowIso(); changed = true }
    }
    for (const item of this.trash) {
      const next = item.task.tagIds.filter(tid => !ids.has(tid))
      if (next.length !== item.task.tagIds.length) item.task.tagIds = next
    }
    void changed
    this.persist()
  }

  // ---------- 回收站 ----------
  trashList(): TrashTask[] {
    return this.trash.slice().sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  }

  trashRestore(id: string): void {
    const idx = this.trash.findIndex(t => t.task.id === id)
    if (idx < 0) throw new Error('回收站中没有该任务')
    const [item] = this.trash.splice(idx, 1)
    // 恢复已完成任务后仍为已完成，完成状态不可撤销
    this.tasks.push(item.task)
    this.persist()
  }

  /** 永久删除：写入简短历史记录后移除数据。 */
  trashPurge(id: string): void {
    const idx = this.trash.findIndex(t => t.task.id === id)
    if (idx < 0) throw new Error('回收站中没有该任务')
    const [item] = this.trash.splice(idx, 1)
    this.history.push({
      id: item.task.id,
      when: compactNow(),
      kind: 'task-purge',
      summary: `[永久删除] ${item.task.name} | tag: ${item.task.tagIds.map(t => this.tagPath(t)).join(',') || '无'} | 优先级: ${item.task.priority} | ddl: ${item.task.ddl ?? '无'} | 状态: ${item.task.done ? '已完成' : '未完成'}`
    })
    this.persist()
  }

  /** 满 30 天的回收站任务在启动时补做清理。 */
  purgeExpired(now: Date = new Date()): number {
    const keep: TrashTask[] = []
    let purged = 0
    for (const item of this.trash) {
      const t = localIsoToDate(item.deletedAt).getTime()
      if (now.getTime() - t >= 30 * 24 * 60 * 60 * 1000) {
        this.history.push({
          id: item.task.id,
          when: compactNow(now),
          kind: 'task-purge',
          summary: `[超期清理] ${item.task.name} | tag: ${item.task.tagIds.map(x => this.tagPath(x)).join(',') || '无'} | 优先级: ${item.task.priority} | ddl: ${item.task.ddl ?? '无'} | 状态: ${item.task.done ? '已完成' : '未完成'}`
        })
        purged++
      } else keep.push(item)
    }
    if (purged) { this.trash = keep; this.persist() }
    return purged
  }

  historyList(): HistoryEntry[] {
    return this.history.slice().reverse()
  }

  /** AI 替换事务：先建新任务，再删旧任务；任何一步失败整体回滚。 */
  replaceTransaction(oldId: string, input: TaskInput): { created: Task } {
    const old = this.get(oldId)
    if (!old) throw new Error('原任务不存在')
    if (old.done) throw new Error('已完成任务不可替换')
    const snapshotTasks = JSON.stringify(this.tasks)
    const snapshotTrash = JSON.stringify(this.trash)
    try {
      const created = this.create(input)
      this.remove(oldId)
      return { created }
    } catch (e) {
      this.tasks = JSON.parse(snapshotTasks) as Task[]
      this.trash = JSON.parse(snapshotTrash) as TrashTask[]
      this.persist()
      throw e
    }
  }
}
