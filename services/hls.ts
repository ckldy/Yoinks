// HLS / m3u8 分片下载模块：从 services/media.ts 拆分，内聚 HLS 清单解析与原生分片下载。
// 依赖 shell-utils（quote/runCommand/formatBytes）、logs（logEvent）、douyin（MOBILE_SAFARI_UA）。

import { AbortController, Path, fetch } from "scripting"
import { logEvent } from "./logs"
import { MOBILE_SAFARI_UA } from "./douyin"
import { formatBytes, quote, runCommand } from "./shell-utils"

export function isM3U8URL(url: string): boolean {
  const lower = url.toLowerCase()
  return lower.includes(".m3u8") || lower.includes("application/x-mpegurl") || lower.includes("application/vnd.apple.mpegurl")
}

export type HlsManifestSummary = { segmentCount: number; durationSeconds: number; endList: boolean }

/** Parse only the conservative media facts needed to detect a one-segment false success. */
export function parseHlsManifestSummary(text: string): HlsManifestSummary | undefined {
  if (!/^\s*#EXTM3U/m.test(text || "")) return undefined
  const durations = [...text.matchAll(/^\s*#EXTINF:([0-9]+(?:\.[0-9]+)?)/gm)].map((match) => Number(match[1])).filter(Number.isFinite)
  if (!durations.length) return undefined
  return { segmentCount: durations.length, durationSeconds: durations.reduce((sum, value) => sum + value, 0), endList: /^\s*#EXT-X-ENDLIST\s*$/m.test(text) }
}

export type HlsVariant = { uri: string; height: number; bandwidth: number }

/**
 * All variants of an HLS master playlist, highest RESOLUTION first (BANDWIDTH tie-break),
 * URI-deduped. Direct media playlists (no #EXT-X-STREAM-INF) return an empty array.
 */
export function listHlsVariants(master: string): HlsVariant[] {
  const seen = new Set<string>()
  const variants: HlsVariant[] = []
  const lines = String(master || "").split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue
    const uri = (lines[index + 1] || "").trim()
    if (!uri || uri.startsWith("#") || seen.has(uri)) continue
    seen.add(uri)
    const attrs = line.slice("#EXT-X-STREAM-INF:".length)
    const resolution = attrs.match(/(?:^|,)\s*RESOLUTION\s*=\s*(\d+)\s*x\s*(\d+)/i)
    const height = resolution ? Number(resolution[2]) : 0
    const bandwidth = Number(attrs.match(/(?:^|,)\s*BANDWIDTH\s*=\s*(\d+)/i)?.[1] || 0)
    variants.push({ uri, height, bandwidth })
  }
  variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth)
  return variants
}

/**
 * Pick the highest-resolution variant of an HLS master playlist, falling back to
 * the highest BANDWIDTH when RESOLUTION is absent. Returns undefined for direct
 * media playlists (no #EXT-X-STREAM-INF). Preview players (AVPlayer/hls.js) always
 * pick the top variant, so downloads must do the same — previously only the FIRST
 * variant was used, yielding e.g. 240p while the preview played 2160p (EPORNER/xHamster).
 */
export function selectHighestHlsVariant(master: string): HlsVariant | undefined {
  return listHlsVariants(master)[0]
}

/** A short VOD output is likely a first segment masquerading as a completed MP4. */
export function hlsCompletenessFailure(manifest: HlsManifestSummary | undefined, outputDurationSeconds: number | undefined): string | undefined {
  if (!manifest || manifest.segmentCount < 2 || !manifest.endList || !Number.isFinite(outputDurationSeconds)) return undefined
  const required = Math.max(manifest.durationSeconds * 0.9, manifest.durationSeconds - 5)
  if ((outputDurationSeconds as number) + 0.1 < required) {
    return `HLS 下载不完整：清单含 ${manifest.segmentCount} 个分片、约 ${Math.round(manifest.durationSeconds)} 秒，输出仅约 ${Math.round(outputDurationSeconds as number)} 秒；未保存文件。`
  }
  return undefined
}

/** Safari-imported HLS must fail closed: an unverified manifest can hide a single segment. */
export function hlsPublishFailure(manifest: HlsManifestSummary | undefined, outputDurationSeconds: number | undefined): string | undefined {
  if (!manifest) return "HLS 清单无法验证完整性；为避免保存单分片，未保存文件。"
  return hlsCompletenessFailure(manifest, outputDurationSeconds)
}

export async function readHlsManifestSummary(sourceURL: string, referer?: string, userAgent?: string): Promise<HlsManifestSummary | undefined> {
  // 无 referer 的 m3u8 直链也统一携带移动 Safari UA，提高 CDN 兼容性。
  const ua = userAgent || MOBILE_SAFARI_UA
  const request = async (url: string) => {
    const args = ["curl -fsSL --max-time 30", `-A ${quote(ua)}`, referer ? `-e ${quote(referer)}` : "", quote(url)].filter(Boolean).join(" ")
    const result = await runCommand(args, 45)
    return result.exitCode === 0 ? String(result.output || "") : undefined
  }
  const master = await request(sourceURL)
  if (!master) return undefined
  const direct = parseHlsManifestSummary(master)
  if (direct) return direct
  // Master playlists: pick the highest-resolution variant (preview players do the same).
  const variant = selectHighestHlsVariant(master)
  if (!variant) return undefined
  try {
    const media = await request(new URL(variant.uri, sourceURL).toString())
    return media ? parseHlsManifestSummary(media) : undefined
  } catch {
    return undefined
  }
}

async function fetchHlsWithSafariHeaders(url: string, referer?: string, userAgent?: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.apple.mpegurl, */*;q=0.9",
        ...(userAgent ? { "User-Agent": userAgent } : {}),
        ...(referer ? { Referer: referer } : {}),
      },
    })
    if (!response.ok) return null
    return await response.text()
  } catch {
    return null
  }
}

/** Media playlist URI lines (skip #-tags) resolved against the playlist URL. */
function hlsSegmentURLs(playlistText: string, baseURL: string): string[] {
  const segments: string[] = []
  for (const line of String(playlistText || "").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    try {
      segments.push(new URL(trimmed, baseURL).toString())
    } catch {}
  }
  return segments
}

/**
 * Native HLS segment downloader strategy.
 * - "fetch": Scripting fetch / NSURLSession native stack first (HTTP/2 connection reuse,
 *   same as the online preview) with a speed gate; falls back to curl batches when the
 *   connection is not reused (slow) or fails.
 * - "curl": direct curl -Z batches (HTTP/1.1, no reuse) — kept for debugging/fallback.
 */
const HLS_NATIVE_MODE: "curl" | "fetch" = "fetch"

async function downloadHlsSegmentsCurlBatches(options: {
  workDirectory: string
  referer?: string
  userAgent?: string
  onProgress?: (value: { fraction: number; stage: string; downloadedBytes?: number; totalBytes?: number; speed?: number }) => void
  isCancelFlagSet?: () => boolean
}, segments: string[], count: number): Promise<void> {
  const BATCH = 30
  const PARALLEL = 8
  const headerArgs = [options.userAgent ? `-A ${quote(options.userAgent)}` : "", options.referer ? `-e ${quote(options.referer)}` : ""].filter(Boolean).join(" ")
  const segmentFile = (index: number) => Path.join(options.workDirectory, `seg_${String(index).padStart(5, "0")}.ts`)
  const fileExists = (index: number): boolean => {
    try {
      const path = segmentFile(index)
      return FileManager.existsSync(path) && FileManager.statSync(path).size > 0
    } catch {
      return false
    }
  }
  let lastBytes = 0
  let lastSampleAt = Date.now()
  let speed = 0
  const progress = (completed: number) => {
    if (options.isCancelFlagSet?.()) {
      // 取消请求已写入，但当前 curl -Z 批次无法中途终止（Shell.run 无 kill 能力），
      // 给出明确反馈并停住进度，避免用户误以为页面卡死。
      options.onProgress?.({
        fraction: 0.15 + 0.78 * (Math.min(completed, count) / count),
        stage: "正在停止（等待当前批次结束）…",
      })
      return
    }
    let files = completed
    let bytes = 0
    try {
      const names = FileManager.readDirectorySync(options.workDirectory)
      files = names.filter((n) => n.startsWith("seg_")).length
      for (const name of names) {
        if (!name.startsWith("seg_")) continue
        const stat = FileManager.statSync(Path.join(options.workDirectory, name))
        bytes += typeof stat.size === "number" ? stat.size : 0
      }
    } catch {}
    const now = Date.now()
    if (now - lastSampleAt >= 1000) {
      speed = ((bytes - lastBytes) * 1000) / Math.max(1, now - lastSampleAt)
      lastBytes = bytes
      lastSampleAt = now
    }
    const done = Math.min(files, count)
    const speedLabel = speed > 0 ? ` · ${formatBytes(speed)}/s` : ""
    options.onProgress?.({
      fraction: 0.15 + 0.78 * (done / count),
      stage: `正在下载分片 ${done} / ${count}${speedLabel}`,
      downloadedBytes: bytes || undefined,
      speed: speed || undefined,
    })
  }
  let completed = 0
  const failures: string[] = []
  for (let start = 0; start < count && !options.isCancelFlagSet?.(); start += BATCH) {
    const end = Math.min(count, start + BATCH)
    // 只补缺失分片：fetch-first 兜底时复用已写 seg_*，避免全量重下已存在的分片。
    const pending = Array.from({ length: end - start }, (_, i) => start + i).filter((index) => !fileExists(index))
    if (pending.length) {
      const curlParts: string[] = ["curl", "-k", "-sS", "-f", "-Z", `--parallel-max ${PARALLEL}`, "--connect-timeout 15", "--max-time 30"]
      if (headerArgs) curlParts.push(headerArgs)
      for (const index of pending) curlParts.push(`-o ${quote(segmentFile(index))}`, quote(segments[index]))
      let stopped = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const poll = () => {
        if (stopped) return
        progress(completed)
        timer = setTimeout(poll, 500)
      }
      timer = setTimeout(poll, 500)
      // 批内无法被取消打断（Shell.run 无 kill）；批次已从 100 缩小到 30，并把每片与整体超时收短，
      // 取消响应最快一个批次（正常 3-12s，极端不超过 150s），而不是原来的最长 600s。
      const result = await runCommand(curlParts.join(" "), 150)
      stopped = true
      if (timer) clearTimeout(timer)
      if (options.isCancelFlagSet?.()) break
      const missing = pending.filter((index) => !fileExists(index))
      for (const index of missing) {
        if (options.isCancelFlagSet?.()) break
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const retry = await runCommand(`curl -k -sS -f --connect-timeout 15 --max-time 30 ${headerArgs} -o ${quote(segmentFile(index))} ${quote(segments[index])}`, 60)
          if (retry.exitCode === 0 && fileExists(index)) break
        }
        if (!fileExists(index)) failures.push(`分片 ${index + 1}`)
      }
    }
    completed = end
    progress(completed)
  }
  if (options.isCancelFlagSet?.()) throw new Error("下载已取消")
  if (failures.length) throw new Error(`分片下载失败（已完成 ${completed}/${count}）：${failures.slice(0, 3).join("、")} 等 ${failures.length} 片下载失败`)
}

/**
 * Native-stack HLS segment downloader (Scripting fetch / NSURLSession, HTTP/2 reuse —
 * the same stack the online preview uses). Downloads with a small concurrency (4 is the
 * measured stable level on this device; higher exhausts memory) and a speed gate: if the
 * first GATE segments are slower than ~1.5 seg/s the connection is not being reused
 * (e.g. capture MITM downgrades to HTTP/1.1) and it returns { slow: true } so the caller
 * can fall back to curl batches — which reuse the seg_* files already written here.
 */
async function downloadHlsSegmentsFetch(
  options: {
    workDirectory: string
    referer?: string
    userAgent?: string
    onProgress?: (value: { fraction: number; stage: string; downloadedBytes?: number; totalBytes?: number; speed?: number }) => void
    isCancelFlagSet?: () => boolean
  },
  segments: string[],
  count: number,
): Promise<{ slow: boolean }> {
  const maxConcurrent = 4
  const GATE = Math.min(24, count)
  const gateStartedAt = Date.now()
  let gateHit = false
  let fetchSlow = false
  let cursor = 0
  let completed = 0
  const failures: Error[] = []
  let downloadedBytes = 0
  let sampleBytes = 0
  let sampleAt = Date.now()
  let speed = 0
  const sizes: number[] = []
  const downloadOne = async (index: number): Promise<void> => {
    if (options.isCancelFlagSet?.()) return
    let lastError: Error | null = null
    const destination = Path.join(options.workDirectory, `seg_${String(index).padStart(5, "0")}.ts`)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (options.isCancelFlagSet?.()) return
      try {
        if (FileManager.existsSync(destination)) FileManager.removeSync(destination)
      } catch {}
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30_000)
        try {
          const response = await fetch(segments[index], {
            headers: {
              Accept: "*/*",
              ...(options.userAgent ? { "User-Agent": options.userAgent } : {}),
              ...(options.referer ? { Referer: options.referer } : {}),
            },
            signal: controller.signal,
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const reader = response.dataStream.getReader()
          let size = 0
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              if (value) {
                await FileManager.appendData(destination, value)
                size += value.size
              }
            }
          } finally {
            try {
              reader.releaseLock()
            } catch {}
          }
          downloadedBytes += size
          sizes.push(size)
          return
        } finally {
          clearTimeout(timeout)
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
      }
    }
    failures.push(lastError || new Error("分片下载失败"))
  }
  const workers = Array.from({ length: Math.min(maxConcurrent, count) }, async () => {
    while (!failures.length && !fetchSlow && !options.isCancelFlagSet?.() && cursor < count) {
      const index = cursor
      cursor += 1
      await downloadOne(index)
      completed += 1
      // Speed gate: 24 segments must finish within 16s (~1.5 seg/s) or the native stack is
      // not reusing the connection (capture MITM / HTTP/1.1), so curl batches take over.
      if (!gateHit && completed >= GATE) {
        gateHit = true
        if (Date.now() - gateStartedAt > 16000) fetchSlow = true
      }
      if (options.isCancelFlagSet?.()) break
      const now = Date.now()
      if (now - sampleAt >= 1000) {
        speed = ((downloadedBytes - sampleBytes) * 1000) / Math.max(1, now - sampleAt)
        sampleBytes = downloadedBytes
        sampleAt = now
      }
      const avg = sizes.length ? sizes.reduce((sum, size) => sum + size, 0) / sizes.length : 0
      const totalEstimate = avg > 0 ? Math.round(avg * count) : undefined
      options.onProgress?.({
        fraction: 0.15 + 0.78 * (completed / count),
        stage: `正在下载分片 ${completed} / ${count}`,
        downloadedBytes,
        totalBytes: totalEstimate,
        speed,
      })
    }
  })
  await Promise.all(workers)
  if (options.isCancelFlagSet?.()) throw new Error("下载已取消")
  if (fetchSlow) return { slow: true }
  const failedError = failures[0]
  if (failedError) throw new Error(`分片下载失败（已完成 ${completed}/${count}）：${failedError.message}`)
  return { slow: false }
}

/**
 * Some CDNs accept Safari/native TLS but drop ffmpeg's OpenSSL handshake ("End of file" /
 * "Remote end closed connection without response"). When that happens, download the VOD
 * segments with Scripting fetch (native TLS, Referer + UA only, no cookies) and remux them
 * locally with ffmpeg so no network TLS is needed for the media bytes.
 */
export async function downloadHlsSegmentsNative(options: {
  sourceURL: string
  destination: string
  workDirectory: string
  referer?: string
  userAgent?: string
  /** When the user picked a specific master variant, download exactly that variant's segments. */
  variantURI?: string
  onProgress?: (value: { fraction: number; stage: string; downloadedBytes?: number; totalBytes?: number; speed?: number }) => void
  isCancelFlagSet?: () => boolean
}): Promise<HlsManifestSummary | undefined> {
  // 无 referer 的 m3u8 直链也统一携带移动 Safari UA，提高 CDN 兼容性（yt-dlp 路径不受影响）。
  const userAgent = options.userAgent || MOBILE_SAFARI_UA
  const nativeOptions = { ...options, userAgent }
  const master = await fetchHlsWithSafariHeaders(options.sourceURL, options.referer, userAgent)
  if (!master) return undefined
  let mediaURL = options.sourceURL
  let mediaText = master
  // User-selected variant: use exactly that variant's media playlist.
  if (options.variantURI) {
    try {
      mediaURL = new URL(options.variantURI, options.sourceURL).toString()
    } catch {
      return undefined
    }
    mediaText = (await fetchHlsWithSafariHeaders(mediaURL, options.referer, userAgent)) || ""
    if (!mediaText) return undefined
  } else {
    // No explicit pick: choose the highest-resolution variant so downloads match the preview
    // quality (AVPlayer/hls.js always select the top variant; the previous first-variant
    // pick downloaded e.g. 240p while previewing 2160p).
    const variant = selectHighestHlsVariant(master)
    if (variant) {
      try {
        mediaURL = new URL(variant.uri, options.sourceURL).toString()
      } catch {
        return undefined
      }
      mediaText = (await fetchHlsWithSafariHeaders(mediaURL, options.referer, userAgent)) || ""
      if (!mediaText) return undefined
    }
  }
  const summary = parseHlsManifestSummary(mediaText)
  // Only VOD (ENDLIST) TS playlists without real key encryption or fMP4 init sections are supported.
  // #EXT-X-KEY:METHOD=NONE explicitly means "no encryption" and must NOT be treated as encrypted:
  // 8xx3 等站点的清单带 METHOD=NONE，此前被误判为加密而跳过原生分片，落入无法取消且本环境
  // 常失败的 ffmpeg 分支（ffmpeg 进程无法被 JS kill，取消只能等其完成/超时）。
  if (!summary || !summary.endList) return undefined
  if (/^\s*#EXT-X-KEY:[^\r\n]*METHOD\s*=\s*(?!NONE\b)\S+/im.test(mediaText) || /^\s*#EXT-X-MAP:/m.test(mediaText)) return undefined
  const segments = hlsSegmentURLs(mediaText, mediaURL)
  const count = segments.length
  if (!count) return undefined
  const finish = async (): Promise<void> => {
    const listPath = Path.join(options.workDirectory, "segments.txt")
    await FileManager.writeAsString(listPath, segments.map((_, index) => `file 'seg_${String(index).padStart(5, "0")}.ts'`).join("\n"))
    const concat = await runCommand(
      `ffmpeg -nostdin -y -f concat -safe 0 -i ${quote(listPath)} -c copy -bsf:a aac_adtstoasc -movflags +faststart ${quote(options.destination)}`,
      1800,
    )
    if (concat.exitCode !== 0 || !FileManager.existsSync(options.destination)) throw new Error("分片合成失败")
  }
  if (HLS_NATIVE_MODE === "curl") {
    await downloadHlsSegmentsCurlBatches(nativeOptions, segments, count)
    options.onProgress?.({ fraction: 0.94, stage: "分片下载完成，正在合成 MP4" })
    await finish()
    options.onProgress?.({ fraction: 0.99, stage: "正在验证媒体文件" })
    return summary
  }
  // fetch-first: native NSURLSession stack (HTTP/2 reuse, same as the online preview)
  // with a speed gate; fall back to curl batches when the connection is not reused (slow)
  // or the native download fails. curl reuses the seg_* files already written here.
  try {
    const fetched = await downloadHlsSegmentsFetch(nativeOptions, segments, count)
    if (fetched.slow) {
      await logEvent({ level: "warn", event: "download.m3u8.fetch-slow", details: { reason: "connection-not-reused", safariRefererApplied: Boolean(options.referer), cookieTransfer: false } })
      await downloadHlsSegmentsCurlBatches(nativeOptions, segments, count)
    }
  } catch (error) {
    if (options.isCancelFlagSet?.()) throw new Error("下载已取消")
    const reason = error instanceof Error ? error.message : String(error)
    await logEvent({ level: "warn", event: "download.m3u8.fetch-fallback", details: { reason: reason.slice(0, 200), safariRefererApplied: Boolean(options.referer), cookieTransfer: false } })
    await downloadHlsSegmentsCurlBatches(nativeOptions, segments, count)
  }
  options.onProgress?.({ fraction: 0.94, stage: "分片下载完成，正在合成 MP4" })
  await finish()
  options.onProgress?.({ fraction: 0.99, stage: "正在验证媒体文件" })
  return summary
}
