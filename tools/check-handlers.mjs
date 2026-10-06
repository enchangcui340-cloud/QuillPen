/**
 * 扫描 UI 组件里 onClick 调用的函数是否真实存在。
 *
 * 事故：用户版对话框的「连接」按钮写了 onClick={() => void doConnect()}，
 * 但函数实际叫 useIt —— doConnect 不存在，点击抛 ReferenceError，
 * **React 事件里被静默吞掉**：界面毫无反应、服务端也收不到请求（日志里没有 connect-key）。
 * 这类错误既没有编译错误也没有运行时提示，必须靠静态扫描兜住。
 *
 * 第一版扫描器误报很多（把 useState 的 setter、props 解构都当成未定义），
 * 这里把"名字来源"补全：const/function/import/useState 解构/props 解构/参数。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CLIENT, ROOT } from './paths.mjs'

const results = []
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d ? ' -- ' + d : ''}`) }

function collectNames(src) {
  const names = new Set()
  // const/let/var/function
  for (const m of src.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  // 解构：const [a, setA] = useState() / const { a, b } = props
  for (const m of src.matchAll(/(?:const|let|var)\s*[\[{]([^\]}]+)[\]}]\s*=/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':').pop()?.split('=')[0]?.trim()
      if (n !== undefined && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n)
    }
  }
  // import { a, b as c }
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (n !== undefined && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n)
    }
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(m[1])
  // 函数参数（含解构）：({ onOpen, onRename }: Props)
  // 注意要匹配 `export default function X(...)` 这种带修饰符的写法
  for (const m of src.matchAll(/(?:export\s+)?(?:default\s+)?function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':')[0]?.trim()
      if (n !== undefined && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n)
    }
  }
  // export default function ({ a, b }: Props) —— 参数本身就是解构对象
  for (const m of src.matchAll(/(?:export\s+)?(?:default\s+)?function\s+[A-Za-z_$][\w$]*\s*\(\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':')[0]?.trim()
      if (n !== undefined && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n)
    }
  }
  // 箭头函数参数解构
  for (const m of src.matchAll(/\(\s*\{([^}]+)\}\s*(?::[^)]*)?\)\s*=>/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':')[0]?.split('=')[0]?.trim()
      if (n !== undefined && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n)
    }
  }
  return names
}

function scanRepo(label, dir) {
  const files = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(abs); continue }
      if (/\.tsx?$/.test(e.name)) files.push(abs)
    }
  }
  walk(dir)

  const problems = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    const names = collectNames(src)
    for (const m of src.matchAll(/on[A-Z]\w*=\{\s*\(\)\s*=>\s*(?:void\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!names.has(m[1])) problems.push(`${f.split(/[\\/]/).pop()} → ${m[1]}()`)
    }
  }
  const uniq = [...new Set(problems)]
  check(`${label}：事件处理器调用的函数都存在`, uniq.length === 0, uniq.join(', '))
}

// 只扫本仓库（dev 版是另一个仓库，开源用户没有它 —— 有才扫）
scanRepo('本仓库', CLIENT)
const DEV_CLIENT = join(ROOT, '..', 'quill-dsh', 'src-client')
if (existsSync(DEV_CLIENT)) scanRepo('dev 版', DEV_CLIENT)

const userClient = readFileSync(join(ROOT, 'packages/dsh-quill-user/lib/client.js'), 'utf8')
check('用户版产物里不再引用 doConnect', !userClient.includes('doConnect'), '')
check('用户版产物里 useIt 存在', userClient.includes('useIt'), '')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.n}：${f.d}`)
process.exit(failed.length === 0 ? 0 : 1)
