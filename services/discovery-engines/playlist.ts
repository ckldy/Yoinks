import { Path, Script } from "scripting"
import { quote } from "../media"
import type { DiscoveryKind, DiscoveryPlatform, DiscoveryResult } from "../discovery"

const DISCOVER_PATH = Path.join(Script.directory, "ytdlp_discover.py")

function detectPlatformFromURL(sourceURL: string): DiscoveryPlatform {
  try {
    const host = new URL(sourceURL).hostname.toLowerCase()
    if (host === "youtu.be" || host.includes("youtube.com") || host.includes("m.youtube.com")) return "youtube"
    if (host.includes("tiktok.com")) return "tiktok"
    if (host.includes("douyin.com") || host.includes("iesdouyin.com")) return "douyin"
    if (host === "x.com" || host.includes("twitter.com")) return "x"
    if (host.includes("xiaohongshu.com") || host === "xhslink.com") return "xiaohongshu"
    if (
      host === "bilibili.com" ||
      host.endsWith(".bilibili.com") ||
      host === "b23.tv" ||
      host.endsWith(".bili22.cn") ||
      host.endsWith(".bili23.cn") ||
      host.endsWith(".bili33.cn") ||
      host.endsWith(".bilivideo.com") ||
      host.endsWith(".bilivideo.cn")
    ) {
      return "bilibili"
    }
  } catch {}
  return "bilibili"
}

export async function discoverPlaylist(options: {
  sourceURL: string
  maxItems: number
  insecure?: boolean
  flat?: boolean
  page?: number
}): Promise<DiscoveryResult> {
  const maxItems = Math.max(1, Math.min(50, options.maxItems))
  const page = Math.max(1, options.page || 1)
  const start = (page - 1) * maxItems + 1
  const args = [
    "python3",
    quote(DISCOVER_PATH),
    "--max",
    String(maxItems),
    "--start",
    String(start),
  ]
  // flat 模式只获取链接列表，速度快；非 flat 模式获取标题、封面等元数据，适合单视频/短链。
  if (options.flat !== false) args.push("--flat-playlist")
  if (options.insecure) args.push("--insecure")
  args.push(quote(options.sourceURL))

  const result = await Shell.run(args.join(" "), { cwd: Script.directory, timeout: 180 })
  if (result.exitCode !== 0) {
    throw new Error(result.output || "发现请求失败")
  }
  const payload = parseJSON(result.output)
  if (payload.ok !== true) {
    throw new Error(String(payload.error || "发现请求未返回有效结果"))
  }
  return normalizeResult(payload, "playlist", options.sourceURL)
}

function parseJSON(value: string): Record<string, unknown> {
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

export function normalizeResult(
  payload: Record<string, unknown>,
  kind: DiscoveryKind,
  sourceURL: string,
  platform?: DiscoveryPlatform,
): DiscoveryResult {
  const items = Array.isArray(payload.items) ? payload.items : []
  return {
    kind,
    platform: platform ?? detectPlatformFromURL(String(payload.sourceURL || sourceURL)),
    sourceURL: String(payload.sourceURL || sourceURL),
    items: items
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item != null)
      .map((item, index) => ({
        id: String(item.id || `item-${index}`),
        url: String(item.url || ""),
        title: String(item.title || "未命名视频"),
        uploader: item.uploader ? String(item.uploader) : undefined,
        duration: typeof item.duration === "number" ? item.duration : undefined,
        thumbnail: item.thumbnail ? String(item.thumbnail) : undefined,
        index: typeof item.index === "number" ? item.index : index,
      }))
      .filter((item) => item.url),
    totalAvailable: typeof payload.totalAvailable === "number" ? payload.totalAvailable : items.length,
  }
}
