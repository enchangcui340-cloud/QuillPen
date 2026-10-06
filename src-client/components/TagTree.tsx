import { useState } from 'react'
import type { Tag } from '@shared/types'
import ContextMenu, { type MenuItem } from './ContextMenu'
import { CloseIcon, PencilIcon, PlusIcon, TagIcon, ToggleIcon } from './Icons'
import InlineRename from './InlineRename'

export interface TagRenameState { id: string; value: string }

interface Props {
  tags: Tag[]
  activeTag: string | null
  counts: Map<string, number>
  expanded: Record<string, boolean>
  renaming: TagRenameState | null
  parentId?: string | null
  onSelect: (id: string | null) => void
  onToggle: (id: string) => void
  onStartRename: (id: string, value: string) => void
  onCommitRename: (value: string) => void
  onCancelRename: () => void
  onDelete: (id: string) => void
  onCreateChild: (parentId: string) => void
  onMove: (id: string, newParentId: string | null) => void
  onMenu: (e: React.MouseEvent, items: MenuItem[]) => void
}

/**
 * tag 树：与笔记库的文件管理保持一致的交互
 * —— 展开/收起、内联改名、右键菜单、拖拽调整层级。
 */
export default function TagTree(props: Props): React.ReactElement {
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const children = props.tags.filter((t) => (t.parentId ?? null) === (props.parentId ?? null))

  return (
    <>
      {children.map((tag) => {
        const kids = props.tags.filter((t) => t.parentId === tag.id)
        const open = props.expanded[tag.id] ?? true
        const isRenaming = props.renaming?.id === tag.id
        const count = props.counts.get(tag.id) ?? 0
        return (
          <div key={tag.id}>
            <div
              className={'tree-node tag' + (props.activeTag === tag.id ? ' active' : '')
                + (dropTarget === tag.id ? ' drop' : '')}
              draggable={!isRenaming}
              onDragStart={(e) => e.dataTransfer.setData('text/tag-id', tag.id)}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDropTarget(tag.id) }}
              onDragLeave={(e) => { e.stopPropagation(); setDropTarget(null) }}
              onDrop={(e) => {
                e.preventDefault()
                // 必须阻止冒泡：否则外层"拖到空白处 = 移到顶层"也会收到，
                // 两个 move 一起跑，tag 就会一会儿进子级一会儿被弹回顶层
                e.stopPropagation()
                setDropTarget(null)
                const id = e.dataTransfer.getData('text/tag-id')
                if (id && id !== tag.id) props.onMove(id, tag.id)
              }}
              onClick={() => { if (!isRenaming) props.onSelect(tag.id) }}
              onContextMenu={(e) => props.onMenu(e, [
                { label: '新建子标签', onClick: () => props.onCreateChild(tag.id) },
                { label: '重命名', onClick: () => props.onStartRename(tag.id, tag.name) },
                { separator: true },
                { label: '删除标签', danger: true, onClick: () => props.onDelete(tag.id) }
              ])}
              title={kids.length > 0 ? '含有 ' + kids.length + ' 个子标签，可拖拽调整层级' : tag.name}
            >
              {kids.length > 0
                ? <span onClick={(e) => { e.stopPropagation(); props.onToggle(tag.id) }}><ToggleIcon open={open} /></span>
                : <span className="tree-toggle-spacer" />}
              <span className="tree-icon"><TagIcon /></span>
              {isRenaming
                ? <InlineRename value={props.renaming!.value} onCommit={props.onCommitRename} onCancel={props.onCancelRename} />
                : <span className="grow nowrap">{tag.name}</span>}
              {!isRenaming && (
                <>
                  <span className="tag-count">{count || ''}</span>
                  <span className="tree-actions">
                    <button className="icon-btn" title="新建子标签"
                      onClick={(e) => { e.stopPropagation(); props.onCreateChild(tag.id) }}><PlusIcon /></button>
                    <button className="icon-btn" title="重命名"
                      onClick={(e) => { e.stopPropagation(); props.onStartRename(tag.id, tag.name) }}><PencilIcon /></button>
                    <button className="icon-btn" title="删除标签"
                      onClick={(e) => { e.stopPropagation(); props.onDelete(tag.id) }}><CloseIcon /></button>
                  </span>
                </>
              )}
            </div>
            {open && kids.length > 0 && (
              <div className="tree-children">
                <TagTree {...props} parentId={tag.id} />
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

