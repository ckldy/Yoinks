import { fetch } from "scripting"
import { logEvent } from "./logs"
import { discoverBilibiliSpace } from "./discovery-engines/bilibili-space"
import { discoverPlaylist } from "./discovery-engines/playlist"
import { discoverRelated } from "./discovery-engines/related"
import { discoverSearch } from "./discovery-engines/search"
import { discoverYouTubeRelated, discoverYouTubeSearch } from "./discovery-engines/youtube"

export type DiscoveryKind = "playlist" | "author" | "search" | "related"

export type DiscoveryPlatform = "bilibili" | "youtube" | "tiktok" | "douyin" | "x" | "xiaohongshu"

export const ALL_DISCOVERY_PLATFORMS: DiscoveryPlatform[] = [
  "bilibili", "youtube", "tiktok", "douyin", "x", "xiaohongshu",
]

export type DiscoveryItem = {
  id: string
  url: string
  title: string
  uploader?: string
  duration?: number
  thumbnail?: string
  index: number
}

export type DiscoveryResult = {
  kind: DiscoveryKind
  platform: DiscoveryPlatform
  sourceURL: string
  query?: string
  items: DiscoveryItem[]
  totalAvailable?: number
  totalPages?: number
}

export type DiscoverOptions = {
  kind: DiscoveryKind
  platform?: DiscoveryPlatform
  sourceURL?: string
  query?: string
  maxItems: number
  experimentalEnabled: boolean
  insecure?: boolean
  /** 1-based page index for "换一批" pagination. */
  page?: number
}

const DISCOVERY_KIND_LABELS: Record<DiscoveryKind, string> = {
  playlist: "播放列表 / 合集 / 频道",
  author: "作者主页",
  search: "关键词搜索",
  related: "相关推荐",
}

const DISCOVERY_PLATFORM_LABELS: Record<DiscoveryPlatform, string> = {
  bilibili: "B站",
  youtube: "YouTube",
  tiktok: "TikTok",
  douyin: "抖音",
  x: "X",
  xiaohongshu: "小红书",
}

export function discoveryPlatformLabel(platform: DiscoveryPlatform): string {
  return DISCOVERY_PLATFORM_LABELS[platform]
}

export function discoveryKindLabel(kind: DiscoveryKind): string {
  return DISCOVERY_KIND_LABELS[kind]
}

function isAllowedURL(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

/**
 * Normalize common share URLs so yt-dlp sees a real playlist/collection.
 * - YouTube watch URL with `list` -> pure playlist URL.
 */
export function normalizeDiscoveryURL(value: string): string {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (
      (host === "www.youtube.com" || host === "youtube.com" || host === "m.youtube.com")
      && url.pathname === "/watch"
    ) {
      const list = url.searchParams.get("list")
      if (list) {
        return `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`
      }
    }
    if (host === "youtu.be") {
      const list = url.searchParams.get("list")
      if (list) {
        return `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`
      }
    }
  } catch {
    // fall through
  }
  return value
}

function isBilibiliSpaceURL(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (host === "space.bilibili.com" || host === "www.space.bilibili.com") return true
    if (host === "m.bilibili.com" && url.pathname.startsWith("/space/")) return true
    return false
  } catch {
    return false
  }
}

function isBilibiliHost(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase()
    return (
      host === "bilibili.com" ||
      host.endsWith(".bilibili.com") ||
      host === "b23.tv" ||
      host.endsWith(".bili22.cn") ||
      host.endsWith(".bili23.cn") ||
      host.endsWith(".bili33.cn") ||
      host.endsWith(".bilivideo.com") ||
      host.endsWith(".bilivideo.cn")
    )
  } catch {
    return false
  }
}

function isSingleVideoURL(value: string): boolean {
  try {
    const pathname = new URL(value).pathname.toLowerCase()
    return /\/video\/(bv\w+|av\d+)/i.test(pathname)
  } catch {
    return false
  }
}

export function bilibiliMobileFallbackURL(value: string): string | null {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if ((host !== "www.bilibili.com" && host !== "bilibili.com") || !isSingleVideoURL(value)) return null
    url.hostname = "m.bilibili.com"
    return url.toString()
  } catch {
    return null
  }
}

export function isBilibiliDiscovery412(message: string): boolean {
  return /\b(?:http\s+error\s+)?412\b/i.test(message)
}

function canonicalBilibiliVideoURL(value: string): string {
  try {
    const url = new URL(value)
    if (url.hostname.toLowerCase() !== "m.bilibili.com" || !isSingleVideoURL(value)) return value
    url.hostname = "www.bilibili.com"
    return url.toString()
  } catch {
    return value
  }
}

function isBilibiliShortLink(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase()
    return host === "b23.tv" || host.endsWith(".bili22.cn") || host.endsWith(".bili23.cn") || host.endsWith(".bili33.cn")
  } catch {
    return false
  }
}

async function resolveShortLink(url: string): Promise<string> {
  try {
    const response = await fetch(url, { method: "HEAD" })
    return response.url || url
  } catch {
    return url
  }
}

/** 构造各平台的搜索 URL，供 yt-dlp extractor 消费。 */
function buildPlatformSearchURL(platform: DiscoveryPlatform, query: string): string | null {
  const q = encodeURIComponent(query)
  switch (platform) {
    case "tiktok": return `https://www.tiktok.com/search?q=${q}`
    case "douyin": return `https://www.douyin.com/search/${q}`
    case "x": return `https://x.com/search?q=${q}&f=video`
    case "xiaohongshu": return `https://www.xiaohongshu.com/search_result?keyword=${q}&type=51`
    default: return null
  }
}

export async function discover(options: DiscoverOptions): Promise<DiscoveryResult> {
  if (options.kind === "search" || options.kind === "related") {
    if (!options.experimentalEnabled) {
      throw new Error("该发现类型属于实验功能，请先在设置中开启")
    }
  }

  switch (options.kind) {
    case "playlist":
    case "author": {
      let sourceURL = (options.sourceURL || "").trim()
      if (!isAllowedURL(sourceURL)) {
        throw new Error("请输入有效的公开 http 或 https 链接")
      }
      sourceURL = normalizeDiscoveryURL(sourceURL)

      // B 站短链（b23.tv 等）需要先解析，否则会被错误分发到作者主页逻辑。
      if (isBilibiliShortLink(sourceURL)) {
        sourceURL = await resolveShortLink(sourceURL)
      }

      if (isBilibiliSpaceURL(sourceURL)) {
        return discoverBilibiliSpace({ sourceURL, maxItems: options.maxItems, page: options.page })
      }

      const taskId = `discover-${Date.now()}`
      const page = options.page || 1
      await logEvent({
        level: "info",
        event: "discover.started",
        taskId,
        details: { kind: options.kind, sourceURL, maxItems: options.maxItems, page },
      })
      try {
        // B 站域名在 MITM/抓包环境下几乎必然触发 SSL 证书校验失败，默认启用 insecure 重试。
      const shouldInsecure = options.insecure === true || isBilibiliHost(sourceURL)
      // 单视频/短链使用非 flat 模式，获取真实标题、UP 主、封面；列表仍用 flat 模式保证速度。
      const shouldFlat = !isSingleVideoURL(sourceURL)
      let result: DiscoveryResult
      try {
        result = await discoverPlaylist({
          sourceURL,
          maxItems: options.maxItems,
          insecure: shouldInsecure,
          flat: shouldFlat,
          page,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const mobileURL = isBilibiliDiscovery412(message) ? bilibiliMobileFallbackURL(sourceURL) : null
        if (!mobileURL) throw error
        await logEvent({
          level: "warn",
          event: "discover.bilibili.mobile-fallback",
          taskId,
          details: { sourceURL, mobileURL, reason: "http-412" },
        })
        try {
          const mobileResult = await discoverPlaylist({
            sourceURL: mobileURL,
            maxItems: options.maxItems,
            insecure: shouldInsecure,
            flat: false,
            page,
          })
          result = {
            ...mobileResult,
            sourceURL,
            items: mobileResult.items.map(item => ({ ...item, url: canonicalBilibiliVideoURL(item.url) })),
          }
        } catch (fallbackError) {
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          throw new Error(`B站桌面页发现返回 HTTP 412；m站回退也失败：${fallbackMessage}`)
        }
      }
        await logEvent({
          level: "info",
          event: "discover.completed",
          taskId,
          details: { kind: options.kind, itemCount: result.items.length, totalAvailable: result.totalAvailable, page },
        })
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await logEvent({
          level: "error",
          event: "discover.failed",
          taskId,
          details: { kind: options.kind, message },
        })
        throw error
      }
    }
    case "search": {
      const query = (options.query || "").trim()
      if (!query) {
        throw new Error("请输入搜索关键词")
      }
      const platform = options.platform || "bilibili"
      if (platform === "youtube") {
        return addPlatform(runDiscovery("search", { query, maxItems: options.maxItems }, () =>
          discoverYouTubeSearch({ query, maxItems: options.maxItems, page: options.page }),
        ), platform)
      }
      if (platform === "bilibili") {
        return addPlatform(runDiscovery("search", { query, maxItems: options.maxItems, page: options.page }, () =>
          discoverSearch({ query, maxItems: options.maxItems, page: options.page }),
        ), platform)
      }
      // 其他平台：构造搜索 URL，交给 yt-dlp extractor 处理
      const searchURL = buildPlatformSearchURL(platform, query)
      if (!searchURL) {
        throw new Error(`${discoveryPlatformLabel(platform)} 搜索功能开发中`)
      }
      return addPlatform(runDiscovery("search", { query, platform, searchURL, maxItems: options.maxItems }, () =>
        discoverPlaylist({ sourceURL: searchURL, maxItems: options.maxItems, flat: false }),
      ), platform)
    }
    case "related": {
      let sourceURL = (options.sourceURL || "").trim()
      if (!isAllowedURL(sourceURL)) {
        throw new Error("请输入有效的公开 http 或 https 链接")
      }
      const platform = options.platform || "bilibili"
      if (isBilibiliShortLink(sourceURL)) {
        sourceURL = await resolveShortLink(sourceURL)
      }
      if (platform === "youtube") {
        return addPlatform(runDiscovery("related", { sourceURL, maxItems: options.maxItems }, () =>
          discoverYouTubeRelated({ sourceURL, maxItems: options.maxItems }),
        ), platform)
      }
      if (platform !== "bilibili") {
        throw new Error(`${discoveryPlatformLabel(platform)} 相关推荐功能开发中`)
      }
      return addPlatform(runDiscovery("related", { sourceURL, maxItems: options.maxItems }, () =>
        discoverRelated({ sourceURL, maxItems: options.maxItems }),
      ), platform)
    }
    default: {
      const _exhaustive: never = options.kind
      throw new Error(`未知的发现类型: ${_exhaustive}`)
    }
  }
}

async function addPlatform(result: Promise<DiscoveryResult>, platform: DiscoveryPlatform): Promise<DiscoveryResult> {
  const r = await result
  return { ...r, platform }
}

async function runDiscovery<K extends DiscoveryKind>(
  kind: K,
  details: Record<string, unknown>,
  execute: () => Promise<DiscoveryResult>,
): Promise<DiscoveryResult> {
  const taskId = `discover-${Date.now()}`
  await logEvent({
    level: "info",
    event: "discover.started",
    taskId,
    details: { kind, ...details },
  })
  try {
    const result = await execute()
    await logEvent({
      level: "info",
      event: "discover.completed",
      taskId,
      details: { kind, itemCount: result.items.length, totalAvailable: result.totalAvailable },
    })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await logEvent({
      level: "error",
      event: "discover.failed",
      taskId,
      details: { kind, message },
    })
    throw error
  }
}
