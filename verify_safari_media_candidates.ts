import { Script } from "scripting"
import {
  MAX_SAFARI_MEDIA_CANDIDATES,
  classifySafariMediaURL,
  normalizeSafariCandidateURL,
  sanitizeSafariMediaCandidates,
  safariCandidateQualityHint,
  safariCandidateContainerHint,
  sanitizeSafariMediaCandidateDiagnostic,
  mergeSafariFrameCandidates,
} from "./services/safari-media-candidates"

const pageURL = "https://page.example/watch?session=private#player"
const envelope = sanitizeSafariMediaCandidates({
  version: 1,
  pageURL,
  pageTitle: "Example\nTitle",
  capturedAt: 100,
  candidates: [
    { id: "segment", url: "https://cdn.example/seg-001.ts", kind: "video" },
    { id: "audio", url: "https://cdn.example/audio-a1.m3u8", kind: "hls" },
    { id: "dash", url: "https://cdn.example/manifest.mpd", kind: "dash" },
    { id: "video", url: "https://cdn.example/video.mp4?token=needed#fragment", kind: "video" },
    { id: "master", url: "https://cdn.example/master.m3u8?token=needed", kind: "hls", source: "metadata" },
    { id: "inferred", url: "https://m.892539.xyz/play.php?site_id=20&source_id=206169", kind: "inferred" },
    { id: "bad", url: "blob:https://page.example/id", kind: "video" },
  ],
})

const frameOnly = sanitizeSafariMediaCandidates({ version: 1, pageURL, capturedAt: 100, candidates: [], playerFrameURL: "https://player.example/embed?id=1#fragment" })

const overLimit = sanitizeSafariMediaCandidates({
  version: 1,
  pageURL,
  capturedAt: 100,
  candidates: Array.from({ length: MAX_SAFARI_MEDIA_CANDIDATES + 5 }, (_, index) => ({
    url: `https://cdn.example/video-${index}.mp4`,
    kind: "video",
  })),
})

const diagnostic = sanitizeSafariMediaCandidateDiagnostic({ version: 1, stage: "captured", capturedAt: 100, candidateCount: 3, resourceCount: 12, mediaLikeResourceCount: 4, iframeCount: 1, resourceHostCount: 2, initiators: { video: 3, script: 2, "bad-key!": 99 }, cookie: "forbidden", url: "https://private.example/?token=secret" })
const mergedFrames = mergeSafariFrameCandidates({
  pageURL,
  pageTitle: "Top page",
  capturedAt: 100,
  topLevel: [],
  frames: [
    { sessionId: "capture-1", pageURL: "https://player.example/embed", candidates: [{ url: "https://cdn.example/video.m3u8?token=needed", kind: "hls", source: "performance" }] },
    { sessionId: "capture-1", pageURL: "https://player.example/embed", candidates: [{ url: "https://cdn.example/video.m3u8?token=needed", kind: "hls" }] },
    { sessionId: "stale", pageURL: "https://player.example/embed", candidates: [{ url: "https://cdn.example/ignored.m3u8", kind: "hls" }] },
  ],
  sessionId: "capture-1",
})

const checks: Array<[string, boolean]> = [
  ["keeps an extensionless inferred endpoint as a candidate", Boolean(envelope?.candidates.some(candidate => candidate.id === "inferred" && candidate.kind === "inferred" && candidate.url.includes("play.php?site_id=20")))],
  ["recognizes query-only manifest", classifySafariMediaURL("https://cdn.example/stream?manifest=video") === "inferred"],
  ["rejects unsafe URL protocols", classifySafariMediaURL("data:video/mp4;base64,AA") === null],
  ["removes fragments but keeps signed queries", normalizeSafariCandidateURL("https://cdn.example/video.mp4?token=needed#fragment") === "https://cdn.example/video.mp4?token=needed"],
  ["filters segments even if labeled video", !envelope?.candidates.some(candidate => candidate.id === "segment")],
  ["sorts master HLS first", envelope?.candidates[0]?.id === "master"],
  ["labels master HLS as adaptive recommendation", safariCandidateQualityHint(envelope?.candidates.find(candidate => candidate.id === "master")!) === "推荐 · 自适应最高画质"],
  ["keeps allowlisted capture source", envelope?.candidates.find(candidate => candidate.id === "master")?.captureSource === "metadata"],
  ["labels HLS container without a network request", safariCandidateContainerHint(envelope?.candidates.find(candidate => candidate.id === "master")!) === "HLS"],
  ["labels fixed MP4 with parsed resolution", safariCandidateQualityHint({ id: "240p", kind: "video", url: "https://cdn.example/240P_1000K.mp4", pageURL, discoveredAt: 0 }) === "备用直链 · 240P"],
  ["labels public player MP4 resolution without P suffix", safariCandidateQualityHint({ id: "1080", kind: "video", url: "https://cdn.example/pubs/hash/1080.mp4", pageURL, discoveredAt: 0 }) === "备用直链 · 1080P"],
  ["does not mistake hash digits for resolution", safariCandidateQualityHint({ id: "hash", kind: "video", url: "https://cdn.example/pubs/6a6d7d3990ceb4.17944547/360.mp4", pageURL, discoveredAt: 0 }) === "备用直链 · 360P"],
  ["places audio rendition after video", (envelope?.candidates.findIndex(candidate => candidate.id === "audio") ?? 0) > (envelope?.candidates.findIndex(candidate => candidate.id === "video") ?? 0)],
  ["keeps only safe envelope fields", !!envelope && !JSON.stringify(envelope).match(/cookie|authorization|headers|license|drm/i)],
  ["keeps a public iframe clue when no top-level media exists", frameOnly?.candidates.length === 0 && frameOnly.playerFrameURL === "https://player.example/embed?id=1"],
  ["limits candidates", overLimit?.candidates.length === MAX_SAFARI_MEDIA_CANDIDATES],
  ["keeps only diagnostic count and initiator whitelist", diagnostic?.candidateCount === 3 && diagnostic?.initiators.video === 3 && diagnostic?.initiators.script === 2 && !("bad-key!" in (diagnostic?.initiators || {}))],
  ["drops diagnostic URLs and credential-like fields", !!diagnostic && !JSON.stringify(diagnostic).match(/cookie|authorization|headers|license|drm|private\.example|token/i)],
  ["merges a matching iframe HLS candidate into an empty top-level capture", mergedFrames.candidates.length === 1 && mergedFrames.candidates[0]?.kind === "hls"],
  ["keeps the iframe page as the direct-media Referer source", mergedFrames.candidates[0]?.pageURL === "https://player.example/embed"],
  ["deduplicates matching frame URLs and ignores stale sessions", !mergedFrames.candidates.some(candidate => candidate.url.includes("ignored"))],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Safari candidate checks failed: ${failed.join(", ")}`)
console.log(`Safari candidate checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
