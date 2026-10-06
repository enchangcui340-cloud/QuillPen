import { applyThemeAttribute, requestPanelReload } from './lib/host-adapt'
import { useCallback, useEffect, useState } from 'react'
import type { AppConfig } from '@shared/types'
import TaskArea from './areas/TaskArea'
import NotesArea from './areas/NotesArea'
import SettingsModal from './components/SettingsModal'
import TrashModal from './components/TrashModal'
import { ToastHost, toast } from './components/Toast'
import { AskHost } from './components/AskDialog'
import { RailNotesIcon, RailSettingsIcon, RailTodoIcon, RailTrashIcon } from './components/Icons'
import appMark from './assets/app-mark.png'
import LibrarySwitcher from './components/LibrarySwitcher'
import CloudBar from './components/CloudBar'

/** DSH 版：去掉「随笔记（AI）」区域 */
type Area = 'todo' | 'notes'

const AREA_TITLE: Record<Area, string> = { todo: 'Todolist', notes: '笔记库' }

export default function App(props: {
  /** DSH 版新增：宿主左侧大栏是否已收起（由插件入口传入） */
  sidebarCollapsed?: boolean
  /** DSH 版新增：切换宿主左侧大栏的显示/隐藏 */
  onToggleSidebar?: () => void
} = {}): React.ReactElement {
  const [area, setArea] = useState<Area>('todo')
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [ready, setReady] = useState(false)
  const [fatal, setFatal] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showTrash, setShowTrash] = useState(false)
  const [cloudLibId, setCloudLibId] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [stats, setStats] = useState({ tasks: 0, notes: 0, trashTasks: 0, trashNotes: 0 })
  /** 待打开的笔记（例如从待办点进来），交给笔记库区域处理 */
  const [pendingNoteId, setPendingNoteId] = useState<string | null>(null)

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const cfg = await window.api.configGet()
        if (cancelled) return
        setConfig(cfg)
        setArea(cfg.lastArea === 'notes' ? 'notes' : 'todo')
        setReady(true)
        const info = await window.api.libraryStats()
        if (!cancelled) setStats(info)
        // 当前用的是不是云端数据目录？是的话显示同步条
        const libs = await window.api.librariesList()
        const cur = libs.items.find((i) => i.id === libs.activeId)
        if (!cancelled) setCloudLibId(cur?.kind === 'cloud' ? cur.id : null)
      } catch (e) {
        if (!cancelled) setFatal((e as Error).message)
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!ready) return
    void window.api.libraryStats().then(setStats).catch(() => undefined)
  }, [ready, refreshToken])

  // 从其它区域请求打开某篇笔记：切到笔记库并让笔记库打开它
  useEffect(() => {
    const handler = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ id?: string }>).detail
      if (!detail?.id) return
      setArea('notes')
      setPendingNoteId(detail.id)
    }
    window.addEventListener('open-note', handler)
    return () => window.removeEventListener('open-note', handler)
  }, [])

  // 应用主题（浅色/深色/跟随系统）
  useEffect(() => {
    if (!config) return
    const apply = (): void => {
      const dark = config.theme === 'dark'
        || (config.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      // DSH 版：主题写在插件自己的根容器上，不动宿主的 documentElement
      applyThemeAttribute(dark)
    }
    apply()
    if (config.theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [config])

  const changeArea = useCallback((next: Area) => {
    setArea(next)
    void window.api.configSet({ lastArea: next }).catch(() => undefined)
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const applyConfig = useCallback(async (patch: Partial<AppConfig>) => {
    try {
      // 换数据目录必须真正切库（只写配置的话界面还在读旧库，看起来就是"笔记不见了"）
      if (patch.libraryPath && patch.libraryPath.trim() && patch.libraryPath !== (config?.libraryPath ?? '')) {
        await window.api.librarySwitch(patch.libraryPath.trim())
        toast('已切换笔记库，正在重新加载…', 'success')
        // DSH 版：不刷新整个页面（那会把宿主一起刷掉），改为请求面板重挂载
        window.setTimeout(() => requestPanelReload(), 400)
        return
      }
      const next = await window.api.configSet(patch)
      setConfig(next)
      toast('设置已保存', 'success')
      refresh()
    } catch (e) {
      toast('保存设置失败：' + (e as Error).message, 'error')
    }
  }, [refresh, config?.libraryPath])

  if (fatal) {
    return (
      <div className="app">
        <div className="empty" style={{ margin: 'auto' }}>
          <div className="big">⚠</div>
          <div>应用启动失败：{fatal}</div>
          <div className="small muted" style={{ marginTop: 8 }}>请检查数据目录是否可写，然后重新打开软件。</div>
        </div>
      </div>
    )
  }

  if (!ready || !config) {
    return <div className="empty" style={{ marginTop: 120 }}>正在加载…</div>
  }

  return (
    <div className="app">
      {/* 左侧图标栏：只放最必要的入口，把宽度让给内容 */}
      <aside className="rail">
        <img className="rail-logo" src={appMark} alt="Quill" title="Quill" />
        <button className={'rail-btn' + (area === 'todo' ? ' active' : '')} title="Todolist" onClick={() => changeArea('todo')}>
          <span className="rail-icon"><RailTodoIcon /></span>
        </button>
        <button className={'rail-btn' + (area === 'notes' ? ' active' : '')} title="笔记库" onClick={() => changeArea('notes')}>
          <span className="rail-icon"><RailNotesIcon /></span>
        </button>
        <div className="spacer" />
        <button className="rail-btn" title="回收站" onClick={() => setShowTrash(true)}>
          <span className="rail-icon"><RailTrashIcon /></span>
        </button>
        <button className="rail-btn" title="设置" onClick={() => setShowSettings(true)}>
          <span className="rail-icon"><RailSettingsIcon /></span>
        </button>
      </aside>

      <main className="main">
        <div className="appbar">
          <h1>{AREA_TITLE[area]}</h1>
          <div className="spacer" />
          <LibrarySwitcher onManage={() => setShowSettings(true)} />
          {/* DSH 版新增：一键隐藏/显示宿主左侧大栏（Windows 桌面端收起后整列为 0 宽） */}
          {props.onToggleSidebar && (
            <button
              className="btn ghost small"
              title={(props.sidebarCollapsed ? '显示侧边栏' : '隐藏侧边栏') + '（Ctrl+B）'}
              onClick={props.onToggleSidebar}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <path d="M9 4v16" />
              </svg>
              {props.sidebarCollapsed ? '显示侧边栏' : '隐藏侧边栏'}
            </button>
          )}
        </div>
        {cloudLibId && <CloudBar libraryId={cloudLibId} />}
        {area === 'todo' && <TaskArea refreshToken={refreshToken} onChanged={refresh} />}
        {area === 'notes' && (
          <NotesArea
            refreshToken={refreshToken}
            onChanged={refresh}
            openNoteId={pendingNoteId}
            onOpenedNote={() => setPendingNoteId(null)}
          />
        )}
      </main>

      {showSettings && (
        <SettingsModal config={config} onClose={() => setShowSettings(false)} onApply={applyConfig} />
      )}
      {showTrash && <TrashModal onClose={() => setShowTrash(false)} onChanged={refresh} />}
      <ToastHost />
      {/* 应用内输入/确认框：DSH 页面里 window.prompt 不可用，confirm 样式也不统一 */}
      <AskHost />
    </div>
  )
}
