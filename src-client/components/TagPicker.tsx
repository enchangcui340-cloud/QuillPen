import { useEffect, useMemo, useRef, useState } from 'react'

export interface TagOption { id: string; name: string; parentId: string | null }

/**
 * 标签选择器：从已有标签里挑，而不是手打。
 * AI 建议了不存在的标签会标出来，让你确认是不是真的要新建。
 */
export default function TagPicker({ value, onChange, placeholder }: {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}): React.ReactElement {
  const [options, setOptions] = useState<TagOption[]>([])
  const [open, setOpen] = useState(false)
  const [keyword, setKeyword] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.api.tagList().then((tags) => {
      setOptions(tags.map((t) => ({ id: t.id, name: t.name, parentId: t.parentId ?? null })))
    }).catch(() => setOptions([]))
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) { setOpen(false); setKeyword('') }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  /** 拼出层级名字：父 / 子 */
  const fullName = useMemo(() => {
    const byId = new Map(options.map((o) => [o.id, o]))
    return (o: TagOption): string => {
      const parent = o.parentId ? byId.get(o.parentId) : undefined
      return parent ? parent.name + ' / ' + o.name : o.name
    }
  }, [options])

  const available = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    return options
      .map((o) => ({ o, name: fullName(o) }))
      .filter((x) => !value.includes(x.o.name))
      .filter((x) => !k || x.name.toLowerCase().includes(k))
      .slice(0, 40)
  }, [options, value, keyword, fullName])

  const existingNames = useMemo(() => new Set(options.map((o) => o.name)), [options])
  const add = (name: string): void => {
    const n = name.trim()
    if (!n || value.includes(n)) return
    onChange([...value, n])
    setKeyword('')
  }
  const remove = (name: string): void => onChange(value.filter((x) => x !== name))

  return (
    <div className="tag-picker grow" ref={boxRef}>
      <div className="tag-picker-box" onClick={() => setOpen(true)}>
        {value.map((t) => (
          <span key={t} className={'tag-chip' + (existingNames.has(t) ? '' : ' new')} title={existingNames.has(t) ? t : '这个标签还不存在，保存任务时会新建'}>
            {t}
            {!existingNames.has(t) && <span className="tag-chip-new">新建</span>}
            <span className="tag-chip-x" onClick={(e) => { e.stopPropagation(); remove(t) }}>×</span>
          </span>
        ))}
        <input
          className="tag-picker-input"
          value={keyword}
          placeholder={value.length ? '' : (placeholder ?? '选择或输入标签')}
          onChange={(e) => { setKeyword(e.target.value); setOpen(true) }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && keyword.trim()) { e.preventDefault(); add(keyword) }
            if (e.key === 'Backspace' && !keyword && value.length) remove(value[value.length - 1])
            if (e.key === 'Escape') { setOpen(false); setKeyword('') }
          }}
        />
      </div>

      {open && (
        <div className="tag-picker-menu">
          {available.map(({ o, name }) => (
            <div key={o.id} className="tag-picker-item" onClick={() => { add(o.name); }}>
              <span className="grow nowrap">{name}</span>
              <span className="small muted">已有</span>
            </div>
          ))}
          {keyword.trim() && !existingNames.has(keyword.trim()) && (
            <div className="tag-picker-item" onClick={() => add(keyword)}>
              <span className="grow nowrap">新建标签「{keyword.trim()}」</span>
            </div>
          )}
          {!available.length && !keyword.trim() && (
            <div className="tag-picker-empty small muted">还没有任何标签，直接输入即可新建</div>
          )}
        </div>
      )}
    </div>
  )
}
