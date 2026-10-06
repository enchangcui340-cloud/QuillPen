import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  label?: string
  onClick?: () => void
  danger?: boolean
  separator?: boolean
  shortcut?: string
  /** 子菜单（"栏中栏"）：给了它，这一项右侧出现箭头，悬停/点击展开 */
  children?: MenuItem[]
  /** 左侧色块（卡片颜色用）：传卡片色板键，具体颜色交给 CSS 按主题决定 */
  swatch?: string
  /** 该项是否已选中（色板里显示对勾用） */
  checked?: boolean
}

/** 把一串菜单项渲染成一个面板 */
function Panel({ items, width, style, onPick, openIndex, onHoverIndex, subRef }: {
  items: MenuItem[]
  width: number
  style: React.CSSProperties
  onPick: (it: MenuItem, index: number) => void
  openIndex: number
  onHoverIndex: (index: number, el: HTMLElement) => void
  subRef?: React.RefObject<HTMLDivElement>
}): React.ReactElement {
  return (
    <div className="ctx-menu" style={{ ...style, width }} ref={subRef} role="menu">
      {items.map((it, i) => it.separator
        ? <div key={'sep' + i} className="ctx-sep" />
        : (
          <button
            key={i}
            type="button"
            role="menuitem"
            // 用 data 属性把"菜单项序号（含分隔线）"钉在 DOM 上：
            // 子菜单定位要按这个序号找回真正的按钮 —— 不能靠 .ctx-item 的 DOM 次序（分隔线不占位，会错位）
            data-menu-index={i}
            className={'ctx-item'
              + (it.danger ? ' danger' : '')
              + (it.children !== undefined ? ' has-sub' : '')
              + (it.children !== undefined && openIndex === i ? ' open' : '')}
            // 有子菜单的项：悬停展开；点击也展开（触屏/精确点击都能用），不关闭整个菜单
            onMouseEnter={(e) => onHoverIndex(i, e.currentTarget as HTMLElement)}
            onClick={(e) => onPick(it, i)}
          >
            {it.swatch !== undefined && <span className="ctx-swatch" data-card-color={it.swatch} />}
            <span className="grow">{it.label}</span>
            {it.checked === true && <span className="ctx-check">✓</span>}
            {it.shortcut !== undefined && <span className="ctx-key">{it.shortcut}</span>}
            {it.children !== undefined && <span className="ctx-arrow">▸</span>}
          </button>
        ))}
    </div>
  )
}

/**
 * 通用右键菜单：超出窗口会自动调整位置。
 *
 * 支持**子菜单**（"栏中栏"）：
 *   · 悬停父项即展开；点击父项也能展开（触屏友好），且不会关掉整个菜单；
 *   · 右侧放不下就翻到左侧；纵向自动贴边，不会被窗口裁掉；
 *   · 父面板与子面板在同一个容器里 → 鼠标从父项移到子项不会被判成"点到了外面"；
 *   · 键盘：↑↓ 移动、→ 进子菜单、← 退出子菜单、Esc 关闭。
 */
export default function ContextMenu({ x, y, items, onClose }: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}): React.ReactElement {
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const [openIndex, setOpenIndex] = useState(-1)
  /** 子菜单的锚点（父项按钮的位置）。存 rect 而不是只存序号 —— 序号在"含分隔线"与"不含"两套体系里会错位 */
  const [anchor, setAnchor] = useState<{ right: number; left: number; top: number } | null>(null)
  const [subStyle, setSubStyle] = useState<React.CSSProperties>({})
  const [focusIndex, setFocusIndex] = useState(0)

  const width = 208
  const subWidth = 168
  const height = items.length * 30 + 12
  const left = Math.max(4, Math.min(x, window.innerWidth - width - 8))
  const top = Math.max(4, Math.min(y, window.innerHeight - height - 8))

  // 展开子菜单时按父项的实际位置摆放：优先右侧，放不下翻到左侧，纵向贴边
  useLayoutEffect(() => {
    if (openIndex < 0) return
    const parent = menuRef.current
    // 锚点优先用悬停/点击时抓到的真实按钮；键盘（→）走 data 属性查回来
    const el = anchor !== null
      ? null
      : parent?.querySelector<HTMLElement>(`[data-menu-index="${openIndex}"]`) ?? null
    const rect = anchor ?? el?.getBoundingClientRect() ?? null
    if (rect === null) return
    const childCount = (items[openIndex]?.children ?? []).length
    const h = childCount * 30 + 12
    const fitsRight = rect.right + 2 + subWidth <= window.innerWidth - 8
    setSubStyle({
      left: fitsRight ? rect.right + 2 : Math.max(4, rect.left - subWidth - 2),
      top: Math.max(4, Math.min(rect.top - 6, window.innerHeight - h - 8))
    })
  }, [openIndex, anchor, items])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    // 滚动/缩放时菜单会飘，直接关掉更稳
    const onScroll = (): void => onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  const hover = useCallback((index: number, el?: HTMLElement) => {
    setFocusIndex(index)
    const it = items[index]
    if (it?.children !== undefined) {
      if (el !== undefined) {
        const r = el.getBoundingClientRect()
        setAnchor({ left: r.left, right: r.right, top: r.top })
      }
      setOpenIndex(index)
    } else {
      setOpenIndex(-1)
    }
  }, [items])

  const pick = useCallback((it: MenuItem, index: number) => {
    if (it.children !== undefined) {
      // 父项：展开/收起子菜单，不关闭菜单本身
      setOpenIndex((cur) => (cur === index ? -1 : index))
      // 键盘路径没有鼠标坐标 → 用 data 属性查回来定位
      setAnchor(null)
      return
    }
    it.onClick?.()
    onClose()
  }, [onClose])

  const sub = openIndex >= 0 ? items[openIndex]?.children : undefined

  return (
    <div
      ref={wrapRef}
      tabIndex={-1}
      className="ctx-wrap"
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setFocusIndex((i) => Math.min(items.length - 1, i + 1))
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setFocusIndex((i) => Math.max(0, i - 1))
        } else if (e.key === 'ArrowRight') {
          const it = items[focusIndex]
          if (it?.children !== undefined) {
            e.preventDefault()
            setAnchor(null)          // 键盘路径没有鼠标坐标，交给 data 属性定位
            setOpenIndex(focusIndex)
          }
        } else if (e.key === 'ArrowLeft') {
          if (openIndex >= 0) { e.preventDefault(); setOpenIndex(-1) }
        } else if (e.key === 'Enter') {
          const it = items[focusIndex]
          if (it !== undefined) { e.preventDefault(); pick(it, focusIndex) }
        }
      }}
    >
      <div ref={menuRef}>
        <Panel
          items={items}
          width={width}
          style={{ left, top }}
          onPick={pick}
          openIndex={openIndex}
          onHoverIndex={hover}
        />
      </div>
      {/* 子菜单：位置算出来之前先不显示，避免"闪一下左上角"（fixed 没有 left/top 时会落到静态位置） */}
      {sub !== undefined && sub.length > 0 && subStyle.left !== undefined && (
        <Panel
          items={sub}
          width={subWidth}
          style={{ ...subStyle }}
          onPick={pick}
          openIndex={-1}
          onHoverIndex={() => undefined}
          subRef={subRef}
        />
      )}
    </div>
  )
}
