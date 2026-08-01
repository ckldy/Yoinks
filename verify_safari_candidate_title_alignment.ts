import { Script } from "scripting"
import { safariCandidateNeedsTitleAlignment } from "./services/media-candidates"

const indexSource = FileManager.readAsStringSync(`${Script.directory}/index.tsx`)

const checks: Array<[string, boolean]> = [
  ["aligns titled Safari HLS candidates", safariCandidateNeedsTitleAlignment({ source: "safari", kind: "hls", title: "公开页面标题" })],
  ["aligns titled Safari DASH candidates", safariCandidateNeedsTitleAlignment({ source: "safari", kind: "dash", title: "公开页面标题" })],
  ["does not align untitled Safari manifests", !safariCandidateNeedsTitleAlignment({ source: "safari", kind: "hls" })],
  ["does not align non-Safari records", !safariCandidateNeedsTitleAlignment({ source: "manual", kind: "hls", title: "手动链接" })],
  ["does not override ordinary Safari page records", !safariCandidateNeedsTitleAlignment({ source: "safari", kind: "page", title: "页面标题" })],
  // inferred 直链（如 8xx3 的 play.php）在 analyzeSafariCandidate 直链路径启用标题对齐，
  // 不改变传给探测的媒体类型上下文（safariCandidateMediaKindRef 仍为 null）。
  ["index declares the title-align ref", /const safariCandidateTitleAlignRef = useRef<boolean>\(false\)/.test(indexSource)],
  ["direct paths (hls/dash/inferred) enable title alignment", /safariCandidateTitleAlignRef\.current = !preferPageFormats/.test(indexSource)],
  ["page-probe fallback enables title alignment", /safariCandidateTitleAlignRef\.current = true\n\s*setURL\(candidate\.url\)/.test(indexSource)],
  ["analyzeMedia overrides degraded titles when aligned", /\(safariMediaKind \|\| safariCandidateTitleAlignRef\.current\) && safariCandidateTitleRef\.current/.test(indexSource)],
  ["candidate-library click routes Safari page (inferred) candidates through analyzeSafariCandidate", /if \(safariOnly && candidate\.pageURL && candidate\.kind\) \{ await analyzeSafariCandidate/.test(indexSource)],
  ["manual paste clears the title-align ref", /safariCandidateTitleRef\.current = null\n\s*safariCandidateTitleAlignRef\.current = false/.test(indexSource)],
]
const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Safari title alignment checks failed: ${failed.join(", ")}`)
console.log(`Safari title alignment checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
