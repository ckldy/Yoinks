// verify_douyin_dual_stream.ts — 验证 probeDouyinDirect 健康检查：每个 choice 的 previewURL 无 Referer 可直链（muxed 音视频同载）
import { Script, fetch } from "scripting"
import { probeMedia } from "./services/media"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(() => resolve(), ms))

async function main() {
  const sourceURL = "https://www.douyin.com/video/7674423673071296878"
  let probe: Awaited<ReturnType<typeof probeMedia>> | null = null
  for (let attempt = 0; attempt < 3 && !probe; attempt += 1) {
    console.log(`attempt ${attempt + 1}`)
    try {
      probe = await probeMedia(sourceURL)
    } catch (e) {
      console.log(`probe error: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!probe) await sleep(2000)
  }
  if (!probe) { console.log("NO PROBE"); Script.exit("failed"); return }

  console.log(`title: ${probe.title}`)
  console.log(`choices: ${probe.choices.length}`)
  // 检查每个 choice 的 previewURL 是否无 Referer 200（模拟 direct 播放请求）
  let ok = 0, blocked = 0
  for (const choice of probe.choices) {
    const url = choice.previewURL || ""
    if (!url) { blocked += 1; continue }
    try {
      const r = await fetch(url, { method: "GET", timeout: 8, headers: { Range: "bytes=0-1023" } })
      const type = (r.headers.get("content-type") || "").toLowerCase()
      const playable = (r.status === 200 || r.status === 206) && (type.includes("video") || type.includes("octet-stream") || type.includes("mp4"))
      if (playable) ok += 1
      else {
        blocked += 1
        console.log(`  BLOCKED [${choice.label}] status=${r.status} type=${type} host=${url.split("/")[2]}`)
      }
    } catch (e) {
      blocked += 1
      console.log(`  BLOCKED [${choice.label}] err host=${url.split("/")[2]}`)
    }
  }
  console.log(`preview health: ok=${ok} blocked=${blocked} total=${probe.choices.length}`)
  if (probe.choices.length > 0 && blocked === 0) {
    Script.exit("ok")
  } else {
    Script.exit("failed")
  }
}

main().catch((e) => {
  console.log(`error: ${e instanceof Error ? e.message : String(e)}`)
  Script.exit("failed")
})
