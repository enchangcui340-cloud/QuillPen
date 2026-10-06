import { useState } from 'react'
import LibraryFinder from './LibraryFinder'
import LibraryManager from './LibraryManager'
import type { AppConfig } from '@shared/types'
import Modal from './Modal'

export default function SettingsModal({ config, onClose, onApply }: {
  config: AppConfig
  onClose: () => void
  onApply: (patch: Partial<AppConfig>) => Promise<void>
}): React.ReactElement {
  const [libraryPath, setLibraryPath] = useState(config.libraryPath)
  const [showFinder, setShowFinder] = useState(false)
  const [theme, setTheme] = useState(config.theme ?? 'light')
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      // DSH 版：模型 ID / 接口地址属于「随笔记（AI）」，界面不再提供
      await onApply({ libraryPath, theme })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="设置"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>保存</button>
        </>
      }
    >
      <div>
        <div className="small muted" style={{ marginBottom: 4 }}>数据目录（笔记库就在其中的 notes 文件夹）</div>
        <input className="input" value={libraryPath} onChange={(e) => setLibraryPath(e.target.value)} />
        <div className="small muted" style={{ marginTop: 4 }}>可以直接填你自己的文件夹路径。点「保存」后会立即切换并重新加载界面。</div>
        <div className="row" style={{ marginTop: 6, gap: 6, alignItems: 'center' }}>
          <button className="btn small" onClick={() => setShowFinder(true)}>找不到笔记？自动检测…</button>
          <span className="small muted">扫描文档/桌面等位置，列出有笔记的库</span>
        </div>
      </div>
      <div>
        <div className="small muted" style={{ marginBottom: 4 }}>界面主题</div>
        <select className="select" value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
          <option value="system">跟随系统</option>
        </select>
      </div>
      <div className="small muted">
        数据都在本地文件里：任务与回收站是 JSON，笔记是 Markdown，白板是 JSON。备份时复制整个数据目录即可。
      </div>
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <LibraryManager />
      </div>
      {showFinder && <LibraryFinder onClose={() => setShowFinder(false)} />}
    </Modal>
  )
}
