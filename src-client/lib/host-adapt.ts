/**
 * 与 DSH 宿主页面打交道的少数几处适配。
 *
 * Quill 原本是一个独立窗口：主题写在 `<html data-theme>` 上、切库直接 `location.reload()`。
 * 搬进 DSH 面板后，这两件事都必须改：文档根属于宿主（不能碰），整页刷新会连 DSH 一起刷掉。
 */

/** 插件根容器 id：所有 Quill 样式都作用域在它下面 */
export const QUILL_ROOT_ID = 'dsh-quill-user-root'

/** 把主题写到插件自己的根容器上（而不是宿主的 documentElement） */
export function applyThemeAttribute(dark: boolean): void {
  const el = document.getElementById(QUILL_ROOT_ID)
  if (el !== null) el.dataset.theme = dark ? 'dark' : 'light'
}

/** 请求插件整体重挂载（等价于原来"切库后重载界面"，但不刷新 DSH 页面） */
export function requestPanelReload(): void {
  window.dispatchEvent(new CustomEvent('quill:reload'))
}

/** 判断宿主（DSH 桌面端）是否提供了真实文件路径能力 */
export function hostPathBridgeAvailable(): boolean {
  const bridge = (globalThis as { __DSH_HOST_PATHS__?: { pathFor?: unknown } }).__DSH_HOST_PATHS__
  return typeof bridge?.pathFor === 'function'
}
