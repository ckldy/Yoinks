// Bilibili CDN URL rewriting utilities.
//
// iOS WKWebView cannot set Referer/Origin/Cookie via XHR/fetch, and many
// Bilibili CDN mirrors (upos/xy/mcdn) do not send Access-Control-Allow-Origin,
// which causes hls.js / dash.js / MSE XHR requests to be blocked by CORS.
//
// GitHub community workaround (ipcjs/oh-my-userscripts, injahow/user.js, etc.):
// replace the CDN host with upos-sz-mirrorhw.bilivideo.com, which is reported to
// have no CORS restrictions (but does enforce User-Agent). Pair this with a
// desktop Chrome UA via WebViewController.setCustomUserAgent().
//
// References:
// - https://github.com/ipcjs/oh-my-userscripts/blob/user.js/packages/unblock-area-limit/src/util/converters.ts
// - https://github.com/injahow/user.js/blob/master/bilibili-parse-download/src/js/ui/config.js

/** Desktop Chrome UA that satisfies Bilibili CDN UA checks. */
export const BILIBILI_DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

/** CDN host reported by the community as not enforcing CORS. */
export const BILIBILI_CORS_FREE_HOST = "upos-sz-mirrorhw.bilivideo.com"

/** Match common Bilibili CDN host suffixes. */
const BILIBILI_CDN_HOST_RE = /(?:^|\.)(?:bilivideo\.com|bilivideo\.cn|akamaized\.net|mcdn\.bilivideo\.cn)$/i

/**
 * Return true if the URL is served from a Bilibili CDN host.
 */
export function isBilibiliCdnUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname
    return BILIBILI_CDN_HOST_RE.test(hostname)
  } catch {
    return false
  }
}

/**
 * Heuristic: return true if the URL looks like it was signed for the HW mirror
 * (og=hw or os contains "hw" / "08").
 * URLs signed for COS (og=cos, os=cosbv, os=estgoss, etc.) often break when
 * the host is rewritten to the HW mirror.
 */
export function isHwCompatibleBilibiliUrl(url: string): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    const og = u.searchParams.get("og") || ""
    const os = u.searchParams.get("os") || ""
    if (og === "hw" || os.includes("hw") || os.includes("08")) return true
    if (og === "cos" || os === "cosbv" || os === "estgoss") return false
    // Default to true for legacy URLs without og/os params.
    return true
  } catch {
    return true
  }
}

/**
 * Rewrite a Bilibili CDN URL to use a CORS-free mirror host.
 * Non-Bilibili URLs and malformed URLs are returned unchanged.
 * The non-standard port (e.g. mcdn's :4483) is dropped in favor of HTTPS 443.
 */
export function rewriteBilibiliCdnUrl(
  url: string,
  preferredHost: string = BILIBILI_CORS_FREE_HOST
): string {
  if (!url) return url
  try {
    const u = new URL(url)
    if (!BILIBILI_CDN_HOST_RE.test(u.hostname)) return url
    // Only rewrite "mirror" hosts (e.g. upos-sz-mirror08h.bilivideo.com).
    // Edge/mcdn hosts like xy*.mcdn.bilivideo.cn use a different signing scheme
    // (often /v1/resource/ + cos/hwbv params) that the HW mirror rejects with 403.
    if (!/mirror/i.test(u.hostname)) return url
    // Do not rewrite COS-signed URLs to the HW mirror: the signature (upsig)
    // is tied to the original host/path params and will return 403.
    const og = u.searchParams.get("og") || ""
    const os = u.searchParams.get("os") || ""
    if (og === "cos" || os === "cosbv" || os === "estgoss") return url
    // Preserve path, search and hash; replace host and force standard HTTPS port.
    return `https://${preferredHost}${u.pathname}${u.search}${u.hash}`
  } catch {
    return url
  }
}
