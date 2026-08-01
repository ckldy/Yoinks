import { Script } from "scripting"
import { activeTaskIdFromCancelPath } from "./services/cache"

const cacheSource = FileManager.readAsStringSync(`${Script.directory}/services/cache.ts`)
const indexSource = FileManager.readAsStringSync(`${Script.directory}/index.tsx`)

const checks: Array<[string, boolean]> = [
  // activeTaskIdFromCancelPath：目录形态（HLS/yt-dlp）与文件形态（抖音）
  ["extracts task id from directory cancel path", activeTaskIdFromCancelPath("/var/.../tmp/2026-08-01T10-50-49Z-abc123/cancel") === "2026-08-01T10-50-49Z-abc123"],
  ["extracts task id from file cancel path", activeTaskIdFromCancelPath("/var/.../tmp/2026-08-01T10-50-49Z-abc123.cancel") === "2026-08-01T10-50-49Z-abc123"],
  ["returns null without a cancel path", activeTaskIdFromCancelPath(null) === null && activeTaskIdFromCancelPath(undefined) === null],
  // 清理实现：跳过活动任务 + 最近写入保护 + 删除其它条目
  ["skips the active task directory", /if \(name === activeTaskId\) continue/.test(cacheSource)],
  ["skips recently written entries", /now - stat\.modificationDate < ACTIVE_WINDOW_MS/.test(cacheSource)],
  ["removes other directories and cancel markers", /FileManager\.removeSync\(full\)/.test(cacheSource)],
  ["recursively sums directory size", /function directorySize\(path: string\): number[\s\S]*FileManager\.readDirectorySync\(path\)/.test(cacheSource)],
  ["returns removed bytes and item count", /Promise<\{ removedBytes: number; removedItems: number \}>/.test(cacheSource)],
  ["uses the Yoinks tmp directory", /Path\.join\(FileManager\.documentsDirectory, \"Yoinks\", \"tmp\"\)/.test(cacheSource)],
  // 设置页入口
  ["settings page shows cache size", /下载缓存：\{downloadCacheBytes == null \? \"…\" : formatBytes\(downloadCacheBytes\)\}/.test(indexSource)],
  ["settings page exposes a clear button", /清理下载缓存/.test(indexSource) && /clearDownloadCacheNow\(\)/.test(indexSource)],
  ["clear button is guarded while busy", /disabled=\{downloading \|\| analyzing \|\| cacheClearing\}/.test(indexSource)],
  ["handler refreshes after clearing and reports result", /await clearDownloadCache\(activeTaskId\)[\s\S]{0,120}refreshDownloadCache\(\)/.test(indexSource)],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Cache cleanup checks failed: ${failed.join(", ")}`)
console.log(`Cache cleanup checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
