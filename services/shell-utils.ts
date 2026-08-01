// 下载主链与 HLS 分片下载共用的基础工具。
// 独立成模块是为了避免 services/hls.ts 与 services/media.ts 之间形成循环依赖。

import { Script } from "scripting"

export function quote(value: string): string {
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`
}

export async function runCommand(command: string, timeout: number) {
  return Shell.run(command, { cwd: Script.directory, timeout })
}

export function formatBytes(value?: number): string {
  if (!value || value <= 0) return ""
  const units = ["B", "KB", "MB", "GB"]
  let size = value
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`
}
