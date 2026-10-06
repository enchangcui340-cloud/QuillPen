/**
 * 白板图形渲染测试入口（仅用于 tools/check-shape-render.mjs）。
 *
 * 直接把 Whiteboard 组件挂到容器里，并注入一块"带 8 种图形"的白板，
 * 这样能在 jsdom 中验证：图形是否真的画出来了、颜色/图层/选中态是否正确。
 */
import { createRoot, type Root } from 'react-dom/client'
import Whiteboard from '../src-client/components/Whiteboard'
import type { Note, WhiteboardFile, WhiteboardShape } from '@shared/types'

export function mountBoard(container: HTMLElement, board: WhiteboardFile): Root {
  const note: Note = {
    id: board.id,
    kind: 'whiteboard',
    fileName: board.title + '.canvas.json',
    dir: '',
    title: board.title,
    createdAt: '2026-01-01T00:00:00',
    updatedAt: '2026-01-01T00:00:00',
    trashed: false
  } as Note

  const root = createRoot(container)
  root.render(
    <Whiteboard
      note={note}
      board={board}
      noteTitles={{}}
      onSaved={() => undefined}
      onOpenNote={() => undefined}
    />
  )
  return root
}

/** 造一块含 8 种图形的白板，供测试断言 */
export function makeFixtureBoard(): WhiteboardFile {
  const shapes: WhiteboardShape[] = [
    { id: 's1', kind: 'rect', color: 'blue', x: 0, y: 0, w: 120, h: 80 },
    { id: 's2', kind: 'ellipse', color: 'pink', x: 200, y: 0, w: 100, h: 100 },
    { id: 's3', kind: 'triangle', color: 'green', x: 400, y: 0, w: 120, h: 90 },
    { id: 's4', kind: 'diamond', color: 'yellow', x: 600, y: 0, w: 120, h: 90 },
    { id: 's5', kind: 'line', color: 'purple', points: [{ x: 0, y: 200 }, { x: 300, y: 260 }] },
    { id: 's6', kind: 'arrow', color: 'default', points: [{ x: 0, y: 300 }, { x: 300, y: 360 }] },
    { id: 's7', kind: 'curve', color: 'blue', points: [{ x: 0, y: 400 }, { x: 150, y: 460 }, { x: 320, y: 410 }] },
    { id: 's8', kind: 'free', color: 'green', points: [{ x: 0, y: 600 }, { x: 40, y: 620 }, { x: 80, y: 590 }, { x: 120, y: 640 }] }
  ]
  return {
    id: 'board_fixture',
    type: 'whiteboard',
    version: 1,
    title: '图形渲染测试',
    nodes: [],
    edges: [],
    shapes
  }
}
