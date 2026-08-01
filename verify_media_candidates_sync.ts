import { Script } from "scripting"
import {
  listMediaCandidates,
  rememberMediaCandidate,
  clearSafariMediaCandidatesFromLibrary,
} from "./services/media-candidates"
import { readSafariMediaCandidates } from "./services/safari-media-candidates"

// 模拟 index.tsx 挂载同步逻辑的语义：
// 1) Safari envelope.capturedAt 晚于候选库最新 safari 候选 createdAt 时，清掉旧 safari 候选（保留 discover/manual）
// 2) envelope 更早时不清（避免误清用户手动保留的历史候选）
// 3) 同步逻辑不依赖闭包 state（用 listMediaCandidates 读存储）
let passed = 0
const checks: Array<{ name: string; ok: boolean }> = []
function check(name: string, ok: boolean) { checks.push({ name, ok }); if (ok) passed += 1 }

// 预置：discover + manual + 旧 safari 候选
clearSafariMediaCandidatesFromLibrary()
rememberMediaCandidate({ source: "discover", url: "https://discover.example.com/video.mp4", kind: "video" })
rememberMediaCandidate({ source: "manual", url: "https://manual.example.com/video.mp4", kind: "video" })
rememberMediaCandidate({ source: "safari", url: "https://old-safari.example.com/old.mp4", kind: "video" })
const before = listMediaCandidates()
check("候选库预置含 1 条旧 safari 候选", before.some(c => c.source === "safari" && c.url.includes("old-safari")))
check("候选库预置含 discover", before.some(c => c.source === "discover"))
check("候选库预置含 manual", before.some(c => c.source === "manual"))

// 模拟启动同步（与 index.tsx 601-612 行一致）
const latestSafariAt = listMediaCandidates().reduce((max, c) => c.source === "safari" ? Math.max(max, c.createdAt) : max, 0)
// envelope.capturedAt 比 latestSafariAt 新（用户又捕获了新数据未导入）
const newerEnvelopeCapturedAt = Date.now() + 1000
if (newerEnvelopeCapturedAt > latestSafariAt) {
  clearSafariMediaCandidatesFromLibrary()
}
const after = listMediaCandidates()
check("新捕获时清掉旧 safari 候选", !after.some(c => c.source === "safari"))
check("保留 discover", after.some(c => c.source === "discover"))
check("保留 manual", after.some(c => c.source === "manual"))

// 场景 2：envelope 更早（无新捕获）时不清
rememberMediaCandidate({ source: "safari", url: "https://old-safari2.example.com/old2.mp4", kind: "video" })
const staleEnvelopeCapturedAt = Date.now() - 5000
const latestSafariAt2 = listMediaCandidates().reduce((max, c) => c.source === "safari" ? Math.max(max, c.createdAt) : max, 0)
let cleared = false
if (staleEnvelopeCapturedAt > latestSafariAt2) { clearSafariMediaCandidatesFromLibrary(); cleared = true }
check("旧 envelope 不清候选库", !cleared && listMediaCandidates().some(c => c.source === "safari" && c.url.includes("old2")))

// 清理
clearSafariMediaCandidatesFromLibrary()

const failed = checks.filter(c => !c.ok)
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}`)
console.log(`\nMedia-candidates startup sync checks: ${passed}/${checks.length}`)
if (failed.length) {
  console.log("FAILED:", failed.map(f => f.name).join("; "))
  Script.exit({ passed, total: checks.length, failed: failed.map(f => f.name) })
} else {
  Script.exit({ passed, total: checks.length })
}
