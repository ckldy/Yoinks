// ==UserScript==
// @name Yoinks
// @namespace https://github.com/ckldy/Yoinks
// @version 1.0.9
// @description Collect public media candidates from the current page for Yoinks.
// @match http://*/*
// @match https://*/*
// @run-at document-end
// @grant GM.getValue
// @grant GM.setValue
// @grant GM.registerMenuCommand
// @grant GM.addStyle
// @grant GM.log
// ==/UserScript==

declare const GM: any

declare const location: { href: string }
declare const document: any
declare const performance: any

type CandidateKind = "hls" | "dash" | "video" | "audio" | "inferred"

type Candidate = {
  id: string
  url: string
  kind: CandidateKind
  pageURL: string
  pageTitle?: string
  discoveredAt: number
  source: string
}

const STORAGE_KEY = "yoinks-media-candidates-v1"
const DIAGNOSTIC_STORAGE_KEY = "yoinks-media-candidates-diagnostic-v1"
const ALWAYS_SHOW_FLOATING_ENTRY_KEY = "yoinks-floating-entry-always-visible-v1"
const FLOATING_ENTRY_ID = "yoinks-media-candidate-entry"
const FLOATING_ENTRY_LONG_PRESS_MS = 700
const MAX_CANDIDATES = 50
const VIDEO_PATTERN = /\.(?:mp4|m4v|mov|webm|mkv|avi|flv)$/i
const AUDIO_PATTERN = /\.(?:m4a|aac|mp3|opus|ogg|wav)$/i
const SEGMENT_PATTERN = /\.(?:ts|m4s)$/i

function normalizeURL(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value, location.href)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

function classify(value: string): CandidateKind | null {
  const normalized = normalizeURL(value)
  if (!normalized) return null
  const url = new URL(normalized)
  const pathname = url.pathname.toLowerCase()
  if (SEGMENT_PATTERN.test(pathname)) return null
  if (/\.m3u8$/.test(pathname)) return "hls"
  if (/\.mpd$/.test(pathname)) return "dash"
  if (VIDEO_PATTERN.test(pathname)) return "video"
  if (AUDIO_PATTERN.test(pathname)) return "audio"
  if (/(?:^|[?&])(?:manifest|playlist|m3u8|mpd)=/i.test(url.search)) return "inferred"
  return null
}

function priority(candidate: Candidate): number {
  const pathname = new URL(candidate.url).pathname.toLowerCase()
  if (candidate.kind === "hls") {
    if (/(?:^|[-_.\/])(?:master|playlist)(?:[-_.\/]|$)/i.test(pathname)) return 0
    return /(?:^|[-_.])(?:a\d+|audio)(?:[-_.]|$)/i.test(pathname) ? 4 : 1
  }
  if (candidate.kind === "dash") return 2
  if (candidate.kind === "video") return 3
  if (candidate.kind === "audio") return 4
  return 5
}

function sourceURLs(element: any): string[] {
  const values = [element.getAttribute("src")]
  const srcset = element.getAttribute("srcset")
  if (srcset) values.push(...srcset.split(",").map((part: string) => part.trim().split(/\s+/)[0]))
  return values.filter((value): value is string => !!value)
}

function collectCandidates(): Candidate[] {
  const discoveredAt = Date.now()
  const pageURL = normalizeURL(location.href)
  if (!pageURL) return []
  const pageTitle = document.title.replace(/[\r\n\x00-\x1f\x7f]/g, " ").trim().slice(0, 240) || undefined
  const pending: Array<{ value: string; source: string; mediaKind?: CandidateKind }> = []

  document.querySelectorAll("video, audio, source").forEach((element: any) => {
    const tag = String(element.tagName || "").toLowerCase()
    const mediaKind: CandidateKind | undefined = tag === "audio" ? "audio" : "video"
    for (const value of sourceURLs(element)) pending.push({ value, source: "dom", mediaKind } as { value: string; source: string; mediaKind?: CandidateKind })
  })
  document.querySelectorAll('link[rel="preload"][as="video"], link[rel="preload"][as="audio"]').forEach((element: any) => {
    const value = element.getAttribute("href")
    if (value) pending.push({ value, source: "preload" })
  })
  document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[name="twitter:player:stream"], meta[property="twitter:player:stream"]').forEach((element: any) => {
    const value = element.getAttribute("content")
    if (value) pending.push({ value, source: "metadata" })
  })
  performance.getEntriesByType("resource").forEach((entry: any) => pending.push({ value: entry.name, source: "performance" }))

  const seen = new Set<string>()
  const candidates: Candidate[] = []
  for (const item of pending) {
    const url = normalizeURL(item.value)
    const kind = url ? classify(url) || item.mediaKind || null : null
    if (!url || !kind || seen.has(url)) continue
    seen.add(url)
    candidates.push({
      id: `candidate-${candidates.length + 1}`,
      url,
      kind,
      pageURL,
      pageTitle,
      discoveredAt,
      source: item.source,
    })
  }
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => priority(a.candidate) - priority(b.candidate) || a.index - b.index)
    .slice(0, MAX_CANDIDATES)
    .map(({ candidate }) => candidate)
}

function captureDiagnostic(candidateCount: number): Record<string, unknown> {
  const resourceEntries = performance.getEntriesByType("resource") as Array<{ name?: string; initiatorType?: string }>
  const initiators: Record<string, number> = {}
  const hosts = new Set<string>()
  let mediaLikeResources = 0
  let iframeCount = 0
  for (const entry of resourceEntries) {
    const initiator = String(entry.initiatorType || "other").slice(0, 40)
    initiators[initiator] = (initiators[initiator] || 0) + 1
    if (initiator === "iframe") iframeCount += 1
    try {
      const url = new URL(String(entry.name || ""))
      hosts.add(url.host)
      if (/\.(?:m3u8|mpd|mp4|m4v|mov|webm|mkv|m4a|mp3|aac|opus|ogg|wav)(?:$|[?#])/i.test(url.pathname) || /(?:manifest|playlist|m3u8|mpd|stream|media|video)=/i.test(url.search)) mediaLikeResources += 1
    } catch {}
  }
  return {
    version: 1,
    stage: candidateCount ? "captured" : "empty",
    capturedAt: Date.now(),
    pageURL: normalizeURL(location.href),
    candidateCount,
    resourceCount: resourceEntries.length,
    mediaLikeResourceCount: mediaLikeResources,
    iframeCount,
    resourceHostCount: hosts.size,
    initiators,
  }
}

async function captureCurrentPage(): Promise<number> {
  const candidates = collectCandidates()
  const envelope = {
    version: 1 as const,
    pageURL: normalizeURL(location.href),
    pageTitle: document.title.replace(/[\r\n\x00-\x1f\x7f]/g, " ").trim().slice(0, 240) || undefined,
    capturedAt: Date.now(),
    candidates,
  }
  await GM.setValue(STORAGE_KEY, envelope)
  await GM.setValue(DIAGNOSTIC_STORAGE_KEY, captureDiagnostic(candidates.length))
  GM.log("Yoinks media candidates captured", { count: candidates.length, pageURL: envelope.pageURL })
  return candidates.length
}

function showFloatingFeedback(entry: any, text: string): void {
  const feedback = document.createElement("span")
  feedback.className = "yoinks-media-candidate-feedback"
  feedback.textContent = text
  entry.appendChild(feedback)
  setTimeout(() => feedback.remove(), 2200)
}

function installFloatingEntry(alwaysVisible: boolean): void {
  if (document.getElementById(FLOATING_ENTRY_ID)) return
  GM.addStyle(`
    #${FLOATING_ENTRY_ID} { position: fixed; z-index: 2147483647; right: max(16px, env(safe-area-inset-right)); bottom: max(96px, calc(env(safe-area-inset-bottom) + 72px)); width: 48px; height: 48px; border: 0; border-radius: 24px; background: #34c759; color: #fff; box-shadow: 0 6px 18px rgba(0,0,0,.25); display: grid; place-items: center; padding: 0; font: 700 23px -apple-system, BlinkMacSystemFont, sans-serif; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
    #${FLOATING_ENTRY_ID}:active { transform: scale(.94); }
    #${FLOATING_ENTRY_ID} .yoinks-media-candidate-feedback { position: absolute; right: 56px; white-space: nowrap; background: rgba(28,28,30,.92); color: #fff; border-radius: 10px; padding: 7px 10px; font: 13px -apple-system, BlinkMacSystemFont, sans-serif; box-shadow: 0 4px 12px rgba(0,0,0,.2); }
  `)
  const entry = document.createElement("button")
  entry.id = FLOATING_ENTRY_ID
  entry.type = "button"
  entry.title = "采集媒体候选到 Yoinks"
  entry.setAttribute("aria-label", "采集媒体候选到 Yoinks")
  entry.textContent = "↓"
  let longPressTimer: any = null
  let longPressTriggered = false
  const clearLongPress = () => {
    if (longPressTimer) clearTimeout(longPressTimer)
    longPressTimer = null
  }
  entry.addEventListener("pointerdown", () => {
    longPressTriggered = false
    if (!alwaysVisible) {
      longPressTimer = setTimeout(() => {
        longPressTriggered = true
        entry.remove()
      }, FLOATING_ENTRY_LONG_PRESS_MS)
    }
  })
  entry.addEventListener("pointerup", clearLongPress)
  entry.addEventListener("pointercancel", clearLongPress)
  entry.addEventListener("pointerleave", clearLongPress)
  entry.addEventListener("click", async () => {
    clearLongPress()
    if (longPressTriggered) return
    entry.disabled = true
    try {
      const count = await captureCurrentPage()
      showFloatingFeedback(entry, `已捕获 ${count} 个候选`)
    } catch {
      showFloatingFeedback(entry, "采集失败")
    } finally {
      entry.disabled = false
    }
  })
  document.documentElement.appendChild(entry)
}

GM.registerMenuCommand("导入本页媒体候选到 Yoinks", async () => {
  await captureCurrentPage()
})

void (async () => {
  const alwaysVisible = await GM.getValue(ALWAYS_SHOW_FLOATING_ENTRY_KEY, true)
  GM.registerMenuCommand(`始终显示浮动入口：${alwaysVisible ? "开" : "关"}`, async () => {
    const next = !alwaysVisible
    await GM.setValue(ALWAYS_SHOW_FLOATING_ENTRY_KEY, next)
    document.getElementById(FLOATING_ENTRY_ID)?.remove()
    installFloatingEntry(next)
  })
  installFloatingEntry(alwaysVisible)
})()
