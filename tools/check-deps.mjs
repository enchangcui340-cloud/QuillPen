/**
 * 依赖完整性检查（新增护栏）：
 * 源码里 import 的**运行时外部依赖**，必须在 package.json 的 dependencies 里声明。
 *
 * 背景：开源审查时发现 host.js 运行时 import `ssh2`，但 package.json 没声明它 ——
 * 陌生人克隆后 `pnpm i` 装不到，插件一加载就崩。这类"漏声明"靠人眼很难发现。
 *
 * 规则：
 *   · 宿主侧（src-host / shared）的外部 import → 必须在 dependencies（因为 host.js 是外部引用）
 *   · 客户端侧（src-client）的外部 import → 打进 bundle，不需要声明（但记下来供参考）
 *   · node: 内置、@shared 别名、electron（DSH 提供）→ 不算
 */
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { PKG, packageDirName } from './paths.mjs'

const results = []
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d ? ' -- ' + d : ''}`) }

const IGNORE = new Set(['electron', '@shared', '@deepseek-ai'])
function pkgRoot(spec) {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
}

function collectImports(dir) {
  const out = new Map()
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name)
      if (e.isDirectory()) { walk(abs); continue }
      if (!['.ts', '.tsx', '.js', '.mjs'].includes(extname(e.name))) continue
      const t = readFileSync(abs, 'utf8')
      // 只认真正的 import/export-from 语句，避免把代码里的普通字符串（如 'ssh-ed25519'）当成包名。
      // 支持：import x from 'p' / import 'p' / export ... from 'p' / import('p')
      const specs = [
        ...t.matchAll(/^\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm),
        ...t.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
        ...t.matchAll(/^\s*export\s[^'"]*from\s*['"]([^'"]+)['"]/gm),
        ...t.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)
      ]
      for (const m of specs) {
        const s = m[1]
        if (s.startsWith('.') || s.startsWith('node:') || s.startsWith('@shared')) continue
        const root = pkgRoot(s)
        if (IGNORE.has(root)) continue
        out.set(root, (out.get(root) ?? 0) + 1)
      }
    }
  }
  walk(dir)
  return out
}

const HOST = join(PKG, '..', '..', 'src-host')
const SHARED = join(PKG, '..', '..', 'shared')
const pkgJson = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
const declared = new Set(Object.keys(pkgJson.dependencies ?? {}))

// 宿主侧：必须声明
const hostImports = new Map([...collectImports(HOST), ...collectImports(SHARED)])
const missing = [...hostImports.keys()].filter((d) => !declared.has(d))
check('宿主侧 import 的运行时依赖都已声明', missing.length === 0, missing.join(', '))

// 声明了但没用到（可能多余，提示性）
const unused = [...declared].filter((d) => !hostImports.has(d))
console.log(`  提示：dependencies 里未被 host 直接引用的（可能供客户端或间接使用）：${unused.join(', ') || '无'}`)

// 反过来：dependencies 的包必须真的存在（能被解析），否则装了也崩。
// 注意：不能只试 `<pkg>/package.json` —— 很多包的 exports 不暴露该子路径（如 @codemirror/*），
// 那样会把"已安装"误判成"未安装"。这里按三个层次依次试：
//   ① 包根（走 exports 的 "."）  ② `<pkg>/package.json`  ③ 通过 node 的查找路径定位目录
import { createRequire } from 'node:module'
const req = createRequire(join(PKG, 'package.json'))
for (const d of declared) {
  const attempts = [
    () => req.resolve(d),
    () => req.resolve(d + '/package.json'),
    () => {
      // 退一步：用 require.resolve 的 paths 找到 node_modules 下的目录即可
      const p = req.resolve.paths(d)
      for (const base of p ?? []) {
        const dir = join(base, d)
        if (existsSync(dir)) return dir
      }
      throw new Error('not found')
    }
  ]
  let ok = false
  let err = ''
  for (const a of attempts) {
    try { a(); ok = true; break } catch (e) { err = e.code ?? e.message }
  }
  check(`依赖 ${d} 可被解析（已安装/可安装）`, ok, ok ? '' : `未安装（${err}）—— 开源用户须先 pnpm i`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.n}：${f.d}`)
process.exit(failed.length === 0 ? 0 : 1)
