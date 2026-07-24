type ProgressLike = {
  fraction: number
  stage: string
  downloadedBytes?: number
  totalBytes?: number
}

const backgroundTasks = new Set<URLSessionDownloadTask>()

function formatBytes(value: number): string {
  if (!value || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let size = value
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers || {})) {
    if (typeof value === "string" && value) result[key] = value
  }
  return result
}

export function cancelBackgroundDownloads() {
  for (const task of Array.from(backgroundTasks)) {
    try {
      task.cancel()
    } catch {}
  }
  backgroundTasks.clear()
}

export async function downloadURLToFileWithProgress(options: {
  url: string
  destination: string
  headers?: Record<string, string>
  start: number
  end: number
  stage: string
  onProgress?: (value: ProgressLike) => void
  isCancelFlagSet?: () => boolean
}): Promise<void> {
  try {
    if (FileManager.existsSync(options.destination)) FileManager.removeSync(options.destination)
  } catch {}

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error | null) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }

    const task = BackgroundURLSession.startDownload({
      url: options.url,
      destination: options.destination,
      headers: normalizeHeaders(options.headers),
    })
    backgroundTasks.add(task)

    task.onProgress = (details) => {
      if (options.isCancelFlagSet?.()) {
        task.cancel()
        return
      }
      const total = details.totalBytesExpectedToWrite
      const downloaded = details.totalBytesWritten
      const inner = total > 0
        ? Math.max(0, Math.min(1, downloaded / total))
        : Math.max(0.02, Math.min(0.96, Math.log2(downloaded / (1024 * 1024) + 1) / 8))
      const fraction = options.start + (options.end - options.start) * inner
      const detail = total > 0
        ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
        : formatBytes(downloaded)
      options.onProgress?.({
        fraction,
        stage: `${options.stage} · ${detail}`,
        downloadedBytes: downloaded,
        totalBytes: total > 0 ? total : undefined,
      })
    }

    task.onComplete = (error) => {
      backgroundTasks.delete(task)
      if (options.isCancelFlagSet?.()) finish(new Error("下载已取消"))
      else finish(error)
    }
    task.resume()
  })

  if (!FileManager.existsSync(options.destination)) {
    throw new Error("下载文件未生成")
  }
}
