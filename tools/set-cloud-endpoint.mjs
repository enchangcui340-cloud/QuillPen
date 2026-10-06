/**
 * 写入/更新「包内云服务器地址文件」`packages/<pkg>/cloud-endpoint.json`。
 *
 * ## 它是干什么的
 *
 * 短 key（QS2）**不含服务器地址**（为了开源仓库里不出现管理员的服务器）。
 * 所以接收方机器需要一个地址来源，优先级：
 *   ① 环境变量 DSH_QUILL_CLOUD_HOST
 *   ② 插件配置 config.cloudHost（在 profile 的 cordis.patch.yml 里）
 *   ③ **本脚本写的这个文件**（跟着插件文件夹走，接收方零配置）
 *
 * 为什么需要 ③：② 在 `~/.dsh/profiles/<profile>/cordis.patch.yml` —— **不在插件文件夹里**，
 * 所以把插件复制到另一台电脑时不会跟着走，那台机器就会报「连不上云服务器」。
 *
 * ## 用法
 *
 *   node tools/set-cloud-endpoint.mjs                       # 从本机 profile 配置里读取，写进包内
 *   node tools/set-cloud-endpoint.mjs 1.2.3.4               # 直接指定地址
 *   node tools/set-cloud-endpoint.mjs 1.2.3.4 2222          # 指定地址与端口
 *   node tools/set-cloud-endpoint.mjs --show                # 只看当前状态，不写
 *   node tools/set-cloud-endpoint.mjs --remove              # 删除该文件
 *
 * ## 安全
 *
 * 本脚本**本身不含任何地址**（可以进开源仓库）；
 * 写出的 `cloud-endpoint.json` 被 `.gitignore` 排除（不进仓库），但会跟着文件夹复制。
 *
 *   node tools/set-cloud-endpoint.mjs
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PKG, ROOT } from './paths.mjs'

const FILE = join(PKG, 'cloud-endpoint.json')

/** 从本机 profile 的 patch 里读 cloudHost（没有就返回 undefined） */
function readFromProfile() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
  const candidates = [
    join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
    join(home, 'profiles', 'web', 'cordis.patch.yml'),
    join(home, 'cordis.patch.yml')
  ]
  for (const f of candidates) {
    if (!existsSync(f)) continue
    const t = readFileSync(f, 'utf8')
    // 只为取地址，用简单正则即可（不引入 yaml 依赖）
    const host = /cloudHost:\s*['"]?([^\s'"]+)['"]?/.exec(t)?.[1]
    const port = /cloudPort:\s*(\d+)/.exec(t)?.[1]
    if (host !== undefined && host !== '') return { host, port: port === undefined ? 22 : Number(port), from: f }
  }
  return undefined
}

function show() {
  console.log(`文件：${FILE}`)
  if (!existsSync(FILE)) { console.log('  状态：不存在（接收方机器只能靠 profile 配置或环境变量）'); return }
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'))
    console.log(`  状态：存在　host=${j.host}　port=${j.port ?? 22}`)
  } catch (e) {
    console.log('  状态：存在但内容不是合法 JSON —— ' + String(e.message))
  }
}

const args = process.argv.slice(2)

if (args.includes('--show') || args.length === 0 && false) { show(); process.exit(0) }

if (args.includes('--remove')) {
  if (existsSync(FILE)) { rmSync(FILE); console.log('已删除 ' + FILE) } else { console.log('文件本来就不存在') }
  process.exit(0)
}

// 决定用哪个地址：命令行参数 > 本机 profile 配置
let host = args.find((a) => !a.startsWith('--'))
let port
if (host !== undefined) {
  port = args.filter((a) => !a.startsWith('--'))[1]
} else {
  const fromProfile = readFromProfile()
  if (fromProfile === undefined) {
    console.log('没找到地址。请显式指定：node tools/set-cloud-endpoint.mjs <地址> [端口]')
    console.log('（或先在本机 profile 的 cordis.patch.yml 里配好 cloudHost）')
    process.exit(1)
  }
  host = fromProfile.host
  port = fromProfile.port
  console.log('从 profile 配置读到地址：' + fromProfile.from)
}

if (typeof host !== 'string' || host.trim() === '') {
  console.log('地址不能为空'); process.exit(1)
}

const payload = {
  host: host.trim(),
  port: port === undefined ? 22 : Number(port),
  _comment: '打包分发用的云服务器地址。仓库里被 .gitignore 排除，不会进开源代码；复制插件文件夹时会跟着走。'
}
writeFileSync(FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8')
console.log('已写入 ' + FILE)
console.log(`  host=${payload.host}　port=${payload.port}`)
console.log('\n注意：本文件不进开源仓库（.gitignore 已排除），但**打包给用户时要带上** ——')
console.log('      这样对方把插件文件夹复制到自己的电脑后，零配置即可用短 key 连接。')
