import { existsSync, mkdirSync } from 'node:fs'
import type { LibraryPaths } from './paths'
import { ensureDirs, makeLibraryPaths, readJson, writeJsonAtomic } from './paths'
import type { AppConfig } from '@shared/types'

export const DEFAULT_CONFIG: Omit<AppConfig, 'libraryPath'> = {
  model: 'deepseek-flash',
  baseUrl: 'https://api.deepseek.com',
  showNetworkNotice: true,
  lastArea: 'todo',
  theme: 'light'
}

/** 应用级单例：库路径、配置、各类数据仓库共享同一实例。 */
export class Store {
  paths!: LibraryPaths
  config!: AppConfig

  constructor(configFile: string) {
    this.configFile = configFile
    const cfg = readJson<Partial<AppConfig>>(configFile, {})
    const libraryPath = cfg.libraryPath && cfg.libraryPath.trim() ? cfg.libraryPath : ''
    this.config = { libraryPath, ...DEFAULT_CONFIG, ...cfg } as AppConfig
    this.attachLibrary(this.config.libraryPath)
  }

  private configFile: string

  attachLibrary(root: string): void {
    this.paths = makeLibraryPaths(root)
    ensureDirs(this.paths)
  }

  setLibrary(root: string): void {
    this.config = { ...this.config, libraryPath: root }
    this.attachLibrary(root)
    this.saveConfig()
  }

  saveConfig(): void {
    mkdirSync(this.paths?.root ?? '.', { recursive: true })
    writeJsonAtomic(this.configFile, this.config)
  }

  patchConfig(patch: Partial<AppConfig>): AppConfig {
    this.config = { ...this.config, ...patch }
    this.saveConfig()
    return this.config
  }

  /** 库被外部删除或指向不存在目录时重建基础结构。 */
  ensureLibrary(): void {
    if (!this.paths || !existsSync(this.paths.root)) {
      this.attachLibrary(this.config.libraryPath)
    }
  }
}
