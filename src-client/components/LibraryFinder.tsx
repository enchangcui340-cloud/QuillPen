import { requestPanelReload } from '../lib/host-adapt'
import { askConfirm } from './AskDialog'
import { useCallback, useEffect, useState } from 'react'
import Modal from './Modal'
import { toast } from './Toast'

interface Candidate { path: string; notes: number; attachments: number; updatedAt: number; current: boolean }

/** 日期显示：今天显示时间，其它显示日期 */
function when(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-CN')
}

/**
 * 自动检测笔记库。
 * 工作区被误改、文件夹被改名之后，用它把散落在磁盘上的笔记找回来。
 */
export default function LibraryFinder({ onClose }: { onClose: () => void }): React.ReactElement {
  const [list, setList] = useState<Candidate[] | null>(null)
  const [scanning, setScanning] = useState(false)

  const scan = useCallback(async (): Promise<void> => {
    setScanning(true)
    try {
      setList(await window.api.libraryCandidates())
    } catch (e) {
      toast('扫描失败：' + (e as Error).message, 'error')
      setList([])
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => { void scan() }, [scan])

  const pick = async (path: string): Promise<void> => {
    if (!(await askConfirm('切换到下面这个笔记库？\n\n' + path + '\n\n切换后界面会重新加载。'))) return
    try {
      await window.api.librarySwitch(path)
      requestPanelReload()
    } catch (e) {
      toast('切换失败：' + (e as Error).message, 'error')
    }
  }

  return (
    <Modal
      title="自动检测笔记库"
      width={720}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => void scan()} disabled={scanning}>{scanning ? '扫描中…' : '重新扫描'}</button>
          <button className="btn primary" onClick={onClose}>关闭</button>
        </>
      }
    >
      <div className="col" style={{ gap: 8 }}>
        <div className="small muted">扫描了「文档」「桌面」「用户目录」以及当前库的上级目录，找出了这些像笔记库的位置（点一行即可切换）：</div>
        {scanning && <div className="small muted" style={{ padding: 12 }}>正在扫描…</div>}
        {!scanning && list && list.length === 0 && (
          <div className="small muted" style={{ padding: 12 }}>
            没有扫描到其它笔记库。如果笔记是被移到了别处，可以在「设置 → 数据目录」里直接填路径。
          </div>
        )}
        {!scanning && list?.map((c) => (
          <div
            key={c.path}
            className="list-row"
            style={{ cursor: 'pointer', alignItems: 'center' }}
            title={c.path}
            onClick={() => void pick(c.path)}
          >
            <span className="grow nowrap">{c.path}</span>
            <span className="badge">{c.notes} 篇</span>
            {c.attachments > 0 && <span className="small muted">{c.attachments} 个附件</span>}
            <span className="small muted" style={{ minWidth: 44, textAlign: 'right' }}>{when(c.updatedAt)}</span>
            {c.current && <span className="badge" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>当前</span>}
          </div>
        ))}
      </div>
    </Modal>
  )
}
