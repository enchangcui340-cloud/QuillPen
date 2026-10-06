/**
 * 跨数据目录复制笔记/笔记夹的纯逻辑。
 *
 * 只做"复制"：源库的内容不动（用户明确要求不给移动）。
 * 复制时要处理两件事：
 *   1) 目标库已有同名文件 -> 自动加（2）（3）
 *   2) 笔记引用的附件要一起带过去（同名冲突同样加序号）
 */
import { normalizeRel } from './sync-plan'

export interface CopyItem {
  /** 相对源库根的路径，如 notes/FTA/笔记.md */
  rel: string
  size: number
}

/** 参与复制的文件（笔记、白板、附件），不含索引与临时文件 */
export function isCopyable(rel: string): boolean {
  const p = normalizeRel(rel)
  if (!p || p.includes('/.tmp-') || p.endsWith('.tmp')) return false
  if (p.endsWith('.md') || p.endsWith('.canvas.json')) return true
  if (p.includes('_attachments/')) return true
  return false
}

/** 取相对 notes/ 之后的路径（目标库里要还原成同样的结构） */
export function toNotesRelative(rel: string): string {
  const p = normalizeRel(rel)
  return p.startsWith('notes/') ? p.slice('notes/'.length) : p
}

/**
 * 在目标库里找一个不冲突的名字。
 * 已有同名时依次尝试「名字（2）.md」「名字（3）.md」…
 */
export function uniquePath(rel: string, taken: (candidate: string) => boolean): string {
  if (!taken(rel)) return rel
  const slash = rel.lastIndexOf('/')
  const dir = slash >= 0 ? rel.slice(0, slash + 1) : ''
  const file = slash >= 0 ? rel.slice(slash + 1) : rel
  // 白板是 xxx.canvas.json，扩展名要整体保留
  const m = /^(.*?)(\.canvas\.json|\.md|\.[a-z0-9]+)$/i.exec(file)
  const base = m ? m[1] : file
  const ext = m ? m[2] : ''
  for (let i = 2; i < 1000; i++) {
    const candidate = dir + base + '（' + i + '）' + ext
    if (!taken(candidate)) return candidate
  }
  return dir + base + '（' + Date.now() + '）' + ext
}

/** 计算每个源文件在目标库里的落点（同一批文件内的重名也一起处理） */
export function planCopyPaths(items: CopyItem[], existing: (rel: string) => boolean): { from: string; to: string }[] {
  const used = new Set<string>()
  const out: { from: string; to: string }[] = []
  for (const it of items) {
    const want = 'notes/' + toNotesRelative(it.rel)
    const target = uniquePath(want, (c) => existing(c) || used.has(c))
    used.add(target)
    out.push({ from: it.rel, to: target })
  }
  return out
}

/** 从笔记内容里找出引用的附件相对路径 */
export function attachmentRefs(content: string): string[] {
  const out = new Set<string>()
  const re = /!\[[^\]]*\]\(([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    let ref = m[1].trim()
    if (ref.startsWith('<') && ref.endsWith('>')) ref = ref.slice(1, -1)
    if (/^https?:|^data:/i.test(ref)) continue
    try { ref = decodeURIComponent(ref) } catch { /* 原样 */ }
    const norm = normalizeRel(ref)
    if (norm.startsWith('_attachments/')) out.add(norm)
  }
  return [...out]
}
