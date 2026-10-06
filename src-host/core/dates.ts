/** 本地时间处理。所有 ddl 以 ISO 字符串保存，按用户本地时区解析。 */

export const DDL_PRECISION = 'minute'

function pad(n: number): string { return n < 10 ? '0' + n : String(n) }

/** 由本地时间分量生成不带时区偏移的 ISO 串：YYYY-MM-DDTHH:mm:00 */
export function toLocalIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`
}

export function localIsoToDate(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(iso)
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? '0'))
  }
  return new Date(iso)
}

export function nowIso(): string {
  return toLocalIso(new Date())
}

/** 解析用户/AI 给出的日期时间文本，返回本地 ISO（精确到分钟）或 null。 */
export function parseDdlInput(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(s)
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}T${pad(+m[4])}:${m[5]}:00`
  m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s)
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}T23:59:00`
  const d = new Date(s)
  if (!Number.isNaN(d.getTime())) return toLocalIso(d)
  return null
}

export function isOverdue(ddlIso: string | null, now: Date = new Date()): boolean {
  if (!ddlIso) return false
  return localIsoToDate(ddlIso).getTime() < now.getTime()
}

export function formatDdl(ddlIso: string | null): string {
  if (!ddlIso) return '无'
  const d = localIsoToDate(ddlIso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 用于历史记录与回收站的紧凑时间戳：YYYY-MM-DD HH:mm */
export function compactNow(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function daysAgo(iso: string, days: number, now: Date = new Date()): boolean {
  const t = localIsoToDate(iso).getTime()
  return now.getTime() - t >= days * 24 * 60 * 60 * 1000
}
