import { randomUUID, createHash } from 'node:crypto'

export function newId(prefix: string): string {
  return prefix + '_' + randomUUID().replace(/-/g, '').slice(0, 20)
}

export function shortHash(input: string | Buffer, len = 12): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len)
}

/** 任务与笔记共享的稳定标识空间足够大，这里只做格式校验。 */
export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z]+_[0-9a-f]{20}$/.test(id)
}
