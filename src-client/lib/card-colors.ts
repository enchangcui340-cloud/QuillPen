/**
 * 白板卡片配色板（6 色 × 深浅两套）。
 *
 * 为什么单独一个模块：颜色现在有**主题差异**（深色下要用深底 + 亮字，浅色下用浅底 + 深字），
 * 而卡片颜色又被这些东西引用：白板渲染、右键菜单、白板工具层（AI 通过 board_edit 写色）、
 * 使用手册。集中在这里定义，才不会各写一份、各错一套。
 *
 * 存储兼容：白板文件里 `node.color` 仍然是**一个十六进制值**（取"浅色主题"那一版的底色），
 * 这样老文件、老工具、AI 直接写 hex 全都照旧能读能存；渲染时再由 CSS 按当前主题决定实际颜色。
 * 也就是说：**数据格式零改动，主题切换纯靠 CSS**。
 */

export type CardColorKey = 'default' | 'yellow' | 'green' | 'blue' | 'pink' | 'purple'

export interface CardColorEntry {
  key: CardColorKey
  /** 菜单里显示的中文名 */
  label: string
  /** 浅色主题下的底色（同时作为**存盘值**） */
  light: string
  /** 深色主题下的底色 */
  dark: string
}

/** 菜单顺序按用户指定：原色 / 粉色 / 蓝色 / 绿色 / 黄色 / 紫色 */
export const CARD_PALETTE: CardColorEntry[] = [
  { key: 'default', label: '原色', light: '#ffffff', dark: '#2a2d31' },
  { key: 'pink', label: '粉色', light: '#fbd9e6', dark: '#4a2434' },
  { key: 'blue', label: '蓝色', light: '#cfe1fb', dark: '#1f3350' },
  { key: 'green', label: '绿色', light: '#cdeccf', dark: '#1f3d2a' },
  { key: 'yellow', label: '黄色', light: '#fdf3b8', dark: '#4a4020' },
  { key: 'purple', label: '紫色', light: '#e3d9fb', dark: '#372b52' }
]

/** 兼容旧引用：原本是 4 个浅色 hex 的数组 */
export const CARD_COLORS = CARD_PALETTE.map((c) => c.light)

/** 旧文件里出现过的历史取值（老四色）→ 新色板 */
const LEGACY: Record<string, CardColorKey> = {
  '#ffffff': 'default',
  '#fff': 'default',
  '#fdf3b8': 'yellow',
  '#cdeccf': 'green',
  '#cfe1fb': 'blue'
}

/** 中文 / 英文色名 → 色板键（给 AI 写白板时用，人也能看懂） */
const ALIASES: Record<string, CardColorKey> = {
  原色: 'default',
  默认: 'default',
  白: 'default',
  白色: 'default',
  default: 'default',
  粉: 'pink',
  粉色: 'pink',
  pink: 'pink',
  蓝: 'blue',
  蓝色: 'blue',
  blue: 'blue',
  绿: 'green',
  绿色: 'green',
  green: 'green',
  黄: 'yellow',
  黄色: 'yellow',
  yellow: 'yellow',
  紫: 'purple',
  紫色: 'purple',
  purple: 'purple'
}

/**
 * 把一个 `color` 值解析成色板键。
 * @returns 色板键；**未知的自定义颜色返回 null**（渲染时按原样使用该颜色，不参与主题切换）
 */
export function resolveCardColorKey(color?: string): CardColorKey | null {
  if (color === undefined || color === null || color === '') return 'default'
  const raw = String(color).trim()
  if (raw === '') return 'default'
  if ((ALIASES as Record<string, CardColorKey>)[raw] !== undefined) return ALIASES[raw]
  const lower = raw.toLowerCase()
  if ((ALIASES as Record<string, CardColorKey>)[lower] !== undefined) return ALIASES[lower]
  // 色板自带的 hex（浅色或深色那版都认）
  for (const entry of CARD_PALETTE) {
    if (entry.light.toLowerCase() === lower || entry.dark.toLowerCase() === lower) return entry.key
  }
  // 历史取值
  if (LEGACY[lower] !== undefined) return LEGACY[lower]
  return null
}

/** 色板键 → 存盘用的 hex（浅色版）。未知键给原色。 */
export function cardColorHex(key: CardColorKey): string {
  return (CARD_PALETTE.find((c) => c.key === key) ?? CARD_PALETTE[0]).light
}

/** 把 AI / 用户给的任意色值规整成"存盘值"：色名 → hex；未知 hex 原样保留。 */
export function normalizeCardColor(color?: string): string {
  const key = resolveCardColorKey(color)
  return key === null ? String(color) : cardColorHex(key)
}

/** 菜单项用的展示信息 */
export function cardColorEntry(key: CardColorKey): CardColorEntry {
  return CARD_PALETTE.find((c) => c.key === key) ?? CARD_PALETTE[0]
}
