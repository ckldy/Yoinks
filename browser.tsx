// ==UserScript==
// @name Yoinks
// @namespace https://github.com/ckldy/Yoinks
// @version 1.1.2
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
const MAX_CANDIDATES = 50
const VIDEO_PATTERN = /\.(?:mp4|m4v|mov|webm|mkv|avi|flv)$/i
const AUDIO_PATTERN = /\.(?:m4a|aac|mp3|opus|ogg|wav)$/i
const SEGMENT_PATTERN = /\.(?:ts|m4s)$/i
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const isTopLevel = () => { try { return window.top === window } catch { return false } }

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
function collectCandidates(): Candidate[] {
  const discoveredAt = Date.now(), pageURL = normalizeURL(location.href); if (!pageURL) return []
  const pageTitle = document.title.replace(/[\r\n\x00-\x1f\x7f]/g, " ").trim().slice(0, 240) || undefined
  const pending: Array<{ value: string; source: string; mediaKind?: CandidateKind }> = []
  document.querySelectorAll("video, audio, source").forEach((element: any) => { const mediaKind: CandidateKind = String(element.tagName || "").toLowerCase() === "audio" ? "audio" : "video"; for (const value of sourceURLs(element)) pending.push({ value, source: "dom", mediaKind }) })
  document.querySelectorAll('link[rel="preload"][as="video"], link[rel="preload"][as="audio"]').forEach((element: any) => { const value = element.getAttribute("href"); if (value) pending.push({ value, source: "preload" }) })
  document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[name="twitter:player:stream"], meta[property="twitter:player:stream"]').forEach((element: any) => { const value = element.getAttribute("content"); if (value) pending.push({ value, source: "metadata" }) })
  performance.getEntriesByType("resource").forEach((entry: any) => pending.push({ value: entry.name, source: "performance" }))
  const seen = new Set<string>(), candidates: Candidate[] = []
  for (const item of pending) { const url = normalizeURL(item.value), kind = url ? classify(url) || item.mediaKind : null; if (!url || !kind || seen.has(url)) continue; seen.add(url); candidates.push({ id: `candidate-${candidates.length + 1}`, url, kind, pageURL, pageTitle, discoveredAt, source: item.source }) }
  return sortCandidates(candidates)
}
function sortCandidates(candidates: Candidate[]): Candidate[] { return candidates.map((candidate, index) => ({ candidate, index })).sort((a, b) => priority(a.candidate) - priority(b.candidate) || a.index - b.index).slice(0, MAX_CANDIDATES).map(({ candidate }) => candidate) }
function firstPublicFrameURL(): string | undefined { for (const frame of Array.from(document.querySelectorAll("iframe")) as any[]) { const url = normalizeURL(frame.getAttribute("src")); if (url) return url } return undefined }
function validSession(value: any): value is CaptureSession { return !!value && typeof value.id === "string" && typeof value.startedAt === "number" && Date.now() >= value.startedAt && Date.now() - value.startedAt <= SESSION_TTL_MS }
function validReport(value: any): value is FrameReport { return !!value && typeof value.sessionId === "string" && typeof value.reportId === "string" && typeof value.pageURL === "string" && Array.isArray(value.candidates) }
function captureDiagnostic(candidateCount: number, topLevelCandidateCount: number, frameReportCount: number, frameCandidateCount: number, waitMs: number, errorKind?: string): Record<string, unknown> {
  const entries = performance.getEntriesByType("resource") as Array<{ name?: string; initiatorType?: string }>, initiators: Record<string, number> = {}, hosts = new Set<string>(); let mediaLikeResourceCount = 0, iframeCount = 0
  for (const entry of entries) { const initiator = String(entry.initiatorType || "other").slice(0, 40); initiators[initiator] = (initiators[initiator] || 0) + 1; if (initiator === "iframe") iframeCount += 1; try { const url = new URL(String(entry.name || "")); hosts.add(url.host); if (/\.(?:m3u8|mpd|mp4|m4v|mov|webm|mkv|m4a|mp3|aac|opus|ogg|wav)(?:$|[?#])/i.test(url.pathname) || /(?:manifest|playlist|m3u8|mpd|stream|media|video)=/i.test(url.search)) mediaLikeResourceCount += 1 } catch {} }
  return { version: 1, stage: candidateCount ? "captured" : "empty", capturedAt: Date.now(), pageURL: normalizeURL(location.href), candidateCount, resourceCount: entries.length, mediaLikeResourceCount, iframeCount, resourceHostCount: hosts.size, initiators, topLevelCandidateCount, frameReportCount, frameCandidateCount, waitMs, ...(errorKind ? { errorKind } : {}) }
}
function mergeCandidates(topLevel: Candidate[], reports: FrameReport[]): Candidate[] { const seen = new Set<string>(), result: Candidate[] = []; for (const candidate of [...topLevel, ...reports.flatMap(report => report.candidates)]) { if (!normalizeURL(candidate.url) || !classify(candidate.url) || seen.has(candidate.url)) continue; seen.add(candidate.url); result.push(candidate) } return sortCandidates(result) }

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
async function captureCurrentPage(): Promise<{ count: number; hasFrameClue: boolean }> {
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
    const envelope = { version: 1 as const, pageURL: normalizeURL(location.href), pageTitle: document.title.replace(/[\r\n\x00-\x1f\x7f]/g, " ").trim().slice(0, 240) || undefined, capturedAt: Date.now(), candidates, ...(candidates.length ? {} : { playerFrameURL: firstPublicFrameURL() }) }
    await GM.setValue(STORAGE_KEY, envelope)
    await GM.setValue(DIAGNOSTIC_STORAGE_KEY, captureDiagnostic(candidates.length, topLevel.length, reports.length, reports.reduce((sum, report) => sum + report.candidates.length, 0), Date.now() - startedAt))
    GM.log("Yoinks media candidates captured", { count: candidates.length, frameReports: reports.length, hasFrameClue: Boolean(envelope.playerFrameURL) })
    return { count: candidates.length, hasFrameClue: Boolean(envelope.playerFrameURL) }
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
      const result = await captureCurrentPage()
      showFloatingFeedback(entry, result.count ? `已捕获 ${result.count} 个候选` : result.hasFrameClue ? "已获取链接信息，需要解析！" : "未捕获到媒体链接")
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
