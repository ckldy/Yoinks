import { Path, Script, fetch } from "scripting"
import { logEvent } from "../logs"
import { quote } from "../media"
import { discoverPlaylist } from "./playlist"
import type { DiscoveryItem, DiscoveryResult } from "../discovery"

const PYTHON_SCRIPT = Path.join(Script.directory, "services", "discovery-engines", "bilibili_space_discover.py")

function extractSpaceMid(url: string): string | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (host === "space.bilibili.com" || host === "www.space.bilibili.com") {
      const match = parsed.pathname.match(/^\/(\d+)/)
      return match?.[1] || null
    }
    if (host === "m.bilibili.com" && parsed.pathname.startsWith("/space/")) {
      const match = parsed.pathname.match(/\/space\/(\d+)/)
      return match?.[1] || null
    }
  } catch {}
  return null
}

async function resolveShortLink(url: string): Promise<string> {
  try {
    const response = await fetch(url, { method: "HEAD" })
    return response.url || url
  } catch {
    return url
  }
}

function normalizeSpaceURL(mid: string): string {
  return `https://space.bilibili.com/${mid}/video`
}

function parseLastJSON(value: string): Record<string, unknown> {
  const lines = value.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      return JSON.parse(line) as Record<string, unknown>
    } catch {
      // continue scanning backwards
    }
  }
  throw new Error("发现工具未返回可识别的 JSON")
}

export async function discoverBilibiliSpace(options: {
  sourceURL: string
  maxItems: number
  page?: number
}): Promise<DiscoveryResult> {
  const taskId = `discover-bili-${Date.now()}`
  let workingURL = options.sourceURL

  // Resolve b23.tv short links to final URL
  if (/b23\.tv|bili22\.cn|bili23\.cn|bili33\.cn/i.test(workingURL)) {
    workingURL = await resolveShortLink(workingURL)
    await logEvent({
      level: "info",
      event: "discover.bilibili.resolve",
      taskId,
      details: { resolvedURL: workingURL },
    })
  }

  const mid = extractSpaceMid(workingURL)
  if (!mid) {
    throw new Error("无法从链接中提取 B 站用户 ID")
  }

  const targetURL = normalizeSpaceURL(mid)
  await logEvent({
    level: "info",
    event: "discover.bilibili.started",
    taskId,
    details: { mid, targetURL, maxItems: options.maxItems },
  })

  try {
    const maxItems = Math.max(1, Math.min(50, options.maxItems))
    const page = Math.max(1, options.page || 1)
    const command = `python3 ${quote(PYTHON_SCRIPT)} ${quote(mid)} ${quote(String(maxItems))} ${quote(String(page))}`
    const result = await Shell.run(command, { cwd: Script.directory, timeout: 120 })

    if (result.exitCode !== 0) {
      throw new Error(result.output || "B 站空间发现工具执行失败")
    }

    const payload = parseLastJSON(result.output)
    if (payload.ok !== true) {
      throw new Error(String(payload.error || "B 站空间发现工具返回失败"))
    }

    const rawItems = Array.isArray(payload.items) ? payload.items : []
    const items: DiscoveryItem[] = rawItems
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item != null)
      .map((item, index) => ({
        id: String(item.id || `bili-${index}`),
        url: String(item.url || ""),
        title: String(item.title || "未命名视频"),
        uploader: item.uploader ? String(item.uploader) : undefined,
        duration: typeof item.duration === "number" ? item.duration : undefined,
        thumbnail: item.thumbnail ? String(item.thumbnail) : undefined,
        index: typeof item.index === "number" ? item.index : index,
      }))
      .filter((item) => item.url)

    await logEvent({
      level: "info",
      event: "discover.bilibili.completed",
      taskId,
      details: { mid, itemCount: items.length, totalAvailable: payload.totalAvailable },
    })

    return {
      kind: "author",
      platform: "bilibili",
      sourceURL: workingURL,
      items,
      totalAvailable: typeof payload.totalAvailable === "number" ? payload.totalAvailable : items.length,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await logEvent({
      level: "warn",
      event: "discover.bilibili.wbi-fallback",
      taskId,
      details: { message, fallback: "discoverPlaylist" },
    })

    // WBI API 被风控时，回退到 yt-dlp 的播放列表发现，保证至少能拿到视频列表。
    try {
      const fallback = await discoverPlaylist({
        sourceURL: targetURL,
        maxItems: options.maxItems,
        insecure: true,
        page: options.page,
      })
      const authorResult: DiscoveryResult = { ...fallback, kind: "author", platform: "bilibili", sourceURL: workingURL }
      await logEvent({
        level: "info",
        event: "discover.bilibili.completed",
        taskId,
        details: {
          mid,
          itemCount: authorResult.items.length,
          totalAvailable: authorResult.totalAvailable,
          fallback: true,
        },
      })
      return authorResult
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      await logEvent({
        level: "error",
        event: "discover.bilibili.failed",
        taskId,
        details: { message, fallbackMessage },
      })
      throw new Error(`B 站作者主页发现失败：${message}；yt-dlp 回退也失败：${fallbackMessage}`)
    }
  }
}
