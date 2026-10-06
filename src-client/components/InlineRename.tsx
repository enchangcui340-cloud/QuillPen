import { useEffect, useRef, useState } from 'react'
import { toast } from './Toast'

/**
 * 行内改名输入框（笔记树与 tag 树共用）。
 *
 * 关于焦点：确认过"输入法候选框浮在屏幕左上角、回车不上屏"就是
 * **输入框没有真正拿到焦点**时的表现。元素刚插入 DOM 时立刻 focus，
 * 很容易被随后的渲染/其它焦点请求抢走，所以这里：
 *   1. 等一帧（布局完成）再聚焦；
 *   2. 之后若发现焦点不在自己身上，短时间内重试几次；
 *   3. 把每次尝试写进控制台（会进入应用日志），方便定位。
 */
export default function InlineRename({ value, onCommit, onCancel }: {
  value: string
  onCommit: (v: string) => void
  onCancel: () => void
}): React.ReactElement {
  const [text, setText] = useState(value)
  const committed = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  /**
   * 把输入框挪进可视区。
   * 这一步很关键：输入框如果在滚动容器外，输入法算不出光标位置，
   * 候选框会飘到屏幕左上角、拼音上不了屏，回车提交的还是原名（看起来就是"改不了名"）。
   */
  const ensureVisible = (input: HTMLInputElement): void => {
    const scroller = input.closest('.tree-scroll, .tag-tree-scroll') as HTMLElement | null
    if (scroller) {
      const ir = input.getBoundingClientRect()
      const sr = scroller.getBoundingClientRect()
      // jsdom 里这些尺寸都是 0，加个判断避免测试里乱滚
      if (sr.height > 0 && ir.height > 0) {
        if (ir.top < sr.top) scroller.scrollTop -= (sr.top - ir.top) + 8
        else if (ir.bottom > sr.bottom) scroller.scrollTop += (ir.bottom - sr.bottom) + 8
      }
    }
    try { input.scrollIntoView({ block: 'nearest' }) } catch { /* 忽略 */ }
  }

  useEffect(() => {
    const timers: number[] = []
    let tries = 0
    const attempt = (): void => {
      const input = inputRef.current
      if (!input) return
      if (document.activeElement === input) {
        console.log('[rename] 输入框已获得焦点（第 ' + (tries + 1) + ' 次尝试）')
        return
      }
      tries++
      // 先确保可见，再聚焦：顺序很重要
      ensureVisible(input)
      // 三件事各自 try：任何一件失败都不能连累聚焦（比如某些环境没有 scrollIntoView）
      try { input.focus() } catch { /* 忽略 */ }
      try { input.select() } catch { /* 忽略 */ }
      console.log('[rename] 可见性检查：' + JSON.stringify(input.getBoundingClientRect()))
      const active = document.activeElement as HTMLElement | null
      console.log('[rename] 第 ' + tries + ' 次聚焦尝试，activeElement=' + (active ? active.tagName + '.' + active.className : 'null'))
      if (tries < 6) timers.push(window.setTimeout(attempt, 60))
      else if (document.activeElement !== input) {
        console.log('[rename] 放弃：多次尝试后焦点仍不在输入框上')
        // 让用户直接看到问题，不用去翻日志
        toast('改名框没能获得输入焦点，请再用鼠标点一下输入框', 'error')
      }
    }
    // 先立刻聚焦一次（此时元素已经完成布局，手感上就是"点完就能打字"），
    // 随后若焦点被别的渲染抢走，再补几次
    attempt()
    return () => { for (const t of timers) window.clearTimeout(t) }
  }, [])

  return (
    <input
      ref={inputRef}
      className="tree-rename"
      spellCheck={false}
      value={text}
      onChange={(e) => setText(e.target.value)}
      // 行上有"点击打开/选中"和"拖动"，这些事件不能冒泡，否则输入框会被抢走鼠标
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDragStart={(e) => e.preventDefault()}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => {
        const active = document.activeElement as HTMLElement | null
        console.log('[rename] 失焦，activeElement=' + (active ? active.tagName + '.' + active.className : 'null'))
        if (!committed.current) onCommit(text)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        /*
         * 中文输入法拼字时，回车 / 空格用来选候选字，不能当成"确认改名"，
         * 否则拼音还没上屏输入框就被关掉了。keyCode 229 是输入法处理中的老标记。
         */
        const composing = e.nativeEvent.isComposing ||
          (e.nativeEvent as unknown as { keyCode?: number }).keyCode === 229
        console.log('[rename] key=' + e.key + ' composing=' + composing + ' text=' + JSON.stringify(text))
        if (composing) return
        if (e.key === 'Enter') { committed.current = true; onCommit(text) }
        if (e.key === 'Escape') { committed.current = true; onCancel() }
      }}
    />
  )
}
