/** 检查客户端 bundle 的关键点（避免 PowerShell 引号地狱） */
import { readFileSync } from 'node:fs'
import { ROOT, packageDirName } from './paths.mjs'
import { join } from 'node:path'

const file = process.argv[2] ?? join(ROOT, 'packages/' + packageDirName() + '/lib/client.js')
const text = readFileSync(file, 'utf8')
const count = (re) => (text.match(re) ?? []).length

const rows = [
  ['字节数', String(text.length)],
  ['__ModuleLoader__.load 外壳', count(/__ModuleLoader__\.load/g)],
  ['globalThis.__quillApi（桥已挂）', count(/__quillApi/g)],
  ['残留 window.api（应为 0）', count(/window\.api/g)],
  ['require("react")（走宿主 React）', count(/require\("react"\)/g)],
  ['require("react/jsx-runtime")', count(/require\("react\/jsx-runtime"\)/g)],
  ['require("react-dom")', count(/require\("react-dom"\)/g)],
  ['CodeMirror 已打包（cm-content）', count(/cm-content/g)],
  ['样式根容器 dsh-quill-user-root', count(/dsh-quill-root/g)],
  ['作用域选择器计数（应为百余条）', count(/#dsh-quill-user-root/g)],
  ['面板 key/id 常量 = notes', count(/PANEL_ID = "notes"/g)],
  ['main 注册用该 key', count(/name: "main", key: PANEL_ID/g)],
  ['侧边栏入口用该 id', count(/id: PANEL_ID, order: 20/g)]
]
for (const [k, v] of rows) console.log(String(k).padEnd(34) + ' : ' + v)

const bad = []
if (count(/window\.api/g) !== 0) bad.push('仍有 window.api 残留')
if (count(/__ModuleLoader__\.load/g) !== 1) bad.push('ModuleLoader 外壳数量异常')
if (count(/__quillApi/g) === 0) bad.push('桥未挂载')
if (count(/require\("react"\)/g) === 0) bad.push('react 未走宿主')
console.log(bad.length === 0 ? '\n结论：bundle 关键点全部正常' : '\n问题：' + bad.join('；'))
process.exitCode = bad.length === 0 ? 0 : 1
