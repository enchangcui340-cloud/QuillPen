import { useEffect, useState } from 'react'
import Modal from './Modal'
import { toast } from './Toast'

interface Target { id: string; name: string; kind: string; isActive: boolean }

/**
 * 把笔记 / 笔记夹复制到另一个数据目录。
 * 只复制，源库的内容保持不动。
 */
export default function CopyToDialog({ fromRel, title, onClose, onDone }: {
  fromRel: string
  title: string
  onClose: () => void
  onDone: () => void
}): React.ReactElement {
  const [items, setItems] = useState<Target[]>([])
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.libraryTargets().then((r) => {
      const others = r.items.filter((i) => !i.isActive)
      setItems(others)
      setTarget(others[0]?.id ?? '')
    }).catch((e: Error) => toast(e.message, 'error'))
  }, [])

  const copy = async (): Promise<void> => {
    if (!target) { toast('请选择目标数据目录', 'error'); return }
    setBusy(true)
    try {
      const r = await window.api.libraryCopy(fromRel, target)
      toast(
        '已复制 ' + r.copied + ' 个文件到「' + r.target + '」' +
        (r.targetKind === 'cloud' ? '（云端库：需切过去点「上传」才会同步到服务器）' : ''),
        'success'
      )
      onDone()
    } catch (e) {
      toast('复制失败：' + (e as Error).message, 'error')
    } finally { setBusy(false) }
  }

  return (
    <Modal
      title={'复制「' + title + '」到另一个数据目录'}
      width={580}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy || !target} onClick={() => void copy()}>{busy ? '复制中…' : '开始复制'}</button>
        </>
      }
    >
      {items.length === 0 && <div className="small muted" style={{ padding: 10 }}>还没有其它数据目录。可以在右上角或设置里新建一个。</div>}
      {items.map((t) => (
        <div
          key={t.id}
          className={'lib-row' + (target === t.id ? ' active' : '')}
          style={{ cursor: 'pointer' }}
          onClick={() => setTarget(t.id)}
        >
          <span className="lib-kind">{t.kind === 'cloud' ? '☁' : '●'}</span>
          <div className="grow">
            <div>{t.name}</div>
            <div className="small muted">{t.kind === 'cloud' ? '云端数据目录（复制后需手动上传）' : '本机数据目录'}</div>
          </div>
          {target === t.id && <span className="badge">已选</span>}
        </div>
      ))}
      <div className="small muted" style={{ marginTop: 10, lineHeight: 1.7 }}>
        · <b>只复制，不移动</b>：源数据目录里的内容保持不动<br />
        · 笔记引用的图片附件会一起带过去<br />
        · 目标目录已有同名文件时会自动加（2）（3）<br />
        · 如果目标是云数据目录，复制进去后需要手动点「上传」才会同步到云端
      </div>
    </Modal>
  )
}
