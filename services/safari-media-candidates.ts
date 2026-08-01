import { redactURL } from "./logs"

export type SafariMediaCandidateKind = "hls" | "dash" | "video" | "audio" | "inferred"

export type SafariCaptureSource = "dom" | "preload" | "metadata" | "performance"

export type SafariMediaCandidate = {
  id: string
  url: string
  kind: SafariMediaCandidateKind
  pageURL: string
  pageTitle?: string
  discoveredAt: number
  captureSource?: SafariCaptureSource
}

export type SafariMediaCandidateEnvelope = {
  version: 1
  pageURL: string
  pageTitle?: string
  capturedAt: number
  candidates: SafariMediaCandidate[]
  playerFrameURL?: string
}

export type SafariFrameCandidateReport = {
  sessionId: string
  pageURL: string
  pageTitle?: string
  candidates: Array<Partial<SafariMediaCandidate> & { source?: SafariCaptureSource }>
}

export function mergeSafariFrameCandidates(input: {
  sessionId: string
  pageURL: string
  pageTitle?: string
  capturedAt: number
  topLevel: Array<Partial<SafariMediaCandidate> & { source?: SafariCaptureSource }>
  frames: SafariFrameCandidateReport[]
}): SafariMediaCandidateEnvelope {
  const rawCandidates: Array<Record<string, unknown>> = []
  for (const candidate of input.topLevel) rawCandidates.push({ ...candidate, pageURL: input.pageURL, pageTitle: candidate.pageTitle ?? input.pageTitle })
  for (const frame of input.frames) {
    if (frame.sessionId !== input.sessionId || !isHTTPURL(frame.pageURL)) continue
    for (const candidate of frame.candidates) rawCandidates.push({ ...candidate, pageURL: frame.pageURL, pageTitle: candidate.pageTitle ?? frame.pageTitle ?? input.pageTitle })
  }
  const envelope = sanitizeSafariMediaCandidates({ version: 1, pageURL: input.pageURL, pageTitle: input.pageTitle, capturedAt: input.capturedAt, candidates: rawCandidates })
  return envelope || { version: 1, pageURL: input.pageURL, pageTitle: safeTitle(input.pageTitle), capturedAt: input.capturedAt, candidates: [] }
}

export const SAFARI_MEDIA_CANDIDATE_STORAGE_KEY = "yoinks-media-candidates-v1"
export const SAFARI_MEDIA_CANDIDATE_DIAGNOSTIC_STORAGE_KEY = "yoinks-media-candidates-diagnostic-v1"
export const SAFARI_MEDIA_CANDIDATE_FILE = "Yoinks.json"
export const MAX_SAFARI_MEDIA_CANDIDATES = 50

const MEDIA_KINDS = new Set<SafariMediaCandidateKind>(["hls", "dash", "video", "audio", "inferred"])
const CAPTURE_SOURCES = new Set<SafariCaptureSource>(["dom", "preload", "metadata", "performance"])

function safeTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const title = value.replace(/[\r\n\x00-\x1f\x7f]/g, " ").trim().slice(0, 240)
  return title || undefined
}

export function isHTTPURL(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

/** Removes fragments while retaining query parameters required by short-lived signed media URLs. */
export function normalizeSafariCandidateURL(value: string): string | null {
  if (!isHTTPURL(value)) return null
  try {
    const url = new URL(value)
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

/**
 * A Safari candidate's public page URL may be used only as this task's Referer.
 * It is never a cookie/header import and is deliberately normalized to remove fragments.
 */
export function safariPageReferer(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\r\n]/.test(value)) return undefined
  return normalizeSafariCandidateURL(value) || undefined
}

export function classifySafariMediaURL(value: string): SafariMediaCandidateKind | null {
  const normalized = normalizeSafariCandidateURL(value)
  if (!normalized) return null
  const pathname = new URL(normalized).pathname.toLowerCase()
  if (/\.m3u8$/.test(pathname)) return "hls"
  if (/\.mpd$/.test(pathname)) return "dash"
  if (/\.(?:m4a|aac|mp3|opus|ogg|wav)$/.test(pathname)) return "audio"
  if (/\.(?:mp4|m4v|mov|webm|mkv|avi|flv)$/.test(pathname)) return "video"
  if (/(?:^|[?&])(?:manifest|playlist|m3u8|mpd)=/i.test(new URL(normalized).search)) return "inferred"
  return null
}

export function safariMediaCandidatePriority(candidate: Pick<SafariMediaCandidate, "url" | "kind">): number {
  const pathname = new URL(candidate.url).pathname.toLowerCase()
  if (candidate.kind === "hls") {
    return /(?:^|[-_.\/])(?:master|playlist)(?:[-_.\/]|$)/i.test(pathname) ? 0
      : isLikelyHLSAudioRendition(candidate.url) ? 4
        : 1
  }
  if (candidate.kind === "dash") return 2
  if (candidate.kind === "video") return 3
  if (candidate.kind === "audio") return 4
  return 5
}

export function sortSafariMediaCandidates(candidates: SafariMediaCandidate[]): SafariMediaCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => safariMediaCandidatePriority(a.candidate) - safariMediaCandidatePriority(b.candidate) || a.index - b.index)
    .map(({ candidate }) => candidate)
}

export function sanitizeSafariMediaCandidates(value: unknown): SafariMediaCandidateEnvelope | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (raw.version !== 1 || !isHTTPURL(raw.pageURL) || !Array.isArray(raw.candidates)) return null
  const pageURL = safariPageReferer(raw.pageURL)
  if (!pageURL) return null
  const capturedAt = typeof raw.capturedAt === "number" && Number.isFinite(raw.capturedAt) ? raw.capturedAt : Date.now()
  const seen = new Set<string>()
  const candidates: SafariMediaCandidate[] = []
  for (const item of raw.candidates) {
    if (!item || typeof item !== "object" || candidates.length >= MAX_SAFARI_MEDIA_CANDIDATES) continue
    const candidate = item as Record<string, unknown>
    const url = normalizeSafariCandidateURL(candidate.url as string)
    const candidatePageURL = safariPageReferer(candidate.pageURL) || pageURL
    const kind = typeof candidate.kind === "string" && MEDIA_KINDS.has(candidate.kind as SafariMediaCandidateKind)
      ? candidate.kind as SafariMediaCandidateKind
      : url ? classifySafariMediaURL(url) : null
    if (!url || !kind || /\.(?:ts|m4s)$/i.test(new URL(url).pathname) || seen.has(url)) continue
    seen.add(url)
    candidates.push({
      id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.slice(0, 96) : `candidate-${candidates.length + 1}`,
      url,
      kind,
      pageURL: candidatePageURL,
      pageTitle: safeTitle(candidate.pageTitle ?? raw.pageTitle),
      discoveredAt: typeof candidate.discoveredAt === "number" && Number.isFinite(candidate.discoveredAt) ? candidate.discoveredAt : capturedAt,
      captureSource: CAPTURE_SOURCES.has(candidate.source as SafariCaptureSource) ? candidate.source as SafariCaptureSource : undefined,
    })
  }
  const playerFrameURL = safariPageReferer(raw.playerFrameURL)
  if (!candidates.length && !playerFrameURL) return null
  return { version: 1, pageURL, pageTitle: safeTitle(raw.pageTitle), capturedAt, candidates: sortSafariMediaCandidates(candidates), ...(playerFrameURL ? { playerFrameURL } : {}) }
}

/**
 * GM.setValue writes each browser script's values to one JSON file in
 * safariBrowserStorageDirectory. The Yoinks browser script is named "Yoinks".
 */
export type SafariMediaCandidateDiagnostic = {
  stage: "captured" | "empty"
  capturedAt: number
  candidateCount: number
  resourceCount: number
  mediaLikeResourceCount: number
  iframeCount: number
  resourceHostCount: number
  initiators: Record<string, number>
  topLevelCandidateCount: number
  frameReportCount: number
  frameCandidateCount: number
  waitMs: number
  errorKind?: "session" | "report" | "storage"
}

export function sanitizeSafariMediaCandidateDiagnostic(value: unknown): SafariMediaCandidateDiagnostic | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (raw.version !== 1 || (raw.stage !== "captured" && raw.stage !== "empty")) return null
  const number = (key: string) => typeof raw[key] === "number" && Number.isFinite(raw[key]) ? Math.max(0, Math.min(100000, Math.floor(raw[key] as number))) : 0
  const initiators: Record<string, number> = {}
  if (raw.initiators && typeof raw.initiators === "object" && !Array.isArray(raw.initiators)) {
    for (const [key, value] of Object.entries(raw.initiators as Record<string, unknown>)) {
      if (/^[a-z]{1,24}$/i.test(key) && typeof value === "number" && Number.isFinite(value) && Object.keys(initiators).length < 20) initiators[key] = Math.max(0, Math.min(100000, Math.floor(value)))
    }
  }
  const errorKind = raw.errorKind === "session" || raw.errorKind === "report" || raw.errorKind === "storage" ? raw.errorKind : undefined
  return { stage: raw.stage, capturedAt: number("capturedAt"), candidateCount: number("candidateCount"), resourceCount: number("resourceCount"), mediaLikeResourceCount: number("mediaLikeResourceCount"), iframeCount: number("iframeCount"), resourceHostCount: number("resourceHostCount"), initiators, topLevelCandidateCount: number("topLevelCandidateCount"), frameReportCount: number("frameReportCount"), frameCandidateCount: number("frameCandidateCount"), waitMs: number("waitMs"), errorKind }
}

export function safariMediaCandidatePath(): string {
  return `${FileManager.safariBrowserStorageDirectory}/${SAFARI_MEDIA_CANDIDATE_FILE}`
}

async function readSafariStorage(): Promise<Record<string, unknown> | null> {
  try {
    const path = safariMediaCandidatePath()
    if (!(await FileManager.exists(path))) return null
    const value = JSON.parse(await FileManager.readAsString(path))
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

export async function readSafariMediaCandidates(): Promise<SafariMediaCandidateEnvelope | null> {
  const storage = await readSafariStorage()
  return storage ? sanitizeSafariMediaCandidates(storage[SAFARI_MEDIA_CANDIDATE_STORAGE_KEY]) : null
}

export async function readSafariMediaCandidateDiagnostic(): Promise<SafariMediaCandidateDiagnostic | null> {
  const storage = await readSafariStorage()
  return storage ? sanitizeSafariMediaCandidateDiagnostic(storage[SAFARI_MEDIA_CANDIDATE_DIAGNOSTIC_STORAGE_KEY]) : null
}

/**
 * GM storage is writable only from its owning Safari userscript. A successful import
 * intentionally leaves the last candidate available for retry; the next Safari menu
 * capture atomically replaces it. This avoids unauthorized writes from the app runtime.
 */
export async function clearSafariMediaCandidates(): Promise<void> {
  // No-op by design; see the function documentation above.
}

export function safariCandidateQualityHint(candidate: SafariMediaCandidate): string | null {
  if (candidate.kind === "hls" && safariMediaCandidatePriority(candidate) <= 1) return "推荐 · 自适应最高画质"
  if (candidate.kind === "dash") return "推荐 · 自适应画质"
  if (candidate.kind !== "video") return null
  const pathname = new URL(candidate.url).pathname
  // 兼容公开播放器格式：既有 1080P_1000K.mp4，也有 1080.mp4 / 720.mp4 / 360.mp4。
  const match = pathname.match(/(?:^|[\/_.-])(\d{3,4})p?(?=[._-]|$)/i)
  return match ? `备用直链 · ${match[1]}P` : "备用直链 · 固定画质"
}

export function safariCandidateContainerHint(candidate: SafariMediaCandidate): string {
  if (candidate.kind === "hls") return "HLS"
  if (candidate.kind === "dash") return "DASH"
  const pathname = new URL(candidate.url).pathname
  const match = pathname.match(/\.([a-z0-9]{2,5})$/i)
  return match ? match[1].toUpperCase() : "未知"
}

export function safariCandidateSummary(candidate: SafariMediaCandidate): string {
  const hint = safariCandidateQualityHint(candidate)
  return `${hint ? `${hint} · ` : ""}${candidate.kind.toUpperCase()} · ${redactURL(candidate.url)}`
}

export function isLikelyHLSAudioRendition(value: string): boolean {
  const normalized = normalizeSafariCandidateURL(value)
  if (!normalized || classifySafariMediaURL(normalized) !== "hls") return false
  return /(?:^|[-_.])(?:a\d+|audio)(?:[-_.]|$)/i.test(new URL(normalized).pathname)
}
