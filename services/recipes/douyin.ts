// recipes/douyin.ts — 抖音远程解析配方（browser-capture）
//
// 背景：本地 iPhone UA 只能拿到带水印 720p（移动版 playwm 接口）；
// 无水印/多清晰度（H.264/H.265、多档码率、最高 4K）需要桌面版 aweme/detail 响应，
// 而桌面 UA 在 iOS WKWebView 上会被抖音 secsdk 风控。
// 方案：通过 DSH 本地 Camoufox MCP（反检测浏览器）在服务器抓取签名 detail 响应——
// 让真实浏览器自然发出签名请求，再截获响应（a_bogus 独立生成不可行）。
// 本文件是通用远程解析框架（remote-resolver.ts）的第一个配方。
//
// 兼容层：services/douyin-remote.ts re-export 本文件的符号，历史导入路径不破坏。

import { createRemoteClient, DEFAULT_ENDPOINT, type RemoteRecipe } from "../remote-resolver"

export interface RemoteQuality {
  label: string
  url: string
  height?: number
  width?: number
  bitrate?: number
  gear?: string
  codec: "H.264" | "H.265" | "?"
  format: "mp4" | "dash" | "?"
}

export interface RemoteDetailResult {
  awemeId: string
  desc: string
  qualities: RemoteQuality[]
}

export interface DouyinRemoteConfig {
  enabled: boolean
  endpoint: string
  token: string
}

// ---------- detail JSON → 清晰度档位（移植 douyin-quality.mjs） ----------

function getNestedRecord(root: unknown, key: string): Record<string, unknown> | null {
  if (!root || typeof root !== "object") return null
  const value = (root as Record<string, unknown>)[key]
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function firstURL(addr: unknown): { url: string; h?: number; w?: number; key?: string } | null {
  if (!addr || typeof addr !== "object") return null
  const parent = addr as Record<string, unknown>
  const urls = getArray(parent.url_list).map((item) => getString(item)).filter((s): s is string => Boolean(s))
  const url = urls[0]
  if (!url) return null
  return { url, h: getNumber(parent.height), w: getNumber(parent.width), key: getString(parent.url_key) || undefined }
}

export function extractDetailQualities(detailJSON: unknown): RemoteDetailResult | null {
  const root = (detailJSON && typeof detailJSON === "object" ? detailJSON : null) as Record<string, unknown> | null
  if (!root) return null
  const aweme = getNestedRecord(root, "aweme_detail") || root
  const video = getNestedRecord(aweme, "video")
  if (!video) return null

  const list: RemoteQuality[] = []
  const push = (label: string, addr: unknown, opts: Partial<RemoteQuality> = {}) => {
    const found = firstURL(addr)
    if (!found) return
    list.push({ label, url: found.url, height: found.h, width: found.w, bitrate: opts.bitrate, gear: opts.gear, codec: opts.codec ?? "?", format: opts.format ?? "mp4" })
  }

  push("默认（H.264）", video.play_addr, { codec: "H.264" })
  push("H.265", video.play_addr_265, { codec: "H.265" })
  push("下载（H.264）", video.download_addr, { codec: "H.264" })
  for (const item of getArray(video.bit_rate)) {
    if (!item || typeof item !== "object") continue
    const rec = item as Record<string, unknown>
    const gear = getString(rec.gear_name) || getString(rec.quality_type) || undefined
    const isH265 = rec.is_h265 === 1 || rec.is_h265 === true || getString(rec.format)?.toLowerCase().includes("h265") || false
    const fmt = getString(rec.format)?.toLowerCase().includes("dash") ? "dash" : "mp4"
    push(`${isH265 ? "H.265" : "H.264"} ${gear ?? fmt}`, rec.play_addr, {
      bitrate: getNumber(rec.bit_rate),
      gear,
      codec: isH265 ? "H.265" : "H.264",
      format: fmt,
    })
  }

  // 去重（同 key 保留第一项，与 douyin-quality.mjs 一致），按高度 + 码率降序
  const seen = new Set<string>()
  const unique: RemoteQuality[] = []
  for (const q of list) {
    const dedupeKey = q.url
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    unique.push(q)
  }
  unique.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0))

  return {
    awemeId: getString(aweme.aweme_id) || "",
    desc: getString(aweme.desc) || getString(aweme.item_title) || "",
    qualities: unique,
  }
}

// ---------- 远程解析主流程（browser-capture 配方） ----------

export interface ResolveDouyinOptions {
  config: DouyinRemoteConfig
  pageURL: string
  log?: (message: string) => void
}

export async function resolveDouyinViaRemote(options: ResolveDouyinOptions): Promise<RemoteDetailResult | null> {
  const { config, pageURL, log } = options
  const endpoint = config.endpoint || DEFAULT_ENDPOINT
  if (!endpoint || !config.token) {
    log?.("抖音远程解析未配置（缺少端点或 Token），跳过。")
    return null
  }

  try {
    log?.("远程解析：连接 Camoufox MCP…")
    const client = await createRemoteClient(endpoint, config.token, log)
    const callTool = client.callTool

    log?.("远程解析：启动反检测浏览器…")
    try {
      await callTool("launch_browser", { headless: true, os_type: "auto", locale: "zh-CN", humanize: true })
    } catch {
      // 浏览器可能已存在或残留状态失效：关闭后重新启动
      try { await callTool("close_browser", {}) } catch { /* 忽略 */ }
      await callTool("launch_browser", { headless: true, os_type: "auto", locale: "zh-CN", humanize: true })
    }

    // 必须先开启网络捕获，否则 list_network_requests 拿不到请求记录。
    log?.("远程解析：开启网络捕获…")
    try {
      await callTool("network_capture", { action: "start", pattern: "**/*", capture_body: true })
    } catch {
      // 已开启时重复 start 可能报错，忽略（若未开启则后续 list 为空会自然失败回退）
    }

    log?.("远程解析：打开抖音页面…")
    await callTool("navigate", { url: pageURL, wait_until: "load" })

    // 等待页面 JS 发出签名 detail 请求（桌面版加载后约 3-5 秒）
    let detailRequest: { id: number | string; url: string } | null = null
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 1200))
      const list = (await callTool("list_network_requests", { url_contains_domain: "aweme/v1/web/aweme/detail" })) as
        | Array<{ id: number | string; url: string; status?: number }>
        | { result?: Array<{ id: number | string; url: string; status?: number }>; requests?: Array<{ id: number | string; url: string; status?: number }> }
        | null
      const listRecord = list && typeof list === "object" && !Array.isArray(list) ? (list as Record<string, unknown>) : null
      const requests = Array.isArray(list)
        ? list
        : Array.isArray(listRecord?.result)
          ? (listRecord.result as Array<{ id: number | string; url: string }>)
          : Array.isArray(listRecord?.requests)
            ? (listRecord.requests as Array<{ id: number | string; url: string }>)
            : []
      const found = requests.find((r) => typeof r.id !== "undefined")
      if (found) {
        detailRequest = found
        break
      }
    }
    if (!detailRequest) {
      log?.("远程解析：未捕获到 aweme/detail 请求（可能命中验证码页）。")
      return null
    }

    log?.("远程解析：读取 detail 响应体…")
    const detailResponse = (await callTool("get_network_request", { request_id: detailRequest.id, include_body: true, include_headers: false, max_body_size: 250000 })) as
      | { response_body?: string }
      | { result?: { response_body?: string } }
      | null
    const detailRecord = detailResponse && typeof detailResponse === "object" && !("response_body" in detailResponse) && "result" in detailResponse
      ? ((detailResponse as { result?: { response_body?: string } }).result ?? null)
      : detailResponse
    const body = (detailRecord as { response_body?: string } | null)?.response_body
    if (!body) {
      log?.("远程解析：detail 响应体为空。")
      return null
    }
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(body)
    } catch {
      log?.("远程解析：detail 响应体不是有效 JSON。")
      return null
    }
    const result = extractDetailQualities(parsedBody)
    if (!result || result.qualities.length === 0) {
      log?.("远程解析：detail 中未提取到清晰度档位。")
      return null
    }
    log?.(`远程解析成功：${result.qualities.length} 个档位（最高 ${Math.max(...result.qualities.map((q) => q.height ?? 0))}p）。`)
    return result
  } catch (error) {
    log?.(`远程解析失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

// ---------- 候选合并（兼容层保留；新代码走 remoteResultToMediaChoices） ----------

export function remoteQualitiesToCandidates(
  result: RemoteDetailResult,
  baseHeaders: Record<string, string>,
  referer: string
): Array<{ label: string; url: string; headers: Record<string, string> }> {
  return result.qualities.map((q) => ({
    label: `remote_${q.codec}_${q.height ?? 0}p${q.bitrate ? `_${Math.round(q.bitrate / 1000)}k` : ""}`,
    url: q.url,
    headers: { ...baseHeaders, Referer: referer },
  }))
}

// ---------- 配方注册 ----------

export const douyinRecipe: RemoteRecipe = {
  id: "douyin",
  match: (url) => /(^|\.)douyin\.com|v\.douyin\.com|iesdouyin\.com/i.test(url),
  // zjcdn 无水印直链签名不绑定服务器 IP，iOS 本地可直接分段下载（已验证）。
  ipBound: false,
  resolve: async (ctx, url) => {
    const result = await resolveDouyinViaRemote({
      config: { enabled: true, endpoint: ctx.endpoint, token: ctx.token },
      pageURL: url,
      log: ctx.log,
    })
    if (!result || result.qualities.length === 0) return null
    return {
      platform: "douyin",
      title: result.desc,
      via: "browser-capture",
      candidates: result.qualities.map((q) => ({
        url: q.url,
        height: q.height,
        width: q.width,
        codec: q.codec,
        bitrate: q.bitrate,
        format: q.format,
        gear: q.gear,
        kind: q.format === "dash" ? "dash" : "mp4",
      })),
    }
  },
}
