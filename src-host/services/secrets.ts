/**
 * 密钥服务桩（DSH 版）。
 *
 * 原实现把 API Key 明文存在 `<userData>/secrets.json`，只为「随笔记」服务。
 * DSH 版没有 AI，这里保留同名方法（`setKey`/`clear`）以免改动 `index.ts`，
 * 但不落盘、不读取 —— 密钥留在 DSH 自己的凭据体系里。
 */

export class SecretService {
  constructor(..._args: unknown[]) {}

  setKey(_key: string): void {}

  clear(): void {}

  get(): string | undefined {
    return undefined
  }
}
