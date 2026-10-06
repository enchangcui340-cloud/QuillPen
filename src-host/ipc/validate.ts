/** 所有来自界面的参数都在这里校验，避免非法输入进入数据层。 */
export function str(v: unknown, field: string, max = 500): string {
  if (typeof v !== 'string') throw new Error(field + ' 必须是文本')
  if (v.length > max) throw new Error(field + ' 过长')
  return v
}

export function optStr(v: unknown, field: string, max = 500): string | null {
  if (v === null || v === undefined) return null
  return str(v, field, max)
}

export function id(v: unknown, field = 'id'): string {
  const s = str(v, field, 64)
  if (!/^[a-z]+_[0-9a-z]{10,}$/.test(s)) throw new Error(field + ' 不合法')
  return s
}

export function idList(v: unknown, field = 'ids'): string[] {
  if (!Array.isArray(v)) throw new Error(field + ' 必须是数组')
  return v.map((x) => id(x, field))
}

export function bool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new Error(field + ' 必须是布尔值')
  return v
}

export function num(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(field + ' 必须是数字')
  return v
}
