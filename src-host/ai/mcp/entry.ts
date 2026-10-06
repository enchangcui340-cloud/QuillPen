/**
 * MCP 入口桩（DSH 版）。
 *
 * 原实现让 Quill 以 `--quill-mcp` 启动、把自己变成 stdio MCP 服务器，
 * 供内嵌的 harness 引擎调用那 28 个语义工具。DSH 版不采用这条链路
 * （宿主逻辑直接跑在 DSH 宿主进程里），因此两个函数都退化为「不是 MCP 模式」。
 */

export function isMcpMode(_argv: string[]): boolean {
  return false
}

export async function runMcpMode(_deps: unknown): Promise<never> {
  throw new Error('MCP 模式未启用（DSH 版不需要内嵌引擎）')
}
