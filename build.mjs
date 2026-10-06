/**
 * 构建脚本
 *
 *   node build.mjs host     → packages/<pkg>/lib/host.js   （宿主逻辑，ESM）
 *   node build.mjs client   → packages/<pkg>/lib/client.js （客户端 classic script）
 *   node build.mjs css      → src-client/styles.generated.ts （作用域化后的样式）
 *   node build.mjs all
 *
 * ## 构建依赖从哪来
 *
 * 按下面的顺序找 esbuild / postcss，**不写死任何本机路径**：
 *   1. 本仓库根目录的 node_modules（`pnpm i` 后就有，开源用户走这条）
 *   2. 包目录自己的 node_modules
 *   3. 环境变量 DSH_QUILL_BUILD_MODULES 指定的 node_modules（开发机借用别处依赖时用）
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

/** 依次尝试这些位置找构建依赖 */
function pickRequire() {
  const candidates = [
    join(root, 'package.json'),                                    // ① 仓库根（pnpm i）
    join(root, 'packages', 'dsh-quill-user', 'package.json'),       // ② 包目录
    join(root, 'packages', 'dsh-quill', 'package.json')
  ]
  if (process.env.DSH_QUILL_BUILD_MODULES) {
    candidates.push(join(process.env.DSH_QUILL_BUILD_MODULES, '..', 'package.json'))
  }
  for (const c of candidates) {
    if (!existsSync(c)) continue
    const req = createRequire(c)
    try { req.resolve('esbuild'); req.resolve('postcss'); return req } catch { /* 换下一个 */ }
  }
  throw new Error(
    '找不到构建依赖 esbuild / postcss。请在仓库根执行 `pnpm install`（或 npm i esbuild postcss），' +
    '或用环境变量 DSH_QUILL_BUILD_MODULES 指向一个含有它们的 node_modules 目录。'
  )
}
const requireFromDeps = pickRequire()
const { build } = requireFromDeps('esbuild')
const postcss = requireFromDeps('postcss')

/**
 * esbuild 解析包时用的 nodePaths（同样不写死）。
 *
 * 依赖可能装在**仓库根**，也可能装在**包目录**（pnpm 在包目录里 install 的情况），
 * 所以两个都放进去 —— 只放一个会导致 "Could not resolve ssh2" 这类失败。
 */
const WORKAPP_MODULES = process.env.DSH_QUILL_BUILD_MODULES ?? join(root, 'node_modules')
const ESBUILD_NODE_PATHS = [WORKAPP_MODULES, join(root, 'packages', 'dsh-quill-user', 'node_modules'), join(root, 'packages', 'dsh-quill', 'node_modules')].filter((p) => existsSync(p))
// 包目录名动态解析：dev 版是 dsh-quill，用户版是 dsh-quill-user。
// 写死会导致"改了源码但产物写到旧目录"（症状：改动看起来完全没生效）；多于一个目录时直接报错。
const PKG = (() => {
  const base = join(root, 'packages')
  const dirs = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('dsh-quill'))
  if (dirs.length === 0) throw new Error('packages/ 下找不到 dsh-quill* 目录')
  if (dirs.length > 1) {
    throw new Error(`packages/ 下有多个 dsh-quill* 目录（${dirs.map((d) => d.name).join(', ')}）—— 请先清理残留，避免产物写错地方`)
  }
  return join(base, dirs[0].name)
})()

/** @shared/* → 本工程 shared/ */
const sharedAlias = {
  name: 'quill-shared-alias',
  setup(b) {
    b.onResolve({ filter: /^@shared\// }, (args) => {
      const rel = args.path.slice('@shared/'.length)
      const base = join(root, 'shared', rel)
      for (const cand of [base, base + '.ts', join(base, 'index.ts')]) {
        if (existsSync(cand)) return { path: cand }
      }
      return { errors: [{ text: `未找到 ${args.path}` }] }
    })
    // electron 整体重定向到本项目 shim：core/{logger,paths}.ts 与 services/library.ts
    // 都直接 import 它，逐个改文件不如在构建层收口。
    b.onResolve({ filter: /^electron$/ }, () => ({ path: join(root, 'src-host', 'electron-shim.ts') }))
    // 文档读取（PDF 逐页渲染 + Office 提取）依赖这三个包 —— 它们是**插件自己的 dependencies**
    // （见 packages/dsh-quill/package.json），所以**不打进 bundle**，设为 external，
    // 产物里保留 import/require 原样，运行时由 Node 从插件的 node_modules 解析：
    //   · pdfjs-dist：ESM-only 且体积大；
    //   · @napi-rs/canvas：带原生 .node 二进制，esbuild 打不进去；
    //   · turndown：CJS（docx/html → Markdown）。
    b.onResolve({ filter: /^(pdfjs-dist|@napi-rs\/canvas|turndown)/ }, (args) => ({ path: args.path, external: true }))
    // ssh2 用**真库**（云数据目录），但它的两个可选原生加速模块要打桩：
    // 原码用 try/catch 包着，桩里抛错正好走"没有原生模块 → 纯 JS 实现"这条路。
    b.onResolve({ filter: /^(cpu-features|nan)$/ }, () => ({ path: join(root, 'src-host', 'stubs', 'native.ts') }))
    b.onResolve({ filter: /sshcrypto\.node$/ }, () => ({ path: join(root, 'src-host', 'stubs', 'native.ts') }))
    // vite 风格的 ?url / ?raw（渲染层遗留）：统一降级为"空资源"，不参与打包。
    b.onResolve({ filter: /\?(url|raw)$/ }, (args) => {
      const clean = args.path.replace(/\?(url|raw)$/, '')
      return { path: clean, namespace: 'quill-asset' }
    })
    b.onLoad({ filter: /.*/, namespace: 'quill-asset' }, () => ({
      contents: 'export default ""',
      loader: 'js'
    }))
  }
}

const common = {
  bundle: true,
  logLevel: 'info',
  nodePaths: ESBUILD_NODE_PATHS,
  plugins: [sharedAlias],
  absWorkingDir: root
}

/**
 * 护栏：src-host 里禁止"函数内 require"。
 * esbuild 打成 ESM 后 `require` 不存在，会在**运行到那一行时**才抛
 * "Dynamic require of ... is not supported" —— 静态构建完全不报错，非常隐蔽。
 * （这条是被交互冒烟测试抓出来的：插入图片时 attachment:import 直接失败。）
 */
function assertNoInlineRequire() {
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) { walk(abs); continue }
      if (!abs.endsWith('.ts') && !abs.endsWith('.js')) continue
      const lines = readFileSync(abs, 'utf8').split(/\r?\n/)
      lines.forEach((line, index) => {
        if (/^\s*(const|let|var)\s*\{[^}]*\}\s*=\s*require\(/.test(line) || /^\s*const\s+\w+\s*=\s*require\(/.test(line)) {
          offenders.push(`${abs.slice(root.length + 1)}:${index + 1}: ${line.trim()}`)
        }
      })
    }
  }
  walk(join(root, 'src-host'))
  if (offenders.length > 0) {
    throw new Error('src-host 里存在函数内 require（ESM 产物会运行时报错），请改成顶层 import：\n  ' + offenders.join('\n  '))
  }
}

async function buildHost() {
  assertNoInlineRequire()
  mkdirSync(join(PKG, 'lib'), { recursive: true })
  await build({
    ...common,
    entryPoints: [join(root, 'src-host', 'plugin-logic.ts')],
    outfile: join(PKG, 'lib', 'host.js'),
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    /**
     * 给产物注入一个**真的** `require`。
     *
     * esbuild 打 CJS 依赖（比如 ssh2）时，遇到它无法静态分析的 require 会生成
     * `__require(x)`，其实现是：`typeof require !== "undefined" ? require : <抛错的代理>`。
     * ESM 产物里没有 `require`，于是运行到那一行就抛
     * "Dynamic require of \"net\" is not supported"（实测：ssh2/lib/agent.js 的 require('net')）。
     *
     * 在模块作用域里放一个 createRequire 出来的 require，`__require` 就会直接用它。
     */
    banner: {
      js: [
        "import { createRequire as __dshCreateRequire } from 'node:module';",
        "import { dirname as __dshDirname } from 'node:path';",
        "import { fileURLToPath as __dshFileURL } from 'node:url';",
        'const require = /* @__PURE__ */ __dshCreateRequire(import.meta.url);',
        // CJS 依赖（ssh2/lib/agent.js 等）会引用 __dirname / __filename；
        // ESM 里没有这两个，Node 会因为"同时出现 __dirname 与顶层 await"而拒绝加载。
        'var __filename = /* @__PURE__ */ __dshFileURL(import.meta.url);',
        'var __dirname = /* @__PURE__ */ __dshDirname(__filename);'
      ].join('\n')
    }
  })
  console.log('[host] 产出 lib/host.js')
}

/** 样式作用域化：把 Quill 的全局 CSS 收进 #dsh-quill-user-root */
async function buildCss() {
  const file = join(root, 'src-client', 'styles.css')
  let css = readFileSync(file, 'utf8')
  // 护栏：去掉可能存在的 UTF-8 BOM。
  // 事故复盘：PowerShell 的 `Set-Content -Encoding UTF8` 会写入 BOM；一旦带上，
  // 内联进产物后**第一条规则的选择器**会变成 `\ufeff#dsh-quill-user-root`（非法）→ 整条规则被浏览器丢弃。
  // 那次丢掉的正好是"浅色主题变量块"，于是浅色下面板/笔记/白板底色全透明（线上事故）。
  if (css.charCodeAt(0) === 0xFEFF) {
    console.warn('[css] 检测到 styles.css 开头有 BOM，已自动去掉（请检查编辑器/写入脚本）')
    css = css.slice(1)
  }
  const ROOT = '#dsh-quill-user-root'
  const plugin = {
    postcssPlugin: 'quill-scope',
    Rule(rule) {
      // 跳过 @keyframes 内部的 from/to
      let p = rule.parent
      while (p) {
        if (p.type === 'atrule' && /keyframes/i.test(p.name)) return
        p = p.parent
      }
      const next = []
      for (const sel of rule.selectors) {
        const s = sel.trim()
        // 1) 只作用于宿主文档根的选择器：丢弃（不能让插件影响 DSH 外壳）
        if (s === 'html' || s === '#root') continue
        // 2) :root ... → #dsh-quill-user-root...
        //    注意不能只判断 s === ':root'：源码里还有 :root[data-theme='dark'] .x 这种，
        //    拼成 "#dsh-quill-user-root :root[...]" 会永远匹配不到（深色主题直接失效）。
        if (s === ':root' || s.startsWith(':root')) {
          let rest = s.slice(':root'.length)
          // ":root[data-theme='dark'] body" → 去掉尾部的 body，否则会变成"根里的根"
          rest = rest.replace(/\s+body\b/g, '')
          next.push(ROOT + rest)
          continue
        }
        // 3) body / body.xxx → 根容器
        if (s === 'body') {
          next.push(ROOT)
          continue
        }
        if (s.startsWith('body.') || s.startsWith('body[') || s.startsWith('body ')) {
          next.push(ROOT + s.slice('body'.length))
          continue
        }
        // 4) 已经是根作用域：原样保留
        if (s.startsWith(ROOT)) {
          next.push(s)
          continue
        }
        // 5) 其余：整体挂到根容器下
        next.push(`${ROOT} ${s}`)
      }
      if (next.length === 0) {
        rule.remove()
        return
      }
      rule.selector = next.join(', ')
    }
  }
  const out = await postcss([plugin]).process(css, { from: file })
  writeFileSync(join(root, 'src-client', 'styles.generated.ts'), `// 由 build.mjs 生成，请勿手改\nconst css = ${JSON.stringify(out.css)}\nexport default css\n`, 'utf8')
  const warn = out.warnings()
  console.log(`[css] 产出 styles.generated.ts（${out.css.length} 字节）${warn.length ? '，警告 ' + warn.length + ' 条' : ''}`)
}

async function buildClient() {
  mkdirSync(join(PKG, 'lib'), { recursive: true })
  const tmp = join(root, '.build', 'client.cjs')
  mkdirSync(dirname(tmp), { recursive: true })
  await build({
    ...common,
    entryPoints: [join(root, 'src-client', 'dsh-entry.tsx')],
    outfile: tmp,
    format: 'cjs',
    platform: 'browser',
    target: 'chrome120',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    define: { 'window.api': 'globalThis.__quillApi' },
    loader: { '.png': 'dataurl', '.woff2': 'dataurl' },
    jsx: 'automatic'
  })
  const body = readFileSync(tmp, 'utf8')
  // 模块 id 必须跟着包名走：DSH 用它做模块键，两个插件同 id 会导致后注册的被忽略（症状：新插件面板不出现）
  const moduleId = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).name
  const wrapped = `// 由 build.mjs 生成（classic script，非 ESM）\nwindow.__ModuleLoader__.load({\n  id: '${moduleId}',\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n${body}\n    return module.exports;\n  }\n});\n`
  writeFileSync(join(PKG, 'lib', 'client.js'), wrapped, 'utf8')
  console.log(`[client] 产出 lib/client.js（${wrapped.length} 字节）`)
}

const task = process.argv[2] ?? 'all'
if (task === 'host' || task === 'all') await buildHost()
if (task === 'css' || task === 'all') await buildCss()
if (task === 'client' || task === 'all') await buildClient()
