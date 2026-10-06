/**
 * DSH 客户端插件入口（这个文件被 esbuild 打成 lib/client.js 的 classic script）。
 *
 * 三件事：
 *   1. 把桥（bridge.ts）挂到 `globalThis.__quillApi` —— 构建时 `window.api` 被 define 成它，
 *      于是 Quill 那 6000 行渲染代码一行都不用改；
 *   2. 注册两个 slot：`main`(key=quill) 面板本体、`sidebar.panellist`(id=quill) 侧边栏入口；
 *   3. 面板内提供「隐藏/显示 DSH 左栏」按钮 —— 用宿主自己的 ctx.layout.toggleSidebar()。
 */
import React from 'react'
import App from './App'
import api from './bridge'
import quillCss from './styles.generated'
import { QUILL_ROOT_ID } from './lib/host-adapt'

// ① 挂桥：构建时 window.api 会被替换成 globalThis.__quillApi
;(globalThis as { __quillApi?: unknown }).__quillApi = api

/** DSH 的客户端 ctx（只用到 slots / layout） */
interface ClientCtx {
  slots: {
    inject(key: string, callback: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  layout: { toggleSidebar(): void }
}

/** 侧边栏大栏是否已收起：ui-layout 收起时在帧元素上留这个属性 */
const COLLAPSED_ATTRIBUTE = 'data-sidebar-collapsed'
function sidebarCollapsed(): boolean {
  return document.querySelector(`[${COLLAPSED_ATTRIBUTE}]`) !== null
}

/** 面板本体：根容器 + 注入样式 + Quill 应用 + DSH 左栏开关 */
export function QuillPanel(): React.ReactElement {
  const [collapsed, setCollapsed] = React.useState(sidebarCollapsed)
  const [generation, setGeneration] = React.useState(0)
  const [fatal, setFatal] = React.useState<string | null>(null)

  React.useEffect(() => {
    // 面板重挂载请求（原 Quill 用 location.reload()，在 DSH 里不能刷整页）
    const reload = (): void => setGeneration((n) => n + 1)
    window.addEventListener('quill:reload', reload)
    // 跟随宿主自己的收起状态（用户按 Ctrl+B 或用侧边栏按钮切换时也要同步文案）
    const timer = window.setInterval(() => {
      setCollapsed((prev) => {
        const next = sidebarCollapsed()
        return next === prev ? prev : next
      })
    }, 400)
    return () => {
      window.removeEventListener('quill:reload', reload)
      window.clearInterval(timer)
    }
  }, [])

  const toggleSidebar = (): void => {
    const layout = (globalThis as { __quillLayout__?: { toggleSidebar?: () => void } }).__quillLayout__
    layout?.toggleSidebar?.()
    setCollapsed(sidebarCollapsed())
  }

  return React.createElement(
    'div',
    { id: QUILL_ROOT_ID, className: 'dsh-quill-user-root', 'data-theme': 'light' },
    // 样式随组件生命周期存在，卸载即回收（DSH 也按 data-plugin 认领/清理插件样式）
    React.createElement('style', { 'data-plugin': 'dsh-quill', 'data-plugin-css': 'dsh-quill/styles', dangerouslySetInnerHTML: { __html: quillCss } }),
    fatal === null
      ? React.createElement(
          QuillErrorBoundary,
          { key: generation, onError: (message: string) => setFatal(message) },
          React.createElement(App, { sidebarCollapsed: collapsed, onToggleSidebar: toggleSidebar }),
        )
      : React.createElement('div', { className: 'empty', style: { marginTop: 80 } }, '面板渲染出错：' + fatal),
  )
}

/** 极简错误边界：任何渲染异常都要在面板里看得见，而不是把宿主整页搞白 */
class QuillErrorBoundary extends React.Component<{ onError: (m: string) => void; children: React.ReactNode }, { failed: boolean }> {
  constructor(props: { onError: (m: string) => void; children: React.ReactNode }) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(error: Error): void {
    this.props.onError(error.message)
  }
  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/** 侧边栏入口图标 */
function QuillPanelIcon(props: { size?: number }): React.ReactElement {
  const size = typeof props.size === 'number' ? props.size : 18
  return React.createElement(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
    React.createElement('path', { d: 'M6 3h9l5 5v13H6z' }),
    React.createElement('path', { d: 'M15 3v5h5' }),
    React.createElement('path', { d: 'M9 13h6' }),
    React.createElement('path', { d: 'M9 17h6' }),
  )
}

/** 依赖的客户端服务：插槽注册 + 布局动作 */
export const inject = ['slots', 'layout']

/**
 * 面板 key / 侧边栏入口 id。
 *
 * 刻意用既有的 `notes`（原先那个空白占位页用的就是它）：
 * 用户要的是"就在这个笔记插件里"，所以 Quill 直接顶掉占位页 ——
 * 侧边栏仍然只有一个「笔记」入口，点进去就是完整应用。
 */
const PANEL_ID = 'notes-user'

export function apply(ctx: ClientCtx): void {
  ;(globalThis as { __quillLayout__?: unknown }).__quillLayout__ = ctx.layout
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, QuillPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: '笔记' }, QuillPanelIcon))
}
