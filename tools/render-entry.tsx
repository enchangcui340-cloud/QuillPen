/**
 * 渲染测试入口（仅用于 tools/smoke-render.mjs）。
 * 把真实的面板组件挂到一个容器里，用于在 jsdom 中验证"面板能不能渲染出来"。
 */
import { createRoot, type Root } from 'react-dom/client'
import { QuillPanel } from '../src-client/dsh-entry'

export function mount(container: HTMLElement): Root {
  const root = createRoot(container)
  root.render(<QuillPanel />)
  return root
}
