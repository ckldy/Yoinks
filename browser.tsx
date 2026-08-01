// ==UserScript==
// @name Yoinks
// @namespace https://github.com/ckldy/Yoinks
// @version 1.1.6
// @description Collect public media candidates from the current page for Yoinks.
// @match http://*/*
// @match https://*/*
// @run-at document-end
// @grant GM.getValue
// @grant GM.setValue
// @grant GM.addValueChangeListener
// @grant GM.registerMenuCommand
// @grant GM.addStyle
// @grant GM.log
// ==/UserScript==

declare const GM: any
declare const location: { href: string }
declare const document: any
declare const performance: any
declare const window: any

type CandidateKind = "hls" | "dash" | "video" | "audio" | "inferred"
type Candidate = { id: string; url: string; kind: CandidateKind; pageURL: string; pageTitle?: string; discoveredAt: number; source: string }
type CaptureSession = { id: string; startedAt: number; pageURL: string }
type FrameReport = { sessionId: string; reportId: string; pageURL: string; pageTitle?: string; candidates: Candidate[]; capturedAt: number }

const STORAGE_KEY = "yoinks-media-candidates-v1"
const DIAGNOSTIC_STORAGE_KEY = "yoinks-media-candidates-diagnostic-v1"
const SESSION_STORAGE_KEY = "yoinks-media-candidates-session-v1"
const REPORT_STORAGE_KEY = "yoinks-media-candidates-frame-report-v1"
const ALWAYS_SHOW_FLOATING_ENTRY_KEY = "yoinks-floating-entry-always-visible-v1"
const FLOATING_ENTRY_ID = "yoinks-media-candidate-entry"
const FLOATING_ENTRY_LONG_PRESS_MS = 700
const FLOATING_ENTRY_POSITION_KEY = "yoinks-floating-entry-position-v1"
const FLOATING_ENTRY_DRAG_THRESHOLD_PX = 8
const FLOATING_ENTRY_EDGE_MARGIN_PX = 12
const CAPTURE_DELAY_MS = 1500
const SESSION_WAIT_MS = 2600
const SESSION_TTL_MS = 8000
// beeg 等站点播放器（hls.js）不会自动请求 m3u8：iOS Safari 拦截 video.play() 的
// NotAllowedError 后只在用户点击播放按钮时才 loadSource()。捕获时若发现页面有媒体
// 元素但无候选，先主动触发播放，再进入监听循环，等用户点播放后自动补捕获。
const PLAYBACK_TRIGGER_MS = 1500
const LISTEN_POLL_MS = 400
const LISTEN_TIMEOUT_MS = 30000
const MAX_CANDIDATES = 50
const VIDEO_PATTERN = /\.(?:mp4|m4v|mov|webm|mkv|avi|flv)$/i
const AUDIO_PATTERN = /\.(?:m4a|aac|mp3|opus|ogg|wav)$/i
const SEGMENT_PATTERN = /\.(?:ts|m4s)$/i
const PLAYER_LITERAL_PATTERN = /(?:loadSource\s*\(\s*|(?:video|audio|player|hls|media)\.src\s*=\s*)["'`]([^"'`]+)["'`]/gi
const PLAYER_BINDING_PATTERN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["'`](https?:\/\/[^"'`]+)["'`]/gi
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const isTopLevel = () => { try { return window.top === window } catch { return false } }
const hasMediaElement = () => Boolean(document.querySelector("video, audio"))
// 在用户激活（浮动入口 click）内同步调用：video.play() 继承手势可绕过 iOS 自动播放拦截，
// 播放器容器（beeg .x-player / data-testid=player / class 含 player）dispatch click 触发
// 站点自己的播放逻辑。失败静默（NotAllowedError 等），由监听循环兜底。
function triggerPlaybackIfIdle(): void {
  const video = document.querySelector("video") as any
  if (video && video.paused !== false) { try { const p = video.play(); if (p && typeof p.catch === "function") p.catch(() => {}) } catch {} }
  const player = document.querySelector(".x-player, [data-testid='player'], [class*='player' i]") as any
  if (player) { try { const MouseEventCtor = (window as any).MouseEvent; player.dispatchEvent(new MouseEventCtor("click", { bubbles: true, cancelable: true, view: window })) } catch {} }
}
function collectMediaLikeURLs(): Set<string> {
  const set = new Set<string>()
  for (const entry of performance.getEntriesByType("resource") as Array<{ name?: string }>) {
    const url = normalizeURL(String(entry.name || ""))
    if (!url) continue
    try {
      const parsed = new URL(url)
      if (/\.(?:m3u8|mpd|mp4|m4v|mov|webm|mkv|ts|m4s)(?:$|[?#])/i.test(parsed.pathname) || /(?:manifest|playlist|m3u8|mpd)=/i.test(parsed.search)) set.add(url)
    } catch {}
  }
  return set
}
function videoStarted(): boolean {
  const video = document.querySelector("video") as any
  return Boolean(video && video.readyState >= 1 && video.paused === false)
}

function normalizeURL(value: string | null | undefined): string | null {
  if (!value) return null
  try { const url = new URL(value, location.href); if (url.protocol !== "http:" && url.protocol !== "https:") return null; url.hash = ""; return url.toString() } catch { return null }
}
function classify(value: string): CandidateKind | null {
  const normalized = normalizeURL(value); if (!normalized) return null
  const url = new URL(normalized), pathname = url.pathname.toLowerCase()
  if (SEGMENT_PATTERN.test(pathname)) return null
  if (/\.m3u8$/.test(pathname)) return "hls"
  if (/\.mpd$/.test(pathname)) return "dash"
  if (VIDEO_PATTERN.test(pathname)) return "video"
  if (AUDIO_PATTERN.test(pathname)) return "audio"
  return /(?:^|[?&])(?:manifest|playlist|m3u8|mpd)=/i.test(url.search) ? "inferred" : null
}
function priority(candidate: Candidate): number {
  const pathname = new URL(candidate.url).pathname.toLowerCase()
  if (candidate.kind === "hls") return /(?:^|[-_.\/])(?:master|playlist)(?:[-_.\/]|$)/i.test(pathname) ? 0 : /(?:^|[-_.])(?:a\d+|audio)(?:[-_.]|$)/i.test(pathname) ? 4 : 1
  return candidate.kind === "dash" ? 2 : candidate.kind === "video" ? 3 : candidate.kind === "audio" ? 4 : 5
}
function sourceURLs(element: any): string[] { const values = [element.getAttribute("src")], srcset = element.getAttribute("srcset"); if (srcset) values.push(...srcset.split(",").map((part: string) => part.trim().split(/\s+/)[0])); return values.filter((value): value is string => !!value) }
// JS 设置的 video.src / currentSrc 不会出现在 getAttribute("src") 里（MSE 路径还会被覆盖为 blob:），
// 读取 IDL 属性以拿到真实解析后的媒体地址。
function mediaElementURLs(element: any): string[] {
  const values: string[] = []
  const resolved = element.currentSrc || element.src
  if (resolved && typeof resolved === "string") values.push(resolved)
  const attr = element.getAttribute("src")
  if (attr) values.push(attr)
  const srcset = element.getAttribute("srcset")
  if (srcset) values.push(...srcset.split(",").map((part: string) => part.trim().split(/\s+/)[0]))
  return values.filter((value): value is string => !!value)
}
// hls.js 等播放器通过 loadSource()/video.src= 显式传入媒体地址；该地址往往是无扩展名端点
// （如 play.php?site_id=...）。仅读取同文档内联脚本文本的字面量/变量绑定 URL，不执行脚本、不跨域。
function playerScriptSourceURLs(): string[] {
  const values: string[] = []
  for (const script of Array.from(document.querySelectorAll("script")) as any[]) {
    const text = String(script.textContent || "")
    if (text.length > 100000) continue
    for (const match of text.matchAll(PLAYER_LITERAL_PATTERN)) { const url = normalizeURL(match[1]); if (url) values.push(url) }
    for (const match of text.matchAll(PLAYER_BINDING_PATTERN)) {
      const url = normalizeURL(match[2]); if (!url) continue
      const id = match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      if (new RegExp(`(?:loadSource\\s*\\(\\s*|(?:video|audio|player|hls|media)\\.src\\s*=\\s*)${id}\\b`).test(text)) values.push(url)
    }
  }
  return values
}
function collectCandidates(): Candidate[] {
  const discoveredAt = Date.now(), pageURL = normalizeURL(location.href); if (!pageURL) return []
  const pageTitle = document.title.replace(/[\r\n\x00-\x1f\x7f]/g, " ").trim().slice(0, 240) || undefined
  const pending: Array<{ value: string; source: string; mediaKind?: CandidateKind }> = []
  document.querySelectorAll("video, audio").forEach((element: any) => { const mediaKind: CandidateKind = String(element.tagName || "").toLowerCase() === "audio" ? "audio" : "video"; for (const value of mediaElementURLs(element)) pending.push({ value, source: "dom", mediaKind }) })
  // 仅收集真正挂在 video/audio 下的 <source>；<picture><source srcset=...gif> 是响应式图片，不是媒体候选。
  document.querySelectorAll("video source, audio source").forEach((element: any) => { const mediaKind: CandidateKind = String(element.parentElement?.tagName || "").toLowerCase() === "audio" ? "audio" : "video"; for (const value of sourceURLs(element)) pending.push({ value, source: "dom", mediaKind }) })
  // 播放器页面的内联脚本会显式调用 loadSource()/video.src= 设置媒体地址；仅在有媒体元素时提取。
  if (document.querySelector("video, audio")) { for (const value of playerScriptSourceURLs()) pending.push({ value, source: "dom", mediaKind: "inferred" }) }
  document.querySelectorAll('link[rel="preload"][as="video"], link[rel="preload"][as="audio"]').forEach((element: any) => { const value = element.getAttribute("href"); if (value) pending.push({ value, source: "preload" }) })
  document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[name="twitter:player:stream"], meta[property="twitter:player:stream"]').forEach((element: any) => { const value = element.getAttribute("content"); if (value) pending.push({ value, source: "metadata" }) })
  performance.getEntriesByType("resource").forEach((entry: any) => pending.push({ value: entry.name, source: "performance" }))
  const seen = new Set<string>(), candidates: Candidate[] = []
  for (const item of pending) { const url = normalizeURL(item.value), kind = url ? classify(url) || item.mediaKind : null; if (!url || !kind || seen.has(url)) continue; seen.add(url); candidates.push({ id: `candidate-${candidates.length + 1}`, url, kind, pageURL, pageTitle, discoveredAt, source: item.source }) }
  return sortCandidates(candidates)
}
function sortCandidates(candidates: Candidate[]): Candidate[] { return candidates.map((candidate, index) => ({ candidate, index })).sort((a, b) => priority(a.candidate) - priority(b.candidate) || a.index - b.index).slice(0, MAX_CANDIDATES).map(({ candidate }) => candidate) }
// 顶层页面常混合广告/追踪 iframe（如 a.adtng.com 横幅）与正片播放器 iframe
// （如 mydaddy.cc/video/...）。直接取第一个 iframe 会把广告当成播放器线索；
// 改为评分选择：排除广告/追踪域名，优先播放器特征路径（/video/、/embed/ 等）。
const AD_FRAME_HOST_RE = /(?:\.|^)(?:adtng|mavrtracktor|magsrv|whitetrafsa|doubleclick|googlesyndication|googletagservices|adnxs|taboola|outbrain|amazon-adsystem|adform|criteo|pubmatic|rubiconproject|openx|casalemedia|serving-sys|zedo)(?:\.|$)/i
const PLAYER_FRAME_PATH_RE = /(?:^|[\/_.-])(?:video|embed|player|watch|stream|play|episode|share|e)(?:[\/_.-]|$)/i
function frameURLScore(url: string): number {
  try {
    const parsed = new URL(url)
    if (AD_FRAME_HOST_RE.test(parsed.hostname)) return -1
    return PLAYER_FRAME_PATH_RE.test(parsed.pathname) ? 2 : 0
  } catch { return 0 }
}
function firstPublicFrameURL(): string | undefined {
  let best: string | undefined, bestScore = -2
  for (const frame of Array.from(document.querySelectorAll("iframe")) as any[]) {
    const url = normalizeURL(frame.getAttribute("src"))
    if (!url) continue
    const score = frameURLScore(url)
    if (score > bestScore) { bestScore = score; best = url }
  }
  return best
}
function validSession(value: any): value is CaptureSession { return !!value && typeof value.id === "string" && typeof value.startedAt === "number" && Date.now() >= value.startedAt && Date.now() - value.startedAt <= SESSION_TTL_MS }
function validReport(value: any): value is FrameReport { return !!value && typeof value.sessionId === "string" && typeof value.reportId === "string" && typeof value.pageURL === "string" && Array.isArray(value.candidates) }
function captureDiagnostic(candidateCount: number, topLevelCandidateCount: number, frameReportCount: number, frameCandidateCount: number, waitMs: number, errorKind?: string): Record<string, unknown> {
  const entries = performance.getEntriesByType("resource") as Array<{ name?: string; initiatorType?: string }>, initiators: Record<string, number> = {}, hosts = new Set<string>(); let mediaLikeResourceCount = 0, iframeCount = 0
  for (const entry of entries) { const initiator = String(entry.initiatorType || "other").slice(0, 40); initiators[initiator] = (initiators[initiator] || 0) + 1; if (initiator === "iframe") iframeCount += 1; try { const url = new URL(String(entry.name || "")); hosts.add(url.host); if (/\.(?:m3u8|mpd|mp4|m4v|mov|webm|mkv|m4a|mp3|aac|opus|ogg|wav)(?:$|[?#])/i.test(url.pathname) || /(?:manifest|playlist|m3u8|mpd|stream|media|video)=/i.test(url.search)) mediaLikeResourceCount += 1 } catch {} }
  return { version: 1, stage: candidateCount ? "captured" : "empty", capturedAt: Date.now(), pageURL: normalizeURL(location.href), candidateCount, resourceCount: entries.length, mediaLikeResourceCount, iframeCount, resourceHostCount: hosts.size, initiators, topLevelCandidateCount, frameReportCount, frameCandidateCount, waitMs, ...(errorKind ? { errorKind } : {}) }
}
function mergeCandidates(topLevel: Candidate[], reports: FrameReport[]): Candidate[] {
  const seen = new Set<string>(), result: Candidate[] = []
  // 候选的 kind 已在各自文档的 collectCandidates 里确定（classify 或媒体元素兜底）；
  // 这里只做去重与归一化，不再用 URL 形状二次过滤（否则无扩展名端点会被误删）。
  for (const candidate of [...topLevel, ...reports.flatMap(report => report.candidates)]) {
    if (!normalizeURL(candidate.url) || seen.has(candidate.url)) continue
    seen.add(candidate.url); result.push(candidate)
  }
  return sortCandidates(result)
}

let activeSessionId: string | null = null
const activeReports = new Map<string, FrameReport>()
if (isTopLevel()) GM.addValueChangeListener(REPORT_STORAGE_KEY, (_: string, __: unknown, value: unknown) => { if (!validReport(value) || value.sessionId !== activeSessionId) return; activeReports.set(value.reportId, value) })

async function reportFrame(session: CaptureSession): Promise<void> {
  if (isTopLevel() || !validSession(session)) return
  await wait(CAPTURE_DELAY_MS)
  if (!validSession(await GM.getValue(SESSION_STORAGE_KEY, null))) return
  const pageURL = normalizeURL(location.href); if (!pageURL) return
  const report: FrameReport = { sessionId: session.id, reportId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, pageURL, pageTitle: document.title.replace(/[\r\n\x00-\x1f\x7f]/g, " ").trim().slice(0, 240) || undefined, candidates: collectCandidates(), capturedAt: Date.now() }
  await GM.setValue(REPORT_STORAGE_KEY, report)
}
async function captureCurrentPage(): Promise<{ count: number; hasFrameClue: boolean; waitingForPlayback?: boolean }> {
  if (!isTopLevel()) return { count: 0, hasFrameClue: false }
  const startedAt = Date.now(), session: CaptureSession = { id: `capture-${startedAt}-${Math.random().toString(36).slice(2, 10)}`, startedAt, pageURL: normalizeURL(location.href) || "" }
  activeSessionId = session.id; activeReports.clear()
  try {
    await GM.setValue(REPORT_STORAGE_KEY, null)
    await GM.setValue(SESSION_STORAGE_KEY, session)
    await wait(CAPTURE_DELAY_MS)
    const topLevel = collectCandidates()
    await wait(Math.max(0, SESSION_WAIT_MS - CAPTURE_DELAY_MS))
    const reports = [...activeReports.values()], candidates = mergeCandidates(topLevel, reports)
    const playerFrameURL = firstPublicFrameURL()
    // beeg 类站点：页面有播放器但未播放时没有媒体请求。等待用户/自动触发播放，
    // 一旦 performance entries 出现 m3u8/mpd/ts 或视频开始播放，立即重新捕获并覆盖存储。
    if (candidates.length === 0 && hasMediaElement()) {
      await wait(PLAYBACK_TRIGGER_MS)
      const startMedia = collectMediaLikeURLs()
      const listenDeadline = Date.now() + LISTEN_TIMEOUT_MS
      while (Date.now() < listenDeadline) {
        await wait(LISTEN_POLL_MS)
        if (collectMediaLikeURLs().size > startMedia.size || videoStarted()) {
          const topLevelAfterPlayback = collectCandidates()
          const candidatesAfterPlayback = mergeCandidates(topLevelAfterPlayback, [...activeReports.values()])
          if (candidatesAfterPlayback.length) {
            const envelopeAfter = { version: 1 as const, pageURL: normalizeURL(location.href), pageTitle: document.title.replace(/[\r\n\x00-\x1f\x7f]/g, " ").trim().slice(0, 240) || undefined, capturedAt: Date.now(), candidates: candidatesAfterPlayback, ...(playerFrameURL ? { playerFrameURL } : {}) }
            await GM.setValue(STORAGE_KEY, envelopeAfter)
            await GM.setValue(DIAGNOSTIC_STORAGE_KEY, captureDiagnostic(candidatesAfterPlayback.length, topLevelAfterPlayback.length, activeReports.size, activeReports.size ? [...activeReports.values()].reduce((sum, report) => sum + report.candidates.length, 0) : 0, Date.now() - startedAt))
            GM.log("Yoinks media candidates captured after playback", { count: candidatesAfterPlayback.length, frameReports: activeReports.size, hasFrameClue: Boolean(envelopeAfter.playerFrameURL) })
            return { count: candidatesAfterPlayback.length, hasFrameClue: Boolean(envelopeAfter.playerFrameURL) }
          }
        }
      }
    }
    // 正片常位于跨域 iframe（如 mydaddy.cc）里；即使顶层已有候选（可能只是推荐/广告短视频），
    // 也总是记录第一个公开 iframe 线索，供导入失败后回退到公开播放器解析。
    const envelope = { version: 1 as const, pageURL: normalizeURL(location.href), pageTitle: document.title.replace(/[\r\n\x00-\x1f\x7f]/g, " ").trim().slice(0, 240) || undefined, capturedAt: Date.now(), candidates, ...(playerFrameURL ? { playerFrameURL } : {}) }
    await GM.setValue(STORAGE_KEY, envelope)
    await GM.setValue(DIAGNOSTIC_STORAGE_KEY, captureDiagnostic(candidates.length, topLevel.length, reports.length, reports.reduce((sum, report) => sum + report.candidates.length, 0), Date.now() - startedAt))
    GM.log("Yoinks media candidates captured", { count: candidates.length, frameReports: reports.length, hasFrameClue: Boolean(envelope.playerFrameURL) })
    return { count: candidates.length, hasFrameClue: Boolean(envelope.playerFrameURL), ...(candidates.length === 0 && hasMediaElement() ? { waitingForPlayback: true } : {}) }
  } catch {
    await GM.setValue(DIAGNOSTIC_STORAGE_KEY, captureDiagnostic(0, 0, activeReports.size, 0, Date.now() - startedAt, "storage"))
    throw new Error("capture failed")
  } finally {
    activeSessionId = null; activeReports.clear()
    await GM.setValue(REPORT_STORAGE_KEY, null)
    await GM.setValue(SESSION_STORAGE_KEY, null)
  }
}
function safeAreaInset(): { top: number; left: number; right: number; bottom: number } {
  const probe = document.createElement("div")
  probe.style.cssText = "position: fixed; top: env(safe-area-inset-top); left: env(safe-area-inset-left); right: env(safe-area-inset-right); bottom: env(safe-area-inset-bottom); visibility: hidden; pointer-events: none;"
  document.documentElement.appendChild(probe)
  const styles = window.getComputedStyle(probe)
  const read = (value: string): number => { const parsed = parseFloat(value); return Number.isFinite(parsed) ? parsed : 0 }
  const inset = { top: read(styles.top), left: read(styles.left), right: read(styles.right), bottom: read(styles.bottom) }
  probe.remove()
  return inset
}
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)) }
function showFloatingFeedback(entry: any, text: string): void {
  const feedback = document.createElement("span")
  feedback.className = "yoinks-media-candidate-feedback"
  feedback.textContent = text
  entry.appendChild(feedback)
  if (entry.getBoundingClientRect().left < 140) { feedback.style.right = "auto"; feedback.style.left = "56px" }
  setTimeout(() => feedback.remove(), 2200)
}
async function installFloatingEntry(alwaysVisible: boolean): Promise<void> {
  if (!isTopLevel() || document.getElementById(FLOATING_ENTRY_ID)) return
  const savedPosition = await GM.getValue(FLOATING_ENTRY_POSITION_KEY, null)
  GM.addStyle(`#${FLOATING_ENTRY_ID} { position: fixed; z-index: 2147483647; right: max(16px, env(safe-area-inset-right)); bottom: max(96px, calc(env(safe-area-inset-bottom) + 72px)); width: 48px; height: 48px; border: 0; border-radius: 24px; background: #34c759; color: #fff; box-shadow: 0 6px 18px rgba(0,0,0,.25); display: grid; place-items: center; padding: 0; font: 700 23px -apple-system, BlinkMacSystemFont, sans-serif; -webkit-tap-highlight-color: transparent; touch-action: none; -webkit-user-select: none; user-select: none; cursor: grab; } #${FLOATING_ENTRY_ID}:active { transform: scale(.94); } #${FLOATING_ENTRY_ID}.yoinks-media-candidate-dragging { cursor: grabbing; transform: scale(1.08); box-shadow: 0 12px 28px rgba(0,0,0,.38); } #${FLOATING_ENTRY_ID} .yoinks-media-candidate-feedback { position: absolute; right: 56px; white-space: nowrap; background: rgba(28,28,30,.92); color: #fff; border-radius: 10px; padding: 7px 10px; font: 13px -apple-system, BlinkMacSystemFont, sans-serif; box-shadow: 0 4px 12px rgba(0,0,0,.2); }`)
  const entry = document.createElement("button"); entry.id = FLOATING_ENTRY_ID; entry.type = "button"; entry.title = "采集媒体候选到 Yoinks"; entry.setAttribute("aria-label", "采集媒体候选到 Yoinks"); entry.textContent = "↓"
  if (savedPosition && typeof savedPosition.x === "number" && typeof savedPosition.y === "number") {
    const inset = safeAreaInset()
    entry.style.right = "auto"; entry.style.bottom = "auto"
    entry.style.left = `${clamp(savedPosition.x, inset.left, Math.max(inset.left, window.innerWidth - 48 - inset.right))}px`
    entry.style.top = `${clamp(savedPosition.y, inset.top, Math.max(inset.top, window.innerHeight - 48 - inset.bottom))}px`
  }
  let longPressTimer: any = null, longPressTriggered = false
  let dragState: { startX: number; startY: number; offsetX: number; offsetY: number; left: number; top: number } | null = null
  let dragging = false, suppressClick = false
  const clearLongPress = () => { if (longPressTimer) clearTimeout(longPressTimer); longPressTimer = null }
  entry.addEventListener("pointerdown", (event: any) => {
    longPressTriggered = false; suppressClick = false; dragging = false
    const rect = entry.getBoundingClientRect()
    dragState = { startX: event.clientX, startY: event.clientY, offsetX: rect.left - event.clientX, offsetY: rect.top - event.clientY, left: rect.left, top: rect.top }
    if (!alwaysVisible) longPressTimer = setTimeout(() => { longPressTriggered = true; entry.remove() }, FLOATING_ENTRY_LONG_PRESS_MS)
  })
  entry.addEventListener("pointermove", (event: any) => {
    if (!dragState) return
    if (!dragging && Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY) > FLOATING_ENTRY_DRAG_THRESHOLD_PX) {
      dragging = true; clearLongPress()
      try { entry.setPointerCapture(event.pointerId) } catch {}
      entry.classList.add("yoinks-media-candidate-dragging")
      entry.style.right = "auto"; entry.style.bottom = "auto"
      entry.style.left = `${dragState.left}px`; entry.style.top = `${dragState.top}px`
    }
    if (dragging) {
      const inset = safeAreaInset()
      entry.style.left = `${clamp(event.clientX + dragState.offsetX, inset.left, window.innerWidth - entry.offsetWidth - inset.right)}px`
      entry.style.top = `${clamp(event.clientY + dragState.offsetY, inset.top, window.innerHeight - entry.offsetHeight - inset.bottom)}px`
    }
  })
  const finishDrag = () => {
    if (!dragging || !dragState) return
    suppressClick = true
    entry.classList.remove("yoinks-media-candidate-dragging")
    const inset = safeAreaInset()
    const width = entry.offsetWidth, height = entry.offsetHeight
    const left = parseFloat(entry.style.left) || dragState.left
    const top = clamp(parseFloat(entry.style.top) || dragState.top, inset.top, Math.max(inset.top, window.innerHeight - height - inset.bottom))
    const snappedLeft = left + width / 2 < window.innerWidth / 2
      ? Math.max(inset.left, FLOATING_ENTRY_EDGE_MARGIN_PX)
      : Math.max(inset.left, Math.min(window.innerWidth - width - inset.right - FLOATING_ENTRY_EDGE_MARGIN_PX, window.innerWidth - width - inset.right))
    entry.style.left = `${snappedLeft}px`; entry.style.top = `${top}px`
    void GM.setValue(FLOATING_ENTRY_POSITION_KEY, { x: snappedLeft, y: top })
  }
  entry.addEventListener("pointerup", () => { clearLongPress(); finishDrag(); dragState = null; dragging = false })
  entry.addEventListener("pointercancel", () => { clearLongPress(); finishDrag(); dragState = null; dragging = false })
  entry.addEventListener("pointerleave", clearLongPress)
  entry.addEventListener("click", async () => {
    clearLongPress()
    if (longPressTriggered || suppressClick) { suppressClick = false; return }
    entry.disabled = true
    try {
      showFloatingFeedback(entry, "正在等待媒体地址…")
      // beeg 等站点需点击播放后才请求 m3u8；在用户激活内同步触发播放，绕过 iOS 自动播放拦截。
      triggerPlaybackIfIdle()
      const result = await captureCurrentPage()
      showFloatingFeedback(entry, result.count ? `已捕获 ${result.count} 个候选` : result.waitingForPlayback ? "请点击页面播放按钮，播放后自动捕获" : result.hasFrameClue ? "已获取链接信息，需要解析！" : "未捕获到媒体链接")
    } catch { showFloatingFeedback(entry, "采集失败") } finally { entry.disabled = false }
  })
  document.documentElement.appendChild(entry)
}
if (isTopLevel()) {
  GM.registerMenuCommand("导入本页媒体候选到 Yoinks", captureCurrentPage)
  void (async () => { const alwaysVisible = await GM.getValue(ALWAYS_SHOW_FLOATING_ENTRY_KEY, true); GM.registerMenuCommand(`始终显示浮动入口：${alwaysVisible ? "开" : "关"}`, async () => { const next = !alwaysVisible; await GM.setValue(ALWAYS_SHOW_FLOATING_ENTRY_KEY, next); document.getElementById(FLOATING_ENTRY_ID)?.remove(); await installFloatingEntry(next) }); await installFloatingEntry(alwaysVisible) })()
} else {
  GM.addValueChangeListener(SESSION_STORAGE_KEY, (_: string, __: unknown, value: CaptureSession) => { void reportFrame(value) })
  void (async () => { const session = await GM.getValue(SESSION_STORAGE_KEY, null); if (validSession(session)) await reportFrame(session) })()
}
