/**
 * 云同步的纯逻辑：文件清单与差异计算。
 *
 * 模型是「整体覆盖」，不做三路合并也不自动同步：
 *   上传 = 本地覆盖云端（含删除）
 *   下载 = 云端覆盖本地（含删除）
 * 所以差异只用来生成"要传哪些、要删哪些"，以及给用户看的确认信息。
 */

export interface FileEntry {
  /** 相对库根目录的路径（统一用 / 分隔） */
  path: string
  size: number
  /** 最后修改时间（毫秒） */
  mtimeMs: number
}

export type FileMap = Record<string, FileEntry>

/** 需要同步的内容。排除项写死在这里，避免 Key、AI 记录、备份被传上去。 */
export function shouldSync(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!p) return false
  if (p === 'secrets.json' || p.endsWith('/secrets.json')) return false
  if (p === 'quill-library.json') return true
  if (p.startsWith('data/ai/')) return false
  if (p.startsWith('data/backups/')) return false
  if (p.startsWith('data/cloud/')) return false
  if (p.startsWith('.trash/') || p.startsWith('.download-backup')) return false
  if (p.startsWith('logs/')) return false
  if (p.includes('/.tmp-')) return false
  if (p.endsWith('.tmp')) return false
  return true
}

/** 路径规范化：统一分隔符，便于两端比较 */
export function normalizeRel(p: string): string {
  return p.split(String.fromCharCode(92)).join('/').replace(/^\/+/, '')
}

export interface SyncDiff {
  /** 需要传过去的文件（新增或内容有变化） */
  upload: FileEntry[]
  /** 需要删掉的目标端文件（源端已经没有） */
  remove: string[]
  /** 两边都有的文件数 */
  sameCount: number
  totalBytes: number
}

/**
 * 计算"把 source 覆盖到 target"需要做什么。
 * direction 只影响措辞，逻辑一样：以 source 为准，target 多出来的删掉。
 */
export function diffForOverwrite(source: FileMap, target: FileMap): SyncDiff {
  const upload: FileEntry[] = []
  const remove: string[] = []
  let same = 0
  let bytes = 0

  for (const [path, s] of Object.entries(source)) {
    const t = target[path]
    if (!t) { upload.push(s); bytes += s.size; continue }
    // 大小不同或时间差超过 2 秒（文件系统的秒级精度）就算变了
    if (t.size !== s.size || Math.abs(t.mtimeMs - s.mtimeMs) > 2000) {
      upload.push(s)
      bytes += s.size
    } else {
      same++
    }
  }
  for (const path of Object.keys(target)) {
    if (!source[path]) remove.push(path)
  }

  upload.sort((a, b) => a.path.localeCompare(b.path))
  remove.sort()
  return { upload, remove, sameCount: same, totalBytes: bytes }
}

/** 给确认框用的一句话说明 */
export function describeDiff(kind: 'upload' | 'download', d: SyncDiff): string {
  const verb = kind === 'upload' ? '上传到云端' : '下载到本机'
  const parts: string[] = []
  if (d.upload.length) parts.push(verb + ' ' + d.upload.length + ' 个文件（' + formatBytes(d.totalBytes) + '）')
  if (d.remove.length) parts.push((kind === 'upload' ? '删除云端' : '删除本机') + ' ' + d.remove.length + ' 个文件')
  if (!parts.length) return '没有需要同步的变化'
  return '将' + parts.join('，并')
}

export function formatBytes(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}
