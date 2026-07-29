/**
 * YouTube 发现引擎: 纯 Scripting fetch, 不走 Shell/Python.
 * 通过 Invidious / Piped 公共实例搜索和获取相关推荐.
 */
import { fetch } from "scripting"
import type { DiscoveryResult } from "../discovery"
import { logEvent } from "../logs"

// 公共 Invidious 实例（自动轮换）
const INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://yewtu.be",
  "https://vid.puffyan.us",
  "https://invidious.slipfox.xyz",
  "https://inv.vern.cc",
  "https://invidious.esmailelbob.xyz",
  "https://invidious.flokinet.to",
  "https://yt.artemislena.eu",
]

let currentInstance = INVIDIOUS_INSTANCES[0]

async function fetchJSON(path: string): Promise<Record<string, unknown> | null> {
  const order = [currentInstance, ...INVIDIOUS_INSTANCES.filter((i) => i !== currentInstance)]
  for (const base of order) {
    try {
      const resp = await fetch(`${base}${path}`, { method: "GET", timeout: 12 })
      if (!resp.ok) continue
      const body = await resp.text()
      if (!body || body.length < 10) continue
      const json = JSON.parse(body) as Record<string, unknown>
      currentInstance = base
      return json
    } catch {
      continue
    }
  }
  return null
}

function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.hostname.includes("youtube.com") || u.hostname === "youtu.be") {
      if (u.pathname === "/watch") return u.searchParams.get("v")
      if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2]
      if (u.pathname.startsWith("/v/")) return u.pathname.split("/")[2]
      if (u.hostname === "youtu.be") return u.pathname.slice(1)
    }
  } catch {}
  return null
}

function resolveThumbnail(v: Record<string, unknown>, videoId: string): string {
  // 1. Invidious videoThumbnails 数组
  const thumbs = v.videoThumbnails as Array<{ url: string }> | undefined
  if (thumbs?.[0]?.url) return thumbs[0].url
  // 2. 单个 thumbnail 字段 (某些旧版本 Invidious)
  if (typeof v.thumbnail === "string" && v.thumbnail) return v.thumbnail
  // 3. 用 videoId 构造 YouTube 标准缩略图 (总是可用)
  if (videoId) return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
  return ""
}

function mapItems(list: Record<string, unknown>[], maxItems: number, prefix: string): DiscoveryResult["items"] {
  return list.slice(0, maxItems).map((v, idx) => {
    const videoId = String(v.videoId || "")
    return {
      id: `${prefix}-${idx}-${videoId}`,
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : "",
      title: String(v.title || "未命名"),
      uploader: String(v.author || ""),
      duration: typeof v.lengthSeconds === "number" ? v.lengthSeconds : undefined,
      thumbnail: resolveThumbnail(v, videoId),
      index: idx,
    }
  }).filter((i) => i.url)
}

// ===== Search =====

export async function discoverYouTubeSearch(options: {
  query: string
  maxItems: number
  page?: number
}): Promise<DiscoveryResult> {
  const query = options.query.trim()
  if (!query) throw new Error("请输入搜索关键词")
  const page = Math.max(1, options.page || 1)

  // Invidious search
  const data = await fetchJSON(`/api/v1/search?q=${encodeURIComponent(query)}&type=video&page=${page}`)
  if (data && Array.isArray(data)) {
    const items = mapItems(data, options.maxItems, "yt")
    if (items.length > 0) {
      await logEvent({ level: "info", event: "youtube.search.ok", details: { itemCount: items.length, source: "invidious" } })
      return { kind: "search", platform: "youtube", sourceURL: "", query, items, totalAvailable: items.length, totalPages: 10 }
    }
  }

  // Fallback: Piped API
  const pipedData = await fetchJSON(`/search?q=${encodeURIComponent(query)}&filter=videos`)
  if (pipedData) {
    const results = (pipedData.items || []) as Record<string, unknown>[]
    const items = results.slice(0, options.maxItems).map((v, idx) => {
      const vid = String(v.url || "").split("v=")[1] || ""
      const thumb = String(v.thumbnail || "") || (vid ? `https://i.ytimg.com/vi/${vid}/mqdefault.jpg` : "")
      return {
        id: `ytp-${idx}-${v.url || ""}`,
        url: String(v.url || ""),
        title: String(v.title || "未命名"),
        uploader: String(v.uploaderName || v.uploader || ""),
        duration: typeof v.duration === "number" ? v.duration : undefined,
        thumbnail: thumb,
        index: idx,
      }
    }).filter((i) => i.url)
    if (items.length > 0) {
      await logEvent({ level: "info", event: "youtube.search.ok", details: { itemCount: items.length, source: "piped" } })
      return { kind: "search", platform: "youtube", sourceURL: "", query, items, totalAvailable: items.length, totalPages: 10 }
    }
  }

  throw new Error("YouTube 搜索失败：所有镜像实例暂不可用，请稍后重试。B站 平台搜索可用。")
}

// ===== Related =====

export async function discoverYouTubeRelated(options: {
  sourceURL: string
  maxItems: number
}): Promise<DiscoveryResult> {
  const url = options.sourceURL.trim()
  if (!url) throw new Error("请输入 YouTube 视频链接")

  const videoId = extractVideoId(url)
  if (!videoId) throw new Error("无法从链接提取 YouTube 视频 ID")

  // Invidious video info → recommendedVideos
  const data = await fetchJSON(`/api/v1/videos/${videoId}`)
  if (data) {
    const related = (data.recommendedVideos || data.relatedVideos || []) as Record<string, unknown>[]
    if (Array.isArray(related) && related.length > 0) {
      const items = mapItems(related, options.maxItems, "ytr")
      if (items.length > 0) {
        await logEvent({ level: "info", event: "youtube.related.ok", details: { itemCount: items.length, source: "invidious" } })
        return { kind: "related", platform: "youtube", sourceURL: url, items, totalAvailable: items.length }
      }
    }
  }

  throw new Error("YouTube 相关推荐失败：所有镜像实例暂不可用，请稍后重试。B站 平台可用。")
}
