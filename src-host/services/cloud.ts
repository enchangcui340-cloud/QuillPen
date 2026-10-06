import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Dirent } from 'node:fs'
import { shouldSync, normalizeRel, type FileEntry, type FileMap } from '../core/sync-plan'
import { log } from '../core/logger'

/**
 * 云库在本机的落地方式：
 *
 *   <软件文件夹>\data\cloud\<库id>\          当前内容（平时就用它，离线也能写）
 *   <软件文件夹>\data\cloud\<库id>.backup\   上一次"下载"之前的版本（只留一份，可一键恢复）
 *
 * 下载走"改名切换"：先备份现有内容 → 拉云端 → 成功才删备份；失败自动还原。
 */

export interface CloudPaths {
  /** 当前内容 */
  dir: string
  /** 下载前的备份（可恢复） */
  backupDir: string
}

export function cloudPaths(baseDir: string, libId: string): CloudPaths {
  const root = join(baseDir, 'cloud')
  return { dir: join(root, libId), backupDir: join(root, libId + '.backup') }
}

/** 扫描一个目录，生成同步用的文件清单 */
export function scanFiles(root: string): FileMap {
  const map: FileMap = {}
  if (!existsSync(root)) return map
  const walk = (dir: string, prefix: string): void => {
    let entries: Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const rel = normalizeRel(prefix ? prefix + '/' + e.name : e.name)
      if (e.name.startsWith('.tmp-')) continue
      const abs = join(dir, e.name)
      // 排除规则必须对文件和目录都生效，而且要在递归之前判断
      if (e.isDirectory()) {
        if (!shouldSync(rel + '/__probe__')) continue
        walk(abs, rel)
        continue
      }
      if (!shouldSync(rel)) continue
      try {
        const st = statSync(abs)
        map[rel] = { path: rel, size: st.size, mtimeMs: st.mtimeMs }
      } catch { /* 跳过读不到的文件 */ }
    }
  }
  walk(root, '')
  return map
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/**
 * 用新内容替换目录内容，并保留替换前的一份备份。
 * 步骤：现有内容 → 改名成备份（瞬间完成）；新内容写入正式目录。
 * 失败时调用 restoreBackup 还原。
 */
export function stashCurrentAsBackup(paths: CloudPaths): boolean {
  const { dir, backupDir } = paths
  rmSync(backupDir, { recursive: true, force: true })
  if (!existsSync(dir)) { ensureDir(dir); return false }
  renameSync(dir, backupDir)
  ensureDir(dir)
  return true
}

/** 把备份还原回去（下载失败/用户点恢复时用） */
export function restoreBackup(paths: CloudPaths): boolean {
  const { dir, backupDir } = paths
  if (!existsSync(backupDir)) return false
  rmSync(dir, { recursive: true, force: true })
  renameSync(backupDir, dir)
  log('已从备份恢复：' + dir)
  return true
}

/** 丢弃备份（下载成功后调用，保证只留一份） */
export function dropBackup(paths: CloudPaths): void {
  try { rmSync(paths.backupDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

export function hasBackup(paths: CloudPaths): boolean {
  return existsSync(paths.backupDir)
}

/** 把某处内容复制进云库当前目录（用于"下载"落盘前的准备） */
export function copyInto(from: string, to: string): void {
  ensureDir(to)
  if (!existsSync(from)) return
  cpSync(from, to, { recursive: true, force: true })
}
