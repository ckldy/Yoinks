// verify_douyin_local_e2e.ts — 本地解析端到端：extractFromWebView(desktop, 真实UA) → buildDownloadCandidates
import { Script } from "scripting"
import { extractFromWebView, buildDownloadCandidates } from "./services/douyin"

async function main() {
  const logs: string[] = []
  const awemeId = "7674423673071296878"
  const started = Date.now()
  const extracted = await extractFromWebView(`https://www.douyin.com/video/${awemeId}`, {
    mode: "desktop",
    onLog: (message) => logs.push(message),
  })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`extractFromWebView: ${elapsed}s`)
  for (const line of logs.slice(-12)) console.log(`  [log] ${line}`)
  if (!extracted) {
    console.log("RESULT: null")
    Script.exit("failed")
    return
  }
  console.log(`pageURL: ${extracted.pageURL}`)
  console.log(`title: ${String(extracted.title).slice(0, 60)}`)
  console.log(`hasDetail: ${Boolean(extracted.apiDetailJSON)}`)
  const candidates = buildDownloadCandidates(extracted, true)
  const bitRate = candidates.filter((c) => c.label.startsWith("inline_bit_rate_"))
  const others = candidates.filter((c) => !c.label.startsWith("inline_bit_rate_"))
  console.log(`candidates: ${candidates.length} (bit_rate=${bitRate.length}, other=${others.length})`)
  for (const c of bitRate.slice(0, 20)) {
    console.log(`  ${c.label} | ${c.url.slice(0, 90)}`)
  }
  for (const c of others.slice(0, 5)) {
    console.log(`  [other] ${c.label} | ${c.url.slice(0, 90)}`)
  }
  Script.exit(bitRate.length >= 2 ? "ok" : "failed")
}

main().catch((e) => {
  console.log(`e2e error: ${e instanceof Error ? e.message : String(e)}`)
  Script.exit("failed")
})
