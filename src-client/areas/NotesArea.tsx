import { askConfirm } from '../components/AskDialog'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteContent } from '@shared/api'
import type { TreeNode } from '@shared/types'
import { toast } from '../components/Toast'
import NoteEditor from '../components/NoteEditor'
import Whiteboard from '../components/Whiteboard'
import ContextMenu, { type MenuItem } from '../components/ContextMenu'
import InlineRename from '../components/InlineRename'
import LibraryFinder from '../components/LibraryFinder'
import CopyToDialog from '../components/CopyToDialog'
import { BoardIcon, CloseIcon, FolderIcon, NoteIcon, PencilIcon, PlusIcon, ToggleIcon } from '../components/Icons'

interface Props {
  refreshToken: number
  onChanged: () => void
  /** 由外部（例如待办关联笔记）请求打开的笔记 id */
  openNoteId?: string | null
  onOpenedNote?: () => void
}

type Renaming = { kind: 'note'; id: string; value: string } | { kind: 'folder'; path: string; value: string } | null

export default function NotesArea({ refreshToken, onChanged, openNoteId, onOpenedNote }: Props): React.ReactElement {
  const [tree, setTree] = useState<TreeNode[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [current, setCurrent] = useState<NoteContent | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  /** 当前选中的笔记夹：新建内容会放进它里面（实现「夹中夹」） */
  const [activeFolder, setActiveFolder] = useState<string | null>(null)
  const [showFinder, setShowFinder] = useState(false)
  const [copyFrom, setCopyFrom] = useState<{ rel: string; title: string } | null>(null)
  const [renaming, setRenaming] = useState<Renaming>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [noteTitles, setNoteTitles] = useState<Record<string, string>>({})

  const loadTree = useCallback(async (): Promise<TreeNode[]> => {
    const next = await window.api.noteTree()
    setTree(next)
    const map: Record<string, string> = {}
    const walk = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        if (n.type === 'note' && n.id) map[n.id] = n.name.replace(/\.canvas\.json$|\.md$/, '')
        if (n.children) walk(n.children)
      }
    }
    walk(next)
    setNoteTitles(map)
    return next
  }, [])

  useEffect(() => {
    void loadTree().catch((e) => toast('读取笔记库失败：' + (e as Error).message, 'error'))
  }, [loadTree, refreshToken])

  const loadNote = useCallback(async (id: string) => {
    try {
      const content = await window.api.noteRead(id)
      setCurrent(content)
      setSelectedId(id)
    } catch (e) {
      toast('打开笔记失败：' + (e as Error).message, 'error')
    }
  }, [])

  // 外部请求打开指定笔记（例如从待办点进来）
  useEffect(() => {
    if (!openNoteId) return
    void loadNote(openNoteId).then(() => onOpenedNote?.())
  }, [openNoteId, loadNote, onOpenedNote])

  /** 当前所在目录：优先用已打开笔记所在目录，否则根目录 */
  const currentDir = useMemo(() => activeFolder ?? current?.note.dir ?? '', [activeFolder, current])

  // ---------- 新建：直接生成「未命名」，不弹对话框，随后可改名 ----------
  const createNote = useCallback(async (kind: 'md' | 'whiteboard', dir?: string): Promise<void> => {
    try {
      const note = await window.api.noteCreate({ dir: dir ?? currentDir, kind, title: '未命名' })
      await loadTree()
      await loadNote(note.id)
      startRename({ kind: 'note', id: note.id, value: '未命名' })
      onChanged()
    } catch (e) {
      toast('新建失败：' + (e as Error).message, 'error')
    }
  }, [currentDir, loadTree, loadNote, onChanged])

  const createFolder = useCallback(async (dir?: string): Promise<void> => {
    try {
      const path = await window.api.folderCreate(dir ?? currentDir, '新建笔记夹')
      await loadTree()
      setExpanded((prev) => ({ ...prev, [dir ?? currentDir]: true }))
      startRename({ kind: 'folder', path, value: '新建笔记夹' })
      onChanged()
      toast('已新建笔记夹，可直接改名', 'success')
    } catch (e) {
      toast('新建笔记夹失败：' + (e as Error).message, 'error')
    }
  }, [currentDir, loadTree, onChanged])

  /**
   * 开始改名。
   * 关键点：如果目标在收起的笔记夹里，内联输入框根本没被渲染出来（看起来就是"点改名没反应"），
   * 所以先把祖先笔记夹全部展开。
   */
  const startRename = useCallback((r: Renaming): void => {
    if (!r) return
    const dir = r.kind === 'folder'
      ? (r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : '')
      : (() => {
        let cur: TreeNode | undefined
        const walk = (list: TreeNode[]): void => {
          for (const n of list) {
            if (n.type === 'note' && n.id === r.id) cur = n
            if (n.children) walk(n.children)
          }
        }
        walk(tree)
        // TreeNode 没有 dir 字段，从 path 推：A/B/note.md -> A/B
        const full = cur?.path ?? ''
        return full.includes('/') ? full.slice(0, full.lastIndexOf('/')) : ''
      })()
    const parts = dir ? dir.split('/') : []
    const patch: Record<string, boolean> = {}
    let acc = ''
    for (const part of parts) {
      acc = acc ? acc + '/' + part : part
      patch[acc] = true
    }
    if (r.kind === 'folder') patch[r.path] = true
    if (Object.keys(patch).length) setExpanded((prev) => ({ ...prev, ...patch }))
    setRenaming(r)
  }, [tree])

  // ---------- 重命名（内联输入，替代 window.prompt） ----------
  const commitRename = useCallback(async (value: string): Promise<void> => {
    const target = renaming
    setRenaming(null)
    const name = value.trim()
    if (!target) return
    if (!name) { toast('名称不能为空', 'error'); return }
    if (/[\\/:*?"<>|]/.test(name)) { toast('名称不能包含 \\ / : * ? " < > | 这些字符', 'error'); return }
    try {
      if (target.kind === 'note') {
        if (name === noteTitles[target.id]) return
        await window.api.noteRename(target.id, name)
        await loadTree()
        if (selectedId === target.id) await loadNote(target.id)
      } else {
        await window.api.folderRename(target.path, name)
        await loadTree()
      }
      onChanged()
      toast('已重命名', 'success')
    } catch (e) {
      toast('重命名失败：' + (e as Error).message, 'error')
    }
  }, [renaming, noteTitles, selectedId, loadTree, loadNote, onChanged])

  // ---------- 删除 ----------
  const removeNote = useCallback(async (id: string, title: string): Promise<void> => {
    if (!(await askConfirm('把「' + title + '」移入笔记回收站？\n（笔记回收站不会自动清理，可随时恢复；关联的任务不会被删除）'))) return
    try {
      await window.api.noteDelete(id)
      if (selectedId === id) { setCurrent(null); setSelectedId(null) }
      await loadTree()
      onChanged()
      toast('已移入笔记回收站', 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }, [selectedId, loadTree, onChanged])

  const removeFolder = useCallback(async (dir: string): Promise<void> => {
    if (!(await askConfirm('删除笔记夹「' + dir + '」及其中的全部笔记？\n内容会进入笔记回收站，可整体恢复。'))) return
    try {
      await window.api.folderDelete(dir)
      setCurrent(null)
      setSelectedId(null)
      await loadTree()
      onChanged()
      toast('已移入笔记回收站', 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }, [loadTree, onChanged])

  const moveFolder = useCallback(async (from: string, to: string): Promise<void> => {
    if (!from || from === to) return
    try {
      await window.api.folderMove(from, to)
      await loadTree()
      setActiveFolder(to)
      onChanged()
      toast('已移动笔记夹', 'success')
    } catch (e) {
      toast('移动失败：' + (e as Error).message, 'error')
    }
  }, [loadTree, onChanged])

  const moveNote = useCallback(async (id: string, dir: string): Promise<void> => {
    try {
      await window.api.noteMove(id, dir)
      await loadTree()
      if (selectedId === id) await loadNote(id)
      onChanged()
      toast('已移动', 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }, [loadTree, loadNote, onChanged, selectedId])

  const revealCurrent = useCallback(async (): Promise<void> => {
    if (!current) return
    // 注意：库根目录下的笔记 dir 是空串，直接拼 '/' 会得到 "/xxx.md" ——
    // Windows 上那是"绝对路径"，宿主的相对路径解析会被绕过、报"文件不存在"。
    const rel = current.note.dir === '' ? current.note.fileName : current.note.dir + '/' + current.note.fileName
    try { await window.api.revealPath(rel) } catch (e) { toast((e as Error).message, 'error') }
  }, [current])

  const restoreOrigin = useCallback(async (): Promise<void> => {
    if (!current) return
    try {
      const res = await window.api.noteRestoreOrigin(current.note.id)
      await loadTree()
      await loadNote(current.note.id)
      toast(res.moved ? '已放回原位置' : '原位置不可用，未移动', res.moved ? 'success' : 'info')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }, [current, loadTree, loadNote])

  const openMenu = useCallback((e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }, [])

  return (
    <div className="notes-layout">
      <div className="tree-panel">
        <div
          className="tree-toolbar tree-head"
          title="把笔记或笔记夹拖到这里 = 移到最外层"
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            const folder = e.dataTransfer.getData('text/folder-path')
            if (folder) { void moveFolder(folder, ''); return }
            const id = e.dataTransfer.getData('text/note-id')
            if (id) void moveNote(id, '')
          }}
        >
          <span className="small muted grow nowrap">笔记库</span>
          <button className="icon-btn" title="新建笔记夹" onClick={() => void createFolder()}><PlusIcon size={11} /><FolderIcon /></button>
          <button className="icon-btn" title="新建笔记" onClick={() => void createNote('md')}><PlusIcon size={11} /><NoteIcon /></button>
          <button className="icon-btn" title="新建白板" onClick={() => void createNote('whiteboard')}><PlusIcon size={11} /><BoardIcon /></button>
        </div>
        <div
          className="tree-scroll"
          onDragOver={(e) => { if (e.target === e.currentTarget) e.preventDefault() }}
          onDrop={(e) => {
            if (e.target !== e.currentTarget) return
            e.preventDefault()
            const folder = e.dataTransfer.getData('text/folder-path')
            if (folder) { void moveFolder(folder, ''); return }
            const id = e.dataTransfer.getData('text/note-id')
            if (id) void moveNote(id, '')
          }}
          onContextMenu={(e) => openMenu(e, [
          { label: '新建笔记夹', onClick: () => void createFolder('') },
          { label: '新建文本笔记', onClick: () => void createNote('md', '') },
          { label: '新建白板', onClick: () => void createNote('whiteboard', '') }
        ])}>
          <TreeView
            nodes={tree}
            selectedId={selectedId}
            expanded={expanded}
            renaming={renaming}
            rootLabel="笔记库根目录"
            onToggle={(path) => setExpanded((prev) => ({ ...prev, [path]: !(prev[path] ?? true) }))}
            onOpen={(id) => void loadNote(id)}
            onStartRename={startRename}
            onCommitRename={(v) => void commitRename(v)}
            onCancelRename={() => setRenaming(null)}
            onDeleteNote={(id, title) => void removeNote(id, title)}
            onDeleteFolder={(dir) => void removeFolder(dir)}
            onMove={(id, dir) => void moveNote(id, dir)}
            onMoveFolder={(from, to) => void moveFolder(from, to)}
            activeFolder={activeFolder}
            onSelectFolder={setActiveFolder}
            onCreateIn={(dir) => void createNote('md', dir)}
            onCreateBoard={(dir) => void createNote('whiteboard', dir)}
            onCreateFolder={(dir) => void createFolder(dir)}
            onMenu={openMenu}
            onCopyTo={(rel, title) => setCopyFrom({ rel, title })}
          />
          {tree.length === 0 && (
            <div className="small muted" style={{ padding: '10px 8px' }}>
              <div>这个笔记库里没有笔记。</div>
              <button className="btn small" style={{ marginTop: 8 }} onClick={() => setShowFinder(true)}>
                我的笔记不见了？自动检测
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="note-editor">
        {!current && (
          <div className="empty" style={{ margin: 'auto' }}>
            <div className="big">▤</div>
            <div>左侧选择一篇笔记或白板</div>
            <div className="small" style={{ marginTop: 6 }}>右键空白处可直接新建。</div>
          </div>
        )}
        {current && current.note.kind === 'md' && (
          <NoteEditor
            key={current.note.id}
            note={current}
            onSaved={() => { void loadTree(); onChanged() }}
            onReveal={() => void revealCurrent()}
            onRestoreOrigin={() => void restoreOrigin()}
            onRename={(title) => startRename({ kind: 'note', id: current.note.id, value: title })}
          />
        )}
        {current && current.note.kind === 'whiteboard' && current.whiteboard && (
          <Whiteboard
            key={current.note.id}
            note={current.note}
            board={current.whiteboard}
            noteTitles={noteTitles}
            onSaved={() => { void loadTree(); onChanged() }}
            onOpenNote={(id) => void loadNote(id)}
          />
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {showFinder && <LibraryFinder onClose={() => setShowFinder(false)} />}
      {copyFrom && (
        <CopyToDialog
          fromRel={copyFrom.rel}
          title={copyFrom.title}
          onClose={() => setCopyFrom(null)}
          onDone={() => { setCopyFrom(null); toast('复制完成', 'success') }}
        />
      )}
    </div>
  )
}

/**
 * 笔记节点 -> 相对**库根**的路径（跨库复制用）。
 * 注意：TreeNode.path 是库内相对路径（如 FTA/FTA111/笔记.md），
 * 而复制要的是 notes/ 开头的路径，所以这里补前缀 —— 之前误用了不存在的 node.dir，导致复制静默失效。
 */
function nodeNoteRel(node: TreeNode): string {
  const p = (node.path ?? node.name ?? '').replace(/^\/+/, '')
  if (!p) return ''
  return p.startsWith('notes/') ? p : 'notes/' + p
}

export function TreeView(props: {
  nodes: TreeNode[]
  selectedId: string | null
  expanded: Record<string, boolean>
  renaming: Renaming
  rootLabel?: string
  onToggle: (path: string) => void
  onOpen: (id: string) => void
  onStartRename: (r: Renaming) => void
  onCommitRename: (value: string) => void
  onCancelRename: () => void
  onDeleteNote: (id: string, title: string) => void
  onDeleteFolder: (dir: string) => void
  onMove: (id: string, dir: string) => void
  onMoveFolder?: (from: string, to: string) => void
  activeFolder?: string | null
  onSelectFolder?: (dir: string | null) => void
  onCreateIn: (dir: string) => void
  onCreateBoard?: (dir: string) => void
  onCreateFolder?: (dir: string) => void
  onMenu: (e: React.MouseEvent, items: MenuItem[]) => void
  /** 复制到另一个数据目录 */
  onCopyTo?: (rel: string, title: string) => void
}): React.ReactElement {
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /**
   * 拖动过程中只在 body 上切一个 class 用于高亮落点。
   * 关键：不要在这里 setState、也不要插入任何新元素 ——
   * 任何布局变化都会让浏览器认为拖动源被移动，从而直接取消这次拖拽
   *（之前那个"移到最外层"的投放条就是这么把拖拽功能弄坏的）。
   */
  const markDragging = (on: boolean): void => {
    document.body.classList.toggle('tree-dragging', on)
  }

  return (
    <>
      {props.nodes.map((node) => {
        if (node.type === 'folder') {
          const open = props.expanded[node.path] ?? true
          const isRenaming = props.renaming?.kind === 'folder' && props.renaming.path === node.path
          return (
            <div key={'folder:' + node.path}>
              <div
                className={'tree-node folder' + (dropTarget === node.path ? ' drop' : '')
                  + (props.activeFolder === node.path ? ' selected-folder' : '')}
                // 改名时关掉拖拽：可拖动元素里的输入框会被拖拽抢走鼠标事件，导致点不进去
                draggable={!isRenaming}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/folder-path', node.path)
                  e.dataTransfer.effectAllowed = 'move'
                  markDragging(true)
                }}
                onDragEnd={() => { markDragging(false); setDropTarget(null) }}
                onClick={() => {
                  props.onToggle(node.path)
                  props.onSelectFolder?.(props.activeFolder === node.path ? null : node.path)
                }}
                onContextMenu={(e) => props.onMenu(e, [
                  { label: '在此新建笔记夹', onClick: () => props.onCreateFolder?.(node.path) },
                  { label: '在此新建笔记', onClick: () => props.onCreateIn(node.path) },
                  { label: '在此新建白板', onClick: () => props.onCreateBoard?.(node.path) },
                  { separator: true },
                  { label: '重命名笔记夹', onClick: () => props.onStartRename({ kind: 'folder', path: node.path, value: node.name }) },
                  { separator: true },
                  { label: '复制到…', onClick: () => props.onCopyTo?.('notes/' + node.path, node.name) },
                  { separator: true },
                  { label: '删除笔记夹', danger: true, onClick: () => props.onDeleteFolder(node.path) }
                ])}
                onDragOver={(e) => { e.preventDefault(); setDropTarget(node.path) }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => {
                  e.preventDefault()
                  // 阻止冒泡：否则外层"移到最外层"的落点也会收到，笔记会被同时移到根目录
                  e.stopPropagation()
                  setDropTarget(null)
                  // 拖入的是笔记夹 -> 变成子笔记夹；拖入的是笔记 -> 移动笔记
                  const folder = e.dataTransfer.getData('text/folder-path')
                  if (folder) { props.onMoveFolder?.(folder, node.path); return }
                  const id = e.dataTransfer.getData('text/note-id')
                  if (id) props.onMove(id, node.path)
                }}
                title={node.path}
              >
                <ToggleIcon open={open} />
                <span className="tree-icon"><FolderIcon /></span>
                {isRenaming
                  ? <InlineRename value={props.renaming!.value} onCommit={props.onCommitRename} onCancel={props.onCancelRename} />
                  : <span className="grow nowrap">{node.name}</span>}
                {!isRenaming && (
                  <span className="tree-actions">
                    <button className="icon-btn" title="重命名笔记夹" onClick={(e) => { e.stopPropagation(); props.onStartRename({ kind: 'folder', path: node.path, value: node.name }) }}><PencilIcon /></button>
                    <button className="icon-btn" title="删除笔记夹" onClick={(e) => { e.stopPropagation(); props.onDeleteFolder(node.path) }}><CloseIcon /></button>
                  </span>
                )}
              </div>
              {open && (
                <div className="tree-children">
                  <TreeView {...props} nodes={node.children ?? []} />
                </div>
              )}
            </div>
          )
        }

        const isBoard = node.kind === 'whiteboard'
        const isRenaming = props.renaming?.kind === 'note' && props.renaming.id === node.id
        const title = node.name.replace(/\.canvas\.json$|\.md$/, '')
        return (
          <div
            key={'note:' + node.id}
            className={'tree-node note' + (props.selectedId === node.id ? ' active' : '')}
            // 改名时关掉拖拽，否则输入框无法获得焦点/选字
            draggable={!isRenaming}
            onDragStart={(e) => { e.dataTransfer.setData('text/note-id', node.id ?? ''); markDragging(true) }}
            onDragEnd={() => markDragging(false)}
            onClick={() => { if (!isRenaming && node.id) { props.onSelectFolder?.(null); props.onOpen(node.id) } }}
            onContextMenu={(e) => props.onMenu(e, [
              { label: '重命名', onClick: () => props.onStartRename({ kind: 'note', id: node.id!, value: title }) },
              { separator: true },
              { label: '复制到…', onClick: () => { const r = nodeNoteRel(node); if (r) props.onCopyTo?.(r, title) } },
              { separator: true },
              { label: '删除', danger: true, onClick: () => props.onDeleteNote(node.id!, title) }
            ])}
            title={title}
          >
            <span className="tree-icon">{isBoard ? <BoardIcon /> : <NoteIcon />}</span>
            {isRenaming
              ? <InlineRename value={props.renaming!.value} onCommit={props.onCommitRename} onCancel={props.onCancelRename} />
              : <span className="grow nowrap">{title}</span>}
            {!isRenaming && (
              <span className="tree-actions">
                <button className="icon-btn" title="重命名" onClick={(e) => { e.stopPropagation(); props.onStartRename({ kind: 'note', id: node.id!, value: title }) }}><PencilIcon /></button>
                <button className="icon-btn" title="删除" onClick={(e) => { e.stopPropagation(); props.onDeleteNote(node.id!, title) }}><CloseIcon /></button>
              </span>
            )}
          </div>
        )
      })}
    </>
  )
}

