import type { WhiteboardFile, WhiteboardNode } from '@shared/types'
import type { NoteService } from './notes'

/** 白板保存前做引用校验：图片路径必须在库内，笔记引用必须存在。 */
export class BoardService {
  constructor(private notes: NoteService) {}

  read(id: string): WhiteboardFile {
    return this.notes.readBoard(id)
  }

  save(id: string, board: WhiteboardFile, baseMtimeMs: number): { ok: true; fileMtimeMs: number } | { ok: false; conflict: true } {
    const nodes = board.nodes.map((n) => this.sanitizeNode(n))
    return this.notes.saveBoard(id, { ...board, nodes }, baseMtimeMs)
  }

  private sanitizeNode(node: WhiteboardNode): WhiteboardNode {
    const out: WhiteboardNode = { ...node }
    if (out.type === 'image' && out.src) {
      const abs = this.notes.attachmentAbs(out.src)
      if (!abs) out.src = ''
    }
    if (out.type === 'note' && out.noteId && !this.notes.get(out.noteId)) {
      out.noteId = ''
    }
    return out
  }

  /** 白板引用的目标是否仍然存在（界面用于显示“目标不存在”）。 */
  refStatus(board: WhiteboardFile): Record<string, boolean> {
    const out: Record<string, boolean> = {}
    for (const n of board.nodes) {
      if (n.type === 'note' && n.noteId) out[n.id] = !!this.notes.get(n.noteId)
    }
    return out
  }
}
