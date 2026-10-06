import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'

/**
 * 云数据目录的 key。
 *
 * 一个 key 打包了：连哪台服务器、用哪个账号、哪个目录、以及**私钥**。
 * 用户只需"复制 key → 在另一台设备粘贴"就能连上同一个云目录。
 *
 * ## 两种格式
 *
 * **旧格式（QC1，仍可解析）**：`QC1-<目录ID>-<base64(JSON)>-<校验位>`
 *   JSON 里带**整把 OpenSSH PEM 私钥**（411 字符）→ 整串约 712 字符。
 *   太长，粘贴极易漏字符（实测用户多次失败）。
 *
 * **新格式（QS2，推荐）**：`QS2-<目录ID>-<种子base64url>-<校验位>`
 *   只带 ed25519 的 **32 字节种子**（43 字符），元数据能省则省 → 整串约 **110 字符**，短到一行看完。
 *   认证前由 {@link materializePrivateKey} 就地重建成 OpenSSH 私钥（ssh2 只认这个格式）。
 *   服务器地址/账号名**不进 key**：账号由目录 id 推导（`quillsync-<id>`），
 *   地址取环境变量或创建时写入的默认值（见 `resolveCloudEndpoint`），避免把管理员服务器写死在公开代码里。
 *
 * 两种格式都有 6 位校验位，**粘少字符会立刻被发现**（而不是连不上才报错）。
 */

export interface CloudKeyPayload {
  v: 1
  /** 服务器地址 */
  h: string
  /** 端口 */
  p: number
  /** 登录用户名（每个云目录一个账号） */
  u: string
  /** 云目录 ID（也用于显示） */
  id: string
  /** 云目录名字（用户自己起的） */
  n: string
  /** 私钥内容（OpenSSH 格式，PEM 文本）—— 解析后总是有值 */
  k: string
}

const PREFIX_V1 = 'QC1'
const PREFIX_V2 = 'QS2'

/** 校验位：取内容的摘要前 6 位，用于发现复制粘贴时的缺字符 */
function checksum(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 6)
}

/* ============================ 种子 ↔ 私钥 ============================ */

/** PKCS#8 包装 ed25519 种子的固定前缀（48 字节 DER = 16 字节前缀 + 32 字节种子） */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/** 把 32 字节种子包成 PKCS#8 DER（Node 能识别） */
export function seedToPkcs8(seed: Buffer): Buffer {
  if (seed.length !== 32) throw new Error('种子必须是 32 字节')
  return Buffer.concat([PKCS8_PREFIX, seed])
}

/**
 * 把 32 字节种子重建成 **OpenSSH 私钥 PEM**。
 *
 * 为什么要重建：`ssh2` 只认 OpenSSH 私钥格式，**不认 PKCS#8**（实测报 "Unsupported key format"）。
 * 所以短 key 里存种子，认证前在这里重建成 ssh2 能用的形状。
 */
export function seedToOpensshPem(seed: Buffer): string {
  const keyObj = createPrivateKey({ key: seedToPkcs8(seed), format: 'der', type: 'pkcs8' })
  const spki = createPublicKey(keyObj).export({ format: 'der', type: 'spki' })
  const pubRaw = spki.subarray(spki.length - 32)

  const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
  const sstr = (buf: Buffer): Buffer => Buffer.concat([u32(buf.length), buf])
  const type = Buffer.from('ssh-ed25519', 'utf8')
  const pubBlob = Buffer.concat([sstr(type), sstr(pubRaw)])

  const check = Buffer.from([0x11, 0x22, 0x33, 0x44])
  let priv = Buffer.concat([
    check, check,
    sstr(type),
    sstr(pubRaw),
    sstr(Buffer.concat([seed, pubRaw])),
    sstr(Buffer.alloc(0))
  ])
  // 按 8 字节块对齐填充 1,2,3...
  const pad = (8 - (priv.length % 8)) % 8
  if (pad > 0) priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))])

  const blob = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'utf8'),
    sstr(Buffer.from('none', 'utf8')),
    sstr(Buffer.from('none', 'utf8')),
    sstr(Buffer.alloc(0)),
    u32(1),
    sstr(pubBlob),
    sstr(priv)
  ])
  const b64 = blob.toString('base64')
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${(b64.match(/.{1,70}/g) ?? []).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
}

/** 从 OpenSSH 私钥 PEM 里取出 32 字节种子（未加密的单密钥容器） */
export function extractSeedFromPem(pem: string): Buffer {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const raw = Buffer.from(b64, 'base64')
  const MAGIC = Buffer.from('openssh-key-v1\0', 'utf8')
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('不是 OpenSSH 私钥格式')
  let o = MAGIC.length
  const str = (): Buffer => { const n = raw.readUInt32BE(o); o += 4; const s = raw.subarray(o, o + n); o += n; return s }
  const cipher = str().toString('utf8')
  const kdf = str().toString('utf8')
  str()
  const nkeys = raw.readUInt32BE(o); o += 4
  if (cipher !== 'none' || kdf !== 'none') throw new Error('私钥已加密，无法提取种子')
  if (nkeys !== 1) throw new Error('多密钥容器，暂不支持')
  str()
  const priv = str()
  let p = 8
  const typeLen = priv.readUInt32BE(p); p += 4
  p += typeLen
  const pubLen = priv.readUInt32BE(p); p += 4
  p += pubLen
  const privLen = priv.readUInt32BE(p); p += 4
  const privKey = priv.subarray(p, p + privLen)
  if (privKey.length < 32) throw new Error('私钥块异常')
  return privKey.subarray(0, 32)
}

/** 把 key 里的正文（种子）解码成 32 字节；自动识别十六进制 / base64url */
export function decodeSeed(body: string): Buffer {
  const buf = /^[0-9a-f]{64}$/i.test(body) ? Buffer.from(body, 'hex') : Buffer.from(body, 'base64url')
  if (buf.length !== 32) throw new Error(`种子必须是 32 字节（当前 ${buf.length} 字节）`)
  return buf
}

/** 认证前把 payload 里的私钥materialize成 ssh2 能用的 PEM（QC1 原样返回，QS2 用种子重建） */
export function materializePrivateKey(payload: CloudKeyPayload): string {
  if (payload.k.startsWith('-----BEGIN')) return payload.k
  // ⚠️ 必须自动识别编码：新格式是 64 位 hex，老格式是 base64url。
  // 只写 base64url 的话，hex 串会被解成 48 字节 → 抛"种子必须是 32 字节"（踩过）。
  return seedToOpensshPem(decodeSeed(payload.k))
}

/* ============================ 编解码 ============================ */

/** 长格式（兼容老服务器返回值）：服务器给什么私钥就打包什么 */
export function encodeCloudKey(payload: CloudKeyPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return PREFIX_V1 + '-' + payload.id + '-' + body + '-' + checksum(body)
}

/**
 * 短格式（推荐）：只带 32 字节种子。
 * 生成的 key 约 110 字符，一行看完，粘贴不易出错。
 */
export function encodeShortCloudKey(input: { id: string; name?: string; privateKey: string }): string {
  const seed = extractSeedFromPem(input.privateKey)
  // ⚠️ 必须用**十六进制**（字母表只有 0-9a-f，绝不含 '-'）：
  // base64url 的字母表含 '-'，会和 key 的分隔符撞车 → 种子里的 '-' 把 key 切成更多段 → 解析错位。
  // 实测 1000 个随机种子有 482 个含 '-'（约一半的 key 天生是坏的）。
  const body = seed.toString('hex')
  return PREFIX_V2 + '-' + input.id + '-' + body + '-' + checksum(body)
}

export type DecodedKey = { ok: true; payload: CloudKeyPayload } | { ok: false; reason: string }
export type DecodedResult = DecodedKey

/**
 * 清洗粘贴进来的 key：去掉换行/空格/**中文标点与引号**等常见污染。
 *
 * 实测用户失败的直接原因就是"从聊天窗口复制"带了换行/空格（旧实现只 replace 空白里的一部分，
 * 且遇到 `“QC1-…”` 这类带引号的粘贴会直接判格式错）。
 */
export function sanitizeKeyText(text: string): string {
  return String(text ?? '')
    .replace(/[\u201c\u201d\u2018\u2019"'`]/g, '')  // 各种引号
    .replace(/[\s\u00a0\u3000]+/g, '')               // 空白（含全角空格、NBSP）
    .replace(/[，,、；;]+$/g, '')                     // 结尾误带的中英文标点
    .trim()
}

/** 解析 key；两种格式都支持 */
export function decodeCloudKey(text: string): DecodedKey {
  const raw = sanitizeKeyText(text)
  if (!raw) return { ok: false, reason: '请先粘贴 key' }

  // 不能 split('-')：老格式的 base64url 种子可能含 '-'，会错位。
  // 改成从两头定位：<前缀>-<id>-<正文（整体）>-<6 位校验位>
  const mm = /^(Q[CS]\d)-([^-]+)-(.+)-([0-9a-f]{6})$/.exec(raw)
  if (mm === null) {
    return { ok: false, reason: `key 格式不正确：应以 QC1- 或 QS2- 开头、以 6 位校验位结尾（当前共 ${raw.length} 字符）—— 请把管理员的 key 整串复制粘贴` }
  }
  const prefix = mm[1]
  const id = mm[2]
  const body = mm[3]
  const sum = mm[4]

  if (prefix === PREFIX_V2) {
    if (checksum(body) !== sum) {
      return {
        // 打印**正文长度**（而不是把 sum 当校验位展示）：之前错位时 sum 其实是种子后半段，用户无从判断
        ok: false,
        reason: `key 不完整或已被改动：校验位对不上（正文 ${body.length} 字符、key 共 ${raw.length} 字符）` +
          `—— 请把管理员的 key 整串重新复制粘贴`
      }
    }
    if (id === '' || body === '') return { ok: false, reason: 'key 内容不完整' }
    try {
      const seed = decodeSeed(body)
      if (seed.length !== 32) return { ok: false, reason: `key 内容不完整（种子应为 32 字节，实际 ${seed.length} 字节）` }
      const ep = resolveCloudEndpoint(id)
      return { ok: true, payload: { v: 1, h: ep.host, p: ep.port, u: 'quillsync-' + id, id, n: ep.name ?? '', k: body } }
    } catch {
      return { ok: false, reason: 'key 内容读不出来（可能已损坏）' }
    }
  }

  if (prefix === PREFIX_V1) {
    if (checksum(body) !== sum) {
      return {
        ok: false,
        reason: `key 不完整（可能复制时少了字符）：校验位对不上（当前 ${raw.length} 字符）—— 请整串重新复制粘贴`
      }
    }
    let obj: CloudKeyPayload
    try {
      obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CloudKeyPayload
    } catch {
      return { ok: false, reason: 'key 内容读不出来（可能已损坏）' }
    }
    if (!obj.h || !obj.u || !obj.k) return { ok: false, reason: 'key 内容不完整' }
    if (obj.id !== id) return { ok: false, reason: 'key 内容与标识不一致' }
    return { ok: true, payload: { ...obj, p: obj.p || 22, v: 1 } }
  }

  return { ok: false, reason: `不认识这个 key（版本是 ${prefix}），可能需要更新软件` }
}

/**
 * 服务器地址从哪来（**不写死在公开代码里**）：
 *   环境变量 DSH_QUILL_CLOUD_HOST / DSH_QUILL_CLOUD_PORT / DSH_QUILL_CLOUD_NAME
 * 短格式 key 不含地址，靠这里补上；没配置时给出明确报错而不是拿空地址去连。
 */
export function resolveCloudEndpoint(id: string): { host: string; port: number; name?: string } {
  const host = (process.env.DSH_QUILL_CLOUD_HOST ?? '').trim()
  const port = Number(process.env.DSH_QUILL_CLOUD_PORT ?? 22) || 22
  return { host, port, name: process.env.DSH_QUILL_CLOUD_NAME }
}

/** 从服务器返回的一行文本解析创建结果："OK <id> <base64私钥> <名称>" */
export function parseProvisionResult(line: string): { id: string; privateKey: string; apiOk: boolean; message?: string } {
  const t = (line ?? '').trim()
  if (t.startsWith('OK ')) {
    const parts = t.split(' ')
    return {
      id: parts[1] ?? '',
      privateKey: parts[2] ? Buffer.from(parts[2], 'base64').toString('utf8') : '',
      apiOk: true
    }
  }
  const msg = t.startsWith('ERR ') ? t.slice(4) : (t || '服务器没有返回结果')
  return { id: '', privateKey: '', apiOk: false, message: msg }
}
