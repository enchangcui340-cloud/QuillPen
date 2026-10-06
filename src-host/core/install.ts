import { basename, isAbsolute, join, relative } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * 绿色便携版判定。
 *
 * 文件夹里有「工作区」就视为**便携安装**：
 *   - 数据目录（设置、API Key、日志、缓存）全部放在 <软件文件夹>\data
 *   - 笔记库是 <软件文件夹>\工作区，配置里存**相对路径**（"工作区"）
 * 这样整个文件夹压缩拷到别的电脑、换个盘符、改个文件夹名，打开就能继续用。
 *
 * 没有「工作区」的（开发环境、单份安装）沿用 %APPDATA%\workapp。
 */
export interface InstallPlan {
  /** 应用数据目录（config.json / secrets.json / logs / 缓存） */
  userData: string
  /** 该安装自己的笔记库；null 表示沿用统一数据目录里的配置 */
  ownLibrary: string | null
  /** 是否便携版 */
  portable: boolean
  /** 便携版的根目录（软件文件夹），非便携为 null */
  installDir: string | null
  /** 该安装的标识（日志/名称冲突时用） */
  slug: string
}

/** 去掉名字里的特殊字符，并附一小段哈希避免重名 */
export function installSlug(name: string): string {
  const cleaned = (name || 'app').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '')
  const hash = createHash('sha1').update(name || 'app').digest('hex').slice(0, 6)
  return (cleaned.slice(0, 24) || 'app') + '-' + hash
}

export function resolveInstallData(
  exeDir: string,
  appDataRoot: string,
  exists: (p: string) => boolean
): InstallPlan {
  const own = join(exeDir, '工作区')
  if (exists(own)) {
    return {
      userData: join(exeDir, 'data'),
      ownLibrary: own,
      portable: true,
      installDir: exeDir,
      slug: installSlug(basename(exeDir))
    }
  }
  return {
    userData: join(appDataRoot, 'workapp'),
    ownLibrary: null,
    portable: false,
    installDir: null,
    slug: 'workapp'
  }
}

/** 笔记库路径不该出现盘符：库在软件文件夹内部就存成相对路径 */
export function toStoredLibraryPath(abs: string, installDir: string | null): string {
  if (!installDir) return abs
  const rel = relative(installDir, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return abs
  return rel
}

/** 反过来：把配置里存的路径还原成绝对路径 */
export function resolveLibraryRoot(stored: string, installDir: string | null): string {
  if (!stored) return ''
  if (isAbsolute(stored)) return stored
  return join(installDir ?? process.cwd(), stored)
}

/**
 * 是否要把旧位置（应用数据目录）的配置/密钥迁移进这个软件文件夹。
 *
 * 只在"这个软件文件夹从没初始化过"时迁移一次。
 * 判断依据：没有 config.json 也没有迁移标记。
 *
 * 为什么必须这样做：如果每次启动都做"缺什么补什么"，
 * 用户主动删掉的 API Key 会在下次启动被重新拷回来 —— 看起来就是"删不掉"。
 */
export function shouldMigrateInto(dir: string, fileExists: (p: string) => boolean): boolean {
  return !fileExists(join(dir, 'config.json')) && !fileExists(join(dir, MIGRATION_MARKER))
}

/** 迁移完成后留下的标记，避免重复迁移 */
export const MIGRATION_MARKER = '.migrated-from-appdata'
