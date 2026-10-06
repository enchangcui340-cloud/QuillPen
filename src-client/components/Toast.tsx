import { useEffect, useState } from 'react'

export interface ToastItem { id: number; text: string; kind: 'info' | 'error' | 'success' }

let listeners: ((items: ToastItem[]) => void)[] = []
let items: ToastItem[] = []
let seq = 1

function publish(): void {
  for (const l of listeners) l([...items])
}

export function toast(text: string, kind: ToastItem['kind'] = 'info'): void {
  const id = seq++
  items = [...items, { id, text, kind }]
  publish()
  setTimeout(() => {
    items = items.filter((i) => i.id !== id)
    publish()
  }, kind === 'error' ? 7000 : 3000)
}

export function ToastHost(): React.ReactElement {
  const [list, setList] = useState<ToastItem[]>([])
  useEffect(() => {
    listeners.push(setList)
    return () => { listeners = listeners.filter((l) => l !== setList) }
  }, [])
  return (
    <div className="toast-wrap">
      {list.map((t) => (
        <div key={t.id} className={'toast ' + (t.kind === 'error' ? 'error' : t.kind === 'success' ? 'success' : '')}>{t.text}</div>
      ))}
    </div>
  )
}
