import { Path, Script } from "scripting"
import { HOST_NOISE_LINE } from "../media"
import { quote } from "../media"
import type { DiscoveryResult } from "../discovery"
import { normalizeResult } from "./playlist"

const DISCOVER_PATH = Path.join(Script.directory, "services", "discovery-engines", "bilibili_web_discover.py")

export async function discoverSearch(options: {
  query: string
  maxItems: number
  page?: number
  insecure?: boolean
}): Promise<DiscoveryResult> {
  const query = options.query.trim()
  if (!query) {
    throw new Error("请输入搜索关键词")
  }

  const page = Math.max(1, options.page || 1)
  const args = [
    "python3",
    quote(DISCOVER_PATH),
    "--search",
    "--max",
    String(Math.max(1, Math.min(50, options.maxItems))),
    "--page",
    String(page),
    quote(query),
  ]

  const result = await Shell.run(args.join(" "), { cwd: Script.directory, timeout: 60 })
  const cleaned = cleanJSONL(result.output || "")

  const payload = tryParseJSON(cleaned)
  if (!payload) {
    throw new Error("搜索未返回有效结果，请重试")
  }
  if (payload.ok !== true) {
    throw new Error(String(payload.error || "搜索失败"))
  }
  return normalizeResult(payload, "search", query)
}

function cleanJSONL(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !HOST_NOISE_LINE.test(line))
    .join("\n")
}

function tryParseJSON(value: string): Record<string, unknown> | undefined {
  const lines = value.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      return JSON.parse(line) as Record<string, unknown>
    } catch {
      // continue
    }
  }
  return undefined
}
