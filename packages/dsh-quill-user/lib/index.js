/**
 * dsh-quill —— DSH「笔记」面板插件的宿主半边（外壳）。
 *
 * 分工：
 *   · 本文件（外壳）：注册 HTTP 路由、解析配置、**热重载宿主逻辑**；
 *   · host.js（构建产物）：由 src-host/plugin-logic.ts 打出来的全套服务层。
 *
 * 为什么要把逻辑单独放一个文件：DSH 里改宿主代码需要重启应用才生效，
 * 而这里每次请求前会比对 host.js 的 mtime，变了就用 `?t=` 破缓存重新 import，
 * 于是"改服务层代码 → 刷新页面"即可生效，不必重启你的 DSH。
 */
import { existsSync, statSync, createReadStream, appendFileSync, readFileSync } from 'node:fs'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// 共享运行时：面板外壳与「羽毛笔」工具层用的是同一份（见 runtime.js 顶部说明）
import { ensureRuntime, resolveOptions } from './runtime.js'
// 技能手册安装器：外壳与工具层都会调用（谁先跑谁装，见该文件顶部说明）
import { syncSkillHandbook } from './skill-sync.js'

/** 依赖的宿主服务：HTTP 路由 + 浏览器登录态校验 */
export const inject = ['webServer', 'connection']

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * 访问日志：`<dataDir>/access.log`。
 * 用途有两个：① 排障时能看出界面到底调了哪些通道、哪些报错；
 * ② 验收"接口连通性 / 错误率"时它就是原始的计数依据。
 * 超过 4MB 自动截断，避免长期运行把盘写满。
 */
function logAccess(dataDir, line) {
  try {
    const file = join(dataDir, 'access.log')
    if (existsSync(file) && statSync(file).size > 4 * 1024 * 1024) {
      appendFileSync(file, '--- 日志超过 4MB，已重新开始 ---\n', 'utf8')
    }
    appendFileSync(file, new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch {
    /* 日志失败不影响功能 */
  }
}

/** 读取请求体（上限 64MB，笔记正文与 base64 图片都在这个量级内） */
function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8'
}

/** 统一的路由处理器：/quill/* */
function createHandler(getConfig) {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')

      if (url.pathname === '/quill-user/ping') {
        const rt = await ensureRuntime(getConfig())
        sendJson(res, 200, {
          ok: true,
          libraryRoot: rt.libraryRoot(),
          channels: rt.channels.length
        })
        return
      }

      if (url.pathname === '/quill-user/api') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '只接受 POST' })
          return
        }
        const raw = await readBody(req)
        let payload
        try {
          payload = JSON.parse(raw || '{}')
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const channel = String(payload?.channel ?? '')
        const args = Array.isArray(payload?.args) ? payload.args : []
        if (channel === '') {
          sendJson(res, 400, { ok: false, error: '缺少 channel' })
          return
        }
        const rt = await ensureRuntime(getConfig())
        const fn = rt.invoke(channel, args)
        const dataDir = resolveOptions(getConfig()).dataDir
        if (fn === undefined) {
          logAccess(dataDir, 'api ' + channel + ' -> 404 未知通道')
          sendJson(res, 404, { ok: false, error: '未知通道：' + channel })
          return
        }
        // index.ts 的 handle() 已经把结果包成 { ok, value | error }，这里原样透传
        const started = Date.now()
        const result = await fn
        const failed = result === null || typeof result !== 'object' || result.ok !== true
        logAccess(dataDir, 'api ' + channel + ' -> ' + (failed ? 'ERR ' + String(result?.error ?? '未知') : 'ok') + ' ' + (Date.now() - started) + 'ms')
        sendJson(res, 200, result)
        return
      }

      if (url.pathname === '/quill-user/attachment') {
        const rel = url.searchParams.get('rel') ?? ''
        const rt = await ensureRuntime(getConfig())
        const abs = rt.attachmentAbs(rel)
        if (typeof abs !== 'string' || abs === '' || !existsSync(abs)) {
          sendJson(res, 404, { ok: false, error: '附件不存在' })
          return
        }
        res.writeHead(200, {
          'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-store'
        })
        createReadStream(abs).pipe(res)
        return
      }

      sendJson(res, 404, { ok: false, error: '未知路径：' + url.pathname })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * 插件入口。
 * @param ctx Cordis 上下文（已注入 webServer / connection）
 * @param config 插件配置（cordis.patch.yml 里那一行的 config）
 */
export function apply(ctx, config) {
  const getConfig = () => config
  // 注意：这里**不**预先 mkdir 数据目录。
  // 之前把它放在鉴权之前，结果连"没通过登录校验的探测请求"都会在磁盘上留下一个空目录
  // （实测：我用 PowerShell 打的 401 探测就建出了 ~/.dsh/quill-plugin）。
  // 真正需要目录的是 ensureRuntime → createRuntime，它自己会建。
  syncSkillHandbook(ctx.logger)

  /**
   * 把云服务器地址透传给宿主逻辑（短 key 里不含地址，所以必须有外部来源）。
   *
   * 为什么短 key 不含地址：为了**开源仓库干净** —— 公开的代码里不出现管理员的服务器。
   *
   * 三个来源，按优先级：
   *   ① 环境变量 DSH_QUILL_CLOUD_HOST / _PORT   —— 已显式设置就用它（最高优先）
   *   ② 插件配置 config.cloudHost / cloudPort   —— 装在 profile 里（本机个人配置，不入仓库）
   *   ③ **包内本地文件 cloud-endpoint.json**     —— 打包给用户时带上，用户零配置即可用
   *
   * 为什么要有 ③：把插件文件夹复制到另一台电脑时，**② 不会跟着走**
   * （它在 `~/.dsh/profiles/<profile>/cordis.patch.yml`，属于 DSH 的 profile 配置，不在插件包里）。
   * 于是那台机器地址为空 → 报「连不上云服务器」。有了 ③，只要文件跟着文件夹一起复制就能用。
   *
   * ①②③ 里，仓库里都不含真实地址：
   *   · ① 由使用者自己设；
   *   · ② 在 profile 配置里，不入仓库；
   *   · ③ 被 .gitignore 排除（见仓库根 .gitignore），但**文件夹复制时会带上**。
   */
  try {
    const cfg = config ?? {}
    /** 只在"还没人设过"时才写入，保证优先级顺序 */
    const setIfEmpty = (key, value) => {
      if (typeof value !== 'string' || value.trim() === '') return false
      if ((process.env[key] ?? '') !== '') return false
      process.env[key] = value.trim()
      return true
    }

    // ② 插件配置
    if (setIfEmpty('DSH_QUILL_CLOUD_HOST', cfg.cloudHost)) {
      ctx.logger?.info?.('[羽毛笔] 云服务器地址来自插件配置')
    }
    if (cfg.cloudPort !== undefined) setIfEmpty('DSH_QUILL_CLOUD_PORT', String(cfg.cloudPort))

    // ③ 包内本地文件（打包分发用；仓库里被 .gitignore 排除）
    if ((process.env.DSH_QUILL_CLOUD_HOST ?? '') === '') {
      const epFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'cloud-endpoint.json')
      if (existsSync(epFile)) {
        const ep = JSON.parse(readFileSync(epFile, 'utf8'))
        if (setIfEmpty('DSH_QUILL_CLOUD_HOST', ep.host)) {
          ctx.logger?.info?.('[羽毛笔] 云服务器地址来自包内 cloud-endpoint.json')
        }
        if (ep.port !== undefined) setIfEmpty('DSH_QUILL_CLOUD_PORT', String(ep.port))
      }
    }

    if ((process.env.DSH_QUILL_CLOUD_HOST ?? '') === '') {
      ctx.logger?.warn?.('[羽毛笔] 未配置云服务器地址 —— 用短 key 连接云目录会失败。' +
        '请在 profile 配置里写 config.cloudHost，或在包内放 cloud-endpoint.json')
    }
  } catch (e) {
    ctx.logger?.warn?.('[羽毛笔] 读取云服务器地址失败：' + String(e?.message ?? e))
  }

  const handler = createHandler(getConfig)
  const guarded = async (req, res) => {
    // 借用 DSH 的登录态校验：非本机来源 / 无会话 cookie 直接 401/403
    let rejection
    try {
      rejection = ctx.connection?.requestRejection?.(req)
    } catch {
      rejection = undefined
    }
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: '未通过 DSH 会话校验' }))
      return
    }
    await handler(req, res)
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/quill-user', handler: guarded }),
    'dsh-quill-user: /quill-user 路由'
  )
}
