// 下载缓存清理：Yoinks/tmp 下失败/中断任务残留的临时分片与工作文件会累积。
// 清理会跳过正在运行的任务目录（当前 cancelPath 对应的 taskId）以及最近
// ACTIVE_WINDOW_MS 内仍有写入的条目（可能正在下载或刚结束）。

import { Path } from "scripting"

const CACHE_DIR = Path.join(FileManager.documentsDirectory, "Yoinks", "tmp")
const ACTIVE_WINDOW_MS = 10 * 60 * 1000

function isDirectory(path: string): boolean {
  try {
    FileManager.readDirectorySync(path)
    return true
  } catch {
    return false
  }
}

function directorySize(path: string): number {
  let total = 0
  try {
    for (const name of FileManager.readDirectorySync(path)) {
      const full = Path.join(path, name)
      try {
        if (isDirectory(full)) total += directorySize(full)
        else {
          const stat = FileManager.statSync(full)
          total += typeof stat.size === "number" ? stat.size : 0
        }
      } catch {}
    }
  } catch {}
  return total
}

/** 总下载缓存字节数（tmp 下所有条目）。 */
export async function downloadCacheSize(): Promise<number> {
  if (!FileManager.existsSync(CACHE_DIR)) return 0
  return directorySize(CACHE_DIR)
}

/**
 * 从当前取消标记路径提取活动任务 id。
 * 支持两种形态：…/tmp/<taskId>/cancel（HLS/yt-dlp 任务）与 …/tmp/<taskId>.cancel（抖音任务）。
 */
export function activeTaskIdFromCancelPath(cancelPath: string | null | undefined): string | null {
  if (!cancelPath) return null
  const parts = String(cancelPath).split("/").filter(Boolean)
  const last = parts[parts.length - 1] || ""
  const second = parts[parts.length - 2] || ""
  if (last.endsWith(".cancel")) return last.slice(0, -".cancel".length)
  if (second && second !== "tmp" && second !== "Yoinks") return second
  return null
}

/**
 * 清理 tmp 下的非活动缓存。返回删除的字节数与条目数。
 * - 跳过 activeTaskId 对应目录（正在运行的下载任务）。
 * - 跳过最近 ACTIVE_WINDOW_MS 内仍有写入的目录/文件。
 * - 删除其它所有子目录（含分片）与 *.cancel 标记文件；空目录一并清理。
 */
export async function clearDownloadCache(activeTaskId: string | null): Promise<{ removedBytes: number; removedItems: number }> {
  if (!FileManager.existsSync(CACHE_DIR)) return { removedBytes: 0, removedItems: 0 }
  let removedBytes = 0
  let removedItems = 0
  const now = Date.now()
  for (const name of FileManager.readDirectorySync(CACHE_DIR)) {
    if (name === activeTaskId) continue
    const full = Path.join(CACHE_DIR, name)
    try {
      const stat = FileManager.statSync(full)
      if (typeof stat.modificationDate === "number" && now - stat.modificationDate < ACTIVE_WINDOW_MS) continue
    } catch {
      continue
    }
    try {
      const size = isDirectory(full) ? directorySize(full) : (FileManager.statSync(full).size || 0)
      FileManager.removeSync(full)
      removedBytes += size
      removedItems += 1
    } catch {}
  }
  return { removedBytes, removedItems }
}
