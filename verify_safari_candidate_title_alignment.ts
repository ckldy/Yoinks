import { Script } from "scripting"
import { safariCandidateNeedsTitleAlignment } from "./services/media-candidates"

const checks: Array<[string, boolean]> = [
  ["aligns titled Safari HLS candidates", safariCandidateNeedsTitleAlignment({ source: "safari", kind: "hls", title: "公开页面标题" })],
  ["aligns titled Safari DASH candidates", safariCandidateNeedsTitleAlignment({ source: "safari", kind: "dash", title: "公开页面标题" })],
  ["does not align untitled Safari manifests", !safariCandidateNeedsTitleAlignment({ source: "safari", kind: "hls" })],
  ["does not align non-Safari records", !safariCandidateNeedsTitleAlignment({ source: "manual", kind: "hls", title: "手动链接" })],
  ["does not override ordinary Safari page records", !safariCandidateNeedsTitleAlignment({ source: "safari", kind: "page", title: "页面标题" })],
]
const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Safari title alignment checks failed: ${failed.join(", ")}`)
console.log(`Safari title alignment checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
