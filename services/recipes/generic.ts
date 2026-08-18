// recipes/generic.ts — 通用兜底配方（evaluate-js + 网络捕获）
//
// 适用：任意未配置专用配方的 URL。通过远程浏览器打开页面，
//   1. evaluate_js 读页面 video 标签的真实播放地址
//   2. 网络捕获轮询找媒体请求（.m3u8/.mpd/.mp4）
// 产出真实播放资源（远程只解析、本地下载）。
// 覆盖力有限（单页视频站/直链页最佳），是专用配方（douyin 等）之外的兜底。

import { type RemoteRecipe } from "../remote-resolver"

// 单表达式 IIFE（Playwright evaluate 限制：不能顶层声明语句）
const EXTRACT_VIDEO_JS = `(() => {
  const out = [];
  const push = (kind, src, w, h) => {
    if (src && src.indexOf('http') === 0 && out.length < 20) out.push({ kind: kind, src: src, width: w || 0, height: h || 0 });
  };
  try {
    document.querySelectorAll('video').forEach((v) => {
      const src = v.currentSrc || v.getAttribute('src') || '';
      push('video', src, v.videoWidth, v.videoHeight);
    });
    document.querySelectorAll('video source').forEach((s) => {
      const src = s.getAttribute('src') || '';
      push('source', src, 0, 0);
    });
  } catch (e) {}
  return out;
})()`

const NOISE_PATTERN = /\.(jpg|jpeg|png|gif|webp|svg|js|css|woff2?|ttf|json|xml|txt|html?)(\?|#|$)/i

function isLikelyMediaURL(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  if (NOISE_PATTERN.test(url)) return false
  return /\.(m3u8|mpd|mp4|m4v|webm|mov|ts|flv)(\?|#|$)/i.test(url) || /\/playlist\/|\/manifest\//i.test(url)
}

export const genericRecipe: RemoteRecipe = {
  id: "generic",
  // 兜底配方：任何 URL 都匹配（专用配方注册在前，优先命中）。
  match: () => true,
  // 无法预知站点签名是否绑定 IP：尝试解析，本地下载失败由用户自行判断。
  ipBound: false,
  resolve: async (ctx, url) => {
    const callTool = ctx.callTool
    const log = ctx.log
    try {
      log?.("通用解析：启动反检测浏览器…")
      try {
        await callTool("launch_browser", { headless: true, os_type: "auto", locale: "zh-CN", humanize: true })
      } catch {
        try { await callTool("close_browser", {}) } catch { /* 忽略 */ }
        await callTool("launch_browser", { headless: true, os_type: "auto", locale: "zh-CN", humanize: true })
      }
      log?.("通用解析：开启网络捕获…")
      try {
        await callTool("network_capture", { action: "start", pattern: "**/*", capture_body: false })
      } catch {
        // 已开启时忽略
      }
      log?.("通用解析：打开页面…")
      await callTool("navigate", { url, wait_until: "domcontentloaded" })

      // 1. evaluate_js 提取 video 标签
      let pageTitle = ""
      let domCandidates: Array<{ kind: string; src: string; width: number; height: number }> = []
      try {
        const pageInfo = (await callTool("get_page_info", {})) as { title?: string } | { result?: { title?: string } } | null
        const infoRecord = pageInfo && typeof pageInfo === "object" && "result" in pageInfo ? ((pageInfo as { result?: { title?: string } }).result ?? null) : pageInfo
        pageTitle = (infoRecord as { title?: string } | null)?.title ?? ""
      } catch { /* 忽略 */ }
      try {
        const jsResult = (await callTool("evaluate_js", { expression: EXTRACT_VIDEO_JS, await_promise: true })) as
          | { value?: Array<{ kind: string; src: string; width: number; height: number }> }
          | { result?: { value?: Array<{ kind: string; src: string; width: number; height: number }> } }
          | null
        const record = jsResult && typeof jsResult === "object" && "value" in jsResult ? jsResult : (jsResult as { result?: { value?: Array<{ kind: string; src: string; width: number; height: number }> } } | null)?.result ?? null
        const value = record && typeof record === "object" && "value" in record ? (record as { value?: Array<{ kind: string; src: string; width: number; height: number }> }).value : null
        domCandidates = Array.isArray(value) ? value : []
      } catch (error) {
        log?.(`通用解析：evaluate_js 失败 ${error instanceof Error ? error.message : String(error)}`)
      }

      // 2. 轮询网络捕获找媒体请求（m3u8/mpd/mp4）
      const networkURLs: string[] = []
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 1000))
        for (const filter of [".m3u8", ".mpd", ".mp4"]) {
          try {
            const list = (await callTool("list_network_requests", { url_filter: filter })) as
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
            for (const r of requests) {
              if (typeof r.url === "string" && isLikelyMediaURL(r.url)) networkURLs.push(r.url)
            }
          } catch { /* 忽略单次轮询错误 */ }
        }
        if (networkURLs.length > 0 && domCandidates.length > 0) break
      }

      // 合并 + 去重（DOM 优先）
      const seen = new Set<string>()
      const candidates: Array<{ kind: string; url: string; width?: number; height?: number }> = []
      const pushUnique = (kind: string, mediaURL: string, width?: number, height?: number) => {
        if (seen.has(mediaURL)) return
        seen.add(mediaURL)
        candidates.push({ kind, url: mediaURL, width, height })
      }
      for (const c of domCandidates) {
        if (isLikelyMediaURL(c.src) || /\.(m3u8|mpd|mp4|webm|mov)(\?|#|$)/i.test(c.src)) {
          pushUnique(c.kind === "source" ? "m3u8" : "mp4", c.src, c.width, c.height)
        }
      }
      for (const mediaURL of networkURLs) {
        const kind = /\.m3u8(\?|#|$)/i.test(mediaURL) ? "m3u8" : /\.mpd(\?|#|$)/i.test(mediaURL) ? "dash" : "mp4"
        pushUnique(kind, mediaURL)
      }

      if (candidates.length === 0) {
        log?.("通用解析：未发现媒体资源。")
        return null
      }
      log?.(`通用解析成功：${candidates.length} 个资源。`)
      return {
        platform: "generic",
        title: pageTitle || url,
        via: "evaluate-js+network-capture",
        candidates: candidates.map((c) => ({
          url: c.url,
          height: c.height || undefined,
          width: c.width || undefined,
          format: c.kind === "dash" ? "dash" : c.kind === "m3u8" ? "mp4" : "mp4",
          kind: (c.kind === "dash" ? "dash" : c.kind === "m3u8" ? "m3u8" : "mp4") as "mp4" | "dash" | "m3u8",
        })),
      }
    } catch (error) {
      log?.(`通用解析失败：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  },
}
