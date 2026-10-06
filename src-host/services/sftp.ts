import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs'
import { dirname, posix } from 'node:path'
import { Client, type SFTPWrapper } from 'ssh2'
import type { FileMap } from '../core/sync-plan'
import { ensureDir } from './cloud'

/** 云端连接参数 */
export interface CloudTarget {
  host: string
  port: number
  user: string
  privateKey: string
  /** chroot 内的相对目录，如 main */
  remoteDir: string
  /** 服务器主机密钥指纹（校验用，防止连到假服务器） */
  hostKeyFingerprint?: string
}

export interface TransferProgress {
  (done: number, total: number, current: string): void
}

/** 一次 SFTP 会话的封装 */
export class SftpClient {
  private conn: Client
  private sftp!: SFTPWrapper
  private remoteRoot = ''
  private constructor(conn: Client) { this.conn = conn }

  static connect(target: CloudTarget, onFingerprint?: (fp: string) => boolean): Promise<SftpClient> {
    return new Promise((resolve, reject) => {
      const conn = new Client()
      const client = new SftpClient(conn)
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) { conn.end(); reject(err); return }
          client.sftp = sftp
          client.remoteRoot = target.remoteDir.replace(/^\/+|\/+$/g, '')
          resolve(client)
        })
      })
      conn.on('error', (e) => reject(e))
      const opts: Record<string, unknown> = {
        host: target.host,
        port: target.port,
        username: target.user,
        privateKey: target.privateKey,
        readyTimeout: 20000
      }
      if (target.hostKeyFingerprint && onFingerprint) {
        opts.hostVerifier = (key: Buffer) => onFingerprint(key.toString('hex'))
      }
      conn.connect(opts)
    })
  }

  close(): void { try { this.conn.end() } catch { /* 忽略 */ } }

  private p(rel: string): string { return posix.join(this.remoteRoot, rel).replace(/\\\\/g, '/') }

  mkdirp(rel: string): Promise<void> {
    // SFTP 没有 mkdir -p，逐级创建
    const parts = this.p(rel).split('/').filter(Boolean)
    let cur = ''
    const step = (i: number): Promise<void> => {
      if (i >= parts.length) return Promise.resolve()
      cur += '/' + parts[i]
      return new Promise<void>((resolve) => {
        this.sftp.mkdir(cur, () => resolve())   // 已存在会报错，忽略即可
      }).then(() => step(i + 1))
    }
    return step(0)
  }

  writeFile(rel: string, content: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.writeFile(this.p(rel), content, (e) => (e ? reject(e) : resolve()))
    })
  }

  readFile(rel: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.sftp.readFile(this.p(rel), (e, buf) => (e ? reject(e) : resolve(buf)))
    })
  }

  /** 上传本地文件（带进度） */
  fastPut(localAbs: string, rel: string, onBytes?: (n: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.fastPut(localAbs, this.p(rel), { concurrency: 4, chunkSize: 32768, step: (t) => onBytes?.(t) }, (e) => (e ? reject(e) : resolve()))
    })
  }

  /** 下载到本地文件 */
  fastGet(rel: string, localAbs: string, onBytes?: (n: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      ensureDir(dirname(localAbs))
      this.sftp.fastGet(this.p(rel), localAbs, { concurrency: 4, chunkSize: 32768, step: (t) => onBytes?.(t) }, (e) => (e ? reject(e) : resolve()))
    })
  }

  unlink(rel: string): Promise<void> {
    return new Promise((resolve) => this.sftp.unlink(this.p(rel), () => resolve()))
  }

  /** 删除一个目录（递归） */
  rmrf(rel: string): Promise<void> {
    const target = this.p(rel)
    return this.listTree(target)
      .then((files) => Promise.all(files.map((f) => new Promise<void>((r) => this.sftp.unlink(f, () => r())))))
      .then(() => new Promise<void>((r) => this.sftp.rmdir(target, () => r())))
      .catch(() => undefined)
  }

  private listTree(dir: string): Promise<string[]> {
    return new Promise((resolve) => {
      this.sftp.readdir(dir, (e, list) => {
        if (e || !list) { resolve([]); return }
        const out: string[] = []
        const jobs = list.map((f) => new Promise<void>((r) => {
          const full = posix.join(dir, f.filename)
          if (f.attrs.isDirectory()) {
            this.listTree(full).then((sub) => { out.push(...sub); r() })
          } else { out.push(full); r() }
        }))
        Promise.all(jobs).then(() => resolve(out))
      })
    })
  }

  rename(fromRel: string, toRel: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.rename(this.p(fromRel), this.p(toRel), (e) => (e ? reject(e) : resolve()))
    })
  }

  exists(rel: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.sftp.stat(this.p(rel), (e) => resolve(!e))
    })
  }

  /** 云端文件清单 */
  listFiles(rel: string, prefix = ''): Promise<FileMap> {
    return new Promise((resolve) => {
      this.sftp.readdir(this.p(rel), (e, list) => {
        if (e || !list) { resolve({}); return }
        const map: FileMap = {}
        const jobs = list.map((f) => new Promise<void>((r) => {
          const childRel = prefix ? prefix + '/' + f.filename : f.filename
          const full = rel ? rel + '/' + f.filename : f.filename
          if (f.attrs.isDirectory()) {
            this.listFiles(full, childRel).then((sub) => { Object.assign(map, sub); r() })
          } else {
            map[childRel] = { path: childRel, size: f.attrs.size, mtimeMs: f.attrs.mtime * 1000 }
            r()
          }
        }))
        Promise.all(jobs).then(() => resolve(map))
      })
    })
  }
}

export function readLocalStats(abs: string): { size: number; mtimeMs: number } {
  const st = statSync(abs)
  return { size: st.size, mtimeMs: st.mtimeMs }
}

void createReadStream
void createWriteStream
void mkdirSync
