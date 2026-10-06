export type Priority = 'important' | 'minor' | 'optional'
export const PRIORITY_LABEL: Record<Priority, string> = { important: '重要', minor: '次要', optional: '可选' }
export const PRIORITY_ORDER: Priority[] = ['important', 'minor', 'optional']

export type HighlightColor = 'yellow' | 'green' | 'pink'

export interface Task {
  id: string
  name: string
  tagIds: string[]
  priority: Priority
  ddl: string | null
  ddlInferred: boolean
  done: boolean
  doneAt: string | null
  noteId: string | null
  origin: 'manual' | 'ai'
  createdAt: string
  updatedAt: string
}

export interface Tag {
  id: string
  name: string
  parentId: string | null
  createdAt: string
}

export type NoteKind = 'md' | 'whiteboard'

export interface Note {
  id: string
  kind: NoteKind
  fileName: string
  dir: string
  title: string
  createdAt: string
  updatedAt: string
  fileMtimeMs: number
  trashed: boolean
  originPath: string | null
  aiTouched: boolean
}

export interface TrashNote {
  id: string
  kind: NoteKind
  fileName: string
  originalDir: string
  title: string
  deletedAt: string
  createdAt: string
  attachments: string[]
  originPath: string | null
}

export interface TrashTask {
  task: Task
  deletedAt: string
}

export interface WhiteboardNode {
  id: string
  type: 'text' | 'image' | 'note' | 'link'
  x: number
  y: number
  w: number
  h: number
  color?: string
  text?: string
  fontSize?: number
  bold?: boolean
  src?: string
  noteId?: string
  url?: string
}

/** 卡片四边之一，连线可以指定从哪条边出发/进入 */
export type WhiteboardSide = 'top' | 'right' | 'bottom' | 'left'

export interface WhiteboardEdge {
  id: string
  from: string
  to: string
  /** 起点卡片的连接边；旧文件没有时按几何位置自动推断 */
  fromSide?: WhiteboardSide
  /** 终点卡片的连接边 */
  toSide?: WhiteboardSide
  /** 线上的文字。它属于这条线，线被删除时文字一并消失 */
  label?: string
}

/** 绘制工具能画的 8 种图形 */
export type ShapeKind =
  | 'rect' | 'ellipse' | 'triangle' | 'diamond'   // 几何图形（用 x/y/w/h）
  | 'line' | 'arrow' | 'curve' | 'free'           // 线类（用 points）

/** 图形上的一个点（世界坐标） */
export interface ShapePt {
  x: number
  y: number
}

/**
 * 白板上"画"出来的图形。
 *
 * 与卡片（WhiteboardNode）的分工：
 *   · 卡片：有内容的方块（文字/图片/笔记/链接），可编辑、可连线；
 *   · 图形：纯装饰/标注（框、圈、箭头、手绘线），不装内容。
 *
 * 颜色存的是**色板键**（default/pink/blue/green/yellow/purple），
 * 深浅主题各有一套 CSS 变量，切换主题时纯靠 CSS 换色，数据不动。
 */
export interface WhiteboardShape {
  id: string
  kind: ShapeKind
  /** 色板键（也接受 hex 或中文色名，读取时规整） */
  color: string
  /** 几何图形：左上角与尺寸 */
  x?: number
  y?: number
  w?: number
  h?: number
  /**
   * 线类：控制点，至少 2 个，含首尾。
   *   · line / arrow：恰好 2 个
   *   · curve：2 个以上（中间的点由用户点击插入）
   *   · free：按采样间隔记录的一串点
   */
  points?: ShapePt[]
}

export interface WhiteboardFile {
  id: string
  type: 'whiteboard'
  version: 1
  title: string
  nodes: WhiteboardNode[]
  edges: WhiteboardEdge[]
  /**
   * 绘制的图形。**可选**：旧白板文件没有这个字段，读取时一律当 `[]` 处理。
   * 注意：读取白板的几处代码是"重建对象"写法，必须显式带上这个字段，
   * 否则一读一存就把用户画的图形抹掉了（见 services/notes.ts 与 services/library.ts）。
   */
  shapes?: WhiteboardShape[]
}

export interface WhiteboardFile {
  id: string
  type: 'whiteboard'
  version: 1
  title: string
  nodes: WhiteboardNode[]
  edges: WhiteboardEdge[]
}

export type ThemeMode = 'light' | 'dark' | 'system'

export interface AppConfig {
  /** 独立安装是否已经默认采用过自己文件夹里的"工作区"（只自动设一次） */
  portableLibrarySet?: boolean
  libraryPath: string
  model: string
  baseUrl: string
  showNetworkNotice: boolean
  lastArea: 'todo' | 'notes' | 'ai'
  theme: ThemeMode
}

export interface HistoryEntry {
  id: string
  when: string
  kind: 'task-purge'
  summary: string
}

export type TreeNode = {
  type: 'folder' | 'note'
  name: string
  path: string
  id?: string
  kind?: NoteKind
  children?: TreeNode[]
}
