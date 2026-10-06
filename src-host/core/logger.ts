import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

let logFile: string | null = null

/** 主进程日志：写到用户数据目录，方便在出问题的机器上直接查看原因。 */
export function log(message: string): void {
  const line = '[' + new Date().toISOString() + '] ' + message
  try {
    if (!logFile) {
      const dir = join(app.getPath('userData'), 'logs')
      mkdirSync(dir, { recursive: true })
      logFile = join(dir, 'main.log')
    }
    appendFileSync(logFile, line + '\n', 'utf8')
  } catch { /* 日志失败不影响应用运行 */ }
  // 同时也写到控制台，开发模式下可见
  console.log(line)
}

/** 安装全局错误捕获，任何未处理异常都记录下来而不是静默消失。 */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (err) => {
    log('未捕获异常：' + (err && err.stack ? err.stack : String(err)))
  })
  process.on('unhandledRejection', (reason) => {
    log('未处理的 Promise 拒绝：' + String(reason))
  })
}

export function logPath(): string | null {
  return logFile
}
