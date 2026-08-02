// HLS / m3u8 分片下载模块：从 services/media.ts 拆分，内聚 HLS 清单解析与原生分片下载。
// 依赖 shell-utils（quote/runCommand/formatBytes）、logs（logEvent）、douyin（MOBILE_SAFARI_UA）。

import { AbortController, Path, fetch } from "scripting"
import { logEvent } from "./logs"
import { MOBILE_SAFARI_UA } from "./douyin"
import { formatBytes, quote, runCommand } from "./shell-utils"
import { decryptAES128CBC, hlsSequenceIV, parseHlsHexIV } from "./hls-crypto"

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

/** 下载二进制资源（AES-128 KEY / EXT-X-MAP init 段），带 Referer + UA，30s 超时。 */
async function fetchHlsBinary(url: string, referer?: string, userAgent?: string, range?: string): Promise<Uint8Array | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const headers: Record<string, string> = {
        Accept: "*/*",
        ...(userAgent ? { "User-Agent": userAgent } : {}),
        ...(referer ? { Referer: referer } : {}),
      }
      if (range) headers.Range = range
      const response = await fetch(url, {
        headers,
        signal: controller.signal,
      })
      if (!response.ok) return null
      return new Uint8Array(await response.arrayBuffer())
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    return null
  }
}

/** 下载 AES-128 密钥并校验 16 字节；失败返回 null（调用方落入 yt-dlp 兑底）。 */
async function fetchHlsKey(keyURI: string, referer?: string, userAgent?: string): Promise<Uint8Array | null> {
  const key = await fetchHlsBinary(keyURI, referer, userAgent)
  if (!key || key.byteLength !== 16) return null
  return key
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
export type HlsEncryptionMethod = "none" | "aes-128" | "unsupported"

export type HlsByteRange = { offset: number; length: number }

export type HlsSegment = { url: string; byteRange?: HlsByteRange }

/** 媒体清单解析结果：分片 URL、AES-128 密钥配置、EXT-X-MAP init 段与序号基线。 */
export type HlsMediaPlaylistPlan = {
  segments: HlsSegment[]
  method: HlsEncryptionMethod
  /** AES-128 密钥 URI（相对已绝对化）。 */
  keyURI?: string
  /** 清单指定 IV（16 字节）；缺省时按分片序号生成（hlsSequenceIV）。 */
  keyIV?: Uint8Array
  /** EXT-X-MAP init 段 URI（相对已绝对化）；存在即为 fMP4/CMAF。 */
  initURI?: string
  /** EXT-X-MAP init 段字节范围（BYTERANGE 属性）。 */
  initByteRange?: HlsByteRange
  /** EXT-X-MEDIA-SEQUENCE 基线，用于缺省 IV 的分片序号。 */
  mediaSequence: number
  /** 是否 fMP4/CMAF（含 EXT-X-MAP），影响分片内容校验规则。 */
  isMP4: boolean
}

/** 提取 HLS 属性串（逗号分隔的 NAME=value）中的值，支持双引号。 */
function hlsAttributeString(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^,\"\\s]+))`, "i"))
  const value = match?.[1] ?? match?.[2]
  return value && value.length ? value : undefined
}

function resolveHlsURL(uri: string, baseURL: string): string | undefined {
  try {
    return new URL(uri, baseURL).toString()
  } catch {
    return undefined
  }
}

/** 解析 #EXT-X-BYTERANGE:length[@offset]（offset 缺省时紧跟上一分片末尾）。 */
function parseHlsByteRange(value: string, previousEnd: number | undefined): HlsByteRange | undefined {
  const match = String(value || "").trim().match(/^(\d+)(?:@(\d+))?$/)
  if (!match) return undefined
  const length = Number(match[1])
  const offset = match[2] ? Number(match[2]) : previousEnd
  if (!Number.isFinite(length) || length <= 0 || offset === undefined || !Number.isFinite(offset)) return undefined
  return { offset, length }
}

/** 构造 Range 请求头值；无 byteRange 返回 undefined。 */
export function hlsRangeHeader(segment: HlsSegment | undefined): string | undefined {
  if (!segment?.byteRange) return undefined
  const { offset, length } = segment.byteRange
  return `bytes=${offset}-${offset + length - 1}`
}

/** 分片 URL（curl 路径直接使用）。 */
function hlsSegmentURL(segment: HlsSegment): string {
  return segment.url
}

/**
 * 解析媒体清单：分片 URL + #EXT-X-KEY（AES-128/NONE/其它）+ #EXT-X-MAP + #EXT-X-BYTERANGE + 序号基线。
 * 多个 KEY 标签按出现顺序覆盖（取最后状态）；key rotation（清单中途换 key）暂不支持，
 * 用最后 KEY 解密失败时由调用方落入 yt-dlp 兑底。
 */
export function parseHlsMediaPlaylist(playlistText: string, baseURL: string): HlsMediaPlaylistPlan {
  const plan: HlsMediaPlaylistPlan = { segments: [], method: "none", mediaSequence: 0, isMP4: false }
  let pendingByteRange: HlsByteRange | undefined
  let previousRangeEnd: number | undefined
  for (const line of String(playlistText || "").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const seq = Number(trimmed.slice("#EXT-X-MEDIA-SEQUENCE:".length).trim())
      if (Number.isFinite(seq) && seq >= 0) plan.mediaSequence = Math.floor(seq)
      continue
    }
    if (trimmed.startsWith("#EXT-X-MAP:")) {
      const attrs = trimmed.slice("#EXT-X-MAP:".length)
      const uri = hlsAttributeString(attrs, "URI")
      if (uri) plan.initURI = resolveHlsURL(uri, baseURL)
      const initRangeAttr = hlsAttributeString(attrs, "BYTERANGE")
      if (initRangeAttr) plan.initByteRange = parseHlsByteRange(initRangeAttr, undefined)
      plan.isMP4 = true
      continue
    }
    if (trimmed.startsWith("#EXT-X-KEY:")) {
      const attrs = trimmed.slice("#EXT-X-KEY:".length)
      const method = hlsAttributeString(attrs, "METHOD")
      if (method === "NONE") {
        plan.method = "none"
      } else if (method === "AES-128") {
        const uri = hlsAttributeString(attrs, "URI")
        const iv = hlsAttributeString(attrs, "IV")
        plan.method = "aes-128"
        if (uri) plan.keyURI = resolveHlsURL(uri, baseURL)
        plan.keyIV = iv ? parseHlsHexIV(iv) : undefined
      } else if (method) {
        plan.method = "unsupported"
      }
      continue
    }
    if (trimmed.startsWith("#EXT-X-BYTERANGE:")) {
      pendingByteRange = parseHlsByteRange(trimmed.slice("#EXT-X-BYTERANGE:".length), previousRangeEnd)
      continue
    }
    if (trimmed.startsWith("#")) continue
    try {
      const url = new URL(trimmed, baseURL).toString()
      const segment: HlsSegment = pendingByteRange ? { url, byteRange: pendingByteRange } : { url }
      if (segment.byteRange) previousRangeEnd = segment.byteRange.offset + segment.byteRange.length
      plan.segments.push(segment)
      pendingByteRange = undefined
    } catch {}
  }
  return plan
}

/** 分片内容粗校验：TS 分片首字节 0x47；fMP4 分片前 8 字节含 moof/mdat/styp/free/moov。 */
function hlsSegmentLooksValid(chunk: Uint8Array, kind: "ts" | "mp4"): boolean {
  if (kind === "ts") return chunk.length > 0 && chunk[0] === 0x47
  if (chunk.length < 8) return false
  const type = String.fromCharCode(chunk[4], chunk[5], chunk[6], chunk[7])
  return type === "moof" || type === "mdat" || type === "styp" || type === "free" || type === "moov"
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
}, segments: HlsSegment[], count: number): Promise<void> {
  const BATCH = 30
  const PARALLEL = 8
  const headerArgs = [options.userAgent ? `-A ${quote(options.userAgent)}` : "", options.referer ? `-e ${quote(options.referer)}` : ""].filter(Boolean).join(" ")
  const rangeArg = (segment: HlsSegment): string => {
    const range = hlsRangeHeader(segment)
    return range ? `-r ${quote(range)}` : ""
  }
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
      for (const index of pending) {
        const segment = segments[index]
        const range = rangeArg(segment)
        if (range) curlParts.push(range)
        curlParts.push(`-o ${quote(segmentFile(index))}`, quote(segment.url))
      }
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
        const segment = segments[index]
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const retry = await runCommand(`curl -k -sS -f --connect-timeout 15 --max-time 30 ${headerArgs} ${rangeArg(segment)} -o ${quote(segmentFile(index))} ${quote(segment.url)}`, 60)
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
    /** 分片内容粗校验：ts=首字节 0x47；mp4=fMP4 box。无加密流下载时启用，拦截伪装分片。 */
    validate?: "ts" | "mp4"
    onProgress?: (value: { fraction: number; stage: string; downloadedBytes?: number; totalBytes?: number; speed?: number }) => void
    isCancelFlagSet?: () => boolean
  },
  segments: HlsSegment[],
  count: number,
): Promise<{ slow: boolean }> {
  const maxConcurrent = 4
  const GATE = Math.min(24, count)
  const gateStartedAt = Date.now()
  let gateHit = false
  let fetchSlow = false
  let cursor = 0
  let completed = 0
  const failedIndexes: number[] = []
  let downloadedBytes = 0
  let sampleBytes = 0
  let sampleAt = Date.now()
  let speed = 0
  const sizes: number[] = []
  const downloadOne = async (index: number): Promise<boolean> => {
    if (options.isCancelFlagSet?.()) return false
    const destination = Path.join(options.workDirectory, `seg_${String(index).padStart(5, "0")}.ts`)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (options.isCancelFlagSet?.()) return false
      try {
        if (FileManager.existsSync(destination)) FileManager.removeSync(destination)
      } catch {}
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30_000)
        try {
          const headers: Record<string, string> = {
            Accept: "*/*",
            ...(options.userAgent ? { "User-Agent": options.userAgent } : {}),
            ...(options.referer ? { Referer: options.referer } : {}),
          }
          const range = hlsRangeHeader(segments[index])
          if (range) headers.Range = range
          const response = await fetch(segments[index].url, {
            headers,
            signal: controller.signal,
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const contentType = (response.headers.get("content-type") || "").toLowerCase()
          if (/^(image\/(?:png|jpeg|gif|webp)|text\/html)/.test(contentType)) {
            throw new Error(`分片内容异常（Content-Type: ${contentType}）`)
          }
          const reader = response.dataStream.getReader()
          let size = 0
          try {
            const first = await reader.read()
            if (first.done) throw new Error("分片内容为空")
            if (first.value) {
              if (options.validate && !hlsSegmentLooksValid(first.value.toUint8Array() || new Uint8Array(0), options.validate)) {
                throw new Error(options.validate === "mp4" ? "分片内容异常（非 fMP4 分片）" : "分片内容异常（非 TS 分片）")
              }
              await FileManager.appendData(destination, first.value)
              size += first.value.size
            }
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
          // byteRange 分片应精确返回指定长度
          const expected = segments[index].byteRange?.length
          if (expected !== undefined && size !== expected) throw new Error(`分片长度不符（期望 ${expected}，实际 ${size}）`)
          downloadedBytes += size
          sizes.push(size)
          return true
        } finally {
          clearTimeout(timeout)
        }
      } catch (error) {
        if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
      }
    }
    return false
  }
  const workers = Array.from({ length: Math.min(maxConcurrent, count) }, async () => {
    while (!fetchSlow && !options.isCancelFlagSet?.() && cursor < count) {
      const index = cursor
      cursor += 1
      const ok = await downloadOne(index)
      if (!ok) failedIndexes.push(index)
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
  // 错误分片集中重下（第一轮全部跑完后重下一轮，仍失败才报错，避免偶发 CDN 瞬断整单失败）
  const retryRound = failedIndexes.slice()
  failedIndexes.length = 0
  for (const index of retryRound) {
    if (options.isCancelFlagSet?.()) break
    if (!(await downloadOne(index))) failedIndexes.push(index)
  }
  if (options.isCancelFlagSet?.()) throw new Error("下载已取消")
  if (failedIndexes.length) {
    throw new Error(`分片下载失败（已完成 ${completed}/${count}）：${failedIndexes.length} 片重下后仍失败（${failedIndexes.slice(0, 3).map((i) => i + 1).join("、")}…）`)
  }
  return { slow: false }
}

/**
 * AES-128 加密 HLS 分片下载：fetch 下载密文 → 内存 AES-CBC 解密 → 写盘。
 * 只走 native fetch 栈（curl 无法解密，也不回退）；并发 2 以控制解密双份内存。
 * 解密后按 TS(0x47) / fMP4(moof) 校验，KEY/IV 错误时立即发现并重试。
 */
async function downloadHlsSegmentsEncrypted(
  options: {
    workDirectory: string
    referer?: string
    userAgent?: string
    onProgress?: (value: { fraction: number; stage: string; downloadedBytes?: number; totalBytes?: number; speed?: number }) => void
    isCancelFlagSet?: () => boolean
  },
  plan: HlsMediaPlaylistPlan,
  key: Uint8Array,
  count: number,
): Promise<void> {
  const maxConcurrent = 2
  let cursor = 0
  let completed = 0
  const failedIndexes: number[] = []
  let downloadedBytes = 0
  let sampleBytes = 0
  let sampleAt = Date.now()
  let speed = 0
  const sizes: number[] = []
  const downloadOne = async (index: number): Promise<boolean> => {
    if (options.isCancelFlagSet?.()) return false
    const destination = Path.join(options.workDirectory, `seg_${String(index).padStart(5, "0")}.ts`)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (options.isCancelFlagSet?.()) return false
      try {
        if (FileManager.existsSync(destination)) FileManager.removeSync(destination)
      } catch {}
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30_000)
        try {
          const headers: Record<string, string> = {
            Accept: "*/*",
            ...(options.userAgent ? { "User-Agent": options.userAgent } : {}),
            ...(options.referer ? { Referer: options.referer } : {}),
          }
          const range = hlsRangeHeader(plan.segments[index])
          if (range) headers.Range = range
          const response = await fetch(plan.segments[index].url, {
            headers,
            signal: controller.signal,
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const contentType = (response.headers.get("content-type") || "").toLowerCase()
          if (/^(image\/(?:png|jpeg|gif|webp)|text\/html)/.test(contentType)) {
            throw new Error(`分片内容异常（Content-Type: ${contentType}）`)
          }
          const buffer = new Uint8Array(await response.arrayBuffer())
          if (!buffer.length) throw new Error("分片内容为空")
          const expected = plan.segments[index].byteRange?.length
          if (expected !== undefined && buffer.length !== expected) throw new Error(`分片长度不符（期望 ${expected}，实际 ${buffer.length}）`)
          const iv = plan.keyIV || hlsSequenceIV(plan.mediaSequence + index)
          const plain = decryptAES128CBC(buffer, key, iv, true)
          if (plan.isMP4) {
            if (!hlsSegmentLooksValid(plain, "mp4")) throw new Error("解密后分片内容异常（非 fMP4 分片，KEY/IV 可能错误）")
          } else if (!hlsSegmentLooksValid(plain, "ts")) {
            throw new Error("解密后分片内容异常（非 TS 分片，KEY/IV 可能错误）")
          }
          await FileManager.appendData(destination, Data.fromUint8Array(plain)!)
          downloadedBytes += buffer.length
          sizes.push(buffer.length)
          return true
        } finally {
          clearTimeout(timeout)
        }
      } catch (error) {
        if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
      }
    }
    return false
  }
  const workers = Array.from({ length: Math.min(maxConcurrent, count) }, async () => {
    while (!options.isCancelFlagSet?.() && cursor < count) {
      const index = cursor
      cursor += 1
      const ok = await downloadOne(index)
      if (!ok) failedIndexes.push(index)
      completed += 1
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
        stage: `正在下载并解密分片 ${completed} / ${count}`,
        downloadedBytes,
        totalBytes: totalEstimate,
        speed,
      })
    }
  })
  await Promise.all(workers)
  if (options.isCancelFlagSet?.()) throw new Error("下载已取消")
  // 错误分片集中重下（第一轮全部跑完后重下一轮，仍失败才报错）
  const retryRound = failedIndexes.slice()
  failedIndexes.length = 0
  for (const index of retryRound) {
    if (options.isCancelFlagSet?.()) break
    if (!(await downloadOne(index))) failedIndexes.push(index)
  }
  if (options.isCancelFlagSet?.()) throw new Error("下载已取消")
  if (failedIndexes.length) {
    throw new Error(`分片下载失败（已完成 ${completed}/${count}）：${failedIndexes.length} 片重下后仍失败（${failedIndexes.slice(0, 3).map((i) => i + 1).join("、")}…）`)
  }
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
  /** 采集器运行时代理捕获的清单文本：清单端点 403/404 时兑底（已校验 #EXTM3U）。 */
  manifestFallbackText?: string
  onProgress?: (value: { fraction: number; stage: string; downloadedBytes?: number; totalBytes?: number; speed?: number }) => void
  isCancelFlagSet?: () => boolean
}): Promise<HlsManifestSummary | undefined> {
  // 无 referer 的 m3u8 直链也统一携带移动 Safari UA，提高 CDN 兼容性（yt-dlp 路径不受影响）。
  const userAgent = options.userAgent || MOBILE_SAFARI_UA
  const nativeOptions = { ...options, userAgent }
  const master = (await fetchHlsWithSafariHeaders(options.sourceURL, options.referer, userAgent)) || options.manifestFallbackText || undefined
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
  return downloadHlsMediaPlaylistText(nativeOptions, mediaText, mediaURL)
}

/**
 * 下载一份已取回的媒体清单文本（HLS media playlist，或 MPD 桥接合成的 m3u8）。
 * 从 downloadHlsSegmentsNative 抽出，供 DASH MPD→m3u8 桥接复用同一分片下载/解密/合成管线。
 */
export async function downloadHlsMediaPlaylistText(options: {
  destination: string
  workDirectory: string
  referer?: string
  userAgent?: string
  onProgress?: (value: { fraction: number; stage: string; downloadedBytes?: number; totalBytes?: number; speed?: number }) => void
  isCancelFlagSet?: () => boolean
}, mediaText: string, mediaURL: string): Promise<HlsManifestSummary | undefined> {
  const userAgent = options.userAgent || MOBILE_SAFARI_UA
  const downloadOptions = { ...options, userAgent }
  const summary = parseHlsManifestSummary(mediaText)
  // Only VOD (ENDLIST) playlists are supported. #EXT-X-KEY:METHOD=NONE explicitly means
  // "no encryption" and must NOT be treated as encrypted: 8xx3 等站点的清单带 METHOD=NONE，
  // 此前被误判为加密而跳过原生分片。真实 AES-128 与 fMP4(EXT-X-MAP) 由下方原生解密路径
  // 支持；SAMPLE-AES 等其它 METHOD 仍回落 yt-dlp（ffmpeg 分支）。
  if (!summary || !summary.endList) return undefined
  const plan = parseHlsMediaPlaylist(mediaText, mediaURL)
  if (plan.method === "unsupported") return undefined
  const segments = plan.segments
  const count = segments.length
  if (!count) return undefined
  const finish = async (): Promise<void> => {
    // fMP4/CMAF：字节级拼接 init + 分片（cat-catch 同款）。fMP4 拼接后本身就是合法
    // MP4 容器（ftyp/moov + styp/moof 序列），无需 ffmpeg remux——concat demuxer 会按
    // .ts 后缀把 fMP4 分片误判为 MPEG-TS 导致解析失败/卡死。
    if (plan.isMP4) {
      if (FileManager.existsSync(options.destination)) FileManager.removeSync(options.destination)
      const parts: string[] = []
      if (plan.initURI) {
        const initPath = Path.join(options.workDirectory, "seg_init.bin")
        if (FileManager.existsSync(initPath)) FileManager.removeSync(initPath)
        const initBytes = await fetchHlsBinary(plan.initURI, options.referer, userAgent, plan.initByteRange ? hlsRangeHeader({ url: plan.initURI, byteRange: plan.initByteRange }) : undefined)
        if (!initBytes || !initBytes.length) throw new Error("EXT-X-MAP init 段下载失败")
        if (plan.initByteRange && initBytes.length !== plan.initByteRange.length) throw new Error("EXT-X-MAP init 段长度不符")
        await FileManager.appendData(initPath, Data.fromUint8Array(initBytes)!)
        parts.push(initPath)
      }
      for (let index = 0; index < segments.length; index += 1) parts.push(Path.join(options.workDirectory, `seg_${String(index).padStart(5, "0")}.ts`))
      for (const part of parts) {
        const data = await FileManager.readAsData(part)
        if (!data) throw new Error("分片读取失败")
        await FileManager.appendData(options.destination, data)
      }
      return
    }
    // TS：把分片写为 concat 列表，ffmpeg 以 MPEG-TS 解析并 remux 到 MP4。
    const listPath = Path.join(options.workDirectory, "segments.txt")
    await FileManager.writeAsString(listPath, segments.map((_, index) => `file 'seg_${String(index).padStart(5, "0")}.ts'`).join("\n"))
    const concat = await runCommand(
      `ffmpeg -nostdin -y -f concat -safe 0 -i ${quote(listPath)} -c copy -bsf:a aac_adtstoasc -movflags +faststart ${quote(options.destination)}`,
      1800,
    )
    if (concat.exitCode !== 0 || !FileManager.existsSync(options.destination)) throw new Error("分片合成失败")
  }
  // AES-128 加密：native fetch 下载密文 → 内存解密 → 写盘；无 curl 回退（curl 无法解密）。
  if (plan.method === "aes-128") {
    const keyURI = plan.keyURI
    if (!keyURI) return undefined
    const key = await fetchHlsKey(keyURI, options.referer, userAgent)
    if (!key) return undefined
    await downloadHlsSegmentsEncrypted(downloadOptions, plan, key, count)
    options.onProgress?.({ fraction: 0.94, stage: "分片下载完成，正在合成 MP4" })
    await finish()
    options.onProgress?.({ fraction: 0.99, stage: "正在验证媒体文件" })
    return summary
  }
  if (HLS_NATIVE_MODE === "curl") {
    await downloadHlsSegmentsCurlBatches(downloadOptions, segments, count)
    options.onProgress?.({ fraction: 0.94, stage: "分片下载完成，正在合成 MP4" })
    await finish()
    options.onProgress?.({ fraction: 0.99, stage: "正在验证媒体文件" })
    return summary
  }
  // fetch-first: native NSURLSession stack (HTTP/2 reuse, same as the online preview)
  // with a speed gate; fall back to curl batches when the connection is not reused (slow)
  // or the native download fails. curl reuses the seg_* files already written here.
  try {
    const fetched = await downloadHlsSegmentsFetch({ ...downloadOptions, validate: plan.isMP4 ? "mp4" : "ts" }, segments, count)
    if (fetched.slow) {
      await logEvent({ level: "warn", event: "download.m3u8.fetch-slow", details: { reason: "connection-not-reused", safariRefererApplied: Boolean(options.referer), cookieTransfer: false } })
      await downloadHlsSegmentsCurlBatches(downloadOptions, segments, count)
    }
  } catch (error) {
    if (options.isCancelFlagSet?.()) throw new Error("下载已取消")
    const reason = error instanceof Error ? error.message : String(error)
    await logEvent({ level: "warn", event: "download.m3u8.fetch-fallback", details: { reason: reason.slice(0, 200), safariRefererApplied: Boolean(options.referer), cookieTransfer: false } })
    await downloadHlsSegmentsCurlBatches(downloadOptions, segments, count)
  }
  options.onProgress?.({ fraction: 0.94, stage: "分片下载完成，正在合成 MP4" })
  await finish()
  options.onProgress?.({ fraction: 0.99, stage: "正在验证媒体文件" })
  return summary
}
