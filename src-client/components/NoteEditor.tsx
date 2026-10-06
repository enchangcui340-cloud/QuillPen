import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteContent } from '@shared/api'
import type { EditorView } from '@codemirror/view'
import { joinFrontmatter, splitFrontmatter } from '../lib/frontmatter'
import { renderMarkdown } from '../lib/markdown'
import { clearHighlight, insertMarkdownLink, insertText, togglePrefixLines, toggleWrap } from '../lib/mdCommands'
import { isFormatted, linesHavePrefix } from '../lib/mdToggle'
import ContextMenu, { type MenuItem } from './ContextMenu'
import Modal from './Modal'
import LinkDialog from './LinkDialog'
import { toMarkdownTarget } from '../lib/linkTarget'
import { encodePath } from '../lib/imageSrc'
import { nameForPastedImage, readAsDataUrl } from '../lib/attachments'
import { redo, undo } from '@codemirror/commands'
import MarkdownEditor from './MarkdownEditor'
import { toast } from './Toast'

/** 三种高亮互为同族：点另一种颜色 = 换色，而不是叠加两种颜色 */
const HIGHLIGHT_SIBLINGS: [string, string][] = [['==y==', '==y=='], ['==g==', '==g=='], ['==p==', '==p==']]

interface Props {
  note: NoteContent
  onSaved: () => void
  onReveal: () => void
  onRestoreOrigin: () => void
  onRename: (title: string) => void
}

/** 文本笔记编辑器：编辑/只读切换、手动保存、自动保存、右键格式化、三色高亮。 */
export default function NoteEditor({ note, onSaved, onReveal, onRestoreOrigin, onRename }: Props): React.ReactElement {
  // 只编辑正文；文件头部（YAML）不显示也不允许被格式化，保存时原样接回
  const { head, body } = useMemo(() => splitFrontmatter(note.content), [note.content])
  const headRef = useRef(head)
  headRef.current = head
  const [draft, setDraft] = useState(body)
  const [readonly, setReadonly] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [lastSaved, setLastSaved] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  /** 保存冲突：把两边内容都留着，交给用户决定，绝不静默丢弃 */
  const [conflict, setConflict] = useState<{ mine: string; theirs: string } | null>(null)
  const [linkDialog, setLinkDialog] = useState(false)
  const conflictRef = useRef(false)
  const viewRef = useRef<EditorView | null>(null)

  const draftRef = useRef(draft)
  const dirtyRef = useRef(false)
  // 关键：保存基准时间必须跟着每次保存更新，否则第二次保存会被误判为「文件被外部修改」
  const mtimeRef = useRef(note.note.fileMtimeMs)

  useEffect(() => { draftRef.current = draft }, [draft])
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  useEffect(() => {
    // 只有在没有未保存修改时才接受外部基准，否则会把基准倒退回旧值，造成"每次都冲突"
    if (!dirtyRef.current) mtimeRef.current = note.note.fileMtimeMs
  }, [note.note.id, note.note.fileMtimeMs])

  const save = useCallback(async (silent = false): Promise<boolean> => {
    if (!dirtyRef.current) return true
    setSaving(true)
    try {
      const result = await window.api.noteSave(note.note.id, joinFrontmatter(headRef.current, draftRef.current), mtimeRef.current)
      if (!result.ok) {
        conflictRef.current = true
        setConflict({ mine: draftRef.current, theirs: result.current })
        toast('保存冲突：文件已被外部程序修改，请选择如何处理', 'error')
        return false
      }
      // 用返回的最新时间作为下次保存的基准
      mtimeRef.current = result.note.fileMtimeMs
      setDirty(false)
      dirtyRef.current = false
      setLastSaved(new Date().toLocaleTimeString('zh-CN'))
      if (!silent) toast('已保存', 'success')
      onSaved()
      return true
    } catch (e) {
      toast('保存失败：' + (e as Error).message, 'error')
      return false
    } finally {
      setSaving(false)
    }
  }, [note.note.id, onSaved])

  // 离开当前笔记（切换、关闭窗口）时自动保存
  useEffect(() => {
    const beforeUnload = (): void => { if (dirtyRef.current) void save(true) }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      if (dirtyRef.current) {
        const content = joinFrontmatter(headRef.current, draftRef.current)
        void window.api.noteSave(note.note.id, content, mtimeRef.current).then(async (r) => {
          if (r.ok) return
          // 被拒绝（文件被外部改过）：把未保存内容另存一份，并告诉用户在哪
          try {
            const path = await window.api.noteBackup(note.note.id, content)
            toast('离开时保存失败，未保存的内容已备份到：' + path, 'error')
          } catch {
            toast('离开时自动保存失败，请重新打开笔记检查内容', 'error')
          }
        }).catch(async () => {
          try {
            const path = await window.api.noteBackup(note.note.id, content)
            toast('离开时保存失败，未保存的内容已备份到：' + path, 'error')
          } catch {
            toast('离开时自动保存失败，请重新打开笔记检查内容', 'error')
          }
        })
      }
    }
  }, [note.note.id, save])

  // 停顿 1.2 秒自动保存
  useEffect(() => {
    if (!dirty || readonly || conflictRef.current) return
    const timer = setTimeout(() => { void save(true) }, 1200)
    return () => clearTimeout(timer)
  }, [draft, dirty, readonly, save, conflict])

  const html = useMemo(() => renderMarkdown(draft, { images: note.inlinedImages }), [draft, note.inlinedImages])

  const onLinkClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement
    // 只读态是 <a data-href>；编辑态是实时预览的 .cm-link（地址挂在 data-href 上）
    const target = el.closest('a') ?? el.closest('.cm-link')
    const href = target?.getAttribute('data-href')
    if (href) {
      e.preventDefault()
      // 网页 -> 浏览器；本地文件/文件夹 -> 系统默认程序（主进程统一分发）
      void window.api.openTarget(href).catch((err: Error) => toast('打开失败：' + err.message, 'error'))
    }
  }, [])

  const run = useCallback((fn: (v: EditorView) => void) => {
    const view = viewRef.current
    if (!view || readonly) return
    fn(view)
  }, [readonly])

  const insertImage = useCallback(async (): Promise<void> => {
    try {
      const picked = await window.api.attachmentImport()
      if (!picked) return
      // 附件名常带空格/括号，插入时转义，否则 Markdown 解析不出来（图片就"消失"了）
      const alt = picked.name.replace(/[[\]]/g, '')
      run((v) => insertText(v, '![' + alt + '](' + encodePath(picked.rel) + ')'))
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }, [run])

  /** 冲突三选一：用我的覆盖 / 用磁盘版（可撤销）/ 稍后处理 */
  const resolveConflict = useCallback(async (choice: 'mine' | 'theirs' | 'later'): Promise<void> => {
    const c = conflict
    if (!c) return
    if (choice === 'later') { setConflict(null); return }
    if (choice === 'mine') {
      try {
        const r = await window.api.noteForceSave(note.note.id, joinFrontmatter(headRef.current, c.mine))
        mtimeRef.current = r.fileMtimeMs
        conflictRef.current = false
        setConflict(null)
        setDirty(false)
        dirtyRef.current = false
        setLastSaved(new Date().toLocaleTimeString('zh-CN'))
        toast('已用编辑器里的内容覆盖保存', 'success')
        onSaved()
      } catch (e) {
        toast('保存失败：' + (e as Error).message, 'error')
      }
      return
    }
    // 用磁盘版本：走正常的编辑器 dispatch，所以这一步本身也可以用 Ctrl+Z 撤销
    const view = viewRef.current
    if (view) {
      const disk = splitFrontmatter(c.theirs).body
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: disk } })
    }
    conflictRef.current = false
    setConflict(null)
    setDirty(false)
    dirtyRef.current = false
    toast('已载入磁盘上的版本（可用 Ctrl+Z 撤销）', 'success')
  }, [conflict, note.note.id, onSaved])

  /**
   * 粘贴/拖入的图片：存进笔记库附件目录，再在光标处插入引用。
   * 从资源管理器复制来的文件优先按路径拷贝（保留原始文件名），
   * 截图这类只有数据的就走 data URL 存档。
   */
  const onPasteImage = useCallback(async (files: File[]): Promise<void> => {
    if (readonly) return
    let done = 0
    for (const file of files) {
      try {
        const name = nameForPastedImage(file)
        const path = window.api.pathForFile ? window.api.pathForFile(file) : ''
        const saved = path
          ? await window.api.attachmentImport(path, name)
          : await window.api.attachmentFromData(await readAsDataUrl(file), name)
        if (!saved) continue
        run((v) => insertText(v, '![' + saved.name.replace(/[[\]]/g, '') + '](' + encodePath(saved.rel) + ')'))
        done++
      } catch (e) {
        toast('插入图片失败：' + (e as Error).message, 'error')
      }
    }
    if (done > 0) toast(done > 1 ? '已插入 ' + done + ' 张图片' : '已插入图片', 'success')
  }, [readonly, run])

  const formatMenu = useCallback((e: React.MouseEvent): void => {
    if (readonly) return
    e.preventDefault()
    // 打开菜单时先看一眼当前选区，把已经生效的格式标出来，不然根本不知道自己加了什么
    const view = viewRef.current
    const on = (marker: string): boolean => {
      if (!view) return false
      const { from, to } = view.state.selection.main
      if (from === to) return false
      return isFormatted(view.state.doc.toString(), from, to, marker, marker)
    }
    const onLine = (prefix: string): boolean => {
      if (!view) return false
      const { from, to } = view.state.selection.main
      return linesHavePrefix(view.state.doc.toString(), from, to, prefix)
    }
    const tick = (v: boolean): string => (v ? '✓ ' : '')

    const items: MenuItem[] = [
      { label: tick(on('**')) + '加粗', shortcut: 'Ctrl+B', onClick: () => run((v) => toggleWrap(v, '**')) },
      { label: tick(on('*')) + '斜体', shortcut: 'Ctrl+I', onClick: () => run((v) => toggleWrap(v, '*')) },
      { separator: true },
      { label: tick(onLine('# ')) + '一级标题', onClick: () => run((v) => togglePrefixLines(v, '# ')) },
      { label: tick(onLine('## ')) + '二级标题', onClick: () => run((v) => togglePrefixLines(v, '## ')) },
      { label: tick(onLine('### ')) + '三级标题', onClick: () => run((v) => togglePrefixLines(v, '### ')) },
      { separator: true },
      { label: tick(onLine('- ')) + '无序列表', onClick: () => run((v) => togglePrefixLines(v, '- ')) },
      { label: tick(onLine('1. ')) + '有序列表', onClick: () => run((v) => togglePrefixLines(v, '1. ')) },
      { separator: true },
      { label: tick(on('==y==')) + '黄色高亮', onClick: () => run((v) => toggleWrap(v, '==y==', '==y==', HIGHLIGHT_SIBLINGS)) },
      { label: tick(on('==g==')) + '绿色高亮', onClick: () => run((v) => toggleWrap(v, '==g==', '==g==', HIGHLIGHT_SIBLINGS)) },
      { label: tick(on('==p==')) + '粉色高亮', onClick: () => run((v) => toggleWrap(v, '==p==', '==p==', HIGHLIGHT_SIBLINGS)) },
      { label: '清除高亮', onClick: () => run((v) => clearHighlight(v)) },
      { separator: true },
      { label: '插入链接 / 本地文件…', onClick: () => setLinkDialog(true) },
      { label: '插入图片', onClick: () => void insertImage() },
      { label: '插入分割线', onClick: () => run((v) => insertText(v, '\n\n---\n\n')) }
    ]
    setMenu({ x: e.clientX, y: e.clientY, items })
  }, [readonly, run, insertImage])

  return (
    <>
      <div className="note-toolbar">
        <button className="note-title" title="点击重命名" onClick={() => onRename(note.note.title)}>
          {note.note.title}
        </button>
        <div className="spacer" />
        <button className="btn small" title="撤销（Ctrl+Z）" disabled={readonly} onClick={() => run((v) => { undo(v) })}>撤销</button>
        <button className="btn small" title="重做（Ctrl+Y）" disabled={readonly} onClick={() => run((v) => { redo(v) })}>重做</button>
        <button className="btn small" onClick={() => setReadonly((v) => !v)}>{readonly ? '编辑' : '只读'}</button>
        <button className="btn small" onClick={onReveal}>在资源管理器中显示</button>
        {note.note.originPath && <button className="btn small" onClick={onRestoreOrigin}>回到原位置</button>}
        <button className="btn small primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
      </div>
      <div className="note-body" onClick={onLinkClick}>
        {readonly && <div className="md-view" dangerouslySetInnerHTML={{ __html: html }} />}
        {/*
          编辑器始终保持挂载，切到只读只是把它隐藏。
          否则每次切回编辑都会重新创建编辑器，用最初加载的内容覆盖当前编辑内容，
          已经添加的格式效果就会「消失」（其实是被旧内容顶掉了）。
        */}
        <div className="editor-slot" style={{ display: readonly ? 'none' : 'block' }}>
          <MarkdownEditor
            value={draft}
            readonly={readonly}
            images={note.inlinedImages}
            onChange={(v) => { setDraft(v); setDirty(true) }}
            onSave={() => void save()}
            onContextMenu={formatMenu}
            onPasteImage={(files) => void onPasteImage(files)}
            onReady={(v) => { viewRef.current = v }}
          />
        </div>
      </div>
      {conflict && (
        <Modal
          title="保存冲突"
          width={560}
          onClose={() => void resolveConflict('later')}
          footer={
            <>
              <button className="btn" onClick={() => void resolveConflict('later')}>稍后处理</button>
              <button className="btn" onClick={() => void resolveConflict('theirs')}>用磁盘上的版本</button>
              <button className="btn primary" onClick={() => void resolveConflict('mine')}>保留我的修改</button>
            </>
          }
        >
          <div className="col" style={{ gap: 8 }}>
            <div>这篇笔记的文件被其它程序改过了。你的修改还完整留在编辑器里，请选择怎么处理：</div>
            <div className="small muted">· <b>保留我的修改</b>：用编辑器里的内容覆盖磁盘文件（对方那次修改会被覆盖）</div>
            <div className="small muted">· <b>用磁盘上的版本</b>：放弃编辑器里未保存的修改（这一步也可以用 Ctrl+Z 撤回）</div>
            <div className="small muted">· <b>稍后处理</b>：什么都不做，内容继续留在编辑器里</div>
            <div className="small muted" style={{ marginTop: 4 }}>磁盘版本的开头：</div>
            <pre className="small" style={{ maxHeight: 120, overflow: 'auto', background: 'var(--panel)', padding: 8, borderRadius: 6 }}>
              {splitFrontmatter(conflict.theirs).body.slice(0, 300) || '（磁盘上的文件是空的）'}
            </pre>
          </div>
        </Modal>
      )}

      {linkDialog && (
        <LinkDialog
          onClose={() => setLinkDialog(false)}
          onConfirm={(label, target) => {
            setLinkDialog(false)
            run((v) => insertMarkdownLink(v, label, toMarkdownTarget(target)))
          }}
        />
      )}

      <div className="note-status">
        <span>{dirty ? '有未保存的修改' : '已保存'}</span>
        {lastSaved && <span>· 上次保存 {lastSaved}</span>}
        <span>· {draft.length} 字</span>
        <div className="spacer" />
        <span>右键格式化 · Ctrl+S 保存 · 离开自动保存</span>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  )
}
