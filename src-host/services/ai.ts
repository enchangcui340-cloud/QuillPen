/**
 * AI 服务桩（DSH 版）。
 *
 * 原 Quill 的「随笔记」依赖一个内嵌的 DeepSeek Harness 引擎 + 一套 28 个语义工具。
 * 本次移植**不含 AI**：这里提供同名类与同名方法，让 `index.ts` 原样编译、原样注册通道，
 * 但任何一次真正的调用都会抛出可读的错误（界面上也不存在 AI 区域，正常不会触发）。
 *
 * 这样做的好处：`index.ts` 那 1500 行完全不用为了"去掉 AI"而做外科手术，
 * 以后想接回 AI（例如直接调 DSH 自己的会话）时，只需替换这一个文件。
 */

export interface IncomingAttachment {
  name: string
  kind: 'image' | 'text' | 'pdf'
}

const REMOVED = '随笔记（AI）功能未移植到 DSH 版，请使用 DSH 自己的会话'

export class AiService {
  constructor(..._args: unknown[]) {}

  // ---- 装配类（bootstrap 会调用，必须存在且安静）----
  attachBoards(..._args: unknown[]): void {}
  attachEngineInfo(..._args: unknown[]): void {}
  attachRulesReader(..._args: unknown[]): void {}
  attachDangerNotifier(..._args: unknown[]): void {}

  // ---- 界面会调用的接口：一律抛错，避免"静默什么都不做"----
  status(): never { throw new Error(REMOVED) }
  setKey(): never { throw new Error(REMOVED) }
  clearKey(): never { throw new Error(REMOVED) }
  list(): never { throw new Error(REMOVED) }
  pendingList(): never { throw new Error(REMOVED) }
  send(): never { throw new Error(REMOVED) }
  confirm(): never { throw new Error(REMOVED) }
  cancel(): never { throw new Error(REMOVED) }
  stop(): never { throw new Error(REMOVED) }
  undo(): never { throw new Error(REMOVED) }
  steps(): never { throw new Error(REMOVED) }
  answerDanger(): never { throw new Error(REMOVED) }
  engineStatus(): never { throw new Error(REMOVED) }
  setEngineMode(): never { throw new Error(REMOVED) }
  abort(): never { throw new Error(REMOVED) }
}
