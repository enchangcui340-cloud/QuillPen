import { useEffect, useMemo, useState } from 'react'
import type { TaskView } from '@shared/api'
import { PRIORITY_LABEL, type Note, type Priority, type Tag } from '@shared/types'
import Modal from './Modal'
import { toast } from './Toast'

interface Props {
  task: TaskView | null
  tags: Tag[]
  onClose: () => void
  onSaved: () => void
}

function toInputValue(ddl: string | null): string {
  if (!ddl) return ''
  return ddl.slice(0, 16)
}

export default function TaskDialog({ task, tags, onClose, onSaved }: Props): React.ReactElement {
  const [name, setName] = useState(task?.name ?? '')
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'minor')
  const [ddl, setDdl] = useState(toInputValue(task?.ddl ?? null))
  const [tagIds, setTagIds] = useState<string[]>(task?.tagIds ?? [])
  const [noteId, setNoteId] = useState<string | null>(task?.noteId ?? null)
  const [notes, setNotes] = useState<Note[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const tree = await window.api.noteTree()
        const flat: Note[] = []
        const walk = (nodes: typeof tree): void => {
          for (const n of nodes) {
            if (n.type === 'note' && n.id) flat.push({ id: n.id, title: n.name.replace(/\.canvas\.json$|\.md$/, ''), kind: n.kind ?? 'md' } as Note)
            if (n.children) walk(n.children)
          }
        }
        walk(tree)
        setNotes(flat)
      } catch { /* 笔记列表读取失败不影响任务编辑 */ }
    })()
  }, [])

  const tagOptions = useMemo(() => {
    const byId = new Map(tags.map((t) => [t.id, t]))
    const pathOf = (id: string): string => {
      const parts: string[] = []
      let cur = byId.get(id)
      let guard = 0
      while (cur && guard++ < 20) { parts.unshift(cur.name); cur = cur.parentId ? byId.get(cur.parentId) : undefined }
      return parts.join(' / ')
    }
    return tags.map((t) => ({ id: t.id, label: pathOf(t.id) })).sort((a, b) => a.label.localeCompare(b.label, 'zh'))
  }, [tags])

  const save = async (): Promise<void> => {
    if (!name.trim()) { toast('任务名称不能为空', 'error'); return }
    setSaving(true)
    try {
      const ddlValue = ddl ? (ddl.length === 16 ? ddl + ':00' : ddl) : null
      if (task) {
        await window.api.taskUpdate(task.id, { name: name.trim(), priority, ddl: ddlValue, tagIds, noteId })
        toast('任务已更新', 'success')
      } else {
        await window.api.taskCreate({ name: name.trim(), priority, ddl: ddlValue, tagIds, noteId })
        toast('任务已创建', 'success')
      }
      onSaved()
    } catch (e) {
      toast('保存失败：' + (e as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={task ? '编辑任务' : '新建任务'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
        </>
      }
    >
      <div>
        <div className="small muted" style={{ marginBottom: 4 }}>任务名称</div>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="要做什么" />
      </div>
      <div className="row">
        <div className="grow">
          <div className="small muted" style={{ marginBottom: 4 }}>优先级</div>
          <select className="select" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {(['important', 'minor', 'optional'] as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
        </div>
        <div className="grow">
          <div className="small muted" style={{ marginBottom: 4 }}>截止时间（可留空）</div>
          <input className="input" type="datetime-local" value={ddl} onChange={(e) => setDdl(e.target.value)} />
        </div>
      </div>
      <div>
        <div className="small muted" style={{ marginBottom: 4 }}>tag（可多选，可留空）</div>
        <div style={{ maxHeight: 140, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
          {tagOptions.length === 0 && <div className="small muted">还没有 tag，请到左侧“管理”中新建。</div>}
          {tagOptions.map((t) => (
            <label key={t.id} className="row" style={{ padding: '3px 0' }}>
              <input
                type="checkbox"
                className="checkbox"
                checked={tagIds.includes(t.id)}
                onChange={(e) => setTagIds((prev) => (e.target.checked ? [...prev, t.id] : prev.filter((x) => x !== t.id)))}
              />
              <span>{t.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <div className="small muted" style={{ marginBottom: 4 }}>关联笔记（最多一篇）</div>
        <select className="select" value={noteId ?? ''} onChange={(e) => setNoteId(e.target.value || null)}>
          <option value="">不关联</option>
          {notes.map((n) => <option key={n.id} value={n.id}>{n.title}{n.kind === 'whiteboard' ? '（白板）' : ''}</option>)}
        </select>
      </div>
      {task?.done && <div className="small muted">已完成任务不可修改。</div>}
    </Modal>
  )
}
