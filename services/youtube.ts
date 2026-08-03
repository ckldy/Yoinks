import { fetch } from "scripting"
import { createTaskId, logEvent } from "./logs"
import type { MediaChoice, MediaProbe } from "./media"

/**
 * YouTube 原生探测模块（IOS client innertube）。
 *
 * 背景：2026 起 YouTube 对 WEB/android_vr/mweb 匿名探测普遍强制 PO token + nsig 双重门槛，
 * 但 IOS 客户端（com.google.ios.youtube，clientVersion 20.10.38）实测（2026-08-02）仍直出
 * 可用签名 URL：27/23/16 个 adaptive 格式全部带 url、0 个 n 参数、无 potoken 要求，
 * App 运行时 fetch ~1.7s 返回，Range 206 实测通过。因此对 YouTube 链接改为：
 *   innertube IOS client → 直链格式列表（复用 direct 下载分支，原生网络栈绕开 yt-dlp
 *   在 MITM 环境下的 SSL 首败 / bot 风控 / googlevideo 403）。
 * 失败（受限/会员/临时收紧）返回 null，调用方回退 yt-dlp（含登录链路）。
 */

/** IOS 客户端 UA：innertube 校验 X-Youtube-Client-Name=5 的请求指纹。 */
export const YOUTUBE_IOS_UA =
  "com.google.ios.youtube/20.10.38 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X; en_US)"

/** googlevideo 直链下载用浏览器 UA（对 Python urllib 指纹可能限速/拒流）。 */
const YOUTUBE_DOWNLOAD_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"

const YOUTUBE_IOS_CLIENT = {
  clientName: "IOS",
  clientVersion: "20.10.38",
  deviceMake: "Apple",
  deviceModel: "iPhone16,2",
  osName: "iPhone",
  osVersion: "17.5.1.21F90",
  hl: "en",
  timeZone: "UTC",
  utcOffsetMinutes: 0,
}

/** 从 YouTube 链接提取视频 ID：watch?v= / youtu.be / shorts / embed。 */
export function parseYouTubeVideoID(value: string): string | null {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (!(host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be")) return null
    if (host === "youtu.be") {
      const id = url.pathname.replace(/^\//, "").split("/")[0]
      return /^[a-zA-Z0-9_-]{5,}$/.test(id) ? id : null
    }
    const v = url.searchParams.get("v")
    if (v && /^[a-zA-Z0-9_-]{5,}$/.test(v)) return v
    const shorts = url.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{5,})/)
    if (shorts) return shorts[1]
    const embed = url.pathname.match(/^\/embed\/([a-zA-Z0-9_-]{5,})/)
    if (embed) return embed[1]
    return null
  } catch {
    return null
  }
}

type YTFormat = {
  itag?: number
  url?: string
  mimeType?: string
  bitrate?: number
  width?: number
  height?: number
  contentLength?: string
  qualityLabel?: string
  fps?: number
}

type YTPlayerResponse = {
  playabilityStatus?: { status?: string; reason?: string }
  videoDetails?: {
    title?: string
    lengthSeconds?: string
    author?: string
    thumbnail?: { thumbnails?: Array<{ url?: string }> }
  }
  streamingData?: { formats?: YTFormat[]; adaptiveFormats?: YTFormat[] }
}

async function fetchPlayerResponse(videoId: string): Promise<YTPlayerResponse | null> {
  try {
    const body = JSON.stringify({
      context: { client: YOUTUBE_IOS_CLIENT },
      videoId,
      playbackContext: { contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS", signatureTimestamp: 20476 } },
      contentCheckOk: true,
      racyCheckOk: true,
    })
    const response = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": YOUTUBE_IOS_UA,
        "X-Youtube-Client-Name": "5",
        "X-Youtube-Client-Version": YOUTUBE_IOS_CLIENT.clientVersion,
      },
      body,
    })
    if (!response.ok) return null
    const json = (await response.json()) as YTPlayerResponse
    return json && typeof json === "object" ? json : null
  } catch {
    return null
  }
}

function codecKind(mimeType: string): NonNullable<MediaChoice["videoCodec"]> {
  const mime = mimeType.toLowerCase()
  if (/avc1|avc3/.test(mime)) return "h264"
  if (/av01|av1/.test(mime)) return "av1"
  if (/vp09|vp9/.test(mime)) return "vp9"
  if (/hev1|hvc1|hevc/.test(mime)) return "hevc"
  return "other"
}

/**
 * YouTube 原生探测：IOS client innertube → 直链格式列表。
 * muxed（progressive，少见）单文件直链；DASH video-only 每档带最佳音频轨（原生合并）。
 * 失败返回 null（调用方回退 yt-dlp）。
 */
export async function probeYouTubeDirect(sourceURL: string): Promise<MediaProbe | null> {
  const videoId = parseYouTubeVideoID(sourceURL)
  if (!videoId) return null
  const taskId = createTaskId()
  const startedAt = Date.now()
  await logEvent({ level: "info", event: "probe.youtube.direct.started", taskId, details: { sourceURL, videoId } })
  const player = await fetchPlayerResponse(videoId)
  if (!player || !player.streamingData) {
    await logEvent({ level: "warn", event: "probe.youtube.direct.empty", taskId, details: { videoId, message: "无 streamingData（可能需登录/受限）" } })
    return null
  }
  const playability = player.playabilityStatus?.status || ""
  if (playability !== "OK") {
    await logEvent({ level: "warn", event: "probe.youtube.direct.unplayable", taskId, details: { videoId, playability, reason: player.playabilityStatus?.reason || "" } })
    return null
  }
  const allFormats = [...(player.streamingData.formats || []), ...(player.streamingData.adaptiveFormats || [])].filter((f) => f && f.url)
  if (!allFormats.length) {
    await logEvent({ level: "warn", event: "probe.youtube.direct.no-urls", taskId, details: { videoId, message: "格式均无直链（potoken/nsig 门槛）" } })
    return null
  }
  const details = player.videoDetails || {}
  const title = details.title || "YouTube 视频"
  const thumbnails = details.thumbnail?.thumbnails || []
  const thumbnail = thumbnails.length ? thumbnails[thumbnails.length - 1].url : undefined
  const durationText = Number(details.lengthSeconds || "0")
  const duration = Number.isFinite(durationText) && durationText > 0 ? durationText : undefined

  const muxedFormats = (player.streamingData.formats || []).filter((f) => f.url)
  const adaptiveFormats = player.streamingData.adaptiveFormats || []
  const videoFormats = adaptiveFormats.filter((f) => f.url && (f.mimeType || "").includes("video/"))
  const audioFormats = adaptiveFormats.filter((f) => f.url && (f.mimeType || "").includes("audio/"))
  const bestAudio = [...audioFormats].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]
  const bestMp4Audio = audioFormats
    .filter((format) => (format.mimeType || "").includes("audio/mp4"))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]
  const previewHeaders = { "User-Agent": YOUTUBE_DOWNLOAD_UA, Accept: "*/*" }

  const choices: MediaChoice[] = []
  // muxed（progressive）：单文件音视频合流，native direct 下载（无需合并）。
  for (const [index, format] of muxedFormats.entries()) {
    const codec = codecKind(format.mimeType || "")
    const container = codec === "h264" ? "mp4" : "mkv"
    const height = format.height || 0
    const label = `${height ? `${height}p` : format.qualityLabel || `格式 ${format.itag || index + 1}`} · ${codec.toUpperCase()} · 容器·${container.toUpperCase()}`
    choices.push({
      id: `youtube-muxed-${format.itag || index + 1}`,
      label,
      kind: "video",
      formatExpression: "direct",
      container,
      height: height || undefined,
      estimatedBytes: Number(format.contentLength || 0) || undefined,
      videoCodec: codec,
      sourceURL: format.url,
      previewURL: format.url,
      previewHeaders,
      sourceReferer: "https://www.youtube.com/",
    })
  }
  // DASH video-only：每档视频轨 + 最佳音频轨（原生下载 + ffmpeg 合并）。
  const dashVideo = [...videoFormats]
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0))
    .slice(0, 12)
  for (const [index, format] of dashVideo.entries()) {
    const codec = codecKind(format.mimeType || "")
    const container = codec === "h264" ? "mp4" : "mkv"
    const selectedAudio = codec === "h264" ? bestMp4Audio || bestAudio : bestAudio || bestMp4Audio
    const height = format.height || 0
    const label = `${height ? `${height}p` : format.qualityLabel || `格式 ${format.itag || index + 1}`} · ${codec.toUpperCase()} · 合并音频 · 容器·${container.toUpperCase()}`
    choices.push({
      id: `youtube-dash-${format.itag || index + 1}`,
      label,
      kind: "video",
      formatExpression: "direct",
      container,
      height: height || undefined,
      estimatedBytes: Number(format.contentLength || 0) || undefined,
      videoCodec: codec,
      sourceURL: format.url,
      previewURL: format.url,
      previewHeaders,
      sourceReferer: "https://www.youtube.com/",
      mergeAudioFormat: selectedAudio ? "bestaudio/best" : undefined,
      mergeExtension: container === "mp4" ? "mp4" : "mkv",
      previewAudioURL: selectedAudio?.url,
      previewAudioCodec: selectedAudio?.mimeType,
      previewVideoCodec: format.mimeType,
      youtubeVideoItag: format.itag,
      youtubeAudioItag: selectedAudio?.itag,
    })
  }
  if (!choices.length) {
    await logEvent({ level: "warn", event: "probe.youtube.direct.no-choices", taskId, details: { videoId, message: "无可用格式" } })
    return null
  }
  const probe: MediaProbe = {
    title,
    uploader: details.author || undefined,
    duration,
    thumbnail,
    webpageURL: `https://www.youtube.com/watch?v=${videoId}`,
    choices,
  }
  await logEvent({ level: "info", event: "probe.youtube.direct.completed", taskId, details: { videoId, title, choiceCount: choices.length, heights: choices.map((c) => c.height || 0).slice(0, 12), hasBestAudio: Boolean(bestAudio), elapsedMilliseconds: Date.now() - startedAt } })
  return probe
}
