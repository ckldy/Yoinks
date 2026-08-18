// remote-resolver.ts — 通用远程解析框架
//
// 设计原则（2026-08-18 用户拍板）：
//   远程只做"解析"——返回真实播放资源（直链/清单 + 必需请求头），
//   所有字节下载留在 iOS 本地走现有下载链路（downloadDirectSegmented 等）。
//
// 架构：配方注册表（recipes/）——每站一个薄配方，描述
//   match（URL 判断）/ ipBound（直链是否绑定服务器 IP）/ resolve（解析入口）。
//   通用解析管线（mcpCall + createRemoteClient）站点无关，原样来自 douyin-remote.ts。
//
// 配置：设置页「通用远程解析」— 端点（默认 DSH 本地 Camoufox MCP）+ API Key（X-API-Key）。
// 认证自适应：端点含 /camoufox/mcp 用 X-API-Key，否则兼容旧 Bearer。

import { AbortController, fetch } from "scripting"
import { douyinRecipe } from "./recipes/douyin"
import { genericRecipe } from "./recipes/generic"
import { xiaohongshuRecipe } from "./recipes/xiaohongshu"

export const DEFAULT_ENDPOINT = "https://ecc.vcncv.com/camoufox/mcp"
export const MCP_PROTOCOL_VERSION = "2025-03-26"
const REQUEST_TIMEOUT_MS = 25000
const CACHE_TTL_MS = 10 * 60 * 1000

// ---------- 数据结构 ----------

export interface RemoteConfig {
  enabled: boolean
  endpoint: string
  token: string
}

/** 远程解析出的一个真实播放资源（候选）。 */
export interface RemoteCandidate {
  url: string
  height?: number
  width?: number
  codec?: string
  bitrate?: number
  format: "mp4" | "dash" | "?"
  gear?: string
  kind: "mp4" | "dash" | "m3u8" | "?"
  /** 必需的自定义请求头（如 Origin/Cookie）；Referer/UA 由接入方统一附加。 */
  headers?: Record<string, string>
}

export interface RemoteResolveResult {
  platform: string
  title: string
  via: string
  candidates: RemoteCandidate[]
}

// ---------- 最小 MCP streamable-HTTP 客户端（站点无关） ----------

type MCPParams = Record<string, unknown>

interface MCPResponse {
  jsonrpc?: string
  id?: number
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean; [key: string]: unknown }
  error?: { code: number; message: string }
}

export async function mcpCall(endpoint: string, token: string, method: string, params: MCPParams, sessionId?: string): Promise<{ result: MCPResponse; sessionId?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    }
    if (token) {
      // DSH 本地端点用 X-API-Key；旧 eooa 端点兼容 Bearer
      if (endpoint.includes("/camoufox/mcp")) headers["X-API-Key"] = token
      else headers.Authorization = `Bearer ${token}`
    }
    if (sessionId) headers["Mcp-Session-Id"] = sessionId

    const response = await fetch(endpoint, {
      method: "POST",
      timeout: REQUEST_TIMEOUT_MS,
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    })
    const text = await response.text()
    let parsed: MCPResponse | null = null
    try {
      parsed = JSON.parse(text) as MCPResponse
    } catch {
      // SSE 多事件响应：每个事件 data: 行可能是 progress 通知或最终 result，
      // 取最后一个包含 result/error 的事件（MCP 约定 result 在最后）。
      const dataLines = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
      for (let index = dataLines.length - 1; index >= 0; index -= 1) {
        try {
          const candidate = JSON.parse(dataLines[index]) as MCPResponse
          if (candidate.result || candidate.error) {
            parsed = candidate
            break
          }
        } catch {
          // 跳过无法解析的 data 行
        }
      }
      if (!parsed) {
        try {
          parsed = JSON.parse(dataLines[dataLines.length - 1] ?? "{}") as MCPResponse
        } catch {
          parsed = {}
        }
      }
    }
    const newSessionId = response.headers?.get?.("Mcp-Session-Id") || undefined
    if (parsed.error) throw new Error(`MCP ${method} 错误: ${parsed.error.message} (code ${parsed.error.code})`)
    return { result: parsed, sessionId: newSessionId }
  } finally {
    clearTimeout(timer)
  }
}

export interface RemoteToolClient {
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

/** 建立 MCP 会话并返回工具调用器（优先 structuredContent，否则解析 content 文本）。 */
export async function createRemoteClient(endpoint: string, token: string, log?: (message: string) => void): Promise<RemoteToolClient> {
  const init = await mcpCall(endpoint, token, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "yoinks-remote", version: "1.0" },
  })
  const sessionId = init.sessionId

  const callTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const { result } = await mcpCall(endpoint, token, "tools/call", { name, arguments: args }, sessionId)
    const body = result?.result
    if (body?.isError) {
      const errorText = body.content?.find((c) => c.type === "text")?.text
      throw new Error(`工具 ${name} 执行失败: ${errorText ?? "未知错误"}`)
    }
    const structured = (body as { structuredContent?: unknown } | undefined)?.structuredContent
    if (structured !== undefined) return structured
    const textParts = (body?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "")
    if (textParts.length === 1) {
      try {
        return JSON.parse(textParts[0])
      } catch {
        return textParts[0]
      }
    }
    if (textParts.length > 1) {
      const parsed: unknown[] = []
      for (const part of textParts) {
        try {
          parsed.push(JSON.parse(part))
        } catch {
          // 忽略非 JSON 元素
        }
      }
      if (parsed.length > 0) return parsed
      return textParts.join("")
    }
    return null
  }

  void log
  return { callTool }
}

// ---------- 配方注册表 ----------

export interface RemoteRecipeContext {
  endpoint: string
  token: string
  log: (message: string) => void
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

export interface RemoteRecipe {
  id: string
  /** URL 是否属于该配方覆盖的站点。 */
  match: (url: string) => boolean
  /** 直链是否绑定服务器 IP（绑定则本地下载必然 403，此类平台不启用远程解析）。 */
  ipBound: boolean
  resolve: (ctx: RemoteRecipeContext, url: string) => Promise<RemoteResolveResult | null>
}

/** 配方公共样板：确保反检测浏览器已启动并开启网络捕获（幂等）。 */
export async function ensureBrowserCapturing(ctx: RemoteRecipeContext): Promise<void> {
  try {
    await ctx.callTool("launch_browser", { headless: true, os_type: "auto", locale: "zh-CN", humanize: true })
  } catch {
    try { await ctx.callTool("close_browser", {}) } catch { /* 忽略 */ }
    await ctx.callTool("launch_browser", { headless: true, os_type: "auto", locale: "zh-CN", humanize: true })
  }
  try {
    await ctx.callTool("network_capture", { action: "start", pattern: "**/*", capture_body: true })
  } catch {
    // 已开启时重复 start 可能报错，忽略（若未开启则后续 list 为空会自然失败回退）
  }
}

const REMOTE_RECIPES: RemoteRecipe[] = [douyinRecipe, xiaohongshuRecipe, genericRecipe]

export function registerRemoteRecipe(recipe: RemoteRecipe): void {
  if (!REMOTE_RECIPES.some((r) => r.id === recipe.id)) REMOTE_RECIPES.push(recipe)
}

// ---------- 解析入口（缓存 + 互斥串行） ----------

const cache = new Map<string, { at: number; value: RemoteResolveResult }>()
// MCP 会话有状态（launch_browser/navigate 共享浏览器），远程解析必须串行。
let queue: Promise<unknown> = Promise.resolve()

export interface ResolveRemoteOptions {
  config: RemoteConfig
  url: string
  log?: (message: string) => void
  /** 跳过 10 分钟缓存（调试/验证用）。 */
  noCache?: boolean
}

export async function resolveRemoteMedia(options: ResolveRemoteOptions): Promise<RemoteResolveResult | null> {
  const { config, url, log, noCache } = options
  const endpoint = config.endpoint || DEFAULT_ENDPOINT
  if (!endpoint || !config.token) {
    log?.("远程解析未配置（缺少端点或 Token），跳过。")
    return null
  }
  const recipe = REMOTE_RECIPES.find((r) => r.match(url))
  if (!recipe) {
    log?.("远程解析：没有匹配的配方，跳过。")
    return null
  }
  if (recipe.ipBound) {
    log?.(`远程解析：配方 ${recipe.id} 的直链绑定服务器 IP，本地无法下载，跳过。`)
    return null
  }
  const cacheKey = `${endpoint}|${url}`
  if (!noCache) {
    const hit = cache.get(cacheKey)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      log?.("远程解析：命中 10 分钟缓存。")
      return hit.value
    }
  }
  const run = queue.then(async () => {
    try {
      const client = await createRemoteClient(endpoint, config.token, log)
      const result = await recipe.resolve(
        { endpoint, token: config.token, log: log ?? (() => {}), callTool: client.callTool },
        url
      )
      if (result && result.candidates.length > 0) {
        cache.set(cacheKey, { at: Date.now(), value: result })
      }
      return result
    } catch (error) {
      log?.(`远程解析失败：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  })
  queue = run.catch(() => undefined)
  return run
}
