import { Script } from "scripting"
import { parseYouTubeVideoID, probeYouTubeDirect } from "./services/youtube"
import { probeMedia } from "./services/media"

// 验证 YouTube IOS client 原生探测：
// 1) parseYouTubeVideoID 各形态
// 2) 真实 probeYouTubeDirect（直链格式 + 高度 + 音频轨）
// 3) probeMedia 集成链路（原生探测命中，不落 yt-dlp）

void (async () => {
const checks: Array<[string, boolean]> = []

function check(name: string, ok: boolean) {
  checks.push([name, ok])
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`)
}

// 1) parse 变体
check("parse watch?v", parseYouTubeVideoID("https://www.youtube.com/watch?v=dQw4w9WgXcQ") === "dQw4w9WgXcQ")
check("parse youtu.be", parseYouTubeVideoID("https://youtu.be/9bZkp7q19f0") === "9bZkp7q19f0")
check("parse shorts", parseYouTubeVideoID("https://www.youtube.com/shorts/jNQXAC9IVRw") === "jNQXAC9IVRw")
check("parse embed", parseYouTubeVideoID("https://www.youtube.com/embed/kJQP7kiw5Fk") === "kJQP7kiw5Fk")
check("parse invalid host", parseYouTubeVideoID("https://example.com/watch?v=abc") === null)
check("parse invalid id", parseYouTubeVideoID("https://youtu.be/ab") === null)

// 2) 真实探测
const startedAt = Date.now()
const probe = await probeYouTubeDirect("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
const elapsed = Date.now() - startedAt
check("probeYouTubeDirect returns probe", Boolean(probe))
if (probe) {
  check("probe title non-empty", probe.title.length > 0)
  check("probe choices > 0", probe.choices.length > 0)
  check("probe has height info", probe.choices.some((c) => (c.height || 0) > 0))
  check("probe has best audio (dash merge)", probe.choices.some((c) => c.mergeAudioFormat && c.previewAudioURL))
  check("probe choices all direct URLs", probe.choices.every((c) => /^https:\/\//.test(c.sourceURL || "")))
  check("probe webpageURL watch", /watch\?v=dQw4w9WgXcQ/.test(probe.webpageURL))
  const top = probe.choices[0]
  console.log("  top choice:", top.label, "| height:", top.height, "| codec:", top.videoCodec, "| container:", top.container)
  console.log("  choices:", probe.choices.length, "| heights:", probe.choices.map((c) => c.height).slice(0, 8).join(","))
}

// 3) probeMedia 集成（youtu.be 短链 → 应命中原生探测，快速返回）
const startedAt2 = Date.now()
let integrated: boolean | null = null
try {
  const viaProbeMedia = await probeMedia("https://youtu.be/dQw4w9WgXcQ")
  integrated = viaProbeMedia.choices.length > 0
  const elapsed2 = Date.now() - startedAt2
  check("probeMedia youtube integration", Boolean(integrated))
  check("probeMedia elapsed < 15s", elapsed2 < 15000)
  console.log("  probeMedia elapsed:", elapsed2, "ms | choices:", viaProbeMedia.choices.length, "| title:", viaProbeMedia.title.slice(0, 40))
} catch (e) {
  check("probeMedia youtube integration", false)
  console.log("  probeMedia error:", e instanceof Error ? e.message : String(e))
}

console.log(`\n原生探测耗时: ${elapsed}ms (直接 probeYouTubeDirect)`)
Script.exit({ passed: checks.filter(([, ok]) => ok).length, total: checks.length })
})()
