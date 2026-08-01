import { Script } from "scripting"
import { probeMedia } from "./services/media"

// 端到端验证：porntrex get_file 直链（尾部斜杠重定向端点）经 probeMedia 解析出 CDN 直链。
// 复现 index.tsx analyzeSafariCandidate(directOnly=true) 的调用参数。
// 预期走 media.ts 提前分支（跳过 yt-dlp），秒级返回。
void (async () => {
try {
const sourceURL = "https://www.porntrex.com/get_file/29/60018ab4e263aaa79fdea5c70bb7baf4c139ef8845/3002000/3002115/3002115.mp4/"
const referer = "https://www.porntrex.com/video/3002115/three-bbws-vs-one-dick"

const startedAt = Date.now()
const probe = await probeMedia(sourceURL, {
  referer,
  safariMediaKind: "video",
  skipPublicPlayerFallback: true,
})
const elapsed = Date.now() - startedAt

const checks: Array<[string, boolean]> = [
  ["probe returned choices", probe.choices.length > 0],
  ["choice is a direct media choice", probe.choices.some(c => c.formatExpression === "direct")],
  ["choice resolved to CDN direct URL", probe.choices.some(c => /cloudswitches\.com|\.mp4(?:\?|$)/i.test(c.sourceURL || c.previewURL || ""))],
  ["choice carries source referer", probe.choices.every(c => !c.sourceReferer || c.sourceReferer === referer)],
  ["returns fast without yt-dlp probe (skip-trailing-slash branch)", elapsed < 30000],
]
const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Porntrex probe end-to-end failed: ${failed.join(", ")}`)
console.log(`Porntrex probe end-to-end passed (${checks.length}) in ${elapsed}ms`)
console.log("choices:", probe.choices.map(c => `${c.label} | ${(c.sourceURL || c.previewURL || "").slice(0, 90)}`).join("\n"))
Script.exit({ passed: checks.length })
} catch (error) {
  console.error("Porntrex probe end-to-end ERROR:", error instanceof Error ? error.message : String(error))
  Script.exit({ passed: 0, error: error instanceof Error ? error.message : String(error) })
}
})()
