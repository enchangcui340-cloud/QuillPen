/**
 * 静态视觉审计（不需要浏览器）。
 *
 * 回答三个问题：
 *   1. **有没有"用了但没样式"的类**：JSX 里 className 用到的类，在 CSS 里有没有规则？
 *      （jsdom 不排版，视觉测试也发现不了这种元素 —— 它渲染得出来，只是没样式。）
 *   2. **作用域化有没有丢规则**：原版 styles.css 里的每个类，作用域化后是否都还在？
 *   3. **有没有把样式漏到宿主**：产物里是否残留 :root / html / body 选择器。
 *
 *   node tools/audit-css.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, WORKAPP_PKG_JSON } from './paths.mjs'

const requireFromWorkapp = createRequire(WORKAPP_PKG_JSON)
const postcss = requireFromWorkapp('postcss')

const CLIENT = join(ROOT, 'src-client')

/** 收集某个选择器里的类名 */
function classesOf(selector) {
  const out = []
  for (const m of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.push(m[1])
  return out
}

/** 解析 CSS 文本 → { 类名集合, 规则数, 选择器列表 } */
function parseCss(css) {
  const root = postcss.parse(css)
  const classes = new Set()
  const selectors = []
  let rules = 0
  root.walkRules((rule) => {
    rules++
    selectors.push(rule.selector)
    for (const cls of classesOf(rule.selector)) classes.add(cls)
  })
  return { classes, selectors, rules }
}

/** 收集 src-client 下所有源码文件（排除样式文件本身，否则"类名出现在源码里"永远为真） */
function sourceFiles() {
  const files = []
  ;(function walk(dir) {
    for (const e of readdirSync(dir)) {
      const abs = join(dir, e)
      if (statSync(abs).isDirectory()) walk(abs)
      else if (abs.endsWith('.tsx') || abs.endsWith('.ts')) {
        const name = e.toLowerCase()
        if (name === 'styles.generated.ts' || name.includes('styles')) continue
        files.push(abs)
      }
    }
  })(CLIENT)
  return files
}

/** 从 TSX 里收集 className 用到的类名 */
function classesUsedInTsx() {
  const files = sourceFiles()

  const used = new Map() // 类名 → Set(文件)
  const add = (cls, file) => {
    if (!/^-?[_a-zA-Z][\w-]*$/.test(cls)) return
    if (!used.has(cls)) used.set(cls, new Set())
    used.get(cls).add(relative(ROOT, file).split('\\').join('/'))
  }

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    // className="a b"  /  className={'a b'}  /  className={`a ${x} b`}  /  className={'a' + (x ? ' b' : '')}
    const re = /className\s*=\s*(\{)?/g
    let m
    while ((m = re.exec(text)) !== null) {
      const start = m.index + m[0].length
      let end
      if (m[1] === '{') {
        // 花括号表达式：一直读到配对的花括号
        let depth = 1
        let i = start
        while (i < text.length && depth > 0) {
          const ch = text[i]
          if (ch === '{') depth++
          else if (ch === '}') depth--
          else if (ch === '"' || ch === "'" || ch === '`') {
            const quote = ch
            i++
            while (i < text.length) {
              if (text[i] === '\\') { i += 2; continue }
              if (text[i] === quote) break
              i++
            }
          }
          i++
        }
        end = i
      } else {
        const quote = text[start]
        end = text.indexOf(quote, start + 1)
        end = end === -1 ? text.length : end
      }
      const chunk = text.slice(start, end)
      // 取出这一坨里的所有字符串字面量，按空白切分成类名
      for (const lit of chunk.matchAll(/['"`]([^'"`]*)['"`]/g)) {
        for (const cls of lit[1].split(/\s+/)) if (cls !== '') add(cls, file)
      }
    }
  }
  return used
}

// ---------- 解析两份 CSS ----------
const originalCss = readFileSync(join(CLIENT, 'styles.css'), 'utf8')
const generated = readFileSync(join(CLIENT, 'styles.generated.ts'), 'utf8')
// styles.generated.ts 形如：const css = "#dsh-quill-user-root {\n ... }"（转义双引号字符串，不是模板字符串）
const quoteStart = generated.indexOf('"')
const quoteEnd = generated.lastIndexOf('"')
const scopedCss = JSON.parse(generated.slice(quoteStart, quoteEnd + 1))

const original = parseCss(originalCss)
const scoped = parseCss(scopedCss)
const used = classesUsedInTsx()

console.log('=== 规模 ===')
console.log(`原版 CSS      ${original.rules} 条规则，${original.classes.size} 个类`)
console.log(`作用域化 CSS  ${scoped.rules} 条规则，${scoped.classes.size} 个类`)
console.log(`JSX 用到的类  ${used.size} 个`)

// ---------- 1. 作用域化是否丢类 ----------
const lostClasses = [...original.classes].filter((c) => !scoped.classes.has(c))
console.log('\n=== 1. 作用域化是否丢规则 ===')
console.log(lostClasses.length === 0
  ? `[OK]   原版 ${original.classes.size} 个类全部保留在作用域化产物里`
  : `[FAIL] 丢了 ${lostClasses.length} 个类：${lostClasses.slice(0, 20).join(', ')}`)

// ---------- 2. 用了但没有样式的类 ----------
const IGNORE = new Set([
  // React/库内部或结构性类名，本来就不需要本项目样式
  'cm-editor', 'cm-content', 'cm-line', 'cm-gutters', 'cm-scroller', 'cm-focused', 'cm-activeLine',
  'cm-cursor', 'cm-selectionBackground', 'cm-activeLineGutter', 'cm-placeholder', 'cm-widgetBuffer',
  'cm-tooltip', 'cm-panels', 'cm-searchMatch', 'highlight', 'grow',
  // 动态拼接里的完整类名（CSS 里是 .note-item.done 这种组合写法）
  'done', 'active', 'drop', 'selected', 'dragging', 'danger', 'primary', 'small', 'big', 'error', 'success'
])
const unstyled = [...used.keys()].filter((c) => !scoped.classes.has(c) && !IGNORE.has(c)).sort()
const unstyledDetail = unstyled.map((c) => `${c}（${[...used.get(c)].slice(0, 2).join(', ')}）`)
console.log('\n=== 2. 用了但没有样式的类 ===')
if (unstyled.length === 0) console.log('[OK]   JSX 用到的类全部有对应样式')
else {
  console.log(`[WARN] ${unstyled.length} 个类在 CSS 里找不到规则：`)
  for (const d of unstyledDetail) console.log('       ' + d)
}

// 这些类在原版 CSS 里有没有？（有 → 是我搬样式时漏了；没有 → 上游本来就无样式）
const upstreamMissing = unstyled.filter((c) => !original.classes.has(c))
const mineMissing = unstyled.filter((c) => original.classes.has(c))
console.log(`\n       其中「上游本来就没有样式」：${upstreamMissing.length} 个`)
if (upstreamMissing.length > 0) console.log('       ' + upstreamMissing.join(', '))
console.log(`       其中「上游有、我搬丢了」：${mineMissing.length} 个`)
if (mineMissing.length > 0) console.log('       ' + mineMissing.join(', '))

// ---------- 3. 是否泄漏到宿主 ----------
console.log('\n=== 3. 是否泄漏到宿主 ===')
const leakRoot = scoped.selectors.filter((s) => /(^|[\s,>+~])(:root|html|body)(?![\w-])/.test(s) && !s.includes('#dsh-quill-user-root'))
const rawBody = (scopedCss.match(/(^|\n)\s*(html|body)\s*[,{]/g) ?? []).length
console.log(leakRoot.length === 0 && rawBody === 0
  ? '[OK]   没有 :root / html / body 选择器泄漏'
  : `[FAIL] 泄漏选择器 ${leakRoot.length} 条（裸 body/html 规则 ${rawBody} 处）：${leakRoot.slice(0, 5).join(' | ')}`)
const scopedOk = scoped.selectors.filter((s) => !s.startsWith('@') && !s.includes('#dsh-quill-user-root') && !/^\s*(from|to|\d+%)/.test(s))
console.log(`       未作用域的选择器：${scopedOk.length} 条${scopedOk.length ? ' → ' + scopedOk.slice(0, 5).join(' | ') : ''}`)

// ---------- 4. 死样式（定义了但源码里根本没出现） ----------
// 判定方式：拿每个 CSS 类名去**全部源码**里做整词查找。
// （比解析 className 表达式可靠得多；方向是"CSS→源码"，正是这里需要的。）
const sourceText = sourceFiles().map((f) => readFileSync(f, 'utf8')).join('\n')
const isUsedInSource = (cls) => new RegExp(`(^|[^\\w-])${cls.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}([^\\w-]|$)`).test(sourceText)
const dead = [...scoped.classes].filter((c) => !isUsedInSource(c)).sort()
const AI_HINTS = /^(ai|assistant|composer|msg|chat|bubble|step|stream|token|prompt)/
const deadAi = dead.filter((c) => AI_HINTS.test(c))
console.log('\n=== 4. 定义了但源码里没出现的类 ===')
console.log(`       共 ${dead.length} 个（占 ${scoped.classes.size} 个的 ${(dead.length / scoped.classes.size * 100).toFixed(0)}%）`)
console.log(`       其中看着像随笔集/AI 遗留的：${deadAi.length} 个`)
if (dead.length > 0) console.log('       ' + dead.slice(0, 40).join(', ') + (dead.length > 40 ? ' …' : ''))

const failed = lostClasses.length > 0 || leakRoot.length > 0 || rawBody > 0 || mineMissing.length > 0
console.log(`\n=== 结论 ===\n${failed ? '存在问题（见上）' : '作用域化无丢失、无泄漏'}`)
console.log(`未样式化类：${unstyled.length} 个（上游本来就没有的 ${upstreamMissing.length} 个 / 我搬丢的 ${mineMissing.length} 个）`)
process.exit(failed ? 1 : 0)
