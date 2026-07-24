import { Path, Script } from "scripting"
import { createTaskId, logEvent } from "./logs"
import type { AuthPlatform } from "./platform-auth"
import { cancelBackgroundDownloads, downloadURLToFileWithProgress } from "./background-download"
import {
  buildDownloadCandidates,
  downloadVideo as downloadDouyinVideo,
  extractFromWebView,
  extractImageURLs,
  extractInlineDetailRoot,
  MOBILE_SAFARI_UA,
  type DownloadSuccess as DouyinDownloadSuccess,
  type ExtractedInfo,
} from "./douyin"

export type SaveMode = "ask" | "photos" | "files"
export type ConcurrentDownloads = 1 | 2 | 4 | 8
export type MediaKind = "video" | "audio" | "image"
export type AutomaticDownloadFormatStrategy = "recommended" | "highest-video" | "highest-audio" | "preferred-container"
export type PreferredContainer = "mp4" | "mkv" | "avi" | "wmv"

export type ToolStatus = {
  ytDlpVersion: string | null
}

export type DownloadProgress = {
  fraction: number
  stage: string
  downloadedBytes?: number
  totalBytes?: number
  speed?: number
  eta?: number
  part?: number
  totalParts?: number
}

export type MediaChoice = {
  id: string
  label: string
  kind: MediaKind
  formatExpression: string
  container?: string
  height?: number
  estimatedBytes?: number
  mergeAudioFormat?: string
  mergeExtension?: "mp4" | "mkv"
  previewURL?: string
  previewReferer?: string
  previewHeaders?: Record<string, string>
  /** Separate audio stream for DASH video-only online preview. */
  previewAudioURL?: string
}

export type MediaProbe = {
  title: string
  uploader?: string
  duration?: number
  thumbnail?: string
  webpageURL: string
  choices: MediaChoice[]
}

export type DownloadResult = {
  filePath: string
  fileName: string
  sourceURL: string
  choice: MediaChoice
  taskId: string
  fileSizeBytes: number
}

type RawFormat = {
  formatId: string
  ext?: string
  vcodec?: string
  acodec?: string
  height?: number
  width?: number
  fps?: number
  abr?: number
  tbr?: number
  filesize?: number
  previewURL?: string
  previewReferer?: string
  previewHeaders?: Record<string, string>
}

const ROOT_DIR = Path.join(FileManager.documentsDirectory, "Yoinks")
const DOWNLOAD_DIR = Path.join(ROOT_DIR, "Downloads")
const TEMP_DIR = Path.join(ROOT_DIR, "tmp")
const RUNNER_PATH = Path.join(Script.directory, "ytdlp_runner.py")
const PROBE_PATH = Path.join(Script.directory, "ytdlp_probe.py")
const MEDIA_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".mkv", ".webm", ".m4a", ".aac", ".opus", ".mp3"])

export function quote(value: string): string {
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`
}

/** Scripting host noise that can mask real yt-dlp exit output. */
const HOST_NOISE_LINE =
  /Script window host view deinit|Transpile JSContext(?: released)?|webview viewmodel cleanup|WebViewController disposed|load start|load stop|set channel|\[WebView\]\s*\[LOG\]|\[WebView\]/i

export function isHostDeinitNoise(value: string): boolean {
  const text = String(value || "").trim()
  if (!text) return false
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const meaningful = lines.filter((line) => !HOST_NOISE_LINE.test(line))
  // Pure host noise (deinit / WebView logs / JSContext) → treat as transient interrupt.
  if (meaningful.length === 0) return lines.some((line) => HOST_NOISE_LINE.test(line)) || /deinit|WebView|JSContext/i.test(text)
  const collapsed = meaningful.join(" ").replace(/\s+/g, " ").trim()
  if (/^(?:Script window host view deinit\s*)+$/i.test(collapsed)) return true
  // Short residual that is only host log tokens, e.g. "[WebView][LOG] [c0]"
  if (collapsed.length <= 64 && /\[WebView\]|deinit|JSContext/i.test(collapsed) && !/ERROR:|Unable to|HTTP Error|Unsupported|timed out|certificate/i.test(collapsed)) {
    return true
  }
  return false
}

/** Network/host failures that often succeed on one automatic re-probe. */
export function isTransientProbeFailure(value: string): boolean {
  if (isHostDeinitNoise(value)) return true
  const text = String(value || "")
  return /timed out|timeout|TransportError|ECONNRESET|Connection reset|temporarily unavailable|Temporary failure|Network is unreachable|nodename nor servname/i.test(text)
}

function stripHostNoise(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !HOST_NOISE_LINE.test(line))
    .join("\n")
}

function compactMessage(value: string): string {
  const cleaned = stripHostNoise(value)
  const source = cleaned || value
  const errors = source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("ERROR:") || /^ERROR\b/i.test(line) || /Unable to download webpage/i.test(line))
  if (errors.length) {
    const last = errors[errors.length - 1].replace(/^ERROR:\s*/i, "").slice(0, 800)
    if (/timed out|timeout|TransportError/i.test(last)) {
      return "打开页面超时，暂时识别不到格式。请检查网络后重试；短链可改完整视频页链接再分析。"
    }
    return last
  }
  if (isHostDeinitNoise(value) && !cleaned) {
    return "探测被宿主中断或日志干扰，未能识别格式。请再点「重新分析链接」。"
  }
  if (/timed out|timeout|TransportError/i.test(source)) {
    return "打开页面超时，暂时识别不到格式。请检查网络后重试；短链可改完整视频页链接再分析。"
  }
  return source.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(-800)
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))]
}

function extensionOf(path: string): string {
  const clean = path.startsWith("/") ? path : path.split(/[?#]/)[0]
  const index = clean.lastIndexOf(".")
  return index >= 0 ? clean.slice(index).toLowerCase() : ""
}

function formatBytes(value?: number): string {
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

function isAllowedURL(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

export type MediaPlatform = "douyin" | "xiaohongshu" | "generic"

const XIAOHONGSHU_URL_PATTERNS = [
  /https?:\/\/(?:www\.)?(?:xiaohongshu|rednote)\.com\/(?:explore|discovery\/item|search_result|user\/profile\/[a-z0-9]+)\/[a-z0-9]+(?:\?[^\s"'<>，。！？；：、]*)?/i,
  /https?:\/\/xhslink\.com\/[^\s"'<>，。！？；：、]+/i,
]
const DOUYIN_URL_PATTERNS = [
  /https?:\/\/v\.douyin\.com\/[a-zA-Z0-9_-]+/i,
  /https?:\/\/(?:www\.)?douyin\.com\/video\/[0-9]+/i,
  /https?:\/\/(?:www\.)?iesdouyin\.com\/[^\s"'<>，。！？；：、]*/i,
]

function sanitizeExtractedURL(value: string): string {
  return value
    .replace(/[^\x00-\x7F]+$/, "")
    .replace(/[，,。.!！？?；;：:、\)）\(（]+$/, "")
}

export function detectMediaPlatform(value: string | null | undefined): MediaPlatform {
  if (!value) return "generic"
  if (DOUYIN_URL_PATTERNS.some((pattern) => pattern.test(value))) return "douyin"
  if (XIAOHONGSHU_URL_PATTERNS.some((pattern) => pattern.test(value))) return "xiaohongshu"
  return "generic"
}

export function mediaPlatformLabel(value: string | null | undefined): string | null {
  switch (detectMediaPlatform(value)) {
    case "douyin": return "抖音"
    case "xiaohongshu": return "小红书"
    default: return null
  }
}

export function extractFirstURL(value: string | null | undefined): string | null {
  if (!value) return null
  for (const pattern of [...XIAOHONGSHU_URL_PATTERNS, ...DOUYIN_URL_PATTERNS]) {
    const match = value.match(pattern)
    if (match) {
      const candidate = sanitizeExtractedURL(match[0])
      if (isAllowedURL(candidate)) return candidate
    }
  }
  const candidate = sanitizeExtractedURL(value.match(/https?:\/\/[^\s<>"']+/i)?.[0] || value.trim())
  return isAllowedURL(candidate) ? candidate : null
}

async function ensureDirectories() {
  if (!(await FileManager.exists(DOWNLOAD_DIR))) await FileManager.createDirectory(DOWNLOAD_DIR, true)
  if (!(await FileManager.exists(TEMP_DIR))) await FileManager.createDirectory(TEMP_DIR, true)
}

async function runCommand(command: string, timeout: number) {
  return Shell.run(command, { cwd: Script.directory, timeout })
}

function parseLastJSON(output: string): Record<string, unknown> {
  try {
    const whole = JSON.parse(output) as unknown
    if (typeof whole === "object" && whole != null && !Array.isArray(whole)) return whole as Record<string, unknown>
  } catch {}
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line) as unknown
      if (typeof value === "object" && value != null && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {}
  }

  // Scripting's ffprobe emits diagnostics around its multi-line JSON payload.
  // Extract balanced object candidates instead of assuming the whole output is JSON.
  for (let start = output.indexOf("{"); start >= 0; start = output.indexOf("{", start + 1)) {
    let depth = 0
    let quoted = false
    let escaped = false
    for (let end = start; end < output.length; end += 1) {
      const character = output[end]
      if (quoted) {
        if (escaped) escaped = false
        else if (character === "\\") escaped = true
        else if (character === '"') quoted = false
        continue
      }
      if (character === '"') {
        quoted = true
        continue
      }
      if (character === "{") depth += 1
      if (character === "}") depth -= 1
      if (depth !== 0) continue
      try {
        const value = JSON.parse(output.slice(start, end + 1)) as unknown
        if (typeof value === "object" && value != null && !Array.isArray(value)) return value as Record<string, unknown>
      } catch {}
      break
    }
  }
  throw new Error("下载工具未返回可识别的媒体信息")
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const result = Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((record, [key, item]) => {
    if (typeof item === "string" && item) record[key] = item
    return record
  }, {})
  return Object.keys(result).length ? result : undefined
}

function formatScore(item: RawFormat): number {
  let score = item.tbr || 0
  if (item.ext === "mp4" || item.ext === "m4v") score += 10_000
  if (item.vcodec?.startsWith("avc")) score += 5_000
  if (item.acodec && item.acodec !== "none") score += 1_000
  return score
}

/** WKWebView progressive <video> decodes H.264 reliably; AV1/VP9/HEVC often black-screen. */
function isAvcCodec(item: RawFormat): boolean {
  const codec = (item.vcodec || "").toLowerCase()
  return codec.startsWith("avc") || codec.includes("h264") || codec.includes("avc1")
}

function isHardVideoCodec(item: RawFormat): boolean {
  const codec = (item.vcodec || "").toLowerCase()
  return /av01|av1|vp09|vp9|hev1|hvc1|hevc/.test(codec)
}

function previewVideoPreference(a: RawFormat, b: RawFormat): number {
  // Prefer decodable preview streams first, then quality.
  return (
    Number(isAvcCodec(b)) - Number(isAvcCodec(a)) ||
    Number(isHardVideoCodec(a)) - Number(isHardVideoCodec(b)) ||
    (b.height || 0) - (a.height || 0) ||
    formatScore(b) - formatScore(a)
  )
}

function isMuxedVideo(item: RawFormat): boolean {
  if (!item.formatId || !item.height) return false
  if (item.vcodec && item.vcodec !== "none" && item.acodec && item.acodec !== "none") return true
  // Some extractors omit codec metadata for progressive HTTP MP4 files.
  return item.formatId.startsWith("http-") && item.ext === "mp4" && Boolean(item.filesize)
}

/** Pick best progressive URL for WKWebView preview (prefer H.264). Download format stays on `item`. */
function pickPreviewVideoSource(
  item: RawFormat,
  muxedVideos: RawFormat[],
  videoOnly: RawFormat[],
): RawFormat {
  // Prefer ANY AVC (same height → lower height) before hard codecs — WKWebView black-screens AV1/HEVC/VP9.
  const anyAvc = [...muxedVideos, ...videoOnly]
    .filter((v) => v.previewURL && isAvcCodec(v) && (v.height || 0) > 0)
    .sort((a, b) => {
      const aSame = (a.height || 0) === (item.height || 0) ? 1 : 0
      const bSame = (b.height || 0) === (item.height || 0) ? 1 : 0
      if (bSame !== aSame) return bSame - aSame
      // Prefer <= selected height, then higher quality among remaining.
      const aOver = (a.height || 0) > (item.height || 9999) ? 1 : 0
      const bOver = (b.height || 0) > (item.height || 9999) ? 1 : 0
      if (aOver !== bOver) return aOver - bOver
      return previewVideoPreference(a, b)
    })
  if (anyAvc[0]) return anyAvc[0]

  const sameHeightMuxed = muxedVideos
    .filter((m) => m.height === item.height && m.previewURL)
    .sort(previewVideoPreference)
  if (sameHeightMuxed[0]) return sameHeightMuxed[0]

  const sameHeightVideoOnly = videoOnly
    .filter((v) => v.height === item.height && v.previewURL)
    .sort(previewVideoPreference)
  if (sameHeightVideoOnly[0]) return sameHeightVideoOnly[0]

  return item
}

function buildChoices(formats: RawFormat[]): MediaChoice[] {
  const audioFormats = formats
    .filter((item) => item.formatId && item.acodec && item.acodec !== "none" && (!item.vcodec || item.vcodec === "none"))
    .sort((a, b) => {
      const aPreference = (a.ext === "m4a" ? 100_000 : 0) + (a.abr || a.tbr || 0)
      const bPreference = (b.ext === "m4a" ? 100_000 : 0) + (b.abr || b.tbr || 0)
      return bPreference - aPreference || formatScore(b) - formatScore(a)
    })
  const muxedVideos = formats
    .filter(isMuxedVideo)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || formatScore(b) - formatScore(a))
  const videoOnly = formats
    .filter((item) => item.formatId && item.vcodec && item.vcodec !== "none" && (!item.acodec || item.acodec === "none") && item.height)
    // Height first, then H.264 for both listing/default download and device-friendly merges.
    .sort((a, b) => (b.height || 0) - (a.height || 0) || Number(isAvcCodec(b)) - Number(isAvcCodec(a)) || formatScore(b) - formatScore(a))

  const choices: MediaChoice[] = muxedVideos.map((item) => {
    const codec = codecLabel(item)
    return {
      id: `video-${item.height}-${item.formatId}`,
      label: `${item.height}p 视频${codec ? ` · ${codec}` : ""}${item.ext ? ` · ${item.ext.toUpperCase()}` : ""}${item.fps ? ` · ${Math.round(item.fps)} fps` : ""}${item.filesize ? ` · 约 ${formatBytes(item.filesize)}` : ""}`,
      kind: "video" as const,
      formatExpression: item.formatId,
      container: item.ext?.toLowerCase(),
      height: item.height,
      estimatedBytes: item.filesize,
      previewURL: item.previewURL,
      previewReferer: item.previewReferer,
      previewHeaders: item.previewHeaders,
    }
  })

  // One download choice per height: first item after sort is preferred (AVC over AV1).
  // Avoid listing multiple 1080p AV1/HEVC variants that fail verify on device ffprobe.
  const seenVideoHeights = new Set<number>()
  for (const item of videoOnly) {
    const height = item.height || 0
    if (!height || seenVideoHeights.has(height)) continue
    seenVideoHeights.add(height)

    const audio = audioFormats.find((candidate) => item.ext === "mp4" || item.ext === "m4s" ? (candidate.ext === "m4a" || candidate.ext === "mp4") : candidate.ext === "webm") || audioFormats[0]
    const canMerge = Boolean(audio)
    const mergeExtension = (item.ext === "mp4" || item.ext === "m4s") && (audio?.ext === "m4a" || audio?.ext === "mp4") ? "mp4" : "mkv"
    const previewSource = pickPreviewVideoSource(item, muxedVideos, videoOnly)
    const previewIsMuxed = isMuxedVideo(previewSource)
    // Hard codecs in WKWebView often black-screen; never pair separate audio for them (avoids 有声无画).
    const previewDecodable = isAvcCodec(previewSource) || !isHardVideoCodec(previewSource)
    const needsSeparateAudio =
      previewDecodable && !previewIsMuxed && Boolean(audio?.previewURL)
    const codec = codecLabel(item)
    choices.push({
      id: `video-${item.height}-${item.formatId}${audio ? `-with-${audio.formatId}` : "-silent"}`,
      label: `${item.height}p ${canMerge ? "视频 · 合并音频" : "无音轨视频"}${codec ? ` · ${codec}` : ""}${item.ext ? ` · ${item.ext.toUpperCase()}` : ""}${item.fps ? ` · ${Math.round(item.fps)} fps` : ""}${(item.filesize || audio?.filesize) ? ` · 约 ${formatBytes((item.filesize || 0) + (audio?.filesize || 0))}` : ""}`,
      kind: "video",
      formatExpression: item.formatId,
      height: item.height,
      estimatedBytes: (item.filesize || 0) + (audio?.filesize || 0) || undefined,
      mergeAudioFormat: audio?.formatId,
      mergeExtension: canMerge ? mergeExtension : undefined,
      previewURL: previewSource.previewURL,
      previewReferer: previewSource.previewReferer || item.previewReferer,
      previewHeaders: previewSource.previewHeaders || item.previewHeaders,
      previewAudioURL: needsSeparateAudio ? audio?.previewURL : undefined,
    })
  }

  choices.push(...audioFormats.map<MediaChoice>((item) => ({
    id: `audio-${item.formatId}`,
    label: `仅音频${item.ext ? ` · ${item.ext.toUpperCase()}` : ""}${item.abr || item.tbr ? ` · ${Math.round(item.abr || item.tbr || 0)} kbps` : ""}${item.filesize ? ` · 约 ${formatBytes(item.filesize)}` : ""}`,
    kind: "audio",
    formatExpression: item.formatId,
    container: item.ext?.toLowerCase(),
    estimatedBytes: item.filesize,
    previewURL: item.previewURL,
    previewReferer: item.previewReferer,
    previewHeaders: item.previewHeaders,
  })))

  return choices
}

export function resolveAutomaticChoice(
  choices: MediaChoice[],
  strategy: AutomaticDownloadFormatStrategy,
  preferredContainer: PreferredContainer,
): { choice: MediaChoice | null; usedFallback: boolean } {
  const recommended = choices[0] || null
  if (!recommended || strategy === "recommended") return { choice: recommended, usedFallback: false }

  if (strategy === "highest-video") {
    const choice = choices.filter((item) => item.kind === "video").sort((a, b) => (b.height || 0) - (a.height || 0))[0] || recommended
    return { choice, usedFallback: choice === recommended && choice.kind !== "video" }
  }

  if (strategy === "highest-audio") {
    const choice = choices.find((item) => item.kind === "audio") || recommended
    return { choice, usedFallback: choice === recommended && choice.kind !== "audio" }
  }

  const choice = choices.find((item) => item.kind === "video" && !item.mergeAudioFormat && item.container === preferredContainer) || recommended
  return { choice, usedFallback: choice !== null && choice.container !== preferredContainer }
}

export async function getToolStatus(): Promise<ToolStatus> {
  const ytDlp = await runCommand("python3 -m yt_dlp --version", 20)
  const status: ToolStatus = {
    ytDlpVersion: ytDlp.exitCode === 0 ? ytDlp.output.trim().split(/\s+/)[0] || null : null,
  }
  await logEvent({ level: status.ytDlpVersion ? "info" : "warn", event: "tools.checked", details: { ytDlpVersion: status.ytDlpVersion, ytDlpExitCode: ytDlp.exitCode } })
  return status
}

export async function installYtDlp(): Promise<string> {
  await logEvent({ level: "info", event: "tools.install.started", details: { tool: "yt-dlp" } })
  const result = await runCommand("python3 -m pip install --upgrade yt-dlp", 900)
  if (result.exitCode !== 0) {
    await logEvent({ level: "error", event: "tools.install.failed", details: { tool: "yt-dlp", exitCode: result.exitCode, output: result.output } })
    throw new Error(compactMessage(result.output || "yt-dlp installation failed"))
  }
  const version = await runCommand("python3 -m yt_dlp --version", 20)
  if (version.exitCode !== 0) throw new Error("yt-dlp 安装完成但版本校验失败")
  const installedVersion = version.output.trim().split(/\s+/)[0]
  await logEvent({ level: "info", event: "tools.install.completed", details: { tool: "yt-dlp", version: installedVersion } })
  return installedVersion
}

export type ProbeOptions = {
  cookieFile?: string
  authorizedPlatform?: AuthPlatform
}


export const DOUYIN_DIRECT_FORMAT = "douyin-webview"

function isDouyinDirectChoice(choice: MediaChoice | null | undefined): boolean {
  return Boolean(choice && (choice.formatExpression === DOUYIN_DIRECT_FORMAT || choice.id.startsWith("douyin-")))
}

function douyinChoiceFromExtracted(extracted: ExtractedInfo, sourceURL: string): { probe: MediaProbe; extracted: ExtractedInfo } {
  const imageURLs = extractImageURLs(extracted)
  const inlineRoot = extractInlineDetailRoot(extracted)
  const candidates = buildDownloadCandidates(extracted, true)
  const galleryLike = /\/(?:share\/)?(?:note|gallery|slides)\//.test(sourceURL)
    || /\/(?:share\/)?(?:note|gallery|slides)\//.test(extracted.canonical || "")
    || /\/(?:share\/)?(?:note|gallery|slides)\//.test(extracted.pageURL || "")
  const preferImages = (galleryLike && imageURLs.length > 0) || (!candidates.length && imageURLs.length > 0)
  const previewURL = preferImages
    ? (imageURLs[0] || extracted.thumbnailURL || undefined)
    : (candidates[0]?.url || extracted.videoSrc || extracted.thumbnailURL || undefined)
  const previewHeaders = candidates[0]?.headers || {
    "User-Agent": MOBILE_SAFARI_UA,
    Referer: extracted.pageURL || sourceURL,
  }
  const choice: MediaChoice = preferImages
    ? {
        id: `douyin-images-${imageURLs.length}`,
        label: imageURLs.length > 1 ? `图文 · ${imageURLs.length} 张` : "图文 · 1 张",
        kind: "image",
        formatExpression: DOUYIN_DIRECT_FORMAT,
        container: "jpg",
        estimatedBytes: undefined,
        previewURL,
        previewReferer: extracted.pageURL || sourceURL,
        previewHeaders,
      }
    : {
        id: "douyin-video",
        label: candidates.length ? `抖音视频 · ${candidates.length} 个候选` : "抖音视频",
        kind: "video",
        formatExpression: DOUYIN_DIRECT_FORMAT,
        container: "mp4",
        estimatedBytes: undefined,
        previewURL,
        previewReferer: extracted.pageURL || sourceURL,
        previewHeaders,
      }
  if (!preferImages && !candidates.length && !extracted.videoSrc && !inlineRoot) {
    throw new Error("未能从页面中提取到视频地址、图片地址或 aweme 内嵌数据")
  }
  const probe: MediaProbe = {
    title: extracted.title || "抖音媒体",
    uploader: undefined,
    duration: undefined,
    thumbnail: extracted.thumbnailURL || undefined,
    webpageURL: extracted.canonical || extracted.pageURL || sourceURL,
    choices: [choice],
  }
  return { probe, extracted }
}

async function probeDouyinDirect(sourceURL: string): Promise<MediaProbe> {
  const taskId = createTaskId()
  await logEvent({ level: "info", event: "probe.douyin.started", taskId, details: { sourceURL, mode: "anonymous-webview" } })
  const extracted = await extractFromWebView(sourceURL, {
    onLog: (message) => {
      void logEvent({ level: "info", event: "probe.douyin.log", taskId, details: { message: message.slice(0, 500) } })
    },
  })
  const { probe } = douyinChoiceFromExtracted(extracted, sourceURL)
  await logEvent({
    level: "info",
    event: "probe.douyin.completed",
    taskId,
    details: {
      title: probe.title,
      choiceId: probe.choices[0]?.id,
      kind: probe.choices[0]?.kind,
      imageCount: extractImageURLs(extracted).length,
      hasVideoSrc: Boolean(extracted.videoSrc),
      hasInline: Boolean(extractInlineDetailRoot(extracted)),
    },
  })
  return probe
}

async function downloadDouyinDirect(options: {
  sourceURL: string
  choice: MediaChoice
  onProgress: (value: DownloadProgress) => void
  onCancelPath: (path: string) => void
}): Promise<DownloadResult> {
  const taskId = createTaskId()
  await ensureDirectories()
  const cancelPath = Path.join(TEMP_DIR, `${taskId}.cancel`)
  try { if (FileManager.existsSync(cancelPath)) FileManager.removeSync(cancelPath) } catch {}
  options.onCancelPath(cancelPath)
  await logEvent({ level: "info", event: "download.douyin.started", taskId, details: { sourceURL: options.sourceURL, choiceId: options.choice.id } })
  const isCancelFlagSet = () => FileManager.existsSync(cancelPath)
  try {
    const result: DouyinDownloadSuccess = await downloadDouyinVideo(options.sourceURL, {
      preferNoWatermark: true,
      onProgress: (progress) => {
        if (isCancelFlagSet()) return
        options.onProgress({
          fraction: progress.fraction,
          stage: progress.stage,
        })
      },
      onLog: (message) => {
        void logEvent({ level: "info", event: "download.douyin.log", taskId, details: { message: message.slice(0, 500) } })
      },
    })
    if (isCancelFlagSet()) throw new Error("下载已取消")
    let filePath = result.filePath
    if (!filePath.includes(`(${taskId.slice(-6)})`)) {
      try {
        filePath = await publishMediaFile(filePath, taskId)
      } catch {
        filePath = result.filePath
      }
    }
    const choice: MediaChoice = {
      ...options.choice,
      kind: result.mediaType === "image" ? "image" : "video",
      label: result.matchedCandidateLabel || options.choice.label,
    }
    if (choice.kind === "video") {
      try {
        await verifyMediaFile(filePath, { ...choice, kind: "video" }, taskId)
      } catch (error) {
        await logEvent({
          level: "warn",
          event: "download.douyin.verify.soft-fail",
          taskId,
          details: { message: error instanceof Error ? error.message : String(error), filePath },
        })
      }
    }
    options.onProgress({ fraction: 1, stage: "下载完成" })
    await logEvent({
      level: "info",
      event: "download.douyin.completed",
      taskId,
      details: {
        filePath,
        mediaType: result.mediaType,
        matchedCandidateLabel: result.matchedCandidateLabel,
        bytesWritten: result.bytesWritten,
      },
    })
    return {
      filePath,
      fileName: Path.basename(filePath),
      sourceURL: options.sourceURL,
      choice,
      taskId,
      fileSizeBytes: result.bytesWritten || await fileSizeBytes(filePath),
    }
  } catch (error) {
    await logEvent({
      level: "error",
      event: "download.douyin.failed",
      taskId,
      details: { message: error instanceof Error ? error.message : String(error) },
    })
    throw error
  } finally {
    try {
      if (FileManager.existsSync(cancelPath)) FileManager.removeSync(cancelPath)
    } catch {}
  }
}


export async function probeMedia(url: string, options: ProbeOptions = {}): Promise<MediaProbe> {
  const sourceURL = extractFirstURL(url)
  if (!sourceURL) throw new Error("请输入有效的公开 http 或 https 链接。")
  // 抖音：匿名 WebView(+detail) → 合成候选，不走 yt-dlp / 不要求用户登录
  if (detectMediaPlatform(sourceURL) === "douyin") {
    return probeDouyinDirect(sourceURL)
  }
  const taskId = createTaskId()
  await logEvent({ level: "info", event: "probe.started", taskId, details: { sourceURL, authorizedPlatform: options.authorizedPlatform || null, cookieAuthorized: Boolean(options.cookieFile) } })
  const cookieArgument = options.cookieFile ? ` ${quote(options.cookieFile)}` : ""
  const runProbe = () => runCommand(`python3 ${quote(PROBE_PATH)} ${quote(sourceURL)}${cookieArgument}`, 120)

  let result = await runProbe()
  await logEvent({ level: result.exitCode === 0 ? "info" : "error", event: "probe.command.completed", taskId, details: { exitCode: result.exitCode, output: result.exitCode === 0 ? "媒体信息已返回" : result.output } })

  // Host noise / short WebView logs / one network timeout often succeed on a single re-probe.
  if (result.exitCode !== 0 && isTransientProbeFailure(result.output || "")) {
    const reason = isHostDeinitNoise(result.output || "") ? "host-noise" : "network"
    await logEvent({
      level: "warn",
      event: reason === "host-noise" ? "probe.deinit.retry" : "probe.transient.retry",
      taskId,
      details: { delayMilliseconds: reason === "host-noise" ? 400 : 800, reason },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, reason === "host-noise" ? 400 : 800))
    result = await runProbe()
    await logEvent({
      level: result.exitCode === 0 ? "info" : "error",
      event: "probe.command.completed",
      taskId,
      details: {
        exitCode: result.exitCode,
        output: result.exitCode === 0 ? "媒体信息已返回" : result.output,
        afterTransientRetry: true,
        retryReason: reason,
      },
    })
  }

  if (result.exitCode !== 0) throw new Error(compactMessage(result.output || "媒体探测失败"))
  let payload: Record<string, unknown>
  try {
    payload = parseLastJSON(result.output)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== "下载工具未返回可识别的媒体信息") throw error
    await logEvent({ level: "warn", event: "probe.output.retry", taskId, details: { delayMilliseconds: 0 } })
    result = await runProbe()
    await logEvent({ level: result.exitCode === 0 ? "info" : "error", event: "probe.command.completed", taskId, details: { exitCode: result.exitCode, output: result.exitCode === 0 ? "媒体信息已返回" : result.output } })
    if (result.exitCode !== 0) throw new Error(compactMessage(result.output || "媒体探测失败"))
    payload = parseLastJSON(result.output)
  }
  if (payload.ok !== true) throw new Error(compactMessage(stringValue(payload.error) || "媒体探测失败"))
  const rawFormats = Array.isArray(payload.formats) ? payload.formats : []
  const formats: RawFormat[] = rawFormats.map((value) => {
    const item = value as Record<string, unknown>
    return {
      formatId: stringValue(item.formatId) || "",
      ext: stringValue(item.ext),
      vcodec: stringValue(item.vcodec),
      acodec: stringValue(item.acodec),
      height: numberValue(item.height),
      width: numberValue(item.width),
      fps: numberValue(item.fps),
      abr: numberValue(item.abr),
      tbr: numberValue(item.tbr),
      filesize: numberValue(item.filesize),
      previewURL: stringValue(item.previewURL),
      previewReferer: stringValue(item.previewReferer),
      previewHeaders: stringRecord(item.previewHeaders),
    }
  }).filter((item) => Boolean(item.formatId))
  const choices = buildChoices(formats)
  const probe: MediaProbe = {
    title: stringValue(payload.title) || "未命名媒体",
    uploader: stringValue(payload.uploader),
    duration: numberValue(payload.duration),
    thumbnail: stringValue(payload.thumbnail),
    webpageURL: stringValue(payload.webpageUrl) || sourceURL,
    choices,
  }
  await logEvent({ level: "info", event: "probe.completed", taskId, details: { title: probe.title, choiceCount: choices.length, formatCount: formats.length } })
  return probe
}

function clearProgressFile(path: string) {
  try {
    if (FileManager.existsSync(path)) FileManager.removeSync(path)
  } catch {}
}

function readRawProgress(path: string): {
  percent: number | null
  downloadedBytes?: number
  totalBytes?: number
  speed?: number
  eta?: number
  fragmentIndex?: number
  fragmentCount?: number
} | null {
  try {
    if (!FileManager.existsSync(path)) return null
    const value = JSON.parse(FileManager.readAsStringSync(path)) as {
      percent?: number
      downloadedBytes?: number
      totalBytes?: number
      speed?: number
      eta?: number
      fragmentIndex?: number
      fragmentCount?: number
    }
    const percent = typeof value.percent === "number" ? Math.max(0, Math.min(100, value.percent)) : null
    return {
      percent,
      downloadedBytes: numberValue(value.downloadedBytes),
      totalBytes: numberValue(value.totalBytes),
      speed: numberValue(value.speed),
      eta: numberValue(value.eta),
      fragmentIndex: numberValue(value.fragmentIndex),
      fragmentCount: numberValue(value.fragmentCount),
    }
  } catch {
    return null
  }
}

/** Map runner 0–100% into a total-progress window; fraction is monotonic. */
function createProgressTracker(onProgress: (value: DownloadProgress) => void) {
  let lastFraction = 0
  const emit = (fraction: number, stage: string, extra?: Partial<DownloadProgress>) => {
    const next = Math.max(lastFraction, Math.min(1, fraction))
    lastFraction = next
    onProgress({ fraction: next, stage, ...extra })
  }
  const mapWindow = (start: number, end: number, percent: number | null, stageBase: string, raw?: ReturnType<typeof readRawProgress>) => {
    const inner = percent == null
      ? 0
      : Math.max(0, Math.min(1, percent / 100))
    const label = percent == null ? stageBase : `${stageBase} ${percent.toFixed(1)}%`
    emit(start + (end - start) * inner, label, {
      downloadedBytes: raw?.downloadedBytes,
      totalBytes: raw?.totalBytes,
      speed: raw?.speed,
      eta: raw?.eta,
      part: raw?.fragmentIndex,
      totalParts: raw?.fragmentCount,
    })
  }
  return {
    emit,
    mapWindow,
    startPolling(path: string, start: number, end: number, stageBase: string) {
      let stopped = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const tick = () => {
        if (stopped) return
        const raw = readRawProgress(path)
        if (raw) mapWindow(start, end, raw.percent, stageBase, raw)
        timer = setTimeout(tick, 500)
      }
      timer = setTimeout(tick, 120)
      return () => {
        stopped = true
        if (timer) clearTimeout(timer)
      }
    },
  }
}

function isM3U8URL(url: string): boolean {
  const lower = url.toLowerCase()
  return lower.includes(".m3u8") || lower.includes("application/x-mpegurl") || lower.includes("application/vnd.apple.mpegurl")
}

function parseOutputPaths(output: string): string[] {
  return uniquePaths(output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("/") && MEDIA_EXTENSIONS.has(extensionOf(line))))
}

function extractProbeStreamTypes(output: string): string[] {
  const types = new Set<string>()
  const summaryPattern = /^\s*Stream #.*:\s+(Video|Audio):/gim
  for (const match of output.matchAll(summaryPattern)) types.add(match[1].toLowerCase())
  if (types.size > 0) return [...types]

  // This ffprobe build writes the selected values after its diagnostic output.
  for (const line of output.split(/\r?\n/)) {
    const type = line.trim().toLowerCase()
    if (type === "video" || type === "audio") types.add(type)
  }
  return [...types]
}

function isBilibiliPremiumMissing(output: string): boolean {
  return /premium member|1080P\s*高码率 are missing|members-only|login required|become a premium/i.test(output)
}

function codecLabel(item: RawFormat): string {
  if (isAvcCodec(item)) return "H.264"
  const codec = (item.vcodec || "").toLowerCase()
  if (/av01|av1/.test(codec)) return "AV1"
  if (/hev1|hvc1|hevc/.test(codec)) return "HEVC"
  if (/vp09|vp9/.test(codec)) return "VP9"
  return ""
}

async function verifyMediaFile(filePath: string, choice: MediaChoice, taskId: string) {
  // Prefer stream type lines; -v error still surfaces codec open failures on this n5.0.1 build.
  const result = await runCommand(`ffprobe -v error -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 ${quote(filePath)}`, 60)
  await logEvent({ level: result.exitCode === 0 ? "info" : "error", event: "verify.command.completed", taskId, details: { exitCode: result.exitCode, output: result.output, filePath } })
  if (result.exitCode !== 0) {
    if (/\bav1\b|av01|Failed to read extradata|Failed to read unit/i.test(result.output || "")) {
      throw new Error("下载文件验证失败：视频为 AV1/损坏流，本机 ffprobe 无法解析。请改选 H.264（AVC）清晰度后重试。")
    }
    throw new Error("下载文件验证失败：ffprobe 无法读取输出")
  }
  const types = extractProbeStreamTypes(result.output)
  const expected = choice.kind === "audio" ? "audio" : "video"
  if (!types.includes(expected)) throw new Error(`下载文件验证失败：缺少${expected === "audio" ? "音频" : "视频"}流`)
  if (choice.mergeAudioFormat && !types.includes("audio")) throw new Error("下载文件验证失败：合并结果缺少音频流")
  await logEvent({ level: "info", event: "verify.completed", taskId, details: { filePath, streamTypes: types, expected } })
}

async function fileSizeBytes(filePath: string): Promise<number> {
  const stat = await FileManager.stat(filePath)
  return typeof stat.size === "number" && stat.size >= 0 ? stat.size : 0
}

export async function cancelDownload(cancelPath: string) {
  await logEvent({ level: "info", event: "download.cancel.requested", details: { cancelPath } })
  await FileManager.writeAsString(cancelPath, String(Date.now()))
  cancelBackgroundDownloads()
}

async function publishMediaFile(workPath: string, taskId: string): Promise<string> {
  const sourceName = Path.basename(workPath)
  const dot = sourceName.lastIndexOf(".")
  const stem = dot > 0 ? sourceName.slice(0, dot) : sourceName
  const extension = dot > 0 ? sourceName.slice(dot) : ""
  const suffix = taskId.slice(-6)
  const destination = Path.join(DOWNLOAD_DIR, `${stem} (${suffix})${extension}`)
  if (await FileManager.exists(destination)) throw new Error("下载文件发布失败：目标文件名已存在")
  await FileManager.rename(workPath, destination)
  return destination
}

export async function downloadMedia(options: {
  url: string
  choice: MediaChoice
  concurrentFragments: ConcurrentDownloads
  insecureTLS?: boolean
  cookieFile?: string
  authorizedPlatform?: AuthPlatform
  onProgress: (value: DownloadProgress) => void
  onCancelPath: (path: string) => void
}): Promise<DownloadResult> {
  const sourceURL = extractFirstURL(options.url)
  if (!sourceURL) throw new Error("请输入有效的公开 http 或 https 链接。")
  await ensureDirectories()

  // 抖音：匿名 WebView → 候选 → 流式/图文下载（全程无用户登录）
  if (detectMediaPlatform(sourceURL) === "douyin" || isDouyinDirectChoice(options.choice)) {
    return downloadDouyinDirect({
      sourceURL,
      choice: options.choice,
      onProgress: options.onProgress,
      onCancelPath: options.onCancelPath,
    })
  }

  const taskId = createTaskId()
  const taskDirectory = Path.join(TEMP_DIR, taskId)
  const workDirectory = Path.join(taskDirectory, "work")
  const configPath = Path.join(taskDirectory, "download.json")
  const progressPath = Path.join(taskDirectory, "progress.json")
  const cancelPath = Path.join(taskDirectory, "cancel")
  await FileManager.createDirectory(workDirectory, true)
  const taskCookiePath = options.cookieFile ? Path.join(taskDirectory, "cookies.txt") : undefined
  if (options.cookieFile && taskCookiePath) await FileManager.copyFile(options.cookieFile, taskCookiePath)
  const mergeAudioFormat = options.choice.mergeAudioFormat
  const tracker = createProgressTracker(options.onProgress)
  const isCancelFlagSet = () => FileManager.existsSync(cancelPath)

  // C: direct m3u8 / HLS — BackgroundURLSession fetch of playlist URL via ffmpeg after optional progressive download of single media
  if (isM3U8URL(sourceURL) || options.choice.formatExpression === "m3u8" || options.choice.id === "m3u8") {
    options.onCancelPath(cancelPath)
    await logEvent({ level: "info", event: "download.m3u8.started", taskId, details: { sourceURL } })
    tracker.emit(0.05, "正在准备 m3u8 下载")
    const workPath = Path.join(workDirectory, `hls_${Date.now()}.mp4`)
    try {
      // Prefer ffmpeg direct (handles multi-segment); progress is time-smoothed because ffmpeg lacks percent file
      let smoothStopped = false
      let smoothTimer: ReturnType<typeof setTimeout> | null = null
      const startedAt = Date.now()
      const smoothTick = () => {
        if (smoothStopped || isCancelFlagSet()) return
        const elapsed = Date.now() - startedAt
        const inner = Math.min(0.95, 1 - Math.exp(-elapsed / 90000))
        tracker.emit(0.08 + 0.82 * inner, `正在通过 FFmpeg 下载 m3u8 · ${Math.round((0.08 + 0.82 * inner) * 100)}%`)
        smoothTimer = setTimeout(smoothTick, 500)
      }
      smoothTimer = setTimeout(smoothTick, 300)
      const ffmpegResult = await runCommand(
        `ffmpeg -nostdin -y -protocol_whitelist file,http,https,tcp,tls,crypto -allowed_extensions ALL -i ${quote(sourceURL)} -c copy -bsf:a aac_adtstoasc -movflags +faststart ${quote(workPath)}`,
        7200,
      )
      smoothStopped = true
      if (smoothTimer) clearTimeout(smoothTimer)
      await logEvent({ level: ffmpegResult.exitCode === 0 ? "info" : "error", event: "download.m3u8.ffmpeg.completed", taskId, details: { exitCode: ffmpegResult.exitCode, output: ffmpegResult.output } })
      if (isCancelFlagSet() || ffmpegResult.exitCode === 130) throw new Error("下载已取消")
      if (ffmpegResult.exitCode !== 0 || !FileManager.existsSync(workPath)) {
        // Fallback: try downloading the m3u8 URL as a single progressive asset (some hosts serve ts-like containers)
        tracker.emit(0.15, "FFmpeg 直连失败，尝试 Background 下载")
        const tmpMedia = Path.join(workDirectory, `hls_raw_${Date.now()}.ts`)
        await downloadURLToFileWithProgress({
          url: sourceURL,
          destination: tmpMedia,
          headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
          start: 0.15,
          end: 0.85,
          stage: "正在下载 m3u8 资源",
          onProgress: options.onProgress,
          isCancelFlagSet,
        })
        tracker.emit(0.88, "正在封装为 MP4")
        const wrap = await runCommand(
          `ffmpeg -nostdin -y -i ${quote(tmpMedia)} -c copy -movflags +faststart ${quote(workPath)}`,
          1800,
        )
        if (wrap.exitCode !== 0 || !FileManager.existsSync(workPath)) {
          throw new Error(compactMessage(ffmpegResult.output || wrap.output || "m3u8 下载失败"))
        }
      }
      await verifyMediaFile(workPath, options.choice, taskId)
      const filePath = await publishMediaFile(workPath, taskId)
      tracker.emit(1, "m3u8 下载并验证完成")
      await logEvent({ level: "info", event: "download.completed", taskId, details: { filePath, choiceId: options.choice.id, kind: "m3u8" } })
      return { filePath, fileName: Path.basename(filePath), sourceURL, choice: options.choice, taskId, fileSizeBytes: await fileSizeBytes(filePath) }
    } catch (error) {
      await logEvent({ level: "error", event: "download.failed", taskId, details: { message: error instanceof Error ? error.message : String(error), kind: "m3u8" } })
      throw error
    } finally {
      cancelBackgroundDownloads()
      try {
        if (FileManager.existsSync(taskDirectory)) FileManager.removeSync(taskDirectory)
      } catch {}
    }
  }

  const config = {
    url: sourceURL,
    format: options.choice.formatExpression,
    format_sort: ["res", "fps", "vcodec:h264", "acodec:aac"],
    output: "%(title).120B [%(id)s].%(ext)s",
    paths: workDirectory,
    progress_path: progressPath,
    cancel_flag: cancelPath,
    concurrent_fragments: options.concurrentFragments,
    no_check_certificates: Boolean(options.insecureTLS),
    cookiefile: taskCookiePath,
    extract_audio: false,
  }
  await FileManager.writeAsString(configPath, JSON.stringify(config))
  await logEvent({ level: "info", event: "download.started", taskId, details: { sourceURL, choiceId: options.choice.id, choiceLabel: options.choice.label, formatExpression: options.choice.formatExpression, concurrentFragments: options.concurrentFragments, tlsInsecure: Boolean(options.insecureTLS), authorizedPlatform: options.authorizedPlatform || null, cookieAuthorized: Boolean(options.cookieFile), outputDirectory: DOWNLOAD_DIR } })
  options.onCancelPath(cancelPath)

  try {
    if (mergeAudioFormat) {
      const videoConfigPath = Path.join(taskDirectory, "video.json")
      const audioConfigPath = Path.join(taskDirectory, "audio.json")
      const videoConfig = { ...config, output: "%(title).120B [%(id)s].video.%(ext)s" }
      const audioConfig = { ...config, format: mergeAudioFormat, output: "%(title).120B [%(id)s].audio.%(ext)s" }
      await FileManager.writeAsString(videoConfigPath, JSON.stringify(videoConfig))
      await FileManager.writeAsString(audioConfigPath, JSON.stringify(audioConfig))

      // video 2%→50%，audio 50%→90%，merge 90%→99%
      clearProgressFile(progressPath)
      tracker.emit(0.02, "正在下载视频流")
      const stopVideoPoll = tracker.startPolling(progressPath, 0.02, 0.5, "下载视频流")
      const videoResult = await runCommand(`python3 ${quote(RUNNER_PATH)} ${quote(videoConfigPath)}`, 7200)
      stopVideoPoll()
      clearProgressFile(progressPath)
      await logEvent({ level: videoResult.exitCode === 0 ? "info" : "error", event: "download.video.command.completed", taskId, details: { exitCode: videoResult.exitCode, output: videoResult.output } })
      if (videoResult.exitCode === 130) throw new Error("下载已取消")
      if (videoResult.exitCode !== 0) {
        if (isBilibiliPremiumMissing(videoResult.output || "")) {
          throw new Error("当前清晰度需 B 站大会员或登录 Cookie 才能下载。请改选较低清晰度（优先 H.264）或先登录后再试。")
        }
        throw new Error(compactMessage(videoResult.output || "视频流下载失败"))
      }
      const videoPath = [...parseOutputPaths(videoResult.output)].reverse().find((path) => FileManager.existsSync(path))
      if (!videoPath) {
        if (isBilibiliPremiumMissing(videoResult.output || "")) {
          throw new Error("视频流未写出文件：该清晰度可能需大会员。请改选 H.264 清晰度或登录后重试。")
        }
        throw new Error("视频流下载完成但未找到输出文件")
      }

      tracker.emit(0.5, "正在下载音频流")
      const stopAudioPoll = tracker.startPolling(progressPath, 0.5, 0.9, "下载音频流")
      const audioResult = await runCommand(`python3 ${quote(RUNNER_PATH)} ${quote(audioConfigPath)}`, 7200)
      stopAudioPoll()
      clearProgressFile(progressPath)
      await logEvent({ level: audioResult.exitCode === 0 ? "info" : "error", event: "download.audio.command.completed", taskId, details: { exitCode: audioResult.exitCode, output: audioResult.output } })
      if (audioResult.exitCode === 130) throw new Error("下载已取消")
      if (audioResult.exitCode !== 0) throw new Error(compactMessage(audioResult.output || "音频流下载失败"))
      const audioPath = [...parseOutputPaths(audioResult.output)].reverse().find((path) => FileManager.existsSync(path))
      if (!audioPath) throw new Error("音频流下载完成但未找到输出文件")

      const extension = options.choice.mergeExtension || "mkv"
      const fileName = `${Path.basename(videoPath).replace(/\.video\.[^.]+$/, "")}.${extension}`
      const workPath = Path.join(workDirectory, fileName)
      const fastStart = extension === "mp4" ? " -movflags +faststart" : ""
      tracker.emit(0.9, "正在使用内置 FFmpeg 合并")
      const mergeResult = await runCommand(`ffmpeg -y -i ${quote(videoPath)} -i ${quote(audioPath)} -map 0:v:0 -map 1:a:0 -c copy${fastStart} ${quote(workPath)}`, 900)
      await logEvent({ level: mergeResult.exitCode === 0 ? "info" : "error", event: "merge.ffmpeg.completed", taskId, details: { exitCode: mergeResult.exitCode, output: mergeResult.output, videoPath, audioPath, workPath } })
      if (mergeResult.exitCode !== 0) {
        // MD-style fallback: VideoToolbox re-encode when stream copy fails
        tracker.emit(0.92, "无损合并失败，正在转码为兼容 MP4")
        await FileManager.remove(workPath).catch(() => {})
        const mp4Path = workPath.replace(/\.[^.]+$/, ".mp4")
        const transcode = await runCommand(
          `ffmpeg -y -i ${quote(videoPath)} -i ${quote(audioPath)} -map 0:v:0 -map 1:a:0 -c:v h264_videotoolbox -c:a aac -movflags +faststart ${quote(mp4Path)}`,
          7200,
        )
        await logEvent({ level: transcode.exitCode === 0 ? "info" : "error", event: "merge.ffmpeg.transcode.completed", taskId, details: { exitCode: transcode.exitCode, output: transcode.output } })
        if (transcode.exitCode !== 0 || !FileManager.existsSync(mp4Path)) {
          throw new Error(compactMessage(mergeResult.output || transcode.output || "FFmpeg 合并失败"))
        }
        await verifyMediaFile(mp4Path, options.choice, taskId)
        const filePath = await publishMediaFile(mp4Path, taskId)
        tracker.emit(1, "下载、转码并验证完成")
        await logEvent({ level: "info", event: "download.completed", taskId, details: { filePath, choiceId: options.choice.id, mergedWithFFmpeg: true, transcoded: true } })
        return { filePath, fileName: Path.basename(filePath), sourceURL, choice: options.choice, taskId, fileSizeBytes: await fileSizeBytes(filePath) }
      }
      await verifyMediaFile(workPath, options.choice, taskId)
      const filePath = await publishMediaFile(workPath, taskId)
      tracker.emit(1, "下载、合并并验证完成")
      await logEvent({ level: "info", event: "download.completed", taskId, details: { filePath, choiceId: options.choice.id, mergedWithFFmpeg: true } })
      return { filePath, fileName: Path.basename(filePath), sourceURL, choice: options.choice, taskId, fileSizeBytes: await fileSizeBytes(filePath) }
    }

    clearProgressFile(progressPath)
    tracker.emit(0.02, "正在下载")
    const stopPoll = tracker.startPolling(progressPath, 0.02, 0.95, "正在下载")
    const result = await runCommand(`python3 ${quote(RUNNER_PATH)} ${quote(configPath)}`, 7200)
    stopPoll()
    clearProgressFile(progressPath)
    await logEvent({ level: result.exitCode === 0 ? "info" : "error", event: "download.command.completed", taskId, details: { exitCode: result.exitCode, output: result.output } })
    if (result.exitCode === 130) throw new Error("下载已取消")
    if (result.exitCode !== 0) throw new Error(compactMessage(result.output || "yt-dlp 下载失败"))
    const paths = parseOutputPaths(result.output)
    const filePath = [...paths].reverse().find((path) => FileManager.existsSync(path))
    if (!filePath) throw new Error("下载完成但未找到输出文件")
    tracker.emit(0.96, "正在验证文件")
    await verifyMediaFile(filePath, options.choice, taskId)
    const publishedPath = await publishMediaFile(filePath, taskId)
    tracker.emit(1, "下载并验证完成")
    await logEvent({ level: "info", event: "download.completed", taskId, details: { filePath: publishedPath, choiceId: options.choice.id } })
    return { filePath: publishedPath, fileName: Path.basename(publishedPath), sourceURL, choice: options.choice, taskId, fileSizeBytes: await fileSizeBytes(publishedPath) }
  } catch (error) {
    await logEvent({ level: "error", event: "download.failed", taskId, details: { message: error instanceof Error ? error.message : String(error) } })
    throw error
  } finally {
    cancelBackgroundDownloads()
    try {
      if (FileManager.existsSync(taskDirectory)) FileManager.removeSync(taskDirectory)
    } catch {}
  }
}

export async function saveResult(filePath: string, fileName: string, mode: SaveMode, taskId?: string): Promise<string> {
  if (mode === "photos") {
    if ([".mp3", ".m4a", ".aac", ".opus"].includes(extensionOf(filePath))) {
      await logEvent({ level: "warn", event: "save.photos.unsupported", taskId, details: { filePath, fileName } })
      throw new Error("音频文件请导出到文件或通过分享面板保存。")
    }
    const isVideo = [".mp4", ".m4v", ".mov", ".mkv", ".webm"].includes(extensionOf(filePath))
    const saved = isVideo
      ? await Photos.saveVideo(filePath, { fileName, shouldMoveFile: false })
      : await Photos.savePhoto(filePath, { fileName, shouldMoveFile: false })
    if (!saved) {
      await logEvent({ level: "error", event: "save.photos.failed", taskId, details: { filePath, fileName } })
      throw new Error("保存到相册失败")
    }
    await logEvent({ level: "info", event: "save.photos.completed", taskId, details: { filePath, fileName } })
    return "已保存到相册。"
  }
  if (mode === "files") {
    const data = Data.fromFile(filePath)
    if (!data) throw new Error("无法读取下载文件")
    const paths = await DocumentPicker.exportFiles({ files: [{ data, name: fileName }] })
    if (!paths.length) {
      await logEvent({ level: "warn", event: "save.files.cancelled", taskId, details: { fileName } })
      throw new Error("已取消导出")
    }
    await logEvent({ level: "info", event: "save.files.completed", taskId, details: { fileName, exportedPaths: paths } })
    return "已导出到文件。"
  }
  const choice = await Dialog.actionSheet({
    title: "下载完成",
    message: fileName,
    actions: [{ label: "播放" }, { label: "保存到相册" }, { label: "导出到文件" }, { label: "分享文件" }, { label: "暂不处理" }],
    cancelButton: true,
  })
  if (choice === 0) {
    await QuickLook.previewURLs([filePath], true)
    await logEvent({ level: "info", event: "save.play.presented", taskId, details: { fileName } })
    return "已关闭系统播放器。"
  }
  if (choice === 1) return saveResult(filePath, fileName, "photos", taskId)
  if (choice === 2) return saveResult(filePath, fileName, "files", taskId)
  if (choice === 3) {
    await ShareSheet.present([filePath])
    await logEvent({ level: "info", event: "save.share.presented", taskId, details: { filePath, fileName } })
    return "已打开分享面板。"
  }
  await logEvent({ level: "info", event: "save.deferred", taskId, details: { filePath, fileName } })
  return "文件已保留在 Yoinks 下载目录。"
}
