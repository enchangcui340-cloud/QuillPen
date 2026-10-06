/**
 * 界面图标：统一用等宽 SVG，避免 emoji 在不同系统上缺字形（显示成方块）。
 */

/** 展开/收起指示：收起时一条横线，展开时向下的小于号；两者宽度完全一致。 */
export function ToggleIcon({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg className="tree-toggle" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {open
        ? <path d="M3 5.5 L7 9.5 L11 5.5" fill="none" stroke="currentColor" strokeWidth="1.6"
            strokeLinecap="round" strokeLinejoin="round" />
        : <path d="M3 7.5 L11 7.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  )
}

/** 笔记夹 */
export function FolderIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.8 4.4c0-.6.5-1.1 1.1-1.1h3l1.3 1.5h6.9c.6 0 1.1.5 1.1 1.1v5.7c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1z"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
      />
    </svg>
  )
}

/** 文本笔记 */
export function NoteIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 1.9h5.2L12.6 5v9.1c0 .5-.4.9-.9.9H4.3c-.5 0-.9-.4-.9-.9V2.8c0-.5.4-.9.9-.9z"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9.1 2v3.1h3.2M5.6 8h4.8M5.6 10.6h4.8" fill="none" stroke="currentColor"
        strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

/** 白板 */
export function BoardIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.2" y="2.6" width="11.6" height="10.8" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.2 6.4h11.6M6.2 6.4v7" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

/** 标签（todolist 分类） */
export function TagIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M7.2 2.1H13a.9.9 0 0 1 .9.9v5.8a1 1 0 0 1-.3.7l-4.8 4.8a.9.9 0 0 1-1.3 0L2.1 8.5a.9.9 0 0 1 0-1.3l4.4-4.8a1 1 0 0 1 .7-.3z"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="10.4" cy="5.6" r="1.15" fill="currentColor" />
    </svg>
  )
}

/* ---------------- 左侧图标栏：统一 24 网格 / 1.7 描边 / 圆角端点 ---------------- */

const RAIL_SVG = {
  width: 19, height: 19, viewBox: '0 0 24 24',
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const
}

/** Todolist：带勾选的清单 */
export function RailTodoIcon(): React.ReactElement {
  return (
    <svg {...RAIL_SVG} aria-hidden="true">
      <rect x="3.6" y="3.6" width="16.8" height="16.8" rx="4" />
      <path d="M8.2 12.3l2.6 2.6L15.9 9.8" />
    </svg>
  )
}

/** 笔记库：带文本行的页面 */
export function RailNotesIcon(): React.ReactElement {
  return (
    <svg {...RAIL_SVG} aria-hidden="true">
      <rect x="4.6" y="3.4" width="14.8" height="17.2" rx="2.6" />
      <path d="M8.4 8.4h7.2M8.4 12h7.2M8.4 15.6h4.6" />
    </svg>
  )
}

/** 随笔记：羽毛笔 */
export function RailAiIcon(): React.ReactElement {
  return (
    <svg {...RAIL_SVG} aria-hidden="true">
      <path d="M20.1 12.1a6.1 6.1 0 0 0-8.6-8.6L5.2 10.4V18.8h8.4z" />
      <path d="M15.9 8.2L3.2 20.9" />
      <path d="M17.4 15H9.1" />
    </svg>
  )
}

/** 回收站 */
export function RailTrashIcon(): React.ReactElement {
  return (
    <svg {...RAIL_SVG} aria-hidden="true">
      <path d="M3.9 6.9h16.2" />
      <path d="M9.4 6.9V5.3c0-.7.5-1.2 1.2-1.2h2.8c.7 0 1.2.5 1.2 1.2v1.6" />
      <path d="M6.4 6.9l.9 12c.1.8.7 1.4 1.5 1.4h6.4c.8 0 1.4-.6 1.5-1.4l.9-12" />
      <path d="M10.4 10.8v5.6M13.6 10.8v5.6" />
    </svg>
  )
}

/** 设置：齿轮 */
export function RailSettingsIcon(): React.ReactElement {
  return (
    <svg {...RAIL_SVG} aria-hidden="true">
      <circle cx="12" cy="12" r="5.2" />
      <circle cx="12" cy="12" r="2.2" />
      <path d="M16.5 9.4l1.9-1.1M12 6.8V4.6M7.5 9.4L5.6 8.3M7.5 14.6l-1.9 1.1M12 17.2v2.2M16.5 14.6l1.9 1.1" />
    </svg>
  )
}

/* ---------------- 行内小操作图标：同一套线条，光学大小一致 ---------------- */

const ACTION_SVG = {
  viewBox: '0 0 16 16',
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.9,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const
}

/** 新建（加号） */
export function PlusIcon({ size = 14 }: { size?: number }): React.ReactElement {
  return (
    <svg {...ACTION_SVG} width={size} height={size} aria-hidden="true">
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </svg>
  )
}

/** 重命名（铅笔） */
export function PencilIcon({ size = 14 }: { size?: number }): React.ReactElement {
  return (
    <svg {...ACTION_SVG} width={size} height={size} aria-hidden="true">
      <path d="M11.4 2.6l2 2-8.1 8.1-2.5.5.5-2.5z" />
      <path d="M10.2 3.8l2 2" />
    </svg>
  )
}

/** 删除（叉号） */
export function CloseIcon({ size = 14 }: { size?: number }): React.ReactElement {
  return (
    <svg {...ACTION_SVG} width={size} height={size} aria-hidden="true">
      <path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" />
    </svg>
  )
}

/* ---------- 云数据目录 / 数据目录切换器用到的图标 ---------- */
/* 统一规范：14×14 或 16×16 viewBox、细描边、currentColor，与上面保持一致 */

/** 云数据目录 */
export function CloudIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.6 11.8h6.9c1.5 0 2.6-1 2.6-2.3 0-1.2-.9-2.2-2.1-2.3-.3-1.9-1.9-3.3-3.8-3.3-1.7 0-3.2 1.1-3.7 2.7-1.4.1-2.4 1.2-2.4 2.6 0 1.4 1.1 2.6 2.5 2.6z"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}

/** 本机数据目录 */
export function LibraryIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.4 3.6c0-.6.5-1.1 1.1-1.1h9c.6 0 1.1.5 1.1 1.1v8.8c0 .6-.5 1.1-1.1 1.1h-9c-.6 0-1.1-.5-1.1-1.1z"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5.2 2.5v11M7.6 6h3.4M7.6 8.6h3.4" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

/** 已连接（当前使用中）的小圆点 */
export function DotIcon({ filled = false }: { filled?: boolean }): React.ReactElement {
  return (
    <svg className="tree-svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3.1" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/** 上传 */
export function UploadIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 11.4V3.6M4.8 6.6 8 3.4l3.2 3.2" fill="none" stroke="currentColor" strokeWidth="1.3"
        strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.4 12.6h9.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** 下载 */
export function DownloadIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.4v7.8M4.8 8.2 8 11.4l3.2-3.2" fill="none" stroke="currentColor" strokeWidth="1.3"
        strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.4 12.6h9.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** 复制 */
export function CopyIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.6" y="5.6" width="7.2" height="7.6" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.4 5.6V4.1c0-.6-.5-1.1-1.1-1.1H4.5c-.6 0-1.1.5-1.1 1.1v6c0 .6.5 1.1 1.1 1.1h1.1"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}

/** 存为本机库（磁盘） */
export function SaveIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.6 4.2c0-.6.5-1.1 1.1-1.1h6.7l3 3v6.7c0 .6-.5 1.1-1.1 1.1H3.7c-.6 0-1.1-.5-1.1-1.1z"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5.4 3.1v3.4h4.4V3.1M5.4 13.2V9.6h5.2v3.6" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  )
}

/** 设备 */
export function DeviceIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.4" y="3.4" width="11.2" height="7.4" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 13h4M8 10.8V13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/** 断开连接 */
export function UnlinkIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.4 9.6 9.6 6.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M7.2 4.2 8.4 3a2.7 2.7 0 0 1 3.8 3.8l-1.2 1.2M8.8 11.8 7.6 13a2.7 2.7 0 0 1-3.8-3.8l1.2-1.2"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 恢复到下载前（回退） */
export function RevertIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 7.6a4.9 4.9 0 1 1 1.5 3.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M3 4.2v3.6h3.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 展开/收起（小箭头，用于云同步栏） */
export function ChevronIcon({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg className="tree-svg" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      {open
        ? <path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        : <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  )
}

/** 警示（无设备连接时的提醒） */
export function WarnIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.6 14.2 13H1.8z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 6.6v3.1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="11.4" r="0.7" fill="currentColor" />
    </svg>
  )
}

/* ---------- 随笔记（聊天界面）用到的图标 ---------- */

/** 发送 */
export function SendIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.2 8 13.8 2.6 11.4 13.8 8.2 9.4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8.2 9.4 13.8 2.6" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

/** 停止（方块） */
export function StopIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.4" fill="currentColor" />
    </svg>
  )
}

/** 模型选择器 */
export function ModelIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.9 13.6 5v6L8 14.1 2.4 11V5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 8 13.4 5M8 8v6M8 8 2.6 5" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  )
}

/** 模式（档位） */
export function ModeIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.6 12.4 6 7.2M6.6 12.4 10 4.4M10.6 12.4 13.4 8.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** 权限（盾牌） */
export function ShieldIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.9 13 4v4.2c0 3-2.1 5.3-5 6-2.9-.7-5-3-5-6V4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5.9 8.1 7.3 9.5l2.9-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 新会话 */
export function NewChatIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.4 8.6c0 2.9-2.4 5.2-5.4 5.2-1 0-1.9-.2-2.6-.6L2.6 14l.8-2.7A5 5 0 0 1 2.6 8.6c0-2.9 2.4-5.2 5.4-5.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M12.4 1.9v4.2M10.3 4h4.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** 会话历史 */
export function HistoryIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M2.3 2.6v3.4h3.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 5.2V8l2.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 附件（回形针） */
export function AttachIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M11.6 7.2 7.3 11.5a2.6 2.6 0 0 1-3.7-3.7l4.9-4.9a1.9 1.9 0 0 1 2.7 2.7l-4.8 4.8a1 1 0 0 1-1.4-1.4l4.2-4.2"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 重试 */
export function RetryIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.5-3.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M13.2 1.9v3.4h-3.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** token 计量 */
export function TokenIcon(): React.ReactElement {
  return (
    <svg className="tree-svg" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.8v6.4M6.2 6.4h3.6M6.2 9.6h3.6" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}
