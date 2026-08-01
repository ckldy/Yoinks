import { AbortController, Path, Script, fetch } from "scripting"
import { createTaskId, logEvent } from "./logs"
import { extractPublicPlayerFrameSources, extractPublicPlayerSources, type PublicPlayerSource } from "./public-player-source"
import type { AuthPlatform } from "./platform-auth"
import { isHwCompatibleBilibiliUrl } from "./player/bilibili-cdn"
import { cancelBackgroundDownloads, downloadURLToFileWithProgress } from "./background-download"
import {
  type HlsManifestSummary,
  downloadHlsSegmentsNative,
  hlsPublishFailure,
  isM3U8URL,
  listHlsVariants,
  readHlsManifestSummary,
} from "./hls"
import { formatBytes, runCommand } from "./shell-utils"

// HLS 清单解析与变体选择已拆分到 services/hls.ts；
// 保留 re-export 以兼容既有 import（verify 脚本等）与公开 API。
export { listHlsVariants, parseHlsManifestSummary, selectHighestHlsVariant } from "./hls"
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
  /** Source video codec family; hard codecs (AV1/VP9/HEVC) mux to MKV for external players. */
  videoCodec?: "h264" | "av1" | "hevc" | "vp9" | "other"
  previewURL?: string
  previewReferer?: string
  previewHeaders?: Record<string, string>
  /** A public extracted stream URL; when present it replaces the webpage URL for this choice only. */
  sourceURL?: string
  /** For HLS master playlists: the selected variant URI (relative to sourceURL). When present,
   * the downloader downloads exactly this variant's segments instead of auto-picking the top one. */
  hlsVariantURI?: string
  /** Public page or allowed same-site iframe URL used only as Referer for sourceURL. */
  sourceReferer?: string
  /** Separate audio stream for DASH video-only online preview. */
  previewAudioURL?: string
  /** Actual video codec string (e.g. avc1.640033) for DASH MPD. */
  previewVideoCodec?: string
  /** Actual audio codec string (e.g. mp4a.40.2) for DASH MPD. */
  previewAudioCodec?: string
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
/** One end-to-end probe, including automatic retries, may use at most this many seconds. */
export const PROBE_TOTAL_TIMEOUT_SECONDS = 45
/** Final containers + common yt-dlp intermediates (Bilibili DASH often uses .m4s). */
const MEDIA_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".mkv", ".webm", ".m4a", ".aac", ".opus", ".mp3", ".m4s", ".ts", ".flv"])

export function quote(value: string): string {
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`
}

/** Scripting host noise that can mask real yt-dlp exit output. */
export const HOST_NOISE_LINE =
  /Script window host view deinit|Transpile JSContext(?: released)?|webview viewmodel cleanup|WebViewController disposed|load start|load stop|set channel|\[WebView\]\s*\[LOG\]|\[WebView\]|Write scripts settings successfully/i

export function isHostDeinitNoise(value: string): boolean {
  const text = String(value || "").trim()
  if (!text) return false
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const meaningful = lines.filter((line) => !HOST_NOISE_LINE.test(line))
  // Pure host noise (deinit / WebView / settings write) → treat as transient interrupt.
  if (meaningful.length === 0) {
    return (
      lines.some((line) => HOST_NOISE_LINE.test(line))
      || /deinit|WebView|JSContext|Write scripts settings successfully/i.test(text)
    )
  }
  const collapsed = meaningful.join(" ").replace(/\s+/g, " ").trim()
  if (/^(?:Script window host view deinit\s*)+$/i.test(collapsed)) return true
  if (/^(?:Write scripts settings successfully\s*)+$/i.test(collapsed)) return true
  // Short residual that is only host log tokens, e.g. "[WebView][LOG] [c0]"
  if (
    collapsed.length <= 64
    && /\[WebView\]|deinit|JSContext|Write scripts settings/i.test(collapsed)
    && !/ERROR:|Unable to|HTTP Error|Unsupported|timed out|certificate/i.test(collapsed)
  ) {
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

/** TLS certificate verification failures, e.g. caused by an on-device HTTPS capture/MITM. */
export function isCertificateVerifyFailure(value: string): boolean {
  const text = String(value || "")
  return /CERTIFICATE_VERIFY_FAILED|certificate verify failed|unable to get local issuer certificate/i.test(text)
}


/** Download-stage TLS/handshake timeouts (mid-file SSL), distinct from probe webpage open. */
export function isDownloadTlsTimeout(value: string): boolean {
  const text = String(value || "")
  if (!text) return false
  if (/handshake operation timed out/i.test(text)) return true
  if (/_ssl\.c:\d+.*timed out/i.test(text)) return true
  if (/Got error:.*(?:timed out|timeout)/i.test(text) && !/Unable to download webpage/i.test(text)) return true
  if (/\[download\].*(?:Got error:|ERROR:).*(?:timed out|timeout)/i.test(text)) return true
  if (/ERROR:\s*\[download\].*(?:timed out|timeout)/i.test(text)) return true
  return false
}

function isRemoteDownloadDisconnect(value: string): boolean {
  return /Remote end closed connection|Connection reset|ECONNRESET|IncompleteRead|Connection aborted/i.test(String(value || ""))
}

function stripHostNoise(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !HOST_NOISE_LINE.test(line))
    .join("\n")
}

/** Extract yt-dlp ERROR snippets even when glued to a progress line without newline. */
function extractErrorSnippets(source: string): string[] {
  const snippets: string[] = []
  for (const match of source.matchAll(/(?:^|[\s\r\n])ERROR:\s*([^\r\n]+)/gi)) {
    const body = (match[1] || "").trim()
    if (body) snippets.push(body)
  }
  for (const match of source.matchAll(/\[download\]\s*Got error:\s*([^\r\n]+)/gi)) {
    const body = (match[1] || "").trim()
    if (body) snippets.push(`[download] Got error: ${body}`)
  }
  for (const line of source.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    if (line.startsWith("ERROR:") || /^ERROR\b/i.test(line) || /Unable to download webpage/i.test(line)) {
      snippets.push(line.replace(/^ERROR:\s*/i, ""))
    }
  }
  return snippets
}

export function isNoDownloadableFormatFailure(value: string): boolean {
  return /no(?:\s+video)?\s+formats?|requested format is not available|未找到可下载的视频格式|no playable formats?/i.test(String(value || ""))
}

export function isProbeTimeoutFailure(value: string): boolean {
  return /^媒体分析超时（\d+ 秒）。请检查网络后重试。$/.test(String(value || "").trim())
}

/** yt-dlp's generic extractor was blocked, while the user-approved Safari capture already observed this public HLS URL. */
export function isCloudflareAntiBotFailure(value: string): boolean {
  const text = String(value || "")
  return /HTTP Error 403 caused by Cloudflare anti-bot challenge|Cloudflare anti-bot challenge/i.test(text)
}

/** A CDN can accept Safari's HLS request but close the Python/yt-dlp connection under HTTPS capture. */
export function isRemoteHlsManifestDisconnect(value: string): boolean {
  return /Unable to download webpage:\s*Remote end closed connection without response|Failed to download m3u8 information:\s*Remote end closed connection without response/i.test(String(value || ""))
}

export function isSafariHlsDirectFallbackFailure(value: string): boolean {
  return isCloudflareAntiBotFailure(value) || isRemoteHlsManifestDisconnect(value)
}

export function compactMessage(value: string): string {
  const cleaned = stripHostNoise(value)
  const source = cleaned || value
  if (isDownloadTlsTimeout(source)) {
    return "下载过程中网络 TLS/握手超时，请检查网络后重试；可改选 H.264 清晰度或稍后再试。"
  }
  if (isRemoteHlsManifestDisconnect(source)) {
    return "读取 HLS 清单时远端 CDN 连接中断，请稍后重试。"
  }
  if (isRemoteDownloadDisconnect(source)) {
    return "下载媒体时远端 CDN 连接中断，已重试仍未完成；请稍后重试。"
  }
  const errors = extractErrorSnippets(source)
  if (errors.length) {
    const last = errors[errors.length - 1].replace(/^ERROR:\s*/i, "").slice(0, 800)
    if (/Unable to download webpage/i.test(last) && /timed out|timeout|TransportError/i.test(last)) {
      return "打开页面超时，暂时识别不到格式。请检查网络后重试；短链可改完整视频页链接再分析。"
    }
    if (/timed out|timeout|TransportError/i.test(last) && !/Unable to download webpage/i.test(last)) {
      return "下载过程中网络超时，请检查网络后重试。"
    }
    if (/timed out|timeout|TransportError/i.test(last)) {
      return "打开页面超时，暂时识别不到格式。请检查网络后重试；短链可改完整视频页链接再分析。"
    }
    return last
  }
  if (isHostDeinitNoise(value) && !cleaned) {
    return "操作被宿主中断或日志干扰，请重试。"
  }
  if (/Unable to download webpage/i.test(source) && /timed out|timeout|TransportError/i.test(source)) {
    return "打开页面超时，暂时识别不到格式。请检查网络后重试；短链可改完整视频页链接再分析。"
  }
  if (/timed out|timeout|TransportError/i.test(source)) {
    return "下载过程中网络超时，请检查网络后重试。"
  }
  return source.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(-800)
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))]
}

function extensionOf(path: string): string {
  const clean = path.startsWith("/") ? path : path.split(/[?#]/)[0]
  const fileName = clean.slice(clean.lastIndexOf("/") + 1)
  const index = fileName.lastIndexOf(".")
  return index > 0 ? fileName.slice(index).toLowerCase() : ""
}

const DIRECT_MEDIA_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".mp3", ".m4a", ".aac", ".opus", ".ogg", ".wav"])

export function hlsMediaChoice(sourceURL: string): MediaChoice | null {
  if (!/\.m3u8(?:$|[?#])/i.test(sourceURL)) return null
  return {
    id: "m3u8",
    label: "HLS 原始清单 · 自适应视频",
    kind: "video",
    formatExpression: "m3u8",
    container: "mp4",
    previewURL: sourceURL,
    sourceURL,
  }
}

/**
 * Same HLS choice shape as hlsMediaChoice but for extensionless endpoints (e.g.
 * play.php?site_id=...) whose body was sniffed as an HLS playlist. formatExpression
 * "m3u8" keeps the download path on the HLS branch regardless of the URL shape.
 */
export function hlsEndpointChoice(sourceURL: string): MediaChoice {
  return { id: "m3u8", label: "HLS 原始清单 · 自适应视频", kind: "video", formatExpression: "m3u8", container: "mp4", previewURL: sourceURL, sourceURL }
}

/**
 * Build one HLS choice per master variant (highest first) so users can pick the
 * quality they actually want, or a single adaptive choice for direct media playlists.
 * Each variant choice carries its URI in hlsVariantURI; the downloader then fetches
 * exactly that variant's segments instead of auto-picking the top one.
 */
export function hlsEndpointChoices(sourceURL: string, master: string): MediaChoice[] {
  const variants = listHlsVariants(master)
  if (!variants.length) return [hlsEndpointChoice(sourceURL)]
  return variants.map((variant, index) => {
    let previewURL = sourceURL
    try { previewURL = new URL(variant.uri, sourceURL).toString() } catch {}
    return {
      id: index === 0 ? "m3u8" : `m3u8-${variant.height || variant.bandwidth}`,
      label: variant.height ? `${variant.height}p · HLS 变体` : `HLS · ${Math.max(1, Math.round(variant.bandwidth / 1000))}kbps`,
      kind: "video" as const,
      formatExpression: "m3u8",
      container: "mp4",
      height: variant.height || undefined,
      previewURL,
      sourceURL,
      hlsVariantURI: variant.uri,
    }
  })
}

/**
 * Fetch a Safari-captured endpoint body and return it only when it is an HLS playlist
 * (#EXTM3U), using only the page Referer + Safari UA. No cookies, no authorization
 * headers, and the body is bounded to 256 KB so a large MP4 is rejected without
 * buffering it. Returns null when the endpoint is not an HLS manifest.
 */
async function sniffHlsManifest(sourceURL: string, referer: string, userAgent: string): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(sourceURL, { headers: { Accept: "*/*", Referer: referer, "User-Agent": userAgent }, signal: controller.signal })
    if (!response.ok) return null
    const contentLength = Number(response.headers.get("content-length") || 0)
    if (Number.isFinite(contentLength) && contentLength > 262144) return null
    const text = await response.text()
    return text.length <= 262144 && /^\s*#EXTM3U/m.test(text || "") ? text : null
  } catch { return null } finally { clearTimeout(timeout) }
}

function isVidURL(value: string): boolean {
  try { return /\.vid(?:$|[?#])/i.test(new URL(value).pathname) } catch { return false }
}

/**
 * 重定向型媒体端点（如 sxyprn.com/cdn8/<obfuscated>.vid → c8.trafficdeposit.com/widi/...vid，
 * 553MB 渐进式 MP4）：yt-dlp generic 常因 302 后被 CDN 断开/SSL 失败。用浏览器式 GET
 * （Range: bytes=0-1 + Referer + Safari UA）跟随重定向，仅当最终响应为音视频 content-type
 * 时返回直链 choice；否则返回 null（交由 HLS 嗅探/公开播放器回退处理）。
 */
async function resolveRedirectedDirectMedia(sourceURL: string, referer: string, userAgent: string, knownKind?: "video" | "audio"): Promise<MediaChoice | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(sourceURL, { headers: { Range: "bytes=0-1", Accept: "*/*", Referer: referer, "User-Agent": userAgent }, signal: controller.signal })
    if (!response.ok) return null
    const finalURL = response.url || sourceURL
    const contentType = response.headers.get("content-type") || ""
    if (!/^(?:video|audio)\//i.test(contentType)) return null
    const choice = directMediaChoice(finalURL, knownKind || (/^audio\//i.test(contentType) ? "audio" : "video"))
    if (!choice) return null
    choice.sourceURL = finalURL
    choice.sourceReferer = referer
    choice.previewReferer = referer
    choice.previewHeaders = { Referer: referer, "User-Agent": userAgent }
    // 重定向后的直链（如 c8.../6a6c61ac44a37.vid）通常不带分辨率；来源页常标注
    // "resolution:HD 720"，据此回填清晰度，让格式列表显示 720p。
    if (!choice.height) {
      const height = await fetchPageResolutionHint(referer)
      if (height) {
        choice.height = height
        choice.label = `原始视频 · 容器·${(choice.container || "mp4").toUpperCase()} · ${height}p`
      }
    }
    return choice
  } catch { return null } finally { clearTimeout(timeout) }
}

/**
 * 从 Safari 来源页 HTML 提取视频分辨率（如 sxyprn 页面 "resolution:<b>HD</b>720"）。
 * 仅在页面为 text/html 且体积受限时尝试，最多 6 秒；失败返回 undefined，不影响主流程。
 */
async function fetchPageResolutionHint(pageURL: string): Promise<number | undefined> {
  if (!/^https?:\/\//i.test(pageURL)) return undefined
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 6000)
  try {
    const response = await fetch(pageURL, { headers: { Accept: "text/html,application/xhtml+xml" }, signal: controller.signal })
    if (!response.ok) return undefined
    const contentType = response.headers.get("content-type") || ""
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) return undefined
    const contentLength = Number(response.headers.get("content-length") || 0)
    if (Number.isFinite(contentLength) && contentLength > 262144) return undefined
    const text = await response.text()
    if (text.length > 262144) return undefined
    const match = text.match(/resolution[^0-9]{0,40}?(\d{3,4})(?:p|\b|$)/i)
    if (!match) return undefined
    const height = Number(match[1])
    return height >= 240 && height <= 4320 ? height : undefined
  } catch { return undefined } finally { clearTimeout(timeout) }
}

export function directMediaChoice(sourceURL: string, knownKind?: "video" | "audio"): MediaChoice | null {
  const detectedExtension = extensionOf(sourceURL)
  const extension = DIRECT_MEDIA_EXTENSIONS.has(detectedExtension)
    ? detectedExtension
    : knownKind === "video" ? ".mp4"
      : knownKind === "audio" ? ".m4a"
        : ""
  if (!extension) return null
  const kind: MediaKind = [".mp3", ".m4a", ".aac", ".opus", ".ogg", ".wav"].includes(extension) ? "audio" : "video"
  const container = extension.slice(1)
  // 公开播放器直链常以 1080.mp4 / 720.mp4 命名，从 URL 推断清晰度并展示。
  const height = kind === "video" ? inferDirectMediaHeight(sourceURL) : undefined
  const heightText = height ? ` · ${height}p` : ""
  return {
    id: `direct-${container}`,
    label: kind === "audio" ? `原始音频 · ${container.toUpperCase()}` : `原始视频 · 容器·${container.toUpperCase()}${heightText}`,
    kind,
    formatExpression: "direct",
    container,
    ...(height ? { height } : {}),
    previewURL: sourceURL,
  }
}

function inferDirectMediaHeight(sourceURL: string): number | undefined {
  try {
    const pathname = new URL(sourceURL).pathname
    const match = pathname.match(/(?:^|[\/_.-])(\d{3,4})p?(?=[._-]|$)/i)
    return match ? Number(match[1]) : undefined
  } catch { return undefined }
}

function isAllowedURL(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

export type MediaPlatform = "douyin" | "xiaohongshu" | "youtube" | "generic"

const XIAOHONGSHU_URL_PATTERNS = [
  /https?:\/\/(?:www\.)?(?:xiaohongshu|rednote)\.com\/(?:explore|discovery\/item|search_result|user\/profile\/[a-z0-9]+)\/[a-z0-9]+(?:\?[^\s"'<>，。！？；：、]*)?/i,
  /https?:\/\/xhslink\.com\/[^\s"'<>，。！？；：、]+/i,
]
const DOUYIN_URL_PATTERNS = [
  /https?:\/\/v\.douyin\.com\/[a-zA-Z0-9_-]+/i,
  /https?:\/\/(?:www\.)?douyin\.com\/video\/[0-9]+/i,
  /https?:\/\/(?:www\.)?iesdouyin\.com\/[^\s"'<>，。！？；：、]*/i,
]
const YOUTUBE_URL_PATTERNS = [
  /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]+/i,
  /https?:\/\/(?:www\.)?youtu\.be\/[a-zA-Z0-9_-]+/i,
  /https?:\/\/(?:www\.)?youtube\.com\/shorts\/[a-zA-Z0-9_-]+/i,
  /https?:\/\/(?:music|gaming)\.youtube\.com\//i,
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
  if (YOUTUBE_URL_PATTERNS.some((pattern) => pattern.test(value))) return "youtube"
  return "generic"
}

export function mediaPlatformLabel(value: string | null | undefined): string | null {
  switch (detectMediaPlatform(value)) {
    case "douyin": return "抖音"
    case "xiaohongshu": return "小红书"
    default: return null
  }
}

/** Pin X/Twitter status URLs to /video/N so multi-video posts stay single-item. */
export function pinXStatusVideoURL(value: string, videoIndex = 1): string {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (!(host === "x.com" || host === "twitter.com" || host.endsWith(".x.com") || host.endsWith(".twitter.com"))) {
      return value
    }
    const match = url.pathname.match(/^(\/(?:[^/]+|i)\/status\/\d+)(?:\/video\/(\d+))?\/?$/i)
    if (!match) return value
    const existing = match[2] ? Number(match[2]) : NaN
    const index = Number.isFinite(existing) && existing > 0 ? existing : Math.max(1, Math.floor(videoIndex || 1))
    url.pathname = `${match[1]}/video/${index}`
    return url.toString()
  } catch {
    return value
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

/** Normalize for batch dedupe: drop trailing slashes so site vs generic matches collapse. */
function batchURLDedupeKey(url: string): string {
  return url.replace(/\/+$/, "") || url
}

/** Batch add: collect public http(s) URLs in document order; site patterns preferred at same index; dedupe. */
export function extractAllURLs(value: string | null | undefined): string[] {
  if (!value) return []
  type Hit = { start: number; raw: string; priority: number }
  const hits: Hit[] = []

  for (const pattern of [...XIAOHONGSHU_URL_PATTERNS, ...DOUYIN_URL_PATTERNS]) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)
    for (const match of value.matchAll(global)) {
      if (match[0] != null && typeof match.index === "number") {
        hits.push({ start: match.index, raw: match[0], priority: 0 })
      }
    }
  }

  const generic = /https?:\/\/[^\s<>"']+/gi
  for (const match of value.matchAll(generic)) {
    if (match[0] != null && typeof match.index === "number") {
      hits.push({ start: match.index, raw: match[0], priority: 1 })
    }
  }

  hits.sort((a, b) => a.start - b.start || a.priority - b.priority)

  const found: string[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    const candidate = sanitizeExtractedURL(hit.raw)
    if (!isAllowedURL(candidate)) continue
    const key = batchURLDedupeKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    // Prefer canonical form without trailing slash for queue identity.
    found.push(key.startsWith("http") ? key : candidate)
  }

  return found
}

/** Spec caps for batch add / session queue (docs/superpowers/specs/2026-07-26-yoinks-batch-download-design.md). */
export const BATCH_ADD_MAX = 20
export const BATCH_QUEUE_MAX = 30

async function ensureDirectories() {
  if (!(await FileManager.exists(DOWNLOAD_DIR))) await FileManager.createDirectory(DOWNLOAD_DIR, true)
  if (!(await FileManager.exists(TEMP_DIR))) await FileManager.createDirectory(TEMP_DIR, true)
}

/** One automatic re-run for host noise or download TLS/handshake timeouts. */
async function runYtdlpWithHostNoiseRetry(options: {
  command: string
  timeout: number
  taskId: string
  stage: string
  isCancelFlagSet: () => boolean
}) {
  let result = await runCommand(options.command, options.timeout)
  if (
    result.exitCode !== 0
    && result.exitCode !== 130
    && !options.isCancelFlagSet()
    && isHostDeinitNoise(result.output || "")
  ) {
    await logEvent({
      level: "warn",
      event: "download.host-noise.retry",
      taskId: options.taskId,
      details: { stage: options.stage, delayMilliseconds: 400 },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 400))
    if (options.isCancelFlagSet()) {
      return { ...result, exitCode: 130 }
    }
    result = await runCommand(options.command, options.timeout)
  }
  if (
    result.exitCode !== 0
    && result.exitCode !== 130
    && !options.isCancelFlagSet()
    && isDownloadTlsTimeout(result.output || "")
  ) {
    await logEvent({
      level: "warn",
      event: "download.tls-timeout.retry",
      taskId: options.taskId,
      details: { stage: options.stage, delayMilliseconds: 800 },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 800))
    if (options.isCancelFlagSet()) {
      return { ...result, exitCode: 130 }
    }
    result = await runCommand(options.command, options.timeout)
  }
  if (
    result.exitCode !== 0
    && result.exitCode !== 130
    && options.stage === "audio"
    && !options.isCancelFlagSet()
    && isRemoteDownloadDisconnect(result.output || "")
  ) {
    await logEvent({
      level: "warn",
      event: "download.audio-remote-disconnect.retry",
      taskId: options.taskId,
      details: { delayMilliseconds: 1200 },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 1200))
    if (options.isCancelFlagSet()) {
      return { ...result, exitCode: 130 }
    }
    result = await runCommand(options.command, options.timeout)
  }
  return result
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
  if (codec.startsWith("avc") || codec.includes("h264") || codec.includes("avc1")) return true
  // Some extractors (e.g. X/Twitter progressive MP4) omit vcodec even though the path contains avc1.
  try {
    const pathname = new URL(item.previewURL || "").pathname.toLowerCase()
    return pathname.includes("/avc1/") || pathname.includes("avc1.")
  } catch {
    return false
  }
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

function isHlsVideoOnlyUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    return pathname.endsWith(".m3u8") || pathname.includes(".m3u8")
  } catch {
    return /\.m3u8(?:[?#]|$)/i.test(url)
  }
}

/** Pick best progressive URL for WKWebView preview (prefer H.264, muxed, decodable). Download format stays on `item`. */
function pickPreviewVideoSource(
  item: RawFormat,
  muxedVideos: RawFormat[],
  videoOnly: RawFormat[],
): RawFormat {
  // X/Twitter serves HLS video-only playlists with separate HLS audio playlists.
  // Current HLS player cannot pair them, so prefer a same-height muxed progressive MP4 if available.
  const itemIsHlsVideoOnly = isHlsVideoOnlyUrl(item.previewURL || "") && (!item.acodec || item.acodec === "none")
  if (itemIsHlsVideoOnly) {
    const sameHeightMuxedAvc = muxedVideos
      .filter((m) => m.height === item.height && m.previewURL && isAvcCodec(m))
      .sort(previewVideoPreference)
    if (sameHeightMuxedAvc[0]) return sameHeightMuxedAvc[0]
  }

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

/** Codec early + always visible; container labeled as 容器 to avoid MP4 = playable confusion. */
export function formatVideoChoiceLabel(options: {
  height?: number
  codecLabel: string
  hardCodec: boolean
  kindText: string
  containerExt?: string
  fps?: number
  estimatedBytes?: number
}): string {
  const heightText = options.height ? `${options.height}p` : "视频"
  const codecText = options.codecLabel || "编码未知"
  const hardHint = options.hardCodec ? " · 外部播放器" : ""
  const containerText = options.containerExt ? ` · 容器·${options.containerExt.toUpperCase()}` : ""
  const fpsText = options.fps ? ` · ${Math.round(options.fps)} fps` : ""
  const sizeText = options.estimatedBytes ? ` · 约 ${formatBytes(options.estimatedBytes)}` : ""
  return `${heightText} · ${codecText}${hardHint} · ${options.kindText}${containerText}${fpsText}${sizeText}`
}

function heightCodecKey(item: RawFormat): string {
  return `${item.height || 0}:${videoCodecKind(item)}`
}

export function buildChoices(formats: RawFormat[]): MediaChoice[] {
  const audioFormats = formats
    .filter((item) => {
      if (!item.formatId) return false
      const isVideoDisabled = !item.vcodec || item.vcodec === "none"
      // Standard audio-only: acodec present and not "none".
      if (isVideoDisabled && item.acodec && item.acodec !== "none") return true
      // X/Twitter HLS audio playlists report acodec=null but format_id/path clearly mark them as audio-only.
      if (isVideoDisabled && (item.formatId.toLowerCase().includes("audio") || /\/mp4a\//i.test(item.previewURL || ""))) return true
      return false
    })
    .sort((a, b) => {
      const aPreference = (a.ext === "m4a" ? 100_000 : 0) + (a.abr || a.tbr || 0)
      const bPreference = (b.ext === "m4a" ? 100_000 : 0) + (b.abr || b.tbr || 0)
      return bPreference - aPreference || formatScore(b) - formatScore(a)
    })
  const muxedVideos = formats
    .filter(isMuxedVideo)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || Number(isAvcCodec(b)) - Number(isAvcCodec(a)) || formatScore(b) - formatScore(a))
  const videoOnly = formats
    .filter((item) => item.formatId && item.vcodec && item.vcodec !== "none" && (!item.acodec || item.acodec === "none") && item.height)
    // Height first, then H.264, then quality — one entry per height+codec family.
    .sort((a, b) => (b.height || 0) - (a.height || 0) || Number(isAvcCodec(b)) - Number(isAvcCodec(a)) || formatScore(b) - formatScore(a))

  const choices: MediaChoice[] = []
  const seenMuxedKeys = new Set<string>()
  for (const item of muxedVideos) {
    const key = heightCodecKey(item)
    if (seenMuxedKeys.has(key)) continue
    seenMuxedKeys.add(key)
    const videoCodec = videoCodecKind(item)
    const hardCodec = videoCodec === "av1" || videoCodec === "hevc" || videoCodec === "vp9"
    choices.push({
      id: `video-${item.height}-${item.formatId}`,
      label: formatVideoChoiceLabel({
        height: item.height,
        codecLabel: codecLabel(item),
        hardCodec,
        kindText: "视频",
        containerExt: item.ext,
        fps: item.fps,
        estimatedBytes: item.filesize,
      }),
      kind: "video" as const,
      formatExpression: item.formatId,
      container: item.ext?.toLowerCase(),
      height: item.height,
      estimatedBytes: item.filesize,
      videoCodec,
      previewURL: item.previewURL,
      previewReferer: item.previewReferer,
      previewHeaders: item.previewHeaders,
    })
  }

  // One choice per height+codec (e.g. 1080p H.264 and 1080p AV1 both listed).
  const seenVideoOnlyKeys = new Set<string>()
  for (const item of videoOnly) {
    const height = item.height || 0
    if (!height) continue
    const key = heightCodecKey(item)
    if (seenVideoOnlyKeys.has(key)) continue
    seenVideoOnlyKeys.add(key)

    const matchingAudios = audioFormats.filter((candidate) => item.ext === "mp4" || item.ext === "m4s" ? (candidate.ext === "m4a" || candidate.ext === "mp4") : candidate.ext === "webm")
    const audio = matchingAudios[0] || audioFormats[0]
    // For preview, prefer an audio URL that survives HW-mirror rewriting (COS-signed URLs return 403).
    let previewAudio = matchingAudios.find((candidate) => isHwCompatibleBilibiliUrl(candidate.previewURL || "")) || audio
    // DashPlayerService only parses MP4 DASH init/index; webm/opus audio cannot be used as the DASH audio stream.
    // Fall back to AAC (m4a/mp4) so YouTube VP9/AV1 choices can still preview via the H.264 video source.
    if (previewAudio?.ext === "webm") {
      previewAudio = audioFormats.find((candidate) => candidate.ext === "m4a" || candidate.ext === "mp4") || previewAudio
    }
    const canMerge = Boolean(audio)
    const videoCodec = videoCodecKind(item)
    const hardCodec = videoCodec === "av1" || videoCodec === "hevc" || videoCodec === "vp9"
    // HEVC/AV1/VP9: always MKV stream-copy for external players; H.264+AAC stays MP4.
    const mergeExtension: "mp4" | "mkv" = hardCodec
      ? "mkv"
      : (item.ext === "mp4" || item.ext === "m4s") && (audio?.ext === "m4a" || audio?.ext === "mp4")
        ? "mp4"
        : "mkv"
    const previewSource = pickPreviewVideoSource(item, muxedVideos, videoOnly)
    const previewIsMuxed = isMuxedVideo(previewSource)
    // Hard codecs in WKWebView often black-screen; never pair separate audio for them (avoids 有声无画).
    const previewDecodable = isAvcCodec(previewSource) || !isHardVideoCodec(previewSource)
    const needsSeparateAudio =
      previewDecodable && !previewIsMuxed && Boolean(previewAudio?.previewURL)
    const estimatedBytes = (item.filesize || 0) + (audio?.filesize || 0) || undefined
    choices.push({
      id: `video-${item.height}-${item.formatId}${audio ? `-with-${audio.formatId}` : "-silent"}`,
      label: formatVideoChoiceLabel({
        height: item.height,
        codecLabel: codecLabel(item),
        hardCodec,
        kindText: canMerge ? "合并音频" : "无音轨视频",
        containerExt: mergeExtension || item.ext,
        fps: item.fps,
        estimatedBytes,
      }),
      kind: "video",
      formatExpression: item.formatId,
      height: item.height,
      estimatedBytes,
      mergeAudioFormat: audio?.formatId,
      mergeExtension: canMerge ? mergeExtension : undefined,
      videoCodec,
      previewURL: previewSource.previewURL,
      previewReferer: previewSource.previewReferer || item.previewReferer,
      previewHeaders: previewSource.previewHeaders || item.previewHeaders,
      previewAudioURL: needsSeparateAudio ? previewAudio?.previewURL : undefined,
      previewVideoCodec: previewSource.vcodec || item.vcodec || undefined,
      previewAudioCodec: previewAudio?.acodec || undefined,
    })
  }

  choices.push(...audioFormats.map<MediaChoice>((item) => ({
    id: `audio-${item.formatId}`,
    label: `仅音频${item.ext ? ` · 容器·${item.ext.toUpperCase()}` : ""}${item.abr || item.tbr ? ` · ${Math.round(item.abr || item.tbr || 0)} kbps` : ""}${item.filesize ? ` · 约 ${formatBytes(item.filesize)}` : ""}`,
    kind: "audio",
    formatExpression: item.formatId,
    container: item.ext?.toLowerCase(),
    estimatedBytes: item.filesize,
    previewURL: item.previewURL,
    previewReferer: item.previewReferer,
    previewHeaders: item.previewHeaders,
  })))

  // Prefer device-playable H.264 over higher AV1/VP9/HEVC so list default and auto-select avoid 有声无画.
  const videos = choices.filter((item) => item.kind === "video").sort((a, b) => {
    const aHard = isDeviceHardVideoChoice(a) ? 1 : 0
    const bHard = isDeviceHardVideoChoice(b) ? 1 : 0
    if (aHard !== bHard) return aHard - bHard
    if ((b.height || 0) !== (a.height || 0)) return (b.height || 0) - (a.height || 0)
    // Same height: H.264 already preferred via hard flag; keep stable id order otherwise.
    return a.id.localeCompare(b.id)
  })
  const audios = choices.filter((item) => item.kind === "audio")
  return [...videos, ...audios]
}

/**
 * Select an initial manual-download format only when the probe has exactly one
 * video choice. Audio alternatives remain available from the format menu.
 */
export function resolveInitialMediaChoice(choices: MediaChoice[]): MediaChoice | null {
  const videos = choices.filter((choice) => choice.kind === "video")
  return videos.length === 1 ? videos[0] : null
}

export function resolveAutomaticChoice(
  choices: MediaChoice[],
  strategy: AutomaticDownloadFormatStrategy,
  preferredContainer: PreferredContainer,
): { choice: MediaChoice | null; usedFallback: boolean } {
  const recommended = choices[0] || null
  if (!recommended || strategy === "recommended") return { choice: recommended, usedFallback: false }

  if (strategy === "highest-video") {
    const choice = choices
      .filter((item) => item.kind === "video")
      .sort((a, b) => {
        const aHard = isDeviceHardVideoChoice(a) ? 1 : 0
        const bHard = isDeviceHardVideoChoice(b) ? 1 : 0
        if (aHard !== bHard) return aHard - bHard
        return (b.height || 0) - (a.height || 0)
      })[0] || recommended
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
  // 本环境 Python 默认 SSL 证书链可能因 MITM/抓包而验证失败（CERTIFICATE_VERIFY_FAILED），
  // 固定信任 pypi.org 域名可确保在 SSL 异常时也能安装/升级 yt-dlp。
  const result = await runCommand("python3 -m pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org --upgrade yt-dlp", 900)
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
  /** Public Safari page URL, used only for this probe as Referer. */
  referer?: string
  /** The Safari DOM explicitly identified this public URL as a media element, even when its path has no extension. */
  safariMediaKind?: "video" | "audio"
  /** Prevent the public HTML fallback from recursively invoking itself. */
  skipPublicPlayerFallback?: boolean
}


const PUBLIC_PLAYER_PAGE_TIMEOUT_MS = 12_000
const PUBLIC_PLAYER_MAX_HTML_BYTES = 1_500_000

/** 公开播放器单次 HTML/JSON 拉取允许的最长毫秒数；传入 deadline 时不超过其剩余时间。 */
export function publicPlayerFetchTimeoutMilliseconds(deadline?: number): number {
  const remainingMilliseconds = deadline ? Math.max(0, deadline - Date.now()) : PUBLIC_PLAYER_PAGE_TIMEOUT_MS
  return Math.min(PUBLIC_PLAYER_PAGE_TIMEOUT_MS, remainingMilliseconds)
}

async function fetchPublicHTML(url: string, deadline?: number): Promise<{ finalURL: string; contentType?: string; html: string; title?: string } | null> {
  // 公开 HTML 回退也必须计入 45 秒总预算，避免 yt-dlp 超时后再叠加页面+iframe 解析造成无界等待。
  const timeoutMilliseconds = publicPlayerFetchTimeoutMilliseconds(deadline)
  if (timeoutMilliseconds <= 0) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds)
  try {
    const response = await fetch(url, { headers: { Accept: "text/html,application/xhtml+xml" }, signal: controller.signal })
    if (!response.ok) return null
    const contentType = response.headers.get("content-type") || undefined
    const contentLength = Number(response.headers.get("content-length") || 0)
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) return null
    if (Number.isFinite(contentLength) && contentLength > PUBLIC_PLAYER_MAX_HTML_BYTES) return null
    const html = await response.text()
    if (html.length > PUBLIC_PLAYER_MAX_HTML_BYTES) return null
    return { finalURL: response.url || url, contentType, html }
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function publicChoice(source: PublicPlayerSource): MediaChoice | null {
  const headers = { Referer: source.referer, "User-Agent": MOBILE_SAFARI_UA }
  if (source.kind === "hls") return {
    id: "public-hls", label: "公开 HLS / m3u8", kind: "video", formatExpression: "m3u8", container: "mp4",
    previewURL: source.url, previewReferer: source.referer, previewHeaders: headers, sourceURL: source.url, sourceReferer: source.referer,
  }
  if (source.kind === "dash") return {
    id: "public-dash", label: "公开 DASH / MPD", kind: "video", formatExpression: "best", container: "mp4",
    previewURL: source.url, previewReferer: source.referer, previewHeaders: headers, sourceURL: source.url, sourceReferer: source.referer,
  }
  const direct = directMediaChoice(source.url, source.kind === "audio" ? "audio" : "video")
  if (!direct) return null
  const height = source.kind === "video" ? source.height : undefined
  return {
    ...direct,
    ...(height ? { id: `public-mp4-${height}`, label: `${height}p · 公开 MP4`, height } : { id: "public-mp4", label: "公开 MP4" }),
    previewReferer: source.referer, previewHeaders: headers, sourceURL: source.url, sourceReferer: source.referer,
  }
}

export async function probeSafariPublicPlayerFrame(frameURL: string, pageTitle?: string, referer?: string): Promise<MediaProbe | null> {
  const taskId = createTaskId()
  const deadline = Date.now() + PUBLIC_PLAYER_PAGE_TIMEOUT_MS
  let remainingBytes = PUBLIC_PLAYER_MAX_HTML_BYTES
  const fetchText = async (url: string, accept: string): Promise<{ finalURL: string; contentType?: string; text: string } | null> => {
    const remainingMilliseconds = deadline - Date.now()
    if (remainingMilliseconds <= 0 || remainingBytes <= 0) return null
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), remainingMilliseconds)
    try {
      // 公开播放器常校验 Referer（如 mydaddy.cc 仅放行来源站点的无浏览器请求）。
      // referer 来自用户 Safari 当前页（公开 URL），不携带 Cookie/授权/请求头。
      const headers: Record<string, string> = { Accept: accept }
      if (referer && /^https?:\/\//i.test(referer)) headers.Referer = referer
      const response = await fetch(url, { headers, signal: controller.signal })
      if (!response.ok) return null
      const contentLength = Number(response.headers.get("content-length") || 0)
      if (Number.isFinite(contentLength) && contentLength > remainingBytes) return null
      const text = await response.text()
      const bytes = new TextEncoder().encode(text).length
      if (bytes > remainingBytes) return null
      remainingBytes -= bytes
      return { finalURL: response.url || url, contentType: response.headers.get("content-type") || undefined, text }
    } catch { return null } finally { clearTimeout(timeout) }
  }
  await logEvent({ level: "info", event: "safari-public-player.started", taskId, details: { hasFrame: true } })
  let stage = "started"
  const extracted = await extractPublicPlayerFrameSources({
    frameURL,
    pageTitle,
    fetchText,
    onStage: (value) => { stage = value },
  })
  const choices = extracted?.sources.map(publicChoice).filter((choice): choice is MediaChoice => Boolean(choice)) || []
  await logEvent({ level: "info", event: "safari-public-player.completed", taskId, details: { hit: choices.length > 0, checkedIframes: extracted?.checkedIframes || 0, candidateCount: choices.length, stage } })
  return choices.length ? { title: extracted?.title || pageTitle || "未命名媒体", webpageURL: frameURL, choices } : null
}

async function probePublicPlayerSource(sourceURL: string, taskId: string, deadline?: number): Promise<MediaProbe | null> {
  await logEvent({ level: "info", event: "probe.public-player.started", taskId, details: { sourceURL, deadlineApplied: Boolean(deadline) } })
  const fetchHTML = deadline ? (url: string) => fetchPublicHTML(url, deadline) : fetchPublicHTML
  const extracted = await extractPublicPlayerSources({ pageURL: sourceURL, fetchHTML })
  if (!extracted) {
    await logEvent({ level: "info", event: "probe.public-player.completed", taskId, details: { hit: false, checkedIframes: 0 } })
    return null
  }
  const choices = extracted.sources.map(publicChoice).filter((choice): choice is MediaChoice => Boolean(choice))
  if (!choices.length) {
    await logEvent({ level: "info", event: "probe.public-player.completed", taskId, details: { hit: false, checkedIframes: extracted.checkedIframes, candidateCount: extracted.sources.length } })
    return null
  }
  const kindCounts = choices.reduce<Record<string, number>>((counts, choice) => {
    const key = choice.id.replace("public-", "")
    counts[key] = (counts[key] || 0) + 1
    return counts
  }, {})
  await logEvent({ level: "info", event: "probe.public-player.completed", taskId, details: { hit: true, checkedIframes: extracted.checkedIframes, kindCounts } })
  return { title: extracted.title, webpageURL: sourceURL, choices }
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
  outputTitle?: string
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
        filePath = await publishMediaFile(filePath, taskId, options.outputTitle)
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
  const extractedURL = extractFirstURL(url)
  if (!extractedURL) throw new Error("请输入有效的公开 http 或 https 链接。")
  // X multi-video bare status URLs extract as playlists with empty top-level formats.
  // Prefer /video/1 so probe and later download share the same single-item URL.
  const sourceURL = pinXStatusVideoURL(extractedURL, 1)
  // 抖音：匿名 WebView(+detail) → 合成候选，不走 yt-dlp / 不要求用户登录
  if (detectMediaPlatform(sourceURL) === "douyin") {
    return probeDouyinDirect(sourceURL)
  }
  const taskId = createTaskId()
  const referer = options.referer && /^https?:\/\//i.test(options.referer) && !/[\r\n]/.test(options.referer) ? options.referer : undefined
  const safariUserAgent = referer ? MOBILE_SAFARI_UA : undefined
  await logEvent({ level: "info", event: "probe.started", taskId, details: { sourceURL, authorizedPlatform: options.authorizedPlatform || null, cookieAuthorized: Boolean(options.cookieFile), safariRefererApplied: Boolean(referer), safariUserAgentApplied: Boolean(safariUserAgent) } })
  const refererArgument = referer ? ` --referer ${quote(referer)}` : ""
  const userAgentArgument = safariUserAgent ? ` --user-agent ${quote(safariUserAgent)}` : ""
  const cookieArgument = options.cookieFile ? ` ${quote(options.cookieFile)}` : ""
  const startedAt = Date.now()
  const deadline = startedAt + PROBE_TOTAL_TIMEOUT_SECONDS * 1000
  let attemptCount = 0
  const timeoutError = () => new Error(`媒体分析超时（${PROBE_TOTAL_TIMEOUT_SECONDS} 秒）。请检查网络后重试。`)
  const tryPublicPlayerFallback = async (message: string): Promise<MediaProbe | null> => {
    if (options.skipPublicPlayerFallback) return null
    // 放宽触发条件：除“无格式/超时”外，Safari 页面候选（带 referer 或显式媒体类型）
    // 的任意探测失败也尝试公开播放器静态抽取——正片可能藏在页面或同源 iframe 的
    // 播放器里（如 hqporner → mydaddy.cc fluidplayer 的 360/720/1080 三清晰度）。
    const safariContext = Boolean(referer || options.safariMediaKind)
    if (!isNoDownloadableFormatFailure(message) && !isProbeTimeoutFailure(message) && !safariContext) return null
    if (Date.now() >= deadline) return null
    return probePublicPlayerSource(sourceURL, taskId, deadline)
  }
  const runProbe = async (insecure = false) => {
    const remainingMilliseconds = deadline - Date.now()
    if (remainingMilliseconds <= 0) throw timeoutError()
    attemptCount += 1
    const result = await runCommand(
      `python3 ${quote(PROBE_PATH)}${insecure ? " --insecure" : ""}${refererArgument}${userAgentArgument} ${quote(sourceURL)}${cookieArgument}`,
      Math.max(1, Math.ceil(remainingMilliseconds / 1000)),
    )
    if (Date.now() >= deadline) {
      await logEvent({ level: "warn", event: "probe.timeout", taskId, details: { elapsedMilliseconds: Date.now() - startedAt, attemptCount } })
      throw timeoutError()
    }
    return result
  }

  try {
  let insecure = false
  let result = await runProbe(insecure)
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

  // On-device HTTPS capture (MITM) often uses a cert that the system trusts but Python's CA bundle does not.
  // Retry once with certificate verification disabled so testing with capture enabled still works.
  if (result.exitCode !== 0 && isCertificateVerifyFailure(result.output || "")) {
    await logEvent({
      level: "warn",
      event: "probe.ssl.retry",
      taskId,
      details: { reason: "certificate_verify_failed", insecure: true },
    })
    insecure = true
    result = await runProbe(insecure)
    await logEvent({
      level: result.exitCode === 0 ? "info" : "error",
      event: "probe.command.completed",
      taskId,
      details: {
        exitCode: result.exitCode,
        output: result.exitCode === 0 ? "媒体信息已返回" : result.output,
        afterSslRetry: true,
      },
    })
  }


  if (result.exitCode !== 0) {
    const error = new Error(compactMessage(result.output || "媒体探测失败")) as Error & { rawOutput?: string }
    error.rawOutput = result.output || ""
    throw error
  }
  let payload: Record<string, unknown>
  try {
    payload = parseLastJSON(result.output)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== "下载工具未返回可识别的媒体信息") throw error
    await logEvent({ level: "warn", event: "probe.output.retry", taskId, details: { delayMilliseconds: 0 } })
    result = await runProbe(insecure)
    await logEvent({ level: result.exitCode === 0 ? "info" : "error", event: "probe.command.completed", taskId, details: { exitCode: result.exitCode, output: result.exitCode === 0 ? "媒体信息已返回" : result.output, afterOutputRetry: true, tlsInsecure: insecure } })
    if (result.exitCode !== 0) {
      const error = new Error(compactMessage(result.output || "媒体探测失败")) as Error & { rawOutput?: string }
      error.rawOutput = result.output || ""
      throw error
    }
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
  if (!choices.length) {
    // An explicit Safari-captured HLS manifest that yt-dlp's generic probe returned with
    // empty formats is still a valid HLS playlist. Keep it as a direct HLS choice instead
    // of mis-treating the .m3u8 as a standalone media file (which fails instantly).
    const safariHlsChoice = referer && isM3U8URL(sourceURL) ? hlsMediaChoice(sourceURL) : null
    if (safariHlsChoice) {
      safariHlsChoice.previewReferer = referer
      safariHlsChoice.previewHeaders = referer ? { Referer: referer, "User-Agent": safariUserAgent || MOBILE_SAFARI_UA } : undefined
      choices.push(safariHlsChoice)
      await logEvent({ level: "warn", event: "probe.safari-hls.empty-formats-fallback", taskId, details: { sourceURL, safariRefererApplied: true, safariUserAgentApplied: Boolean(safariUserAgent), cookieTransfer: false } })
    } else {
      // An extensionless Safari endpoint (.php?id=...) may still be an HLS playlist even
      // though the URL carries no .m3u8. Sniff the body with the page Referer + Safari UA
      // (no cookies) before mis-treating it as a standalone MP4.
      const sniffedMaster = referer ? await sniffHlsManifest(sourceURL, referer, safariUserAgent || MOBILE_SAFARI_UA) : null
      if (sniffedMaster && referer) {
        for (const hlsChoice of hlsEndpointChoices(sourceURL, sniffedMaster)) {
          hlsChoice.previewReferer = referer
          hlsChoice.previewHeaders = { Referer: referer, "User-Agent": safariUserAgent || MOBILE_SAFARI_UA }
          choices.push(hlsChoice)
        }
        await logEvent({ level: "warn", event: "probe.safari-hls.sniffed-endpoint", taskId, details: { sourceURL, reason: "empty-formats", variantCount: choices.filter((c) => c.hlsVariantURI).length, safariRefererApplied: true, safariUserAgentApplied: Boolean(safariUserAgent), cookieTransfer: false } })
      } else {
        const directChoice = directMediaChoice(sourceURL, options.safariMediaKind)
        if (directChoice) {
          directChoice.previewReferer = referer
          directChoice.previewHeaders = referer ? { Referer: referer, "User-Agent": safariUserAgent || MOBILE_SAFARI_UA } : undefined
          choices.push(directChoice)
          await logEvent({ level: "info", event: "probe.direct-media.fallback", taskId, details: { sourceURL, extension: extensionOf(sourceURL) || (options.safariMediaKind === "audio" ? ".m4a" : options.safariMediaKind === "video" ? ".mp4" : ""), knownSafariMediaKind: options.safariMediaKind || null, safariRefererApplied: Boolean(referer), safariUserAgentApplied: Boolean(safariUserAgent) } })
        } else {
          throw new Error("未找到可下载的视频格式（该帖可能是纯文字/图文，或需要登录后才能访问媒体）")
        }
      }
    }
  }
  // Prefer the probe-pinned X /video/N URL so download reuses a single-item page.
  const webpageURL = pinXStatusVideoURL(stringValue(payload.webpageUrl) || sourceURL, 1)
  const probe: MediaProbe = {
    title: stringValue(payload.title) || "未命名媒体",
    uploader: stringValue(payload.uploader),
    duration: numberValue(payload.duration),
    thumbnail: stringValue(payload.thumbnail),
    webpageURL,
    choices,
  }
  await logEvent({ level: "info", event: "probe.completed", taskId, details: { title: probe.title, choiceCount: choices.length, formatCount: formats.length, webpageURL } })
  return probe
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const rawOutput = error instanceof Error ? (error as Error & { rawOutput?: string }).rawOutput || "" : ""
    // A Safari-captured HLS manifest is already an explicit user-selected media URL.
    // If yt-dlp's generic probe is rejected by Cloudflare or the CDN closes only its
    // Python connection, preserve that public manifest as a direct HLS choice. The
    // download path still uses only Referer + UA; no Safari cookies, challenge tokens,
    // or authorization data are read or transferred.
    // compactMessage() maps the raw CDN disconnect into a friendly line, so also check
    // the original yt-dlp output attached to the thrown error.
    const safariHlsChoice = referer && (isSafariHlsDirectFallbackFailure(message) || isSafariHlsDirectFallbackFailure(rawOutput))
      ? hlsMediaChoice(sourceURL)
      : null
    if (safariHlsChoice && referer) {
      // yt-dlp 被 CDN 断开时，浏览器式 fetch（Referer + Safari UA）仍能拿到完整 master。
      // 先原生嗅探 master 并解析变体，让用户可选清晰度；嗅探失败才退回单个 HLS 原始清单。
      const sniffedMaster = await sniffHlsManifest(sourceURL, referer, safariUserAgent || MOBILE_SAFARI_UA)
      if (sniffedMaster) {
        const hlsChoices = hlsEndpointChoices(sourceURL, sniffedMaster).map((hlsChoice) => {
          hlsChoice.previewReferer = referer
          hlsChoice.previewHeaders = { Referer: referer, "User-Agent": safariUserAgent || MOBILE_SAFARI_UA }
          return hlsChoice
        })
        await logEvent({
          level: "warn",
          event: "probe.safari-hls.sniffed-variants",
          taskId,
          details: { sourceURL, reason: "probe-failed", variantCount: hlsChoices.filter((c) => c.hlsVariantURI).length, safariRefererApplied: true, safariUserAgentApplied: Boolean(safariUserAgent), cookieTransfer: false },
        })
        return { title: "Safari HLS 视频", webpageURL: sourceURL, choices: hlsChoices }
      }
      safariHlsChoice.previewReferer = referer
      safariHlsChoice.previewHeaders = { Referer: referer, "User-Agent": safariUserAgent || "Mozilla/5.0" }
      await logEvent({
        level: "warn",
        event: "probe.safari-hls.direct-fallback",
        taskId,
        details: { sourceURL, reason: isCloudflareAntiBotFailure(message) ? "cloudflare-anti-bot" : "remote-manifest-disconnect", safariRefererApplied: true, safariUserAgentApplied: Boolean(safariUserAgent), cookieTransfer: false },
      })
      return { title: "Safari HLS 视频", webpageURL: sourceURL, choices: [safariHlsChoice] }
    }
    // .vid 重定向型媒体端点（sxyprn cdn8 → c8/c10...vid）不可能是 HLS：跳过 sniff
    // （无 Range 的 sniff 会触发数百 MB body 下载 + 慢 TTFB 拖垮后续），直接跟随 302
    // 解析最终直链；解析失败（CDN 慢/限流/临时 503）时保留 .vid 源直链兜底，
    // 下载/预览由 NSURLSession/AVPlayer 自行跟随 302（与页面播放器一致）。
    if (referer && isVidURL(sourceURL)) {
      const resolvedChoice = await resolveRedirectedDirectMedia(sourceURL, referer, safariUserAgent || MOBILE_SAFARI_UA, options.safariMediaKind)
      if (resolvedChoice) {
        await logEvent({ level: "info", event: "probe.vid.redirect-resolved", taskId, details: { sourceURL, finalURL: resolvedChoice.sourceURL, safariRefererApplied: true, safariUserAgentApplied: Boolean(safariUserAgent), cookieTransfer: false } })
        return { title: "Safari 视频直链", webpageURL: sourceURL, choices: [resolvedChoice] }
      }
      const fallbackChoice = directMediaChoice(sourceURL, options.safariMediaKind || "video")
      if (fallbackChoice) {
        fallbackChoice.sourceReferer = referer
        fallbackChoice.previewReferer = referer
        fallbackChoice.previewHeaders = { Referer: referer, "User-Agent": safariUserAgent || MOBILE_SAFARI_UA }
        await logEvent({ level: "warn", event: "probe.vid.direct-fallback", taskId, details: { sourceURL, safariRefererApplied: true, safariUserAgentApplied: Boolean(safariUserAgent), cookieTransfer: false } })
        return { title: "Safari 视频直链", webpageURL: sourceURL, choices: [fallbackChoice] }
      }
    }
    // A non-.m3u8 Safari endpoint may still be HLS (e.g. play.php?site_id=...); sniff the
    // body when yt-dlp itself was rejected, so the probe survives CDN anti-bot closes.
    if (referer && !isVidURL(sourceURL)) {
      const sniffedMaster = await sniffHlsManifest(sourceURL, referer, safariUserAgent || "Mozilla/5.0")
      if (sniffedMaster) {
        const hlsChoices = hlsEndpointChoices(sourceURL, sniffedMaster).map((hlsChoice) => {
          hlsChoice.previewReferer = referer
          hlsChoice.previewHeaders = { Referer: referer, "User-Agent": safariUserAgent || "Mozilla/5.0" }
          return hlsChoice
        })
        await logEvent({ level: "warn", event: "probe.safari-hls.sniffed-endpoint", taskId, details: { sourceURL, reason: "probe-failed", variantCount: hlsChoices.filter((c) => c.hlsVariantURI).length, safariRefererApplied: true, safariUserAgentApplied: Boolean(safariUserAgent), cookieTransfer: false } })
        return { title: "Safari HLS 视频", webpageURL: sourceURL, choices: hlsChoices }
      }
      // 无扩展名端点（非 .vid）也可能是 302→media 的直链：跟随重定向解析最终 URL。
      const resolvedChoice = await resolveRedirectedDirectMedia(sourceURL, referer, safariUserAgent || MOBILE_SAFARI_UA, options.safariMediaKind)
      if (resolvedChoice) {
        await logEvent({ level: "info", event: "probe.vid.redirect-resolved", taskId, details: { sourceURL, finalURL: resolvedChoice.sourceURL, safariRefererApplied: true, safariUserAgentApplied: Boolean(safariUserAgent), cookieTransfer: false } })
        return { title: "Safari 视频直链", webpageURL: sourceURL, choices: [resolvedChoice] }
      }
    }
    const extracted = await tryPublicPlayerFallback(message)
    if (extracted) return extracted
    throw error
  }
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

/** A real HLS playlist must never fall back to publishing a standalone first segment. */
export function hlsFailureMessage(sourceURL: string, output: string): string | undefined {
  if (!isM3U8URL(sourceURL)) return undefined
  if (/HTTP error 410 Gone/i.test(output || "")) {
    return "HLS 分片已失效（HTTP 410 Gone），无法合成为完整视频。请回到 Safari 重新捕获后立即下载。"
  }
  return `HLS 清单下载失败，未发布不完整分片：${compactMessage(output || "m3u8 下载失败")}`
}

/** Absolute media paths printed by ytdlp_runner or embedded in yt-dlp log lines. */
export function parseOutputPaths(output: string): string[] {
  const found: string[] = []
  for (const raw of String(output || "").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith("/") && MEDIA_EXTENSIONS.has(extensionOf(line))) {
      found.push(line)
      continue
    }
    // [download] Destination: /abs/path.mp4
    const destination = line.match(/(?:^|\s)Destination:\s*(\/\S+)/i)
    if (destination?.[1] && MEDIA_EXTENSIONS.has(extensionOf(destination[1]))) {
      found.push(destination[1])
      continue
    }
    // [download] /abs/path.mp4 has already been downloaded
    const already = line.match(/(?:^|\s)(\/\S+)\s+has already been downloaded/i)
    if (already?.[1] && MEDIA_EXTENSIONS.has(extensionOf(already[1]))) {
      found.push(already[1])
      continue
    }
    // Merging formats into "/abs/path.mp4"
    const merged = line.match(/Merging formats into\s+"(\/[^"]+)"/i)
    if (merged?.[1] && MEDIA_EXTENSIONS.has(extensionOf(merged[1]))) {
      found.push(merged[1])
    }
  }
  return uniquePaths(found)
}

/** Prefer stage-tagged files (`.video.` / `.audio.`) then any media under work dir. */
export function listWorkMediaFiles(directory: string, nameHint?: string): string[] {
  try {
    if (!directory || !FileManager.existsSync(directory)) return []
    const names = FileManager.readDirectorySync(directory)
    const candidates: { path: string; mtime: number }[] = []
    for (const name of names) {
      if (!name || name.startsWith(".")) continue
      if (name.endsWith(".part") || name.endsWith(".ytdl") || name.endsWith(".temp")) continue
      const full = Path.join(directory, name)
      if (!MEDIA_EXTENSIONS.has(extensionOf(full))) continue
      if (nameHint && !name.includes(nameHint)) continue
      try {
        if (!FileManager.existsSync(full)) continue
        const stat = FileManager.statSync(full)
        const mtime = typeof stat.modificationDate === "number" ? stat.modificationDate : 0
        const size = typeof stat.size === "number" ? stat.size : 0
        if (size <= 0) continue
        candidates.push({ path: full, mtime })
      } catch {
        // skip unreadable entries
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path))
    return candidates.map((item) => item.path)
  } catch {
    return []
  }
}

/** Resolve downloaded media: stdout paths first, then work-directory scan. */
export function resolveDownloadedMediaPath(options: {
  output: string
  workDirectory: string
  nameHint?: string
  excludePaths?: string[]
}): string | undefined {
  const excluded = new Set(options.excludePaths || [])
  const usable = (path: string) => {
    if (excluded.has(path)) return false
    try {
      return FileManager.existsSync(path)
    } catch {
      return false
    }
  }
  const fromOutput = [...parseOutputPaths(options.output)].reverse().find((path) => usable(path))
  if (fromOutput) return fromOutput
  const fromDir = listWorkMediaFiles(options.workDirectory, options.nameHint).filter((path) => usable(path))
  if (fromDir.length) return fromDir[0]
  // Stage hint miss: prefer files that do not belong to the other merge stage.
  if (options.nameHint) {
    const otherHint = options.nameHint.includes("video")
      ? ".audio."
      : options.nameHint.includes("audio")
        ? ".video."
        : ""
    const any = listWorkMediaFiles(options.workDirectory).filter((path) => {
      if (!usable(path)) return false
      const base = Path.basename(path)
      if (otherHint && base.includes(otherHint)) return false
      return true
    })
    if (any.length) return any[0]
  }
  return undefined
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

function videoCodecKind(item: RawFormat): NonNullable<MediaChoice["videoCodec"]> {
  if (isAvcCodec(item)) return "h264"
  const codec = (item.vcodec || "").toLowerCase()
  if (/av01|av1/.test(codec)) return "av1"
  if (/hev1|hvc1|hevc/.test(codec)) return "hevc"
  if (/vp09|vp9/.test(codec)) return "vp9"
  return "other"
}

/** AV1/VP9/HEVC: keep original; open with external players (Infuse/VLC/nPlayer). */
export function isDeviceHardVideoChoice(choice: Pick<MediaChoice, "videoCodec" | "label"> | null | undefined): boolean {
  if (!choice) return false
  if (choice.videoCodec === "av1" || choice.videoCodec === "hevc" || choice.videoCodec === "vp9") return true
  return /\bAV1\b|\bVP9\b|\bHEVC\b/i.test(choice.label || "")
}

async function mediaDurationSeconds(filePath: string): Promise<number | undefined> {
  const result = await runCommand(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${quote(filePath)}`, 60)
  if (result.exitCode !== 0) return undefined
  const value = Number(String(result.output || "").trim().split(/\s+/).pop())
  return Number.isFinite(value) && value >= 0 ? value : undefined
}
async function verifyMediaFile(filePath: string, choice: MediaChoice, taskId: string) {
  // Prefer stream type lines; -v error still surfaces codec open failures on this n5.0.1 build.
  const result = await runCommand(`ffprobe -v error -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 ${quote(filePath)}`, 60)
  await logEvent({ level: result.exitCode === 0 ? "info" : "error", event: "verify.command.completed", taskId, details: { exitCode: result.exitCode, output: result.output, filePath } })
  if (result.exitCode !== 0) {
    // Hard codecs often make this LGPL ffprobe fail while the MKV is fine for external players.
    if (isDeviceHardVideoChoice(choice)) {
      const size = await fileSizeBytes(filePath)
      if (size > 0) {
        await logEvent({
          level: "warn",
          event: "verify.soft.completed",
          taskId,
          details: { filePath, fileSizeBytes: size, reason: "hard-codec-ffprobe-unreliable", sourceVideoCodec: choice.videoCodec || null },
        })
        return
      }
    }
    throw new Error("下载文件验证失败：ffprobe 无法读取输出")
  }
  const types = extractProbeStreamTypes(result.output)
  const expected = choice.kind === "audio" ? "audio" : "video"
  if (!types.includes(expected)) {
    if (isDeviceHardVideoChoice(choice) && (await fileSizeBytes(filePath)) > 0) {
      await logEvent({
        level: "warn",
        event: "verify.soft.completed",
        taskId,
        details: { filePath, streamTypes: types, expected, reason: "hard-codec-stream-types-missing" },
      })
      return
    }
    throw new Error(`下载文件验证失败：缺少${expected === "audio" ? "音频" : "视频"}流`)
  }
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

async function verifyAndPublishMediaFile(options: {
  workPath: string
  choice: MediaChoice
  taskId: string
  hlsOrigin: boolean
  hlsManifest: HlsManifestSummary | undefined
  outputTitle?: string
}): Promise<string> {
  await verifyMediaFile(options.workPath, options.choice, options.taskId)
  if (options.hlsOrigin) {
    const outputDurationSeconds = await mediaDurationSeconds(options.workPath)
    const completenessFailure = hlsPublishFailure(options.hlsManifest, outputDurationSeconds)
    await logEvent({
      level: completenessFailure ? "error" : "info",
      event: "download.hls.completeness.checked",
      taskId: options.taskId,
      details: {
        outputDurationSeconds: outputDurationSeconds || null,
        manifestDurationSeconds: options.hlsManifest?.durationSeconds || null,
        manifestSegmentCount: options.hlsManifest?.segmentCount || null,
        manifestEndList: options.hlsManifest?.endList || null,
        complete: !completenessFailure,
      },
    })
    if (completenessFailure) throw new Error(completenessFailure)
  }
  return publishMediaFile(options.workPath, options.taskId, options.outputTitle)
}

export function safeOutputStem(value: string | undefined, fallback: string): string {
  const cleaned = String(value || "").replace(/[\\/:*?\"<>|\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").replace(/^[.\s]+|[.\s]+$/g, "").trim().slice(0, 160)
  return cleaned || fallback
}

async function publishMediaFile(workPath: string, taskId: string, outputTitle?: string): Promise<string> {
  const sourceName = Path.basename(workPath)
  const dot = sourceName.lastIndexOf(".")
  const fallbackStem = dot > 0 ? sourceName.slice(0, dot) : sourceName
  const extension = dot > 0 ? sourceName.slice(dot) : ""
  const stem = safeOutputStem(outputTitle, fallbackStem)
  let index = 0
  let destination = Path.join(DOWNLOAD_DIR, `${stem}${extension}`)
  while (await FileManager.exists(destination)) {
    index += 1
    destination = Path.join(DOWNLOAD_DIR, `${stem} (${index})${extension}`)
  }
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
  /** Public Safari page URL, used only for this download as Referer. */
  referer?: string
  /** Preferred final filename stem from probe or discovery metadata. */
  outputTitle?: string
  onProgress: (value: DownloadProgress) => void
  onCancelPath: (path: string) => void
}): Promise<DownloadResult> {
  const extractedURL = extractFirstURL(options.choice.sourceURL || options.url)
  if (!extractedURL) throw new Error("请输入有效的公开 http 或 https 链接。")
  const sourceURL = pinXStatusVideoURL(extractedURL, 1)
  const requestedReferer = options.referer || options.choice.sourceReferer
  const referer = requestedReferer && /^https?:\/\//i.test(requestedReferer) && !/[\r\n]/.test(requestedReferer) ? requestedReferer : undefined
  const safariUserAgent = referer ? MOBILE_SAFARI_UA : undefined
  await ensureDirectories()

  // 抖音：匿名 WebView → 候选 → 流式/图文下载（全程无用户登录）
  if (detectMediaPlatform(sourceURL) === "douyin" || isDouyinDirectChoice(options.choice)) {
    return downloadDouyinDirect({
      sourceURL,
      choice: options.choice,
      outputTitle: options.outputTitle,
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
  const hlsOrigin = isM3U8URL(sourceURL)
  const hlsManifest = hlsOrigin ? await readHlsManifestSummary(sourceURL, referer, safariUserAgent) : undefined
  if (options.choice.formatExpression === "direct") {
    const extension = extensionOf(sourceURL) || (options.choice.container ? `.${options.choice.container}` : ".mp4")
    const workPath = Path.join(workDirectory, `direct_${Date.now()}${extension}`)
    options.onCancelPath(cancelPath)
    await logEvent({ level: "info", event: "download.started", taskId, details: { sourceURL, choiceId: options.choice.id, choiceLabel: options.choice.label, formatExpression: "direct", safariRefererApplied: Boolean(referer), safariUserAgentApplied: Boolean(safariUserAgent), outputDirectory: DOWNLOAD_DIR } })
    try {
      await downloadURLToFileWithProgress({
        url: sourceURL,
        destination: workPath,
        headers: { "User-Agent": safariUserAgent || "Mozilla/5.0", Accept: "*/*", ...(referer ? { Referer: referer } : {}) },
        start: 0.02,
        end: 0.95,
        stage: "正在下载直接媒体资源",
        onProgress: options.onProgress,
        isCancelFlagSet,
      })
      if (isCancelFlagSet()) throw new Error("下载已取消")
      const filePath = await verifyAndPublishMediaFile({ workPath, choice: options.choice, taskId, hlsOrigin: false, hlsManifest: undefined, outputTitle: options.outputTitle })
      tracker.emit(1, "直接媒体下载并验证完成")
      await logEvent({ level: "info", event: "download.completed", taskId, details: { filePath, choiceId: options.choice.id, kind: "direct" } })
      return { filePath, fileName: Path.basename(filePath), sourceURL, choice: options.choice, taskId, fileSizeBytes: await fileSizeBytes(filePath) }
    } catch (error) {
      await logEvent({ level: "error", event: "download.failed", taskId, details: { message: error instanceof Error ? error.message : String(error), kind: "direct" } })
      throw error
    } finally {
      cancelBackgroundDownloads()
      try {
        if (FileManager.existsSync(taskDirectory)) FileManager.removeSync(taskDirectory)
      } catch {}
    }
  }
  if (hlsOrigin) {
    await logEvent({ level: "info", event: "download.hls-origin.detected", taskId, details: { segmentCount: hlsManifest?.segmentCount || null, durationSeconds: hlsManifest?.durationSeconds || null, endList: hlsManifest?.endList || null } })
  }

  // C: direct m3u8 / HLS — 原生分片优先（fetch HTTP/2，快、可取消），ffmpeg 仅作
  // 清单类型不支持（加密 / fMP4 / live）或原生下载失败时的兑底。
  if (isM3U8URL(sourceURL) || options.choice.formatExpression === "m3u8" || options.choice.id === "m3u8") {
    options.onCancelPath(cancelPath)
    await logEvent({ level: "info", event: "download.m3u8.started", taskId, details: { sourceURL, safariRefererApplied: Boolean(referer), safariUserAgentApplied: Boolean(safariUserAgent) } })
    tracker.emit(0.05, "正在准备 m3u8 下载")
    const workPath = Path.join(workDirectory, `hls_${Date.now()}.mp4`)
    // 原生分片路径（含取消 throw）此前不经过 ffmpeg 分支的 finally，会残留 taskDirectory；
    // 这里在原生完成（成功或报错）时统一释放 Background 下载与临时目录，取消后用户可立即
    // 重新下载；原生返回 undefined（清单不支持）时保留 taskDirectory 供 ffmpeg 分支使用。
    let nativeCompleted = false
    let nativeManifest: HlsManifestSummary | undefined
    let nativeError: string | null = null
    try {
      tracker.emit(0.08, "正在解析 HLS 分片清单")
      try {
        nativeManifest = await downloadHlsSegmentsNative({
          sourceURL,
          destination: workPath,
          workDirectory,
          referer,
          userAgent: safariUserAgent,
          variantURI: options.choice.hlsVariantURI,
          onProgress: (value) => tracker.emit(value.fraction, value.stage, { downloadedBytes: value.downloadedBytes, totalBytes: value.totalBytes, speed: value.speed }),
          isCancelFlagSet,
        })
      } catch (error) {
        nativeError = error instanceof Error ? error.message : String(error)
      }
      if (nativeManifest) {
        nativeCompleted = true
        await logEvent({ level: "warn", event: "download.m3u8.native-segments", taskId, details: { segmentCount: nativeManifest.segmentCount, durationSeconds: Math.round(nativeManifest.durationSeconds), safariRefererApplied: Boolean(referer), cookieTransfer: false } })
        const filePath = await verifyAndPublishMediaFile({ workPath, choice: options.choice, taskId, hlsOrigin, hlsManifest: hlsManifest || nativeManifest, outputTitle: options.outputTitle })
        tracker.emit(1, "m3u8 下载并验证完成")
        await logEvent({ level: "info", event: "download.completed", taskId, details: { filePath, choiceId: options.choice.id, kind: "m3u8" } })
        return { filePath, fileName: Path.basename(filePath), sourceURL, choice: options.choice, taskId, fileSizeBytes: await fileSizeBytes(filePath) }
      }
      if (nativeError) {
        if (nativeError === "下载已取消" || isCancelFlagSet()) {
          nativeCompleted = true
          throw new Error("下载已取消")
        }
        // Safari 导入（有 referer）：原生失败直接报错，避免落入 ffmpeg 网络 TLS 常失败的死胡同。
        // 无 referer 的 m3u8 直链：保留 ffmpeg 兑底（旧行为），仅记录 warning，且保留 taskDirectory。
        if (referer) {
          nativeCompleted = true
          await logEvent({ level: "error", event: "download.m3u8.native-segments.failed", taskId, details: { reason: nativeError, safariRefererApplied: true, cookieTransfer: false } })
          throw new Error(nativeError)
        }
        await logEvent({ level: "warn", event: "download.m3u8.native-skipped", taskId, details: { reason: nativeError.slice(0, 200), safariRefererApplied: false, cookieTransfer: false } })
      }
    } finally {
      if (nativeCompleted) {
        cancelBackgroundDownloads()
        try {
          if (FileManager.existsSync(taskDirectory)) FileManager.removeSync(taskDirectory)
        } catch {}
      }
    }
    await logEvent({ level: "info", event: "download.m3u8.manifest.checked", taskId, details: { segmentCount: hlsManifest?.segmentCount || null, durationSeconds: hlsManifest?.durationSeconds || null, endList: hlsManifest?.endList || null } })
    try {
      // FFmpeg's Shell output is only available after exit. Sample its growing work file instead:
      // byte count and speed below are real observations; only the bar remains an indeterminate-style estimate.
      let smoothStopped = false
      let smoothTimer: ReturnType<typeof setTimeout> | null = null
      const startedAt = Date.now()
      let lastSampleBytes = 0
      let lastSampleAt = startedAt
      const smoothTick = async () => {
        if (smoothStopped) return
        if (isCancelFlagSet()) {
          // ffmpeg 进程无法被 JS kill（Shell.run 无 abort）；给出明确停止反馈，避免误以为页面卡死。
          tracker.emit(0.08 + 0.82 * Math.min(0.95, 1 - Math.exp(-(Date.now() - startedAt) / 90000)), "正在停止（等待 FFmpeg 结束）…")
          return
        }
        const now = Date.now()
        const downloadedBytes = await fileSizeBytes(workPath).catch(() => 0)
        const elapsed = now - startedAt
        const inner = Math.min(0.95, 1 - Math.exp(-elapsed / 90000))
        const elapsedSinceLastSample = Math.max(1, now - lastSampleAt)
        const speed = downloadedBytes >= lastSampleBytes
          ? (downloadedBytes - lastSampleBytes) * 1000 / elapsedSinceLastSample
          : 0
        lastSampleBytes = downloadedBytes
        lastSampleAt = now
        tracker.emit(0.08 + 0.82 * inner, "正在通过 FFmpeg 下载 m3u8", {
          downloadedBytes: downloadedBytes || undefined,
          speed: speed || undefined,
        })
        if (!smoothStopped && !isCancelFlagSet()) smoothTimer = setTimeout(smoothTick, 500)
      }
      smoothTimer = setTimeout(() => { void smoothTick() }, 300)
      // 取消请求可能在进入 ffmpeg 分支前已写入；此时不再无谓启动 ffmpeg。
      if (isCancelFlagSet()) throw new Error("下载已取消")
      const ffmpegResult = await runCommand(
        `ffmpeg -nostdin -y -rw_timeout 30000000${referer ? ` -referer ${quote(referer)}` : ""}${safariUserAgent ? ` -user_agent ${quote(safariUserAgent)}` : ""} -protocol_whitelist file,http,https,tcp,tls,crypto -allowed_extensions ALL -i ${quote(sourceURL)} -c copy -bsf:a aac_adtstoasc -movflags +faststart ${quote(workPath)}`,
        600,
      )
      smoothStopped = true
      if (smoothTimer) clearTimeout(smoothTimer)
      await logEvent({ level: ffmpegResult.exitCode === 0 ? "info" : "error", event: "download.m3u8.ffmpeg.completed", taskId, details: { exitCode: ffmpegResult.exitCode, output: ffmpegResult.output } })
      if (isCancelFlagSet() || ffmpegResult.exitCode === 130) throw new Error("下载已取消")
      if (ffmpegResult.exitCode !== 0 || !FileManager.existsSync(workPath)) {
        // Safari-imported HLS: some CDNs drop ffmpeg's OpenSSL TLS handshake ("End of file" /
        // "Remote end closed connection without response") while accepting native TLS. When
        // that happens, download the VOD segments with Scripting fetch (Referer + UA only,
        // no cookies) and remux them locally so no network TLS is needed for the media bytes.
        tracker.emit(0.15, "FFmpeg 直连失败，尝试原生分片下载")
        await logEvent({ level: "info", event: "download.m3u8.native-fallback.started", taskId, details: { segmentCount: null, safariRefererApplied: Boolean(referer), safariUserAgentApplied: Boolean(safariUserAgent), cookieTransfer: false } })
        let nativeError: string | null = null
        const nativeManifest = await downloadHlsSegmentsNative({
          sourceURL,
          destination: workPath,
          workDirectory,
          referer,
          userAgent: safariUserAgent,
          variantURI: options.choice.hlsVariantURI,
          onProgress: (value) => tracker.emit(value.fraction, value.stage, { downloadedBytes: value.downloadedBytes, totalBytes: value.totalBytes, speed: value.speed }),
          isCancelFlagSet,
        }).catch((error) => {
          nativeError = error instanceof Error ? error.message : String(error)
          return undefined
        })
        if (nativeManifest) {
          await logEvent({ level: "warn", event: "download.m3u8.native-fallback", taskId, details: { segmentCount: nativeManifest.segmentCount, durationSeconds: Math.round(nativeManifest.durationSeconds), safariRefererApplied: Boolean(referer), safariUserAgentApplied: Boolean(safariUserAgent), cookieTransfer: false } })
          const filePath = await verifyAndPublishMediaFile({ workPath, choice: options.choice, taskId, hlsOrigin, hlsManifest: hlsManifest || nativeManifest, outputTitle: options.outputTitle })
          tracker.emit(1, "m3u8 下载并验证完成")
          await logEvent({ level: "info", event: "download.completed", taskId, details: { filePath, choiceId: options.choice.id, kind: "m3u8" } })
          return { filePath, fileName: Path.basename(filePath), sourceURL, choice: options.choice, taskId, fileSizeBytes: await fileSizeBytes(filePath) }
        }
        if (nativeError) {
          await logEvent({ level: "error", event: "download.m3u8.native-fallback.failed", taskId, details: { reason: nativeError, safariRefererApplied: Boolean(referer), safariUserAgentApplied: Boolean(safariUserAgent), cookieTransfer: false } })
          throw new Error(nativeError)
        }
        // A .m3u8 URL is a playlist, never a standalone media asset. Downloading it through
        // the generic fallback can yield only its first .ts segment, which still has A/V streams
        // and would otherwise be mispublished as a complete video.
        const playlistFailure = hlsFailureMessage(sourceURL, ffmpegResult.output || "")
        if (playlistFailure) throw new Error(playlistFailure)
        // Non-playlist pseudo-HLS URLs may still be a single transport stream, so retain the
        // conservative fallback only for those legacy cases.
        tracker.emit(0.15, "FFmpeg 直连失败，尝试 Background 下载")
        const tmpMedia = Path.join(workDirectory, `hls_raw_${Date.now()}.ts`)
        await downloadURLToFileWithProgress({
          url: sourceURL,
          destination: tmpMedia,
          headers: { "User-Agent": safariUserAgent || "Mozilla/5.0", Accept: "*/*", ...(referer ? { Referer: referer } : {}) },
          start: 0.15,
          end: 0.85,
          stage: "正在下载媒体资源",
          onProgress: options.onProgress,
          isCancelFlagSet,
        })
        tracker.emit(0.88, "正在封装为 MP4")
        const wrap = await runCommand(
          `ffmpeg -nostdin -y -i ${quote(tmpMedia)} -c copy -movflags +faststart ${quote(workPath)}`,
          1800,
        )
        if (wrap.exitCode !== 0 || !FileManager.existsSync(workPath)) {
          throw new Error(compactMessage(ffmpegResult.output || wrap.output || "媒体资源下载失败"))
        }
      }
      const filePath = await verifyAndPublishMediaFile({ workPath, choice: options.choice, taskId, hlsOrigin, hlsManifest, outputTitle: options.outputTitle })
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
    referer,
    user_agent: safariUserAgent,
    extract_audio: false,
  }
  await FileManager.writeAsString(configPath, JSON.stringify(config))
  await logEvent({ level: "info", event: "download.started", taskId, details: { sourceURL, choiceId: options.choice.id, choiceLabel: options.choice.label, formatExpression: options.choice.formatExpression, concurrentFragments: options.concurrentFragments, tlsInsecure: Boolean(options.insecureTLS), authorizedPlatform: options.authorizedPlatform || null, cookieAuthorized: Boolean(options.cookieFile), safariRefererApplied: Boolean(referer), safariUserAgentApplied: Boolean(safariUserAgent), outputDirectory: DOWNLOAD_DIR } })
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
      const videoResult = await runYtdlpWithHostNoiseRetry({
        command: `python3 ${quote(RUNNER_PATH)} ${quote(videoConfigPath)}`,
        timeout: 7200,
        taskId,
        stage: "video",
        isCancelFlagSet,
      })
      stopVideoPoll()
      clearProgressFile(progressPath)
      await logEvent({ level: videoResult.exitCode === 0 ? "info" : "error", event: "download.video.command.completed", taskId, details: { exitCode: videoResult.exitCode, output: videoResult.output, workFiles: listWorkMediaFiles(workDirectory) } })
      if (videoResult.exitCode === 130) throw new Error("下载已取消")
      if (videoResult.exitCode !== 0) {
        if (isBilibiliPremiumMissing(videoResult.output || "")) {
          throw new Error("当前清晰度需 B 站大会员或登录 Cookie 才能下载。请改选较低清晰度（优先 H.264）或先登录后再试。")
        }
        throw new Error(compactMessage(videoResult.output || "视频流下载失败"))
      }
      const videoFromOutput = parseOutputPaths(videoResult.output).some((path) => FileManager.existsSync(path))
      const videoPath = resolveDownloadedMediaPath({ output: videoResult.output, workDirectory, nameHint: ".video." })
      if (!videoPath) {
        if (isBilibiliPremiumMissing(videoResult.output || "")) {
          throw new Error("视频流未写出文件：该清晰度可能需大会员。请改选 H.264 清晰度或登录后重试。")
        }
        throw new Error("视频流下载完成但未找到输出文件")
      }
      if (!videoFromOutput) {
        await logEvent({ level: "warn", event: "download.output.fallback", taskId, details: { stage: "video", filePath: videoPath, workFiles: listWorkMediaFiles(workDirectory) } })
      }

      tracker.emit(0.5, "正在下载音频流")
      const stopAudioPoll = tracker.startPolling(progressPath, 0.5, 0.9, "下载音频流")
      const audioResult = await runYtdlpWithHostNoiseRetry({
        command: `python3 ${quote(RUNNER_PATH)} ${quote(audioConfigPath)}`,
        timeout: 7200,
        taskId,
        stage: "audio",
        isCancelFlagSet,
      })
      stopAudioPoll()
      clearProgressFile(progressPath)
      await logEvent({ level: audioResult.exitCode === 0 ? "info" : "error", event: "download.audio.command.completed", taskId, details: { exitCode: audioResult.exitCode, output: audioResult.output, workFiles: listWorkMediaFiles(workDirectory) } })
      if (audioResult.exitCode === 130) throw new Error("下载已取消")
      if (audioResult.exitCode !== 0) throw new Error(compactMessage(audioResult.output || "音频流下载失败"))
      const audioFromOutput = parseOutputPaths(audioResult.output).some((path) => FileManager.existsSync(path))
      const audioPath = resolveDownloadedMediaPath({ output: audioResult.output, workDirectory, nameHint: ".audio.", excludePaths: [videoPath] })
      if (!audioPath) throw new Error("音频流下载完成但未找到输出文件")
      if (!audioFromOutput) {
        await logEvent({ level: "warn", event: "download.output.fallback", taskId, details: { stage: "audio", filePath: audioPath, workFiles: listWorkMediaFiles(workDirectory) } })
      }

      const hardCodec = isDeviceHardVideoChoice(options.choice)
      // Hard codecs always MKV (stream-copy only); H.264 prefers choice.mergeExtension / mp4.
      const extension = hardCodec ? "mkv" : options.choice.mergeExtension || "mkv"
      const videoBase = Path.basename(videoPath).replace(/\.video\.[^.]+$/i, "").replace(/\.[^.]+$/, "")
      const fileName = `${videoBase}.${extension}`
      const workPath = Path.join(workDirectory, fileName)
      const fastStart = extension === "mp4" ? " -movflags +faststart" : ""
      tracker.emit(0.9, hardCodec ? "正在合成 MKV（无损，供外部播放器）" : "正在使用内置 FFmpeg 合并")
      const mergeResult = await runCommand(`ffmpeg -y -i ${quote(videoPath)} -i ${quote(audioPath)} -map 0:v:0 -map 1:a:0 -c copy${fastStart} ${quote(workPath)}`, 900)
      await logEvent({
        level: mergeResult.exitCode === 0 ? "info" : "error",
        event: "merge.ffmpeg.completed",
        taskId,
        details: {
          exitCode: mergeResult.exitCode,
          output: mergeResult.output,
          videoPath,
          audioPath,
          workPath,
          container: extension,
          sourceVideoCodec: options.choice.videoCodec || null,
          streamCopyOnly: hardCodec || undefined,
        },
      })
      if (mergeResult.exitCode !== 0 || !FileManager.existsSync(workPath)) {
        if (hardCodec) {
          throw new Error(compactMessage(mergeResult.output || "HEVC/AV1/VP9 流拷贝合成 MKV 失败。请改选 H.264，或检查下载完整性后重试。"))
        }
        // H.264 path only: stream-copy failed → optional compatibility transcode.
        tracker.emit(0.92, "无损合并失败，正在转码为兼容 MP4")
        await FileManager.remove(workPath).catch(() => {})
        const mp4Path = workPath.replace(/\.[^.]+$/, ".mp4")
        const transcode = await runCommand(
          `ffmpeg -y -i ${quote(videoPath)} -i ${quote(audioPath)} -map 0:v:0 -map 1:a:0 -c:v h264_videotoolbox -c:a aac -movflags +faststart ${quote(mp4Path)}`,
          7200,
        )
        await logEvent({
          level: transcode.exitCode === 0 ? "info" : "error",
          event: "merge.ffmpeg.transcode.completed",
          taskId,
          details: {
            exitCode: transcode.exitCode,
            output: transcode.output,
            reason: "stream-copy-failed",
            sourceVideoCodec: options.choice.videoCodec || null,
          },
        })
        if (transcode.exitCode !== 0 || !FileManager.existsSync(mp4Path)) {
          throw new Error(compactMessage(mergeResult.output || transcode.output || "FFmpeg 合并失败"))
        }
        const filePath = await verifyAndPublishMediaFile({ workPath: mp4Path, choice: options.choice, taskId, hlsOrigin, hlsManifest, outputTitle: options.outputTitle })
        tracker.emit(1, "下载、转码并验证完成")
        await logEvent({ level: "info", event: "download.completed", taskId, details: { filePath, choiceId: options.choice.id, mergedWithFFmpeg: true, transcoded: true, sourceVideoCodec: options.choice.videoCodec || null } })
        return { filePath, fileName: Path.basename(filePath), sourceURL, choice: options.choice, taskId, fileSizeBytes: await fileSizeBytes(filePath) }
      }
      const filePath = await verifyAndPublishMediaFile({ workPath, choice: options.choice, taskId, hlsOrigin, hlsManifest, outputTitle: options.outputTitle })
      tracker.emit(1, hardCodec ? "下载并合成 MKV 完成（请用外部播放器打开）" : "下载、合并并验证完成")
      await logEvent({
        level: "info",
        event: "download.completed",
        taskId,
        details: {
          filePath,
          choiceId: options.choice.id,
          mergedWithFFmpeg: true,
          container: extension,
          sourceVideoCodec: options.choice.videoCodec || null,
          streamCopyOnly: hardCodec || undefined,
        },
      })
      return { filePath, fileName: Path.basename(filePath), sourceURL, choice: options.choice, taskId, fileSizeBytes: await fileSizeBytes(filePath) }
    }

    clearProgressFile(progressPath)
    tracker.emit(0.02, "正在下载")
    const stopPoll = tracker.startPolling(progressPath, 0.02, 0.95, "正在下载")
    const result = await runYtdlpWithHostNoiseRetry({
      command: `python3 ${quote(RUNNER_PATH)} ${quote(configPath)}`,
      timeout: 7200,
      taskId,
      stage: "single",
      isCancelFlagSet,
    })
    stopPoll()
    clearProgressFile(progressPath)
    await logEvent({ level: result.exitCode === 0 ? "info" : "error", event: "download.command.completed", taskId, details: { exitCode: result.exitCode, output: result.output, workFiles: listWorkMediaFiles(workDirectory) } })
    if (result.exitCode === 130) throw new Error("下载已取消")
    if (result.exitCode !== 0) throw new Error(compactMessage(result.output || "yt-dlp 下载失败"))
    const singleFromOutput = parseOutputPaths(result.output).some((path) => FileManager.existsSync(path))
    let filePath = resolveDownloadedMediaPath({ output: result.output, workDirectory })
    if (!filePath) throw new Error("下载完成但未找到输出文件")
    if (!singleFromOutput) {
      await logEvent({ level: "warn", event: "download.output.fallback", taskId, details: { stage: "single", filePath, workFiles: listWorkMediaFiles(workDirectory) } })
    }
    // Single-file HEVC/AV1/VP9: keep original container; open with external players (no H.264 transcode).
    tracker.emit(0.96, "正在验证文件")
    const publishedPath = await verifyAndPublishMediaFile({ workPath: filePath, choice: options.choice, taskId, hlsOrigin, hlsManifest, outputTitle: options.outputTitle })
    const hardSingle = options.choice.kind === "video" && isDeviceHardVideoChoice(options.choice)
    tracker.emit(1, hardSingle ? "下载完成（请用外部播放器打开）" : "下载并验证完成")
    await logEvent({
      level: "info",
      event: "download.completed",
      taskId,
      details: {
        filePath: publishedPath,
        choiceId: options.choice.id,
        sourceVideoCodec: options.choice.videoCodec || null,
        streamCopyOnly: hardSingle || undefined,
      },
    })
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
