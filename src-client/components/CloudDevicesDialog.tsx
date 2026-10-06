import { askConfirm } from './AskDialog'
import { useCallback, useEffect, useState } from 'react'
import Modal from './Modal'
import { toast } from './Toast'
import type { CloudDevice } from '@shared/api'

function whenText(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const days = Math.floor((Date.now() - d.getTime()) / 86400000)
  if (days === 0) return '今天 ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return days + ' 天前'
}

/** 管理"已连接设备"：只在连接/断开时计数，服务器不主动检测；可手动删除某台。 */
export default function CloudDevicesDialog({ libraryId, onClose }: {
  libraryId: string
  onClose: () => void
}): React.ReactElement {
  const [devices, setDevices] = useState<CloudDevice[]>([])
  const [selfId, setSelfId] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await window.api.cloudDevices2(libraryId)
      setDevices(r.devices)
      setSelfId(r.selfId)
    } catch (e) { toast((e as Error).message, 'error') }
  }, [libraryId])

  useEffect(() => { void load() }, [load])

  const remove = async (d: CloudDevice): Promise<void> => {
    if (!(await askConfirm('删除「' + d.name + '」这台设备的连接记录？\n\n它下次连接会自动重新登记。'))) return
    try {
      await window.api.cloudRemoveDevice(libraryId, d.id)
      toast('已删除', 'success')
      void load()
    } catch (e) { toast((e as Error).message, 'error') }
  }

  return (
    <Modal title="已连接的设备" width={620} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>关闭</button>}>
      <div className="small muted" style={{ marginBottom: 10, lineHeight: 1.7 }}>
        设备只在<b>连接</b>和<b>断开</b>时计数，服务器不主动检测。<br />
        已连接设备数为 0 时，12×24 小时后云端内容会被自动删除。
      </div>
      {devices.length === 0 && <div className="small muted" style={{ padding: 10 }}>当前没有设备连接。</div>}
      {devices.map((d) => (
        <div className="lib-row" key={d.id}>
          <span className="lib-kind">💻</span>
          <div className="grow">
            <div>{d.name}{d.id === selfId && <span className="badge" style={{ marginLeft: 6, background: 'var(--accent-soft)', color: 'var(--accent)' }}>本机</span>}</div>
            <div className="small muted">连接于 {whenText(d.since)}</div>
          </div>
          {d.id !== selfId && <button className="btn small danger" onClick={() => void remove(d)}>删除这台设备</button>}
        </div>
      ))}
    </Modal>
  )
}
