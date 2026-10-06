/**
 * 外壳（HTTP 层）冒烟测试 —— 仍然不需要 DSH、不需要重启。
 *
 * 做法：伪造一个 cordis ctx（webServer.register 捕获路由、connection.requestRejection 放行），
 * 然后伪造 req/res 走真实路由代码：ping / api / 未知通道 / 附件 / 未知路径。
 *
 *   node tools/smoke-shell.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { Writable } from 'node:stream'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { LIBRARY_SNAPSHOT, packageName, ROOT } from './paths.mjs'

/** 路由前缀随插件版本变化（用户版是 /quill-user） */
const ROUTE_PREFIX = packageName().endsWith('-user') ? '/quill-user' : '/quill'
const API_PATH = ROUTE_PREFIX + '/api'

const SRC_LIB = LIBRARY_SNAPSHOT
const work = join(join(ROOT, '.tmp', 'smoke-shell'), new Date().toISOString().replace(/[:.]/g, '-'))
const libDir = join(work, 'lib')
const dataDir = join(work, 'data')
mkdirSync(work, { recursive: true })
cpSync(SRC_LIB, libDir, { recursive: true })

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`)
}

/** 捕获 webServer.register 的路由 */
let handler = null
let registeredPath = ''
const fakeCtx = {
  webServer: {
    register(route) {
      registeredPath = route.path
      handler = route.handler
      return () => undefined
    }
  },
  connection: { requestRejection: () => undefined },
  effect(fn) {
    fn()
  }
}

const mod = await import('../packages/' + packageName() + '/lib/index.js')
mod.apply(fakeCtx, { libraryRoot: libDir, dataDir })
check('路由已注册', handler !== null && registeredPath === ROUTE_PREFIX, `path=${registeredPath}`)

/** 伪造响应对象 */
class FakeRes extends Writable {
  constructor() {
    super()
    this.chunks = []
    this.status = 0
    this.headers = {}
  }
  writeHead(status, headers) {
    this.status = status
    this.headers = { ...headers }
    return this
  }
  _write(chunk, _enc, cb) {
    this.chunks.push(Buffer.from(chunk))
    cb()
  }
  get body() {
    return Buffer.concat(this.chunks)
  }
  get text() {
    return this.body.toString('utf8')
  }
}

/** 发一个请求给真实路由 */
function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:19387' }
  const res = new FakeRes()
  return new Promise((resolvePromise, reject) => {
    res.on('finish', () => resolvePromise(res))
    res.on('error', reject)
    void handler(req, res).catch(reject)
  })
}

const ping = await request('GET', '/quill-user/ping')
let pingJson = {}
try { pingJson = JSON.parse(ping.text) } catch { /* 下面断言会失败 */ }
check('GET /quill-user/ping', ping.status === 200 && pingJson.ok === true, `channels=${pingJson.channels} library=${pingJson.libraryRoot}`)
check('ping 里的库路径正确', pingJson.libraryRoot === libDir.replace(/\\/g, '\\'), pingJson.libraryRoot)

const info = await request('POST', '/quill-user/api', JSON.stringify({ channel: 'app:info', args: [] }))
const infoJson = JSON.parse(info.text)
check('POST /quill-user/api app:info', info.status === 200 && infoJson.ok === true, infoJson.value?.libraryPath)

const tree = await request('POST', '/quill-user/api', JSON.stringify({ channel: 'note:tree', args: [] }))
const treeJson = JSON.parse(tree.text)
check('POST /quill-user/api note:tree', tree.status === 200 && treeJson.ok === true && Array.isArray(treeJson.value), `${treeJson.value?.length ?? 0} 个顶层节点`)

const unknown = await request('POST', '/quill-user/api', JSON.stringify({ channel: 'no:such', args: [] }))
check('未知通道 → 404', unknown.status === 404, unknown.text.slice(0, 60))

const badChannel = await request('POST', '/quill-user/api', JSON.stringify({ args: [] }))
check('缺少 channel → 400', badChannel.status === 400, badChannel.text.slice(0, 60))

const badJson = await request('POST', '/quill-user/api', '{not json')
check('请求体非 JSON → 400', badJson.status === 400, badJson.text.slice(0, 60))

const wrongMethod = await request('GET', '/quill-user/api')
check('GET /quill-user/api → 405', wrongMethod.status === 405, wrongMethod.text.slice(0, 60))

// 附件：在库里找一个真实图片
const attachDir = join(libDir, 'notes', '_attachments')
const firstFile = existsSync(attachDir) ? readdirSync(attachDir)[0] : undefined
if (firstFile !== undefined) {
  const url = '/quill-user/attachment?rel=' + encodeURIComponent('_attachments/' + firstFile)
  const got = await request('GET', url)
  check('GET /quill-user/attachment', got.status === 200 && got.body.length > 0, `${firstFile} → ${got.body.length} 字节, ${got.headers['content-type']}`)

  const outside = await request('GET', '/quill-user/attachment?rel=' + encodeURIComponent('../../../../Windows/win.ini'))
  check('附件越界被拒', outside.status === 404, outside.text.slice(0, 60))
} else {
  check('GET /quill-user/attachment', false, '库里没有 _attachments 目录')
}

const nope = await request('GET', '/quill-user/nope')
check('未知路径 → 404', nope.status === 404, nope.text.slice(0, 60))

console.log('\n=== 汇总 ===')
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
console.log('工作目录：' + work)
process.exitCode = failed.length === 0 ? 0 : 1
