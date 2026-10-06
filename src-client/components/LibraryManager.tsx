import { requestPanelReload } from '../lib/host-adapt'
import { askText, askConfirm } from './AskDialog'
import { useCallback, useEffect, useState } from 'react'
import type { LibraryListItem } from '@shared/api'
import { toast } from './Toast'
import LibraryCreateDialog from './LibraryCreateDialog'

function sizeText(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

/**
 * 设置里的「数据目录管理」：查看 / 切换 / 重命名 / 移除 / 新建。
 * 移除只从列表里拿掉，不会删文件（程序不提供删文件功能，避免误删）。
 */
export default function LibraryManager(): React.ReactElement {
  const [items, setItems] = useState<LibraryListItem[]>([])
  const [showCreate, setShowCreate] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await window.api.librariesList()
      setItems(r.items)
    } catch (e) {
      toast('读取数据目录失败：' + (e as Error).message, 'error')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const activate = async (it: LibraryListItem): Promise<void> => {
    if (it.isActive) return
    try {
      await window.api.libraryActivate(it.id)
      toast('已切换到「' + it.name + '」', 'success')
      window.setTimeout(() => requestPanelReload(), 400)
    } catch (e) {
      toast('切换失败：' + (e as Error).message, 'error')
    }
  }

  const rename = async (it: LibraryListItem): Promise<void> => {
    const name = (await askText('新的名称', it.name))
    if (name === null) return
    if (!name.trim()) { toast('名称不能为空', 'error'); return }
    if (name.trim() === it.name) return
    try {
      await window.api.libraryRename(it.id, name.trim())
      toast('已重命名为「' + name.trim() + '」', 'success')
      void load()
    } catch (e) {
      toast('重命名失败：' + (e as Error).message, 'error')
    }
  }

  const remove = async (it: LibraryListItem): Promise<void> => {
    // 云数据目录的"移除"就是断开连接：必须走警告 + 注销设备 + 刷新界面
    if (it.kind === 'cloud') {
      let lastMsg = ''
      try {
        const { devices, selfId } = await window.api.cloudDevices2(it.id)
        const others = devices.filter((d) => d.id !== selfId)
        lastMsg = others.length === 0
          ? '你是最后一个连接这个云数据目录的设备。\n\n断开后如果 12×24 小时内没有设备再连接它，\n服务器上的内容会被【全部删除】。\n\n'
          : '还有 ' + others.length + ' 台设备连接着它，断开不影响它们。\n\n'
      } catch {
        lastMsg = '（查询其他设备失败，可能是离线）\n\n'
      }
      if (!(await askConfirm('断开云数据目录「' + it.name + '」？\n\n' + lastMsg + '本机副本会保留在磁盘上，之后可以用 key 再连回来。\n\n确定断开？'))) return
      try {
        const r = await window.api.cloudDisconnect(it.id)
        toast('已断开云数据目录' + (r.next ? '，已切回「' + r.next + '」' : ''), 'success')
        window.setTimeout(() => requestPanelReload(), 600)
      } catch (e) {
        toast('断开失败：' + (e as Error).message, 'error')
      }
      return
    }
    if (!(await askConfirm('从列表移除「' + it.name + '」？\n\n只从列表移除，文件夹和里面的笔记都不会动。'))) return
    try {
      await window.api.libraryRemove(it.id)
      toast('已从列表移除', 'success')
      if (it.isActive) window.setTimeout(() => requestPanelReload(), 600)
      else void load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <div>
      <div className="row" style={{ alignItems: 'center', marginBottom: 6 }}>
        <div className="small muted grow">数据目录（每个都是独立的笔记库，可随时切换）</div>
        <button className="btn small" onClick={() => setShowCreate(true)}>新建…</button>
      </div>
      {items.map((it) => (
        <div className="lib-row" key={it.id}>
          <span className="lib-kind">{it.kind === 'cloud' ? '☁' : '●'}</span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="nowrap">
              {it.name}
              {it.isActive && <span className="badge" style={{ marginLeft: 6, background: 'var(--accent-soft)', color: 'var(--accent)' }}>当前</span>}
              {!it.exists && <span className="badge" style={{ marginLeft: 6, background: '#fdeceb', color: '#c9372c' }}>路径不存在</span>}
            </div>
            <div className="small muted nowrap" title={it.dir}>{it.dir}</div>
            <div className="small muted">{it.notes} 篇 · {sizeText(it.sizeBytes)}</div>
          </div>
          {!it.isActive && <button className="btn small" onClick={() => void activate(it)}>切换</button>}
          <button className="btn small" onClick={() => void rename(it)}>重命名</button>
          <button className="btn small danger" onClick={() => void remove(it)}>{it.kind === 'cloud' ? '断开' : '移除'}</button>
        </div>
      ))}
      {showCreate && <LibraryCreateDialog onClose={() => setShowCreate(false)} onDone={() => { setShowCreate(false); void load() }} />}
    </div>
  )
}
