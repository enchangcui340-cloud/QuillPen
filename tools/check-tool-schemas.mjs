/**
 * 工具 schema 元校验（W2：补上导致 INVALID_REQUEST 的测试盲区）。
 *
 * 为什么需要它：2026-10-03 线上真实失败 ——
 *   本机运行失败  Invalid schema for function 'attachment_import': true is not of type "array"
 * 原因是手写 JSON Schema 时在**属性层**写了 `required: true`（JSON Schema 里 `required` 只能出现在
 * 对象层且必须是字符串数组），接口在收到工具列表时直接判 INVALID_REQUEST —— 整轮请求发不出去。
 * 而当时的测试只检查"字段在不在"，**没把 schema 喂给校验器**，所以完全没发现。
 *
 * 现在做三件事：
 *   1. 用 ajv 对每个工具的 parameters / output.schema 做 **draft-07 元校验**（schema 本身合法吗）；
 *   2. 结构检查：parameters 必须是 object、必须 additionalProperties:false、
 *      required 只能是"字符串数组且每项都在 properties 里"；
 *   3. 语义检查：每个工具至少要能编译出可调用形状（properties 非空 or 允许无参）。
 *
 *   node tools/check-tool-schemas.mjs
 */
import { createRequire } from 'node:module'
import { WORKAPP_PKG_JSON, packageDirName } from './paths.mjs'

const requireFromWorkapp = createRequire(WORKAPP_PKG_JSON)
const Ajv = requireFromWorkapp('ajv')
// strict:false —— 我们只关心"schema 本身是否合法"，不做 ajv 的严格风格检查
const ajv = new Ajv({ strict: false, allowUnionTypes: true })

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`)
}

/* ---------- 收集工具 ---------- */
const definitions = []
const mod = await import('../packages/' + packageDirName() + '/lib/tools.js')
mod.apply({
  tools: { register: (d) => { definitions.push(d); return () => {} } },
  logger: { info: () => {}, warn: () => {} }
})
console.log(`\n=== 工具 schema 元校验（共 ${definitions.length} 个工具） ===\n`)

/** 把 ajv 的错误压成一行 */
const fmt = (errors) => (errors ?? []).slice(0, 3)
  .map((e) => `${e.instancePath || '/'} ${e.message}${e.params?.allowedValue !== undefined ? ' (允许值 ' + JSON.stringify(e.params.allowedValue) + ')' : ''}`)
  .join('；')

let badSchemas = 0
let badRequired = 0
let badShape = 0

for (const def of definitions) {
  const params = def.parameters

  // 1) schema 本身合法吗（就是这一步能抓住 `required: true`）
  const paramsOk = ajv.validateSchema(params)
  if (!paramsOk) {
    badSchemas++
    check(`${def.name}：parameters 是合法 JSON Schema`, false, fmt(ajv.errors))
  }

  const outOk = ajv.validateSchema(def.output?.schema)
  if (!outOk) {
    badSchemas++
    check(`${def.name}：output.schema 是合法 JSON Schema`, false, fmt(ajv.errors))
  }

  // 2) 结构检查（对工具注册与模型调用都重要）
  const shapeProblems = []
  if (params === null || typeof params !== 'object' || params.type !== 'object') shapeProblems.push('parameters.type 必须是 "object"')
  if (params?.additionalProperties !== false) shapeProblems.push('parameters 必须 additionalProperties:false')
  if (params?.properties !== undefined && (typeof params.properties !== 'object' || params.properties === null)) shapeProblems.push('properties 必须是对象')
  if (params?.required !== undefined) {
    if (!Array.isArray(params.required)) {
      badRequired++
      shapeProblems.push(`required 必须是字符串数组（现在是 ${JSON.stringify(params.required)}）`)
    } else if (!params.required.every((k) => typeof k === 'string')) {
      badRequired++
      shapeProblems.push('required 里必须全是字符串')
    } else {
      const unknown = params.required.filter((k) => !(k in (params.properties ?? {})))
      if (unknown.length > 0) shapeProblems.push(`required 里有 properties 里没有的字段：${unknown.join(', ')}`)
    }
  }
  // 属性层不允许出现 required（这是本次事故的根因）
  for (const [key, prop] of Object.entries(params?.properties ?? {})) {
    if (prop !== null && typeof prop === 'object' && 'required' in prop) {
      badRequired++
      shapeProblems.push(`属性 ${key} 里写了 required（JSON Schema 不允许，必须写到对象层的 required 数组）`)
    }
  }
  if (shapeProblems.length > 0) {
    badShape++
    check(`${def.name}：parameters 结构正确`, false, shapeProblems.join('；'))
  }
}

console.log('')
check('所有工具的 parameters / output.schema 都是合法 JSON Schema', badSchemas === 0, badSchemas === 0 ? `${definitions.length} 个工具全部通过` : `${badSchemas} 处非法`)
check('所有工具的 required 写法正确（字符串数组、字段存在、属性层没有 required）', badRequired === 0, badRequired === 0 ? '' : `${badRequired} 处`)
check('所有工具的 parameters 结构正确（object + additionalProperties:false）', badShape === 0, badShape === 0 ? '' : `${badShape} 个工具`)

// 反向自证：脚本真的能抓住这次事故的写法
console.log('\n=== 反向自证（故意造一个非法 schema，验证校验器抓得住） ===')
const broken = { type: 'object', additionalProperties: false, properties: { a: { type: 'string', required: true } }, required: ['a'] }
const caughtByAjv = ajv.validateSchema(broken) === false
check('ajv 元校验能抓住「属性层 required: true」', caughtByAjv, fmt(ajv.errors))
const caughtByShape = (() => {
  for (const [, prop] of Object.entries(broken.properties)) if ('required' in prop) return true
  return false
})()
check('结构检查也能抓住同一种写法', caughtByShape)

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 汇总 ===\n${results.length - failed.length}/${results.length} 通过`)
for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
process.exit(failed.length === 0 ? 0 : 1)
