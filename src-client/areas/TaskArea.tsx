import { askConfirm } from '../components/AskDialog'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TaskView } from '@shared/api'
import { PRIORITY_LABEL, type Priority, type Tag } from '@shared/types'
import { toast } from '../components/Toast'
import TaskDialog from '../components/TaskDialog'
import TagTree, { type TagRenameState } from '../components/TagTree'
import ContextMenu, { type MenuItem } from '../components/ContextMenu'
import { PlusIcon } from '../components/Icons'

interface Props { refreshToken: number; onChanged: () => void }

type DoneFilter = 'show' | 'hide'

export default function TaskArea({ refreshToken, onChanged }: Props): React.ReactElement {
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [showDone, setShowDone] = useState<DoneFilter>('show')
  const [editing, setEditing] = useState<TaskView | null>(null)
  const [creating, setCreating] = useState(false)
  const [expandedTags, setExpandedTags] = useState<Record<string, boolean>>({})
  const [tagRenaming, setTagRenaming] = useState<TagRenameState | null>(null)
  const [tagMenu, setTagMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  const load = useCallback(async () => {
    try {
      const [t, g] = await Promise.all([window.api.taskList(), window.api.tagList()])
      setTasks(t)
      setTags(g as Tag[])
    } catch (e) {
      toast('读取任务失败：' + (e as Error).message, 'error')
    }
  }, [])

  useEffect(() => { void load() }, [load, refreshToken])

  /** tag 筛选：命中直接 tag 或任意层级后代 tag，同一任务只显示一次。 */
  const { undone, done } = useMemo(() => {
    const childrenOf = (id: string): string[] => {
      const out = [id]
      const walk = (pid: string): void => {
        for (const t of tags) if (t.parentId === pid) { out.push(t.id); walk(t.id) }
      }
      walk(id)
      return out
    }
    const ids = activeTag ? new Set(childrenOf(activeTag)) : null
    const kw = keyword.trim().toLowerCase()
    const match = (t: TaskView): boolean => {
      if (ids && !t.tagIds.some((id) => ids.has(id))) return false
      if (kw) {
        const hay = (t.name + ' ' + t.tagPaths.join(' ')).toLowerCase()
        if (!hay.includes(kw)) return false
      }
      return true
    }
    return { undone: tasks.filter((t) => !t.done && match(t)), done: tasks.filter((t) => t.done && match(t)) }
  }, [tasks, tags, activeTag, keyword])

  const groups = useMemo(() => {
    const overdue: TaskView[] = []
    const withDdl: TaskView[] = []
    const noDdl: TaskView[] = []
    const now = Date.now()
    for (const t of undone) {
      const ms = t.ddl ? new Date(t.ddl).getTime() : null
      if (ms !== null && ms < now) overdue.push(t)
      else if (ms !== null) withDdl.push(t)
      else noDdl.push(t)
    }
    const prio = (p: Priority): number => (p === 'important' ? 0 : p === 'minor' ? 1 : 2)
    const byDdlThenPrio = (a: TaskView, b: TaskView): number =>
      (new Date(a.ddl!).getTime() - new Date(b.ddl!).getTime()) || (prio(a.priority) - prio(b.priority)) || a.createdAt.localeCompare(b.createdAt)
    const byPrio = (a: TaskView, b: TaskView): number => (prio(a.priority) - prio(b.priority)) || a.createdAt.localeCompare(b.createdAt)
    overdue.sort(byDdlThenPrio)
    withDdl.sort(byDdlThenPrio)
    noDdl.sort(byPrio)
    done.sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''))
    return [
      { title: '逾期', items: overdue, tone: 'overdue' as const },
      { title: '有截止时间', items: withDdl, tone: 'normal' as const },
      { title: '无截止时间', items: noDdl, tone: 'normal' as const },
      { title: '已完成', items: done, tone: 'done' as const }
    ].filter((g) => g.items.length > 0 && (g.title !== '已完成' || showDone === 'show'))
  }, [undone, done, showDone])

  /** tag id -> 完整路径（如 学校/数学） */
  const tagName = useMemo(() => {
    const map = new Map(tags.map((t) => [t.id, t]))
    const path = (id: string): string => {
      const parts: string[] = []
      let cur = map.get(id)
      let guard = 0
      while (cur && guard++ < 20) { parts.unshift(cur.name); cur = cur.parentId ? map.get(cur.parentId) : undefined }
      return parts.join('/')
    }
    return path
  }, [tags])

  // ---------- tag 管理（与笔记库的树一致：新建/改名/删除/拖拽调整层级） ----------
  const createTag = useCallback(async (parentId: string | null): Promise<void> => {
    try {
      const tag = await window.api.tagCreate('新标签', parentId)
      if (parentId) setExpandedTags((prev) => ({ ...prev, [parentId]: true }))
      setTagRenaming({ id: tag.id, value: '新标签' })
      onChanged()
      void load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }, [onChanged, load])

  const commitTagRename = useCallback(async (value: string): Promise<void> => {
    const target = tagRenaming
    setTagRenaming(null)
    const name = value.trim()
    if (!target || !name) return
    try {
      await window.api.tagRename(target.id, name)
      onChanged()
      void load()
    } catch (e) {
      toast('重命名失败：' + (e as Error).message, 'error')
    }
  }, [tagRenaming, onChanged, load])

  const deleteTag = useCallback(async (id: string): Promise<void> => {
    const name = tagName(id)
    if (!(await askConfirm('删除标签「' + name + '」？\n只会把它从任务上移除，不会删除任务；其子标签也会一并删除。'))) return
    try {
      await window.api.tagDelete(id)
      if (activeTag && (activeTag === id || tagName(activeTag).startsWith(name + '/'))) setActiveTag(null)
      toast('已删除标签', 'success')
      onChanged()
      void load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }, [tagName, activeTag, onChanged, load])

  const moveTag = useCallback(async (id: string, newParentId: string | null): Promise<void> => {
    try {
      await window.api.tagMove(id, newParentId)
      if (newParentId) setExpandedTags((prev) => ({ ...prev, [newParentId]: true }))
      onChanged()
      void load()
    } catch (e) {
      toast('移动失败：' + (e as Error).message, 'error')
    }
  }, [onChanged, load])

  const completeTask = useCallback(async (task: TaskView) => {
    try {
      await window.api.taskComplete(task.id)
      toast('任务已完成', 'success')
      onChanged()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }, [onChanged])

  const deleteTask = useCallback(async (task: TaskView) => {
    if (!(await askConfirm('删除任务「' + task.name + '」？\n任务将进入回收站保留 30 天，关联的笔记不会被删除。'))) return
    try {
      await window.api.taskDelete(task.id)
      toast('已移入任务回收站', 'success')
      onChanged()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }, [onChanged])

  const openNote = useCallback(async (task: TaskView) => {
    if (!task.noteId) return
    try {
      if (task.noteMissing) { toast('关联的笔记已被永久删除，目标不存在', 'error'); return }
      window.dispatchEvent(new CustomEvent('open-note', { detail: { id: task.noteId } }))
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }, [])

  const undoNoop = useCallback((task: TaskView) => {
    if (task.done) toast('完成状态不可撤销', 'error')
  }, [])

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of tasks) {
      if (t.done) continue
      for (const id of t.tagIds) {
        const parts: string[] = []
        let cur: Tag | undefined = tags.find((x) => x.id === id)
        let guard = 0
        while (cur && guard++ < 20) { parts.push(cur.id); cur = cur.parentId ? tags.find((x) => x.id === cur!.parentId) : undefined }
        for (const pid of parts) map.set(pid, (map.get(pid) ?? 0) + 1)
      }
    }
    return map
  }, [tasks, tags])

  return (
    <div className="task-layout">
      <div className="tag-panel">
        <button
          className={'tag-root-row' + (activeTag === null ? ' active' : '')}
          onClick={() => setActiveTag(null)}
        >
          <span className="grow nowrap">全部</span>
          <span className="tag-count">{undone.length || ''}</span>
        </button>
        <div className="tag-panel-head">
          <span>分类</span>
          <button className="icon-btn" title="新建顶层标签" onClick={() => void createTag(null)}><PlusIcon size={15} /></button>
        </div>
        {/* 与笔记库一致的树：展开收起、右键菜单、拖拽调整层级 */}
        <div
          className="tag-tree-scroll"
          onContextMenu={(e) => {
            e.preventDefault()
            setTagMenu({ x: e.clientX, y: e.clientY, items: [{ label: '新建顶层标签', onClick: () => void createTag(null) }] })
          }}
          onDragOver={(e) => { if (e.target === e.currentTarget) e.preventDefault() }}
          onDrop={(e) => {
            // 只有落在真正的空白区域才算"移到顶层"；落在某一行上由那一行自己处理
            if (e.target !== e.currentTarget) return
            e.preventDefault()
            const id = e.dataTransfer.getData('text/tag-id')
            if (id) void moveTag(id, null)
          }}
        >
          <TagTree
            tags={tags}
            activeTag={activeTag}
            counts={counts}
            expanded={expandedTags}
            renaming={tagRenaming}
            onSelect={setActiveTag}
            onToggle={(id) => setExpandedTags((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }))}
            onStartRename={(id, value) => setTagRenaming({ id, value })}
            onCommitRename={(v) => void commitTagRename(v)}
            onCancelRename={() => setTagRenaming(null)}
            onDelete={(id) => void deleteTag(id)}
            onCreateChild={(parentId) => void createTag(parentId)}
            onMove={(id, parentId) => void moveTag(id, parentId)}
            onMenu={(e, items) => { e.preventDefault(); e.stopPropagation(); setTagMenu({ x: e.clientX, y: e.clientY, items }) }}
          />
          {tags.length === 0 && (
            <div className="small muted" style={{ padding: '8px 6px' }}>还没有标签，点右上角 ＋ 新建，右键可管理。</div>
          )}
        </div>
      </div>

      <div className="task-main">
        <div className="task-toolbar">
          <div className="topbar-title" style={{ fontWeight: 600 }}>
            {activeTag ? tagName(activeTag) : '全部任务'}
          </div>
          <input
            className="input"
            style={{ maxWidth: 260 }}
            placeholder="搜索任务名称或 tag"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <div className="spacer" />
          <label className="row small muted" style={{ gap: 4 }}>
            <input type="checkbox" className="checkbox" checked={showDone === 'show'} onChange={(e) => setShowDone(e.target.checked ? 'show' : 'hide')} />
            显示已完成
          </label>
          <button className="btn primary" onClick={() => setCreating(true)}>+ 新建任务</button>
        </div>

        <div className="task-list">
          {groups.length === 0 && (
            <div className="empty">
              <div className="big">☑</div>
              <div>这里还没有任务</div>
              <div className="small" style={{ marginTop: 6 }}>点击右上角“新建任务”，或到“随笔记”里让 AI 帮你提取。</div>
            </div>
          )}
          {groups.map((g) => (
            <div key={g.title}>
              <div className="task-group-title">{g.title}（{g.items.length}）</div>
              {g.items.map((t) => {
                const overdue = !t.done && t.ddl !== null && new Date(t.ddl).getTime() < Date.now()
                return (
                  <div key={t.id} className={'task-item' + (t.done ? ' done' : '')}>
                    <button
                      className="check"
                      title={t.done ? '完成状态不可撤销' : '标记为完成'}
                      onClick={() => (t.done ? undoNoop(t) : void completeTask(t))}
                    />
                    <div className="grow" onDoubleClick={() => { if (!t.done) setEditing(t) }}>
                      <div
                        className={'name' + (t.noteId && !t.noteMissing ? ' clickable' : '')}
                        onClick={() => { if (t.noteId && !t.done) void openNote(t) }}
                        title={t.noteId ? (t.noteMissing ? '关联的笔记已被永久删除' : '打开关联笔记') : undefined}
                      >
                        {t.name}
                      </div>
                      <div className="task-meta">
                        {t.tagPaths.map((p, i) => <span key={i} className="badge tag">{p}</span>)}
                        <span className={'badge p-' + t.priority}>{PRIORITY_LABEL[t.priority]}</span>
                        {t.ddl && (
                          <span className={'badge' + (overdue ? ' overdue' : '')}>
                            {overdue ? '已逾期 ' : ''}{formatDdl(t.ddl)}{t.ddlInferred ? '（AI 推断）' : ''}
                          </span>
                        )}
                        {t.origin === 'ai' && <span className="badge ai">AI</span>}
                        {t.noteId && (t.noteMissing
                          ? <span className="badge" style={{ background: '#fdeceb', color: '#c9372c' }}>笔记目标不存在</span>
                          : <span className="badge">笔记：{t.noteTitle ?? '未命名'}</span>)}
                      </div>
                    </div>
                    <div className="task-actions">
                      {!t.done && <button className="btn ghost small" onClick={() => setEditing(t)}>编辑</button>}
                      <button className="btn ghost small danger" onClick={() => void deleteTask(t)}>删除</button>
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>

      {(creating || editing) && (
        <TaskDialog
          task={editing}
          tags={tags}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); onChanged() }}
        />
      )}
      {tagMenu && <ContextMenu x={tagMenu.x} y={tagMenu.y} items={tagMenu.items} onClose={() => setTagMenu(null)} />}
    </div>
  )
}

export function formatDdl(ddl: string): string {
  const d = new Date(ddl)
  if (Number.isNaN(d.getTime())) return ddl
  const p = (n: number): string => (n < 10 ? '0' + n : String(n))
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}
