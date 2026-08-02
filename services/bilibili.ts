import { fetch } from "scripting"
import { createTaskId, logEvent } from "./logs"
import type { MediaChoice, MediaProbe } from "./media"

/**
 * B 站原生探测模块。
 *
 * 背景：yt-dlp 的 Python urllib 指纹在当前网络/抓包（MITM）环境下会被 B 站
 * 412 风控拦截（桌面页与 m 站均返回 412）；而 Scripting fetch 走 iOS 网络栈，
 * 携带真实浏览器 UA 时 B 站正常返回 200。因此对 B 站链接改为：
 *   m 站页面（真实 UA fetch）→ 提取 bvid/cid/标题 → playurl API → 直链。
 * 直链下载/预览沿用 direct 分支（native，不依赖 yt-dlp）。
 */

export const BILIBILI_MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

/** qn → 高度（匿名可用的常规档位）。 */
const QN_HEIGHT: Array<{ qn: number; height: number }> = [
  { qn: 80, height: 1080 },
  { qn: 64, height: 720 },
  { qn: 32, height: 480 },
  { qn: 16, height: 360 },
]

/** 从 B 站视频 URL 提取 BV id 与分 P 序号（b23.tv 短链需先解析成完整 URL）。 */
export function parseBilibiliVideoURL(value: string): { bvid: string; page: number } | null {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (!(host === "bilibili.com" || host.endsWith(".bilibili.com"))) return null
    const match = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)
    if (!match) return null
    const page = Number(url.searchParams.get("p") || "1")
    return { bvid: match[1], page: Number.isFinite(page) && page > 0 ? page : 1 }
  } catch {
    return null
  }
}

function pick(html: string, pattern: RegExp): string {
  const match = html.match(pattern)
  return match ? match[1] : ""
}

async function fetchPage(bvid: string, page: number): Promise<string> {
  const pageURL = `https://m.bilibili.com/video/${bvid}${page > 1 ? `?p=${page}` : ""}`
  const response = await fetch(pageURL, { headers: { "User-Agent": BILIBILI_MOBILE_UA } })
  if (response.status !== 200) throw new Error(`B站移动页返回 ${response.status}`)
  return response.text()
}

type PlayurlDurl = { url?: string; backupUrl?: string[]; size?: number; quality?: number }
type PlayurlVideo = { id?: number; width?: number; height?: number; codecs?: string; baseUrl?: string; backupUrl?: string[]; bandwidth?: number }
type PlayurlAudio = { id?: number; codecs?: string; baseUrl?: string; backupUrl?: string[]; bandwidth?: number }
type PlayurlResponse = {
  code?: number
  message?: string
  data?: {
    dash?: { video: PlayurlVideo[]; audio: PlayurlAudio[]; duration?: number }
    durl?: PlayurlDurl[]
  }
}

async function fetchPlayurl(bvid: string, cid: number, qn: number): Promise<PlayurlResponse | null> {
  const url = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=${qn}&fnval=1&fnver=0&fourk=0`
  const response = await fetch(url, {
    headers: { "User-Agent": BILIBILI_MOBILE_UA, Referer: "https://www.bilibili.com/", Accept: "application/json" },
  })
  if (!response.ok) return null
  try {
    return (await response.json()) as PlayurlResponse
  } catch {
    return null
  }
}

function heightForQn(qn: number): number {
  return QN_HEIGHT.find((entry) => entry.qn === qn)?.height ?? 0
}

function directChoice(qn: number, durl: PlayurlDurl, title: string): MediaChoice {
  const url = durl.url || ""
  const height = heightForQn(qn)
  const label = height
    ? `原始视频 · 容器·MP4 · ${height}p`
    : `原始视频 · 容器·MP4`
  return {
    id: `bilibili-direct-${qn}`,
    label,
    kind: "video",
    formatExpression: "direct",
    container: "mp4",
    height: height || undefined,
    estimatedBytes: durl.size,
    sourceURL: url,
    previewURL: url,
    previewReferer: "https://www.bilibili.com/",
    previewHeaders: { Referer: "https://www.bilibili.com/", "User-Agent": BILIBILI_MOBILE_UA },
    sourceReferer: "https://www.bilibili.com/",
  }
}

function dashChoice(index: number, video: PlayurlVideo, audio: PlayurlAudio | undefined): MediaChoice {
  const url = video.baseUrl || ""
  const height = video.height || 0
  const codec = String(video.codecs || "").includes("av01") ? "av1" : String(video.codecs || "").includes("hev") ? "hevc" : String(video.codecs || "").includes("vp09") ? "vp9" : "h264"
  const container = codec === "h264" ? "mp4" : "mkv"
  const label = `${height || video.id || "?"}p · ${codec.toUpperCase()}${audio ? " · 合并音频" : " · 无声"} · 容器·${container.toUpperCase()}`
  return {
    id: `bilibili-dash-${index}`,
    label,
    kind: "video",
    formatExpression: "direct",
    container,
    height: height || undefined,
    videoCodec: codec === "av1" ? "av1" : codec === "hevc" ? "hevc" : codec === "vp9" ? "vp9" : "h264",
    sourceURL: url,
    previewURL: url,
    previewReferer: "https://www.bilibili.com/",
    previewHeaders: { Referer: "https://www.bilibili.com/", "User-Agent": BILIBILI_MOBILE_UA },
    sourceReferer: "https://www.bilibili.com/",
    mergeAudioFormat: audio ? "bestaudio/best" : undefined,
    previewAudioURL: audio?.baseUrl,
    previewAudioCodec: audio?.codecs,
    previewVideoCodec: video.codecs,
  }
}

/**
 * B 站原生探测：m 站页面 → bvid/cid/标题 → playurl API 直链。
 * 优先收集多档 durl（progressive MP4，匿名 qn=80 即 1080p）；durl 缺失时才解析 DASH。
 * 失败返回 null（调用方回退 yt-dlp 与 412 m 站兜底）。
 */
export async function probeBilibiliDirect(sourceURL: string): Promise<MediaProbe | null> {
  const parsed = parseBilibiliVideoURL(sourceURL)
  if (!parsed) return null
  const taskId = createTaskId()
  await logEvent({ level: "info", event: "probe.bilibili.direct.started", taskId, details: { sourceURL, bvid: parsed.bvid } })
  try {
    const html = await fetchPage(parsed.bvid, parsed.page)
    const bvid = pick(html, /"bvid":"(BV[0-9A-Za-z]+)"/) || parsed.bvid
    const cidText = pick(html, /"cid":(\d+)/)
    if (!cidText) throw new Error("未从页面提取到视频 cid")
    const cid = Number(cidText)
    const title = (pick(html, /property="og:title" content="([^"]+)"/) || pick(html, /<h1[^>]*>([^<]{0,120})/)).replace(/_哔哩哔哩_bilibili$/, "").trim() || "B站视频"
    const thumbnail = pick(html, /property="og:image" content="([^"]+)"/) || undefined

    // 多档 durl：从高到低收集可用的 progressive 直链。
    const choices: MediaChoice[] = []
    for (const { qn } of QN_HEIGHT) {
      const playurl = await fetchPlayurl(bvid, cid, qn)
      if (playurl?.data?.durl?.length) {
        choices.push(directChoice(qn, playurl.data.durl[0], title))
      }
    }
    // durl 全失败时尝试 DASH（登录态/特定视频会返回 dash 而非 durl）。
    if (!choices.length) {
      const playurl = await fetchPlayurl(bvid, cid, 80)
      const dash = playurl?.data?.dash
      if (dash?.video?.length) {
        const audio = dash.audio?.[0]
        for (const video of dash.video) {
          if (!video.baseUrl) continue
          choices.push(dashChoice(choices.length, video, audio))
        }
      }
    }
    if (!choices.length) {
      await logEvent({ level: "warn", event: "probe.bilibili.direct.empty", taskId, details: { bvid, cid, message: "无可用流" } })
      return null
    }
    const probe: MediaProbe = {
      title,
      uploader: undefined,
      duration: undefined,
      thumbnail,
      webpageURL: `https://www.bilibili.com/video/${bvid}`,
      choices,
    }
    await logEvent({ level: "info", event: "probe.bilibili.direct.completed", taskId, details: { bvid, cid, title, choiceCount: choices.length, heights: choices.map((c) => c.height || 0) } })
    return probe
  } catch (error) {
    await logEvent({ level: "warn", event: "probe.bilibili.direct.failed", taskId, details: { message: error instanceof Error ? error.message : String(error) } })
    return null
  }
}
