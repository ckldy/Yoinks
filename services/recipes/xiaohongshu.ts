// recipes/xiaohongshu.ts — 小红书远程解析配方（evaluate-js 提取 video 直链）
//
// 实测结论（2026-08-18 Camoufox 实测）：
//   - PC 笔记页必须带 xsec_token（分享链接天然携带；裸 URL 302→404 拦截，无法解析）
//   - 笔记数据 SSR 内嵌（无 feed API）；video 标签 src 直接是无水印直链
//     （sns-bak-v*.xhscdn.com/stream/.../xxx_N.mp4）
//   - 直链签名不绑定服务器 IP：iOS 本地 Range 206 实测通过（ipBound=false）
//   - 分享页 /discovery/item/{id} JS 渲染后自动跳转 /explore/{id}，同页提取即可
// 产出：单档无水印直链（PC 默认档；多档需 SSR/stream 枚举，留待后续增强）

import { ensureBrowserCapturing, type RemoteRecipe } from "../remote-resolver"

// 单表达式 IIFE（Playwright evaluate 限制）
const EXTRACT_VIDEO_JS = `(() => {
  const v = document.querySelector('video');
  const src = v ? (v.currentSrc || v.getAttribute('src') || '') : '';
  const m = location.pathname.match(/\\/explore\\/([a-zA-Z0-9]+)/);
  const note = m ? m[1] : '';
  const is404 = /\\/404/.test(location.pathname) || document.title.indexOf('\u9875\u9762\u4e0d\u89c1\u4e86') >= 0;
  return { src: src, note: note, is404: is404, path: location.pathname, title: document.title.slice(0, 120) };
})()`

export const xiaohongshuRecipe: RemoteRecipe = {
  id: "xiaohongshu",
  match: (url) => /(^|[^a-z0-9-])(xiaohongshu\.com|xhslink\.com|xhslink\.cn)/i.test(url),
  ipBound: false,
  resolve: async (ctx, url) => {
    const callTool = ctx.callTool
    const log = ctx.log
    // URL 结构指纹（不记录 token 值）：query key 集合 + xsec_token 长度，用于定位“缺 token” vs “token 无效”
    try {
      const u = new URL(url)
      const keys = Array.from(u.searchParams.keys())
      const tokenLen = u.searchParams.get("xsec_token")?.length ?? 0
      log?.(`小红书解析：URL 指纹 path=${u.pathname} queryKeys=[${keys.join(",")}] xsec_token_len=${tokenLen}`)
    } catch {
      log?.("小红书解析：URL 指纹解析失败（非合法 URL）")
    }
    try {
      log?.("小红书解析：启动反检测浏览器…")
      await ensureBrowserCapturing(ctx)

      // 打开笔记页；404 时重试一次（小红书偶发 302→404 抖动，重试可恢复）
      let src = ""
      let noteId = ""
      let pageTitle = ""
      let is404 = false
      for (let navAttempt = 0; navAttempt < 2; navAttempt += 1) {
        if (navAttempt > 0) {
          log?.("小红书解析：重试打开笔记页…")
          await callTool("navigate", { url, wait_until: "domcontentloaded" })
        } else {
          log?.("小红书解析：打开笔记页…")
          await callTool("navigate", { url, wait_until: "domcontentloaded" })
        }

        // 等待 SPA 渲染出 video 标签（短链 302 跟随 + discovery→explore 跳转）
        src = ""
        noteId = ""
        pageTitle = ""
        is404 = false
        for (let attempt = 0; attempt < 6; attempt += 1) {
          await new Promise<void>((resolve) => setTimeout(() => resolve(), 1500))
          try {
            const jsResult = (await callTool("evaluate_js", { expression: EXTRACT_VIDEO_JS, await_promise: true })) as
              | { value?: { src: string; note: string; is404: boolean; title: string } }
              | { result?: { value?: { src: string; note: string; is404: boolean; title: string } } }
              | null
            const record = jsResult && typeof jsResult === "object" && "value" in jsResult
              ? jsResult
              : ((jsResult as { result?: { value?: { src: string; note: string; is404: boolean; title: string } } } | null)?.result ?? null)
            const value = record && typeof record === "object" && "value" in record
              ? (record as { value?: { src: string; note: string; is404: boolean; title: string } }).value
              : null
            if (value) {
              src = value.src || ""
              noteId = value.note || ""
              pageTitle = value.title || ""
              is404 = value.is404
              if (src && !is404) break
              if (is404) break
            }
          } catch {
            // 单次 evaluate 失败继续轮询
          }
        }
        if (!is404 && src) break
      }

      if (is404) {
        log?.("小红书解析：页面 404。原因：链接中的 xsec_token 已失效（过期或绑定原会话）或笔记已不可见。请在小红书 App 里用「分享」按钮重新生成链接（地址栏复制的链接 token 会失效），短链 xhslink.com 或带新鲜 token 的完整链接均可。")
        return null
      }
      if (!src) {
        log?.("小红书解析：未渲染出 video 标签（可能无权限或非视频笔记）。")
        return null
      }
      if (!/^https?:\/\//i.test(src)) {
        log?.("小红书解析：video src 不是有效 URL。")
        return null
      }

      const title = pageTitle.replace(/\s*-\s*小红书\s*$/, "").trim() || url
      log?.(`小红书解析成功：${title.slice(0, 40)} (${noteId || "?"})`)
      return {
        platform: "xiaohongshu",
        title,
        via: "evaluate-js",
        candidates: [
          {
            url: src,
            format: "mp4",
            kind: "mp4",
            headers: { Referer: url },
          },
        ],
      }
    } catch (error) {
      log?.(`小红书解析失败：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  },
}
