export type PublicPlayerSourceKind = "hls" | "dash" | "video" | "audio" | "inferred"
export type PublicPlayerSourceOrigin = "page" | "iframe"
export type PublicPlayerSource = { url: string; kind: PublicPlayerSourceKind; origin: PublicPlayerSourceOrigin; referer: string; height?: number }
export type PublicPlayerPage = { url: string; html: string; title?: string; origin: PublicPlayerSourceOrigin }
export type PublicHTMLResponse = { finalURL: string; contentType?: string; html: string; title?: string }
export type PublicHTMLFetcher = (url: string) => Promise<PublicHTMLResponse | null>
export type PublicPlayerExtractionResult = { title: string; sources: PublicPlayerSource[]; checkedIframes: number }
export type PublicTextResponse = { finalURL: string; contentType?: string; text: string }
export type PublicTextFetcher = (url: string, accept: string) => Promise<PublicTextResponse | null>

const MAX_CANDIDATES = 12
const MAX_IFRAMES = 3
const VIDEO = new Set(["mp4", "m4v", "mov", "webm", "mkv", "avi", "flv"])
const AUDIO = new Set(["m4a", "mp3", "aac", "opus", "ogg", "wav"])
const SENSITIVE = /(?:^|[/?&_.-])(drm|license|widevine|fairplay|authorization|cookie)(?:$|[/?&=_.-])/i
const COMMON_SUFFIXES = new Set(["com", "net", "org", "io", "tv", "app", "dev", "me", "si", "co", "info", "biz", "xyz", "online", "site", "cn", "uk", "au", "jp"])
const TWO_LEVEL_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "com.cn", "net.cn", "org.cn", "com.au", "net.au", "org.au", "co.jp", "ne.jp", "or.jp"])

function cleanText(value: unknown): string {
  return String(value ?? "").replace(/[\r\n\x00-\x1f\x7f]/g, "").trim()
}

function decodeValue(value: string): string {
  return value
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\\u0026/gi, "&").replace(/\\\//g, "/")
}

export function normalizePublicURL(value: unknown, baseURL?: string): string | null {
  const raw = cleanText(value)
  if (!raw || /[\r\n]/.test(String(value ?? ""))) return null
  try {
    const url = new URL(decodeValue(raw), baseURL)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    url.hash = ""
    return url.toString()
  } catch { return null }
}

export function classifyPublicMediaURL(value: string): { accepted: true; kind: PublicPlayerSourceKind } | { accepted: false; reason: string } {
  const normalized = normalizePublicURL(value)
  if (!normalized) return { accepted: false, reason: "non-http" }
  const url = new URL(normalized)
  const subject = `${url.pathname}${url.search}`
  if (SENSITIVE.test(subject)) return { accepted: false, reason: "sensitive-keyword" }
  const path = url.pathname.toLowerCase()
  if (/\.(ts|m4s)$/.test(path)) return { accepted: false, reason: "segment-url" }
  if (/\.m3u8$/.test(path)) return { accepted: true, kind: "hls" }
  if (/\.mpd$/.test(path)) return { accepted: true, kind: "dash" }
  const ext = path.match(/\.([a-z0-9]+)$/)?.[1]
  if (ext && VIDEO.has(ext)) return { accepted: true, kind: "video" }
  if (ext && AUDIO.has(ext)) return { accepted: true, kind: "audio" }
  if (/(?:^|[?&])(?:manifest|playlist|m3u8|mpd)=/i.test(url.search)) return { accepted: true, kind: "inferred" }
  return { accepted: false, reason: "unsupported-media" }
}

function registrableDomain(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  if (!host || host === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return null
  const parts = host.split(".")
  if (parts.length < 2) return null
  const tail2 = parts.slice(-2).join(".")
  if (TWO_LEVEL_SUFFIXES.has(tail2)) return parts.length >= 3 ? parts.slice(-3).join(".") : null
  return COMMON_SUFFIXES.has(parts.at(-1) || "") ? tail2 : null
}

export function isSamePublicSite(pageURL: string, iframeURL: string): boolean {
  const page = normalizePublicURL(pageURL), frame = normalizePublicURL(iframeURL)
  if (!page || !frame) return false
  const a = new URL(page).hostname.toLowerCase(), b = new URL(frame).hostname.toLowerCase()
  const aDomain = registrableDomain(a), bDomain = registrableDomain(b)
  return aDomain && bDomain ? aDomain === bDomain : a === b
}

function attributeValues(html: string, tag: string, attribute: string, required?: RegExp): string[] {
  const result: string[] = []
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attribute}\\s*=\\s*(["'])([\\s\\S]*?)\\1[^>]*>`, "gi")
  for (const match of html.matchAll(re)) if (!required || required.test(match[0])) result.push(match[2])
  return result
}

export function extractAllowedIframeURLs(pageURL: string, html: string, maxIframes = MAX_IFRAMES): string[] {
  const seen = new Set<string>(), frames: string[] = []
  for (const raw of attributeValues(html, "iframe", "src")) {
    const url = normalizePublicURL(raw, pageURL)
    if (!url || !isSamePublicSite(pageURL, url) || seen.has(url)) continue
    seen.add(url); frames.push(url)
    if (frames.length >= maxIframes) break
  }
  return frames
}

function staticURLs(html: string): string[] {
  const values = [
    ...attributeValues(html, "video", "src"), ...attributeValues(html, "audio", "src"), ...attributeValues(html, "source", "src"),
  ]
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const source = tag[0]
    if (!/\brel\s*=\s*(["'])?preload\1?/i.test(source) || !/\bas\s*=\s*(["'])?(?:video|audio)\1?/i.test(source)) continue
    const href = source.match(/\bhref\s*=\s*(["'])([\s\S]*?)\1/i)?.[2]
    if (href) values.push(href)
  }
  const meta = /<meta\b[^>]*(?:property|name)\s*=\s*(["'])(?:og:video(?::url)?|twitter:player:stream)\1[^>]*content\s*=\s*(["'])([\s\S]*?)\2[^>]*>/gi
  for (const match of html.matchAll(meta)) values.push(match[3])
  const literals = /(?:https?:)?\\?\/\\?\/[\w.-]+(?:\\?\/[\w~%+.,:@!$&'()*;=-]+)+(?:\?[^\s"'<>\\]*)?|https?:\/\/[^\s"'<>]+/gi
  for (const match of html.matchAll(literals)) values.push(match[0])
  return values
}

function rank(kind: PublicPlayerSourceKind): number { return kind === "hls" ? 0 : kind === "dash" ? 1 : kind === "video" ? 2 : kind === "audio" ? 3 : 4 }

export function inferPublicMediaHeight(value: string): number | undefined {
  const path = new URL(value).pathname
  const match = path.match(/(?:^|[^0-9])(2160|1440|1080|720|540|480|360|240)p?(?:[^0-9]|$)/i)
  return match ? Number(match[1]) : undefined
}

export function extractPublicPlayerSourcesFromHTML(page: PublicPlayerPage, maxCandidates = MAX_CANDIDATES): PublicPlayerSource[] {
  const candidates: Array<PublicPlayerSource & { index: number }> = []
  const seenURLs = new Set<string>()
  const seenProgressiveVariants = new Set<string>()
  for (const raw of staticURLs(page.html)) {
    const url = normalizePublicURL(raw, page.url)
    if (!url || seenURLs.has(url)) continue
    const classified = classifyPublicMediaURL(url)
    if (!classified.accepted) continue
    const height = classified.kind === "video" ? inferPublicMediaHeight(url) : undefined
    // Multiple CDN/preload URLs for the same progressive rendition are fallbacks, not user choices.
    // HLS and DASH remain independent because their manifests can expose their own variant ladders.
    const progressiveKey = classified.kind === "video" || classified.kind === "audio" ? `${classified.kind}:${height || 0}` : null
    if (progressiveKey && seenProgressiveVariants.has(progressiveKey)) continue
    seenURLs.add(url)
    if (progressiveKey) seenProgressiveVariants.add(progressiveKey)
    candidates.push({ url, kind: classified.kind, origin: page.origin, referer: page.url, height, index: candidates.length })
  }
  return candidates.sort((a, b) => rank(a.kind) - rank(b.kind) || (b.height || 0) - (a.height || 0) || a.index - b.index).slice(0, maxCandidates).map(({ index, ...item }) => item)
}

function sameOrigin(a: string, b: string): boolean { try { return new URL(a).origin === new URL(b).origin } catch { return false } }

function firstSameOriginScript(pageURL: string, html: string): string | null {
  for (const raw of attributeValues(html, "script", "src")) {
    const url = normalizePublicURL(raw, pageURL)
    if (url && sameOrigin(pageURL, url)) return url
  }
  return null
}

function publicJSONEndpoints(baseURL: string, text: string): string[] {
  const found = new Set<string>()
  const add = (value: string) => {
    const url = normalizePublicURL(value, baseURL)
    if (url && sameOrigin(baseURL, url) && /(?:stream|player|media)/i.test(`${new URL(url).pathname}${new URL(url).search}`)) found.add(url)
  }
  for (const match of text.matchAll(/(?:fetch|axios\.(?:get|post)|\$\.getJSON)\s*\(\s*["']([^"']+)["']/gi)) add(match[1])
  // Allow one explicitly constructed same-origin endpoint only when a fetch receives a non-literal expression.
  // Query values are copied from the public iframe URL; no headers, cookies, or arbitrary script execution occur.
  const fetchArg = text.match(/(?:fetch|axios\.(?:get|post)|\$\.getJSON)\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:\(|[,)])/i)?.[1]
  if (!found.size && fetchArg) {
    const constructed = [...text.matchAll(/new\s+URL\(\s*["'`](\/(?:[^"'`]*(?:stream|player|media)[^"'`]*))["'`]\s*,\s*location\.origin\s*\)/gi)]
    const used = constructed.find((match) => {
      const before = text.slice(Math.max(0, (match.index || 0) - 200), match.index || 0)
      const bindings = [...before.matchAll(/(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/g)]
      const last = bindings[bindings.length - 1]
      return last ? (last[1] || last[2]) === fetchArg : false
    })
    const path = used?.[1]
    if (path) {
      const endpoint = new URL(path, baseURL)
      const iframe = new URL(baseURL)
      iframe.searchParams.forEach((value, key) => {
        if (!/(?:authorization|cookie|token|license|drm|signature|sig|key)/i.test(key)) endpoint.searchParams.set(key, value)
      })
      const id = iframe.pathname.match(/\/e\/([a-z0-9_-]+)/i)?.[1]
      if (id) endpoint.searchParams.set("id", id)
      add(endpoint.toString())
    }
  }
  return [...found].slice(0, 1)
}

function mediaValues(value: unknown, key = ""): string[] {
  if (typeof value === "string") return /^(stream|url|src|file)$/i.test(key) ? [value] : []
  if (!value || typeof value !== "object") return []
  const result: string[] = []
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) result.push(...mediaValues(childValue, childKey))
  return result
}

export async function extractPublicPlayerFrameSources(input: { frameURL: string; pageTitle?: string; fetchText: PublicTextFetcher; onStage?: (stage: string) => void }): Promise<PublicPlayerExtractionResult | null> {
  const stage = input.onStage || (() => {})
  const frameURL = normalizePublicURL(input.frameURL)
  if (!frameURL) return null
  const pageResponse = await input.fetchText(frameURL, "text/html,application/xhtml+xml")
  const pageURL = pageResponse && normalizePublicURL(pageResponse.finalURL)
  if (!pageResponse || !pageURL) { stage("frame-html-failed"); return null }
  stage("frame-html-read")
  const page: PublicPlayerPage = { url: pageURL, html: pageResponse.text, title: input.pageTitle || titleOf(pageResponse.text), origin: "iframe" }
  const staticSources = extractPublicPlayerSourcesFromHTML(page)
  if (staticSources.length) { stage("static-media"); return { title: page.title || "未命名媒体", sources: staticSources, checkedIframes: 1 } }
  const scriptURL = firstSameOriginScript(pageURL, pageResponse.text)
  if (!scriptURL) { stage("script-not-found"); return null }
  const script = await input.fetchText(scriptURL, "text/javascript,application/javascript")
  if (!script || !sameOrigin(pageURL, script.finalURL)) { stage("script-failed"); return null }
  stage("script-read")
  const endpoint = publicJSONEndpoints(pageURL, `${pageResponse.text}\n${script.text}`)[0]
  if (!endpoint) { stage("endpoint-not-found"); return null }
  stage("endpoint-found")
  const json = await input.fetchText(endpoint, "application/json")
  if (!json || !sameOrigin(pageURL, json.finalURL)) { stage("json-failed"); return null }
  stage("json-read")
  let parsed: unknown
  try { parsed = JSON.parse(json.text) } catch { stage("json-failed"); return null }
  const html = mediaValues(parsed).map(value => `<source src="${value.replace(/"/g, "&quot;")}">`).join("")
  const sources = extractPublicPlayerSourcesFromHTML({ ...page, html })
  if (!sources.length) { stage("media-filtered"); return null }
  stage("media-found")
  return { title: page.title || "未命名媒体", sources, checkedIframes: 1 }
}

function titleOf(html: string): string | undefined {
  const value = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const cleaned = cleanText(value)
  return cleaned ? cleaned.slice(0, 240) : undefined
}

export async function extractPublicPlayerSources(input: { pageURL: string; pageTitle?: string; fetchHTML: PublicHTMLFetcher; maxIframes?: number }): Promise<PublicPlayerExtractionResult | null> {
  const pageURL = normalizePublicURL(input.pageURL)
  if (!pageURL) return null
  const pageResponse = await input.fetchHTML(pageURL)
  if (!pageResponse) return null
  const finalPageURL = normalizePublicURL(pageResponse.finalURL)
  if (!finalPageURL) return null
  const page: PublicPlayerPage = { url: finalPageURL, html: pageResponse.html, title: input.pageTitle || pageResponse.title || titleOf(pageResponse.html), origin: "page" }
  const pageSources = extractPublicPlayerSourcesFromHTML(page)
  if (pageSources.length) return { title: page.title || "未命名媒体", sources: pageSources, checkedIframes: 0 }
  const iframeTitles: string[] = []
  let checkedIframes = 0
  for (const iframeURL of extractAllowedIframeURLs(finalPageURL, page.html, input.maxIframes ?? MAX_IFRAMES)) {
    const response = await input.fetchHTML(iframeURL)
    checkedIframes += 1
    const finalURL = response && normalizePublicURL(response.finalURL)
    if (!response || !finalURL || !isSamePublicSite(finalPageURL, finalURL)) continue
    const iframe: PublicPlayerPage = { url: finalURL, html: response.html, title: response.title || titleOf(response.html), origin: "iframe" }
    const sources = extractPublicPlayerSourcesFromHTML(iframe)
    if (!sources.length) continue
    if (iframe.title) iframeTitles.push(iframe.title)
    return { title: page.title || iframeTitles[0] || "未命名媒体", sources, checkedIframes }
  }
  return null
}
