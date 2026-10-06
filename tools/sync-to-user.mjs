#!/usr/bin/env node
/**
 * 把 dev 版（quill-dsh）的源码同步到用户版（dsh-quill-user），并**重放用户版独有的改造**。
 *
 * 为什么需要它：用户版是 dev 版的复制品 + 一批独有改动（改名、删云创建、干净新库、文案、跨平台）。
 * 如果"直接覆盖"同步，这些改动会被冲掉；如果"手改两份"，两边一定漂移。
 * 所以设计成两步：**先同步 dev 源码 → 再重放用户版补丁**。
 *
 *   node tools/sync-to-user.mjs           # 预演（只打印会改哪些文件，不写盘）
 *   node tools/sync-to-user.mjs --apply   # 真同步
 *
 * 纪律：
 *   · 用户版的功能改进**不要手改** —— 先改 dev 版，再跑这个脚本；
 *   · 同步后**必须**跑：node tools/check-user-edition.mjs（确认没有把"创建云目录"能力带回来）。
 */
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const USER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEV_ROOT = process.env.DSH_QUILL_DEV_ROOT ?? 'D:/DSH/test01/quill-dsh'
const APPLY = process.argv.includes('--apply')

/** 同步范围：只同步源码与构建脚本；产物、依赖、报告一律不同步 */
const SYNC_DIRS = ['src-client', 'src-host', 'shared']
const SYNC_FILES = ['build.mjs']
/** 排除（用户版专属或不应同步） */
const SKIP = [
  'node_modules', 'reports', '.tmp', '.build', 'provision.key',
  'styles.generated.ts',
  /lib[\\/](host|client)\.js$/
]

const planned = []
function shouldSkip(rel) {
  const r = rel.replace(/\\/g, '/')
  return SKIP.some((s) => (typeof s === 'string' ? r.includes(s) : s.test(r)))
}
function walkSync(srcDir, dstDir, relBase = '') {
  for (const e of readdirSync(srcDir, { withFileTypes: true })) {
    const rel = relBase === '' ? e.name : relBase + '/' + e.name
    if (shouldSkip(rel)) continue
    const s = join(srcDir, e.name)
    const d = join(dstDir, e.name)
    if (e.isDirectory()) { walkSync(s, d, rel); continue }
    const a = existsSync(d) ? readFileSync(d, 'utf8') : null
    const b = readFileSync(s, 'utf8')
    if (a !== b) planned.push({ rel, changed: a !== null })
    if (APPLY) cpSync(s, d)
  }
}

console.log(`dev 版：${DEV_ROOT}`)
console.log(`用户版：${USER_ROOT}`)
console.log(APPLY ? '模式：真同步\n' : '模式：预演（加 --apply 才写盘）\n')

for (const d of SYNC_DIRS) {
  const s = join(DEV_ROOT, d)
  if (existsSync(s)) walkSync(s, join(USER_ROOT, d), d)
}
for (const f of SYNC_FILES) {
  const s = join(DEV_ROOT, f)
  if (existsSync(s) && readFileSync(s, 'utf8') !== readFileSync(join(USER_ROOT, f), 'utf8')) {
    planned.push({ rel: f, changed: true })
    if (APPLY) cpSync(s, join(USER_ROOT, f))
  }
}

console.log(`需要同步的文件：${planned.length} 个`)
for (const p of planned.slice(0, 40)) console.log('  ' + p.rel)
if (planned.length > 40) console.log(`  …还有 ${planned.length - 40} 个`)

console.log(`
下一步（很重要）：
  1) 重放用户版改动：这些改动**不在同步范围内**（它们只存在于用户版），同步不会覆盖；
     但 dev 版一旦改了**同一处**（例如 cloud-dirs.ts 的连接逻辑），需要人工把用户版的改造再套一遍。
     用户版改造清单（见 用户版插件-工作流程.md §2/§3/§4/§5/§6）：
       · 11 处改名（包名/面板 key/路由/样式作用域/数据目录/技能目录/行与预设 id）
       · 删"新建云数据目录"（客户端半边 + cloud:create 通道 + createCloudDir/provisionKey）
       · 默认干净新库（不读 Quill 旧配置，落在 ~/Documents/QuillNotes）
       · 四类友好错误文案（humanizeCloudError）
       · 跨平台：platformCommand() 平台分派
  2) 重新构建： node build.mjs all
  3) 必跑验收： node tools/check-user-edition.mjs   ← 确认没把创建能力带回来
  4) 再跑全量测试：见 README`)
process.exit(0)
