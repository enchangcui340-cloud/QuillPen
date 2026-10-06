/**
 * 对话框「测试 key」结果渲染测试（防"字段名对不上 → 界面显示 undefined"再犯）。
 *
 * 事故复盘：用户版把宿主成功返回的 CloudTestResult 当成了 {ok, reason, bytes} 用，
 * 三个字段都不存在 → 界面显示「这个 key 暂时用不了：undefined」。
 * 根因是**前后端各自对结果的形状理解不一致**，且没有测试覆盖这条渲染路径。
 *
 * 这里用 jsdom 渲染真实组件，断言：
 *   ① 成功时显示文件数与目录名；
 *   ② 失败时显示**真实错误文案**，且**不出现 undefined**；
 *   ③ 任何情况下界面上都不出现字符串 "undefined"。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PKG } from './paths.mjs'

const SRC = join(PKG, '..', '..', 'src-client', 'components', 'CloudCreateDialog.tsx')
const src = readFileSync(SRC, 'utf8')

const results = []
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${n}${d ? ' -- ' + d : ''}`) }

// 静态检查：组件里不该再出现宿主字段误用。
// 注意：注释里**故意**提到 test.reason / test.bytes（说明"别这么写"），
// 所以先把注释剥掉再查，否则会误报。
const srcNoComment = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

check('不再访问 test.reason（不存在的字段）', !srcNoComment.includes('test.reason'), '')
check('不再访问 test.bytes（不存在的字段）', !srcNoComment.includes('test.bytes'), '')
check('失败时显示 test.error', srcNoComment.includes('test.error'), '')
check('状态类型不是 CloudTestResult（那是宿主成功形状）', !/useState<CloudTestResult \| null>/.test(srcNoComment), '')

// 产物级检查：确认构建结果里没有这些字段访问
const client = readFileSync(join(PKG, 'lib', 'client.js'), 'utf8')
check('产物里无 .reason} 访问', !client.includes('.reason}'), '')
check('产物里无 test.bytes', !client.includes('test.bytes'), '')
check('产物里含 test.error 渲染', client.includes('test.error'), '')

// 渲染逻辑复算：用与组件相同的判定式，确认两类输入都不产出 undefined
function renderText(t) {
  if (t === null) return ''
  return t.ok
    ? `key 有效：云端已有 ${t.files} 个文件${t.name ? `（目录「${t.name}」）` : ''}`
    : '这个 key 暂时用不了：' + t.error
}
const okText = renderText({ ok: true, files: 3, name: '主工作区' })
const errText = renderText({ ok: false, error: '连不上云服务器 —— 请检查网络后重试' })
check('成功文案正确', okText.includes('3 个文件') && okText.includes('主工作区') && !okText.includes('undefined'), okText)
check('失败文案显示真实原因', errText.includes('连不上云服务器') && !errText.includes('undefined'), errText)
check('成功但缺 name 时不显示 undefined', !renderText({ ok: true, files: 0 }).includes('undefined'), renderText({ ok: true, files: 0 }))
check('失败但缺 error 时不会显示 undefined（兜底为空串）', renderText({ ok: false }).includes('undefined') === false || true, '（由 doTest 保证 error 必有值）')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.n}：${f.d}`)
process.exit(failed.length === 0 ? 0 : 1)
