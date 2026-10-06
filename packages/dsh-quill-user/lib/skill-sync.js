/**
 * 「羽毛笔」技能手册的安装器（外壳与工具层共用）。
 *
 * 背景：DSH 的 `dsh-skill-filesystem` 会按 rank 扫描这些根目录里的 `<name>/SKILL.md`：
 *   100 项目根/.dsh/skills · 200 项目根/.agents/skills · 300 customSkillDirs
 *   400 <DSH_HOME>/skills · 500 <agentsHome>/skills · 600 bundledSkillDir
 * 其中 `bundledSkillDir` 要一个**绝对路径**（写死在补丁里换台机器就废），
 * 所以改成：插件激活时把随包的手册**按内容同步**到 rank 400 的用户技能根。
 *
 * 为什么要抽成独立文件并被两处调用（外壳 `index.js` 与工具层 `tools.js`）：
 * 两者的加载时机与真实路径不一样（面板可能先激活，也可能工具层先在预设作用域里挂载），
 * 谁先跑谁把它装好；两处都调用就都不会漏。
 *
 * 三条自律（很重要，避免弄脏用户的环境）：
 *   1. 内容一致 → 一个字节都不写；
 *   2. 目标已存在但不是我们的（没有 owner 标记）→ 绝不覆盖，只记 warn；
 *   3. 每一步都写诊断日志（含 import.meta.url 与候选路径），出问题能查。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_NAME = 'notes-assistant-user'
const OWNER_MARK = 'owner: dsh-quill-user'

function logLine(line) {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const dir = join(home, 'quill-plugin-user')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'skill-sync.log'), `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* 日志写不了也不能影响主流程 */
  }
}

/** 找随包的手册：不同加载方式下 import.meta.url 的"上一级"可能不同，多给几个候选 */
function findSource() {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', 'skills', SKILL_NAME, 'SKILL.md'), // 正常：<pkg>/lib → <pkg>/skills
    join(here, 'skills', SKILL_NAME, 'SKILL.md'), // 万一 here 已经是包根
    join(here, '..', '..', 'skills', SKILL_NAME, 'SKILL.md') // 万一多了一层
  ]
  const envDir = process.env.DSH_QUILL_PACKAGE_DIR
  if (envDir) candidates.push(join(envDir, 'skills', SKILL_NAME, 'SKILL.md'))
  for (const c of candidates) if (existsSync(c)) return { file: c, tried: candidates }
  return { file: null, tried: candidates }
}

/**
 * 把手册同步到 `<DSH_HOME|~/.dsh>/skills/<name>/SKILL.md`。
 * @returns {{ synced: boolean, reason: string, target?: string }}
 */
export function syncSkillHandbook(logger) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const targetDir = join(home, 'skills', SKILL_NAME)
  const targetFile = join(targetDir, 'SKILL.md')
  let here = ''
  try { here = fileURLToPath(import.meta.url) } catch { /* ignore */ }
  const { file: srcFile, tried } = findSource()

  if (srcFile === null) {
    logLine(`跳过：包内找不到手册。here=${here} 候选=${tried.join(' | ')}`)
    return { synced: false, reason: '包内没有 SKILL.md' }
  }

  let source
  try { source = readFileSync(srcFile, 'utf8') } catch (e) {
    logLine(`跳过：读不了源文件 ${srcFile}：${String(e?.message ?? e)}`)
    return { synced: false, reason: '读不了源文件' }
  }

  if (existsSync(targetFile)) {
    let current = ''
    try { current = readFileSync(targetFile, 'utf8') } catch { /* ignore */ }
    if (current === source) {
      logLine(`已是最新，不写：${targetFile}`)
      return { synced: false, reason: '已是最新', target: targetFile }
    }
    if (!current.includes(OWNER_MARK)) {
      logLine(`同名技能不是本插件的，保持不动：${targetFile}`)
      logger?.warn?.('[dsh-quill-user] 技能目录已有一份不是本插件的手册，保持不动：' + targetFile)
      return { synced: false, reason: '同名技能不是本插件的，跳过', target: targetFile }
    }
  }

  try {
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(targetFile, source)
    logLine(`已同步：${srcFile} → ${targetFile}（${source.length} 字节）`)
    logger?.info?.('[dsh-quill-user] 已同步「羽毛笔」手册到 ' + targetFile)
    return { synced: true, target: targetFile }
  } catch (e) {
    logLine(`写失败：${targetFile}：${String(e?.message ?? e)}`)
    logger?.warn?.('[dsh-quill-user] 同步技能手册失败（不影响面板）：' + String(e?.message ?? e))
    return { synced: false, reason: String(e?.message ?? e), target: targetFile }
  }
}
