type Handler = (payload: unknown) => void

/** 极简事件总线：主进程内部通知界面刷新（data-changed）。 */
class Bus {
  private handlers = new Map<string, Set<Handler>>()

  on(event: string, h: Handler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(h)
    return () => this.handlers.get(event)?.delete(h)
  }

  emit(event: string, payload: unknown = null): void {
    for (const h of this.handlers.get(event) ?? []) {
      try { h(payload) } catch { /* 单个订阅者出错不影响其他订阅者 */ }
    }
  }
}

export const bus = new Bus()
export const EV = { dataChanged: 'data-changed' } as const
