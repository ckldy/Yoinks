export type MediaCandidateSource = "safari" | "discover" | "manual"
export type MediaCandidateKind = "hls" | "dash" | "video" | "audio" | "page"
export type SafariCaptureSource = "dom" | "preload" | "metadata" | "performance"
export type MediaCandidate = {
  id: string; source: MediaCandidateSource; url: string; pageURL?: string; title?: string; kind?: MediaCandidateKind
  createdAt: number; expiresAt: number; captureSource?: SafariCaptureSource; qualityHint?: string; containerHint?: string
}
export type MediaCandidateInput = Omit<MediaCandidate, "id" | "createdAt" | "expiresAt">
export type MediaCandidateFilter = "all" | "recommended" | MediaCandidateKind
const KEY = "yoinks.media-candidates.v1"
export const MEDIA_CANDIDATE_LIMIT = 50
export const MEDIA_CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000
const SOURCES = new Set<MediaCandidateSource>(["safari", "discover", "manual"])
const KINDS = new Set<MediaCandidateKind>(["hls", "dash", "video", "audio", "page"])
const CAPTURE_SOURCES = new Set<SafariCaptureSource>(["dom", "preload", "metadata", "performance"])
export function normalizeMediaCandidateURL(value: unknown): string | null { if (typeof value !== "string" || /[\r\n]/.test(value)) return null; try { const url = new URL(value); if (url.protocol !== "http:" && url.protocol !== "https:") return null; url.hash = ""; return url.toString() } catch { return null } }
function text(value: unknown, max: number): string | undefined { return typeof value === "string" ? value.replace(/[\r\n\x00-\x1f\x7f]/g, " ").trim().slice(0, max) || undefined : undefined }
function valid(value: unknown, now: number): MediaCandidate | null {
  if (!value || typeof value !== "object") return null
  const x = value as Partial<MediaCandidate>; const url = normalizeMediaCandidateURL(x.url)
  if (!url || !SOURCES.has(x.source as MediaCandidateSource) || typeof x.createdAt !== "number" || typeof x.expiresAt !== "number" || x.expiresAt <= now) return null
  const captureSource = CAPTURE_SOURCES.has(x.captureSource as SafariCaptureSource) ? x.captureSource as SafariCaptureSource : undefined
  return { id: text(x.id, 96) || url, source: x.source as MediaCandidateSource, url, pageURL: normalizeMediaCandidateURL(x.pageURL) || undefined, title: text(x.title, 240), kind: KINDS.has(x.kind as MediaCandidateKind) ? x.kind as MediaCandidateKind : undefined, createdAt: x.createdAt, expiresAt: x.expiresAt, captureSource, qualityHint: text(x.qualityHint, 80), containerHint: text(x.containerHint, 40) }
}
function read(now: number): MediaCandidate[] { const raw = Storage.get<unknown>(KEY); const list = Array.isArray(raw) ? raw.map(x => valid(x, now)).filter((x): x is MediaCandidate => !!x) : []; return list.sort((a,b) => b.createdAt-a.createdAt).slice(0, MEDIA_CANDIDATE_LIMIT) }
export function listMediaCandidates(now = Date.now()): MediaCandidate[] { const next = read(now); Storage.set(KEY, next); return next }
export function rememberMediaCandidate(input: MediaCandidateInput, now = Date.now()): MediaCandidate[] {
  const url = normalizeMediaCandidateURL(input.url); if (!url || !SOURCES.has(input.source)) return listMediaCandidates(now)
  const old = read(now).find(x => x.url === url); const kind = KINDS.has(input.kind as MediaCandidateKind) ? input.kind : old?.kind
  const record: MediaCandidate = { id: old?.id || `candidate-${now}-${Math.random().toString(36).slice(2,8)}`, source: input.source, url, pageURL: normalizeMediaCandidateURL(input.pageURL) || old?.pageURL, title: text(input.title,240) || old?.title, kind, createdAt: now, expiresAt: now + MEDIA_CANDIDATE_TTL_MS, captureSource: CAPTURE_SOURCES.has(input.captureSource as SafariCaptureSource) ? input.captureSource : old?.captureSource, qualityHint: text(input.qualityHint,80) || old?.qualityHint, containerHint: text(input.containerHint,40) || old?.containerHint }
  const next=[record,...read(now).filter(x=>x.url!==url)].slice(0,MEDIA_CANDIDATE_LIMIT); Storage.set(KEY,next); return next
}
export function filterMediaCandidates(candidates: MediaCandidate[], filter: MediaCandidateFilter): MediaCandidate[] { if (filter === "all") return candidates; if (filter === "recommended") return candidates.filter(x => x.source === "safari" && /^推荐/.test(x.qualityHint || "")); return candidates.filter(x => x.kind === filter) }
export function candidateDetailValue(value: string | undefined, safariOnly: boolean): string { return value || (safariOnly ? "未知，导入并分析后可获取" : "不适用") }
export function safariManifestNeedsTitleAlignment(kind: MediaCandidateKind | "inferred" | undefined, title: string | undefined): boolean { return (kind === "hls" || kind === "dash") && Boolean(title) }
export function safariCandidateNeedsTitleAlignment(candidate: Pick<MediaCandidate, "source" | "kind" | "title">): boolean { return candidate.source === "safari" && safariManifestNeedsTitleAlignment(candidate.kind, candidate.title) }
export function clearMediaCandidates(): void { Storage.remove(KEY) }
