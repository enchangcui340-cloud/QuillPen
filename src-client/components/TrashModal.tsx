import { askConfirm } from './AskDialog'
import { useCallback, useEffect, useState } from 'react'
import type { TrashNote, TrashTask } from '@shared/types'
import Modal from './Modal'
import { toast } from './Toast'
import { PRIORITY_LABEL } from '@shared/types'

export default function TrashModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }): React.ReactElement {
  const [tab, setTab] = useState<'task' | 'note'>('task')
  const [tasks, setTasks] = useState<TrashTask[]>([])
  const [notes, setNotes] = useState<TrashNote[]>([])
  const [selectedNotes, setSelectedNotes] = useState<string[]>([])
  const [history, setHistory] = useState<{ id: string; when: string; summary: string }[]>([])

  const load = useCallback(async () => {
    try {
      const [t, n, h] = await Promise.all([window.api.trashTaskList(), window.api.trashNoteList(), window.api.historyList()])
      setTasks(t)
      setNotes(n)
      setHistory(h)
    } catch (e) {
      toast('读取回收站失败：' + (e as Error).message, 'error')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const restoreTask = async (id: string): Promise<void> => {
    try {
      await window.api.trashTaskRestore(id)
      toast('任务已恢复', 'success')
      await load()
      onChanged()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const purgeTask = async (id: string, name: string): Promise<void> => {
    if (!(await askConfirm('永久删除任务「' + name + '」？\n此操作不可恢复，只会在后台保留一条简短历史记录。'))) return
    try {
      await window.api.trashTaskPurge(id)
      toast('已永久删除', 'success')
      await load()
      onChanged()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const restoreNotes = async (): Promise<void> => {
    if (!selectedNotes.length) { toast('请先选择要恢复的笔记', 'error'); return }
    try {
      const res = await window.api.trashNoteRestore(selectedNotes)
      const renamed = res.renamed.length ? '，其中 ' + res.renamed.length + ' 项因同名自动改名' : ''
      toast('已恢复 ' + res.restored.length + ' 项' + renamed, 'success')
      setSelectedNotes([])
      await load()
      onChanged()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const purgeNotes = async (): Promise<void> => {
    if (!selectedNotes.length) { toast('请先选择要永久删除的笔记', 'error'); return }
    if (!(await askConfirm('永久删除选中的 ' + selectedNotes.length + ' 项？\n不会删除引用它的任务；不再被引用的附件会一并清理。'))) return
    try {
      await window.api.trashNotePurge(selectedNotes)
      toast('已永久删除', 'success')
      setSelectedNotes([])
      await load()
      onChanged()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <Modal title="回收站" width={720} onClose={onClose} footer={<button className="btn" onClick={onClose}>关闭</button>}>
      <div className="tabs" style={{ margin: '-16px -18px 0', padding: '0 6px' }}>
        <button className={'tab' + (tab === 'task' ? ' active' : '')} onClick={() => setTab('task')}>任务回收站（{tasks.length}）</button>
        <button className={'tab' + (tab === 'note' ? ' active' : '')} onClick={() => setTab('note')}>笔记回收站（{notes.length}）</button>
      </div>

      {tab === 'task' && (
        <>
          <div className="small muted">删除的任务保留 30 天，到期后自动清除；恢复后已完成状态保持不变。</div>
          <div style={{ maxHeight: 340, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
            {tasks.length === 0 && <div className="small muted" style={{ padding: 14 }}>任务回收站是空的。</div>}
            {tasks.map((t) => (
              <div key={t.task.id} className="list-row">
                <div className="grow">
                  <div>{t.task.name} {t.task.done && <span className="badge">已完成</span>}</div>
                  <div className="small muted">
                    {PRIORITY_LABEL[t.task.priority]} · 删除于 {t.deletedAt.slice(0, 16).replace('T', ' ')}
                    {t.task.ddl ? ' · ddl ' + t.task.ddl.slice(0, 16).replace('T', ' ') : ' · 无 ddl'}
                  </div>
                </div>
                <button className="btn small" onClick={() => void restoreTask(t.task.id)}>恢复</button>
                <button className="btn small danger" onClick={() => void purgeTask(t.task.id, t.task.name)}>永久删除</button>
              </div>
            ))}
          </div>
          {history.length > 0 && (
            <details>
              <summary className="small muted">查看永久删除历史（{history.length} 条）</summary>
              <div style={{ maxHeight: 140, overflow: 'auto', marginTop: 6 }}>
                {history.map((h) => <div key={h.id + h.when} className="small muted">{h.when} · {h.summary}</div>)}
              </div>
            </details>
          )}
        </>
      )}

      {tab === 'note' && (
        <>
          <div className="row">
            <span className="small muted grow">笔记回收站不会自动清理；原笔记夹可用时恢复到原位置，否则回到笔记库根目录。</span>
            <button className="btn small" onClick={() => void restoreNotes()}>恢复选中</button>
            <button className="btn small danger" onClick={() => void purgeNotes()}>永久删除选中</button>
          </div>
          <div style={{ maxHeight: 340, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
            {notes.length === 0 && <div className="small muted" style={{ padding: 14 }}>笔记回收站是空的。</div>}
            {notes.map((n) => (
              <div key={n.id} className="list-row">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={selectedNotes.includes(n.id)}
                  onChange={(e) => setSelectedNotes((prev) => (e.target.checked ? [...prev, n.id] : prev.filter((x) => x !== n.id)))}
                />
                <div className="grow">
                  <div>{n.kind === 'whiteboard' ? '▦ ' : '📄 '}{n.title}</div>
                  <div className="small muted">
                    原位置：{n.originalDir || '根目录'} · 删除于 {n.deletedAt.slice(0, 16).replace('T', ' ')}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}
