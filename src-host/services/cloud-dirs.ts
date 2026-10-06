import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { Client } from 'ssh2'
import { encodeCloudKey, encodeShortCloudKey, materializePrivateKey, parseProvisionResult, type CloudKeyPayload } from '../core/cloud-key'
import { log } from '../core/logger'
import { ensureDir, scanFiles } from './cloud'

/**
 * 云服务器地址：**不写死在源码里**（开源时不该暴露管理员的服务器）。
 *
 * 取值顺序：环境变量 DSH_QUILL_CLOUD_HOST → 空字符串。
 * 实际连接用的地址来自 **key 本身**（老格式 QC1 的 h 字段）或插件配置注入的环境变量
 * （短格式 QS2 不含地址，靠 config.cloudHost 注入）。留空也完全不影响用 key 连接。
 */
export const CLOUD_HOST = typeof process.env.DSH_QUILL_CLOUD_HOST === 'string' ? process.env.DSH_QUILL_CLOUD_HOST : ''
export const CLOUD_PORT = Number(process.env.DSH_QUILL_CLOUD_PORT ?? 22) || 22
/** 每个云目录的容量上限（与服务器配额一致） */
export const CLOUD_QUOTA_BYTES = 1536 * 1024 * 1024

/** 设备标识：一台设备一个 id，存在本机 */
export function deviceId(dataDir: string): string {
  const f = join(dataDir, 'cloud', 'device.json')
  try {
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, 'utf8')) as { id?: string; name?: string }
      if (j.id) return j.id
    }
  } catch { /* 重建 */ }
  const id = randomBytes(6).toString('hex')
  ensureDir(join(dataDir, 'cloud'))
  writeFileSync(f, JSON.stringify({ id, name: hostname() }, null, 2), 'utf8')
  return id
}

export function deviceName(dataDir: string): string {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, 'cloud', 'device.json'), 'utf8')) as { name?: string }
    return j.name || hostname()
  } catch {
    return hostname()
  }
}

export function setDeviceName(dataDir: string, name: string): void {
  const f = join(dataDir, 'cloud', 'device.json')
  const id = deviceId(dataDir)
  writeFileSync(f, JSON.stringify({ id, name: (name || '').trim() || hostname() }, null, 2), 'utf8')
}

/** 一次 SSH/SFTP 连接 */
export interface CloudConn { client: Client; sftp: import('ssh2').SFTPWrapper; close: () => void }

export function connectCloud(payload: CloudKeyPayload): Promise<CloudConn> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    const fail = (e: Error): void => { try { client.end() } catch { /* 忽略 */ } reject(e) }
    client.on('ready', () => {
      client.sftp((err, sftp) => {
        if (err) return fail(new Error('打开 SFTP 失败：' + err.message))
        resolve({ client, sftp, close: () => { try { client.end() } catch { /* 忽略 */ } } })
      })
    })
    client.on('error', (e) => fail(new Error(humanizeCloudError(e))))
    try {
      client.connect({
        host: payload.h,
        port: payload.p || 22,
        username: payload.u,
        // 短格式 key（QS2）里存的是 32 字节种子，认证前重建成 OpenSSH 私钥；
        // 老格式（QC1）本身就是 PEM，原样使用。
        privateKey: materializePrivateKey(payload),
        readyTimeout: 20000
      })
    } catch (e) {
      // 私钥/种子有问题时 ssh2 是**同步抛出**的（不走 'error' 事件），单独接一次给友好文案
      fail(new Error(humanizeCloudError(e as Error)))
    }
  })
}

/**
 * 把 SSH 的原始报错翻译成用户看得懂的话（用户版/开发版共用）。
 */
export function humanizeCloudError(e: Error | { message?: string; code?: string }): string {
  const raw = String((e as Error)?.message ?? e ?? '')
  const code = String((e as { code?: string })?.code ?? '')
  if (/Cannot parse privateKey|Unsupported key format|Malformed OpenSSH|bad base64|error:1E08010C/i.test(raw)) {
    return 'key 无效：请把管理员给你的 key 完整复制粘贴（不要有空格或换行）'
  }
  if (/All configured authentication methods failed|authentication failure|Permission denied/i.test(raw)) {
    return 'key 无效，或这个云目录已经不存在了 —— 请向管理员确认，或索取新的 key'
  }
  if (/ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|Timed out|timeout/i.test(raw) || /ETIMEDOUT|ECONNREFUSED/.test(code)) {
    return '连不上云服务器 —— 请检查网络后重试'
  }
  if (/ENOSPC|No space left|quota/i.test(raw)) {
    return '云空间已满 —— 请先清理云端内容'
  }
  return '连接失败：' + raw
}

const p = (rel: string): string => (rel ? rel.replace(/^\/+/, '') : '.')

export function sftpWrite(conn: CloudConn, rel: string, content: Buffer | string): Promise<void> {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  return new Promise((resolve, reject) => {
    conn.sftp.writeFile(p(rel), data, (e) => (e ? reject(new Error('写入失败：' + e.message)) : resolve()))
  })
}

export function sftpRead(conn: CloudConn, rel: string): Promise<string | null> {
  return new Promise((resolve) => {
    conn.sftp.readFile(p(rel), (e, buf) => resolve(e || !buf ? null : buf.toString('utf8')))
  })
}

export function sftpMkdirp(conn: CloudConn, rel: string): Promise<void> {
  const parts = p(rel).split('/').filter(Boolean)
  let cur = ''
  const step = (i: number): Promise<void> => {
    if (i >= parts.length) return Promise.resolve()
    cur += (cur ? '/' : '') + parts[i]
    return new Promise<void>((r) => conn.sftp.mkdir(cur, () => r())).then(() => step(i + 1))
  }
  return step(0)
}

export function sftpUnlink(conn: CloudConn, rel: string): Promise<void> {
  return new Promise((resolve) => conn.sftp.unlink(p(rel), () => resolve()))
}

export function sftpList(conn: CloudConn, rel: string): Promise<string[]> {
  return new Promise((resolve) => {
    conn.sftp.readdir(p(rel), (e, list) => resolve(e || !list ? [] : list.map((f) => f.filename)))
  })
}

export function sftpPutFile(conn: CloudConn, localAbs: string, rel: string): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.sftp.fastPut(localAbs, p(rel), { concurrency: 4 }, (e) => (e ? reject(new Error('上传失败：' + e.message)) : resolve()))
  })
}

export function sftpGetFile(conn: CloudConn, rel: string, localAbs: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ensureDir(join(localAbs, '..'))
    conn.sftp.fastGet(p(rel), localAbs, { concurrency: 4 }, (e) => (e ? reject(new Error('下载失败：' + e.message)) : resolve()))
  })
}

// ---------- 设备（一台设备一个文件，天然没有并发冲突） ----------

export interface DeviceInfo { id: string; name: string; since: string }

/** 登记本机"已连接"（连接成功时调用） */
export async function deviceJoin(conn: CloudConn, dataDir: string, cloudId: string): Promise<DeviceInfo> {
  const id = deviceId(dataDir)
  const name = deviceName(dataDir)
  const info: DeviceInfo = { id, name, since: new Date().toISOString() }
  await sftpMkdirp(conn, '.quill/devices')
  await sftpWrite(conn, '.quill/devices/' + id + '.json', JSON.stringify(info, null, 2))
  // 有设备在用 -> 清掉空置标记（倒计时归零）
  await sftpUnlink(conn, '.quill/state.json')
  log('已登记设备 ' + name + '（' + cloudId + '）')
  return info
}

/** 注销本机（断开/切换时调用）；返回是否已成为"最后一个设备" */
export async function deviceLeave(conn: CloudConn, dataDir: string, cloudId: string): Promise<{ wasLast: boolean; others: DeviceInfo[] }> {
  const id = deviceId(dataDir)
  const before = await listDevices(conn)
  const others = before.filter((d) => d.id !== id)
  await sftpUnlink(conn, '.quill/devices/' + id + '.json')
  const wasLast = others.length === 0
  if (wasLast) {
    // 没有设备了 -> 开始 12 天倒计时
    await sftpWrite(conn, '.quill/state.json', JSON.stringify({ emptySince: new Date().toISOString() }))
  }
  log((wasLast ? '最后一个设备已断开，开始 12 天倒计时：' : '设备已断开：') + cloudId)
  return { wasLast, others }
}

export async function listDevices(conn: CloudConn): Promise<DeviceInfo[]> {
  const names = await sftpList(conn, '.quill/devices')
  const out: DeviceInfo[] = []
  for (const f of names) {
    if (!f.endsWith('.json')) continue
    const txt = await sftpRead(conn, '.quill/devices/' + f)
    if (!txt) continue
    try { out.push(JSON.parse(txt) as DeviceInfo) } catch { /* 忽略坏文件 */ }
  }
  return out.sort((a, b) => a.since.localeCompare(b.since))
}

export async function removeDevice(conn: CloudConn, id: string): Promise<void> {
  await sftpUnlink(conn, '.quill/devices/' + id + '.json')
}

// ---------- 时间码 ----------

export interface CloudStamp { version: number; updatedAt: string; updatedBy: string; files: number; bytes: number }

export async function readStamp(conn: CloudConn): Promise<CloudStamp | null> {
  const txt = await sftpRead(conn, '.quill/stamp.json')
  if (!txt) return null
  try { return JSON.parse(txt) as CloudStamp } catch { return null }
}

export async function writeStamp(conn: CloudConn, dataDir: string, files: number, bytes: number): Promise<CloudStamp> {
  const prev = await readStamp(conn)
  const stamp: CloudStamp = {
    version: (prev?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: deviceName(dataDir),
    files,
    bytes
  }
  await sftpWrite(conn, '.quill/stamp.json', JSON.stringify(stamp, null, 2))
  return stamp
}

/** 云端空置状态（用于显示"还剩几天"） */
export async function readEmptyState(conn: CloudConn): Promise<{ emptySince: string | null }> {
  const txt = await sftpRead(conn, '.quill/state.json')
  if (!txt) return { emptySince: null }
  try {
    const j = JSON.parse(txt) as { emptySince?: string }
    return { emptySince: j.emptySince ?? null }
  } catch { return { emptySince: null } }
}

/** 云端用量（用于容量进度条） */
export function localCloudUsage(dir: string): { files: number; bytes: number } {
  const map = scanFiles(dir)
  const files = Object.keys(map).length
  const bytes = Object.values(map).reduce((n, f) => n + f.size, 0)
  return { files, bytes }
}

// ---------- 创建云目录 ----------

/** 内容指纹（给"本机是否有未上传修改"用） */
export function dirFingerprint(dir: string): string {
  const map = scanFiles(dir)
  const h = createHash('sha1')
  for (const k of Object.keys(map).sort()) h.update(k + ':' + map[k].size + ';')
  return h.digest('hex').slice(0, 16)
}

/** 删除本机云目录副本 */
export function dropLocalCopy(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** 目录是否为空 */
export function isEmptyDir(dir: string): boolean {
  try {
    return !existsSync(dir) || readdirSync(dir).length === 0
  } catch {
    return true
  }
}

void mkdirSync
void statSync
