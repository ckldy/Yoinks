import { Script, fetch } from "scripting"
import { probeMedia } from "./services/media"

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
const REFERER = "https://www.bilibili.com/"

async function readN(resp: any, n: number): Promise<number> {
  const reader = resp.body.getReader()
  let received = 0
  try {
    while (received < n) {
      const { done, value } = await reader.read()
      if (done) break
      received += value?.byteLength || 0
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return received
}

async function main() {
  const url = "https://b23.tv/kPEW5is"
  const probe = await probeMedia(url)
  // 找最高清晰度 durl direct choice
  const biliChoices = probe.choices.filter((c) => c.id.startsWith("bilibili-direct"))
  if (!biliChoices.length) throw new Error(`无 B站 direct choice: ${probe.choices.map((c) => c.id).join(",")}`)
  const top = biliChoices.sort((a, b) => (b.height || 0) - (a.height || 0))[0]
  const streamURL = top.sourceURL || top.previewURL
  if (!streamURL) throw new Error("无流 URL")
  console.log(`测速目标: ${top.label} (${top.id}) size=${top.estimatedBytes}`)
  const headers = { "User-Agent": UA, Referer: REFERER }

  // 1) 完整 GET 前 8MB 测速
  try {
    const started = Date.now()
    const resp = await fetch(streamURL, { headers })
    console.log("完整 GET status:", resp.status, "content-type:", resp.headers.get("content-type"), "content-length:", resp.headers.get("content-length"))
    const received = await readN(resp, 8 * 1024 * 1024)
    const elapsed = (Date.now() - started) / 1000
    console.log(`完整 GET 前 8MB: ${(received / 1048576).toFixed(1)}MB / ${elapsed.toFixed(1)}s = ${(received / 1048576 / elapsed).toFixed(2)} MiB/s`)
  } catch (e) {
    console.log("完整 GET 失败:", e instanceof Error ? e.message : String(e))
  }

  // 2) Range 支持 + 1MB 小分片稳定性（×4）
  let smallOk = 0
  const smallStarted = Date.now()
  for (let i = 0; i < 4; i += 1) {
    const start = i * 1024 * 1024
    try {
      const resp = await fetch(streamURL, { headers: { ...headers, Range: `bytes=${start}-${start + 1048575}` } })
      if (resp.status !== 206) {
        console.log(`小分片 ${i}: status ${resp.status}`)
        continue
      }
      const received = await readN(resp, 1024 * 1024)
      smallOk += 1
      console.log(`小分片 ${i}: 1MB 成功 (${received} bytes)`)
    } catch (e) {
      console.log(`小分片 ${i}: 中断 - ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const smallElapsed = (Date.now() - smallStarted) / 1000
  console.log(`小分片(1MB×4串行): ${smallOk}/4 成功, ${smallElapsed.toFixed(1)}s ≈ ${(smallOk * 4 / smallElapsed).toFixed(2)} MiB/s`)

  // 3) 并发 2/4 连接 × 1MB
  for (const n of [2, 4]) {
    try {
      const started = Date.now()
      const chunk = 1024 * 1024
      const tasks = Array.from({ length: n }, (_, i) => (async () => {
        const start = (4 + i) * chunk
        const resp = await fetch(streamURL, { headers: { ...headers, Range: `bytes=${start}-${start + chunk - 1}` } })
        if (resp.status !== 206) return 0
        return readN(resp, chunk)
      })())
      const results = await Promise.all(tasks)
      const total = results.reduce((a, b) => a + b, 0)
      const elapsed = (Date.now() - started) / 1000
      console.log(`${n} 连接并发 1MB: ${(total / 1048576).toFixed(2)}MB / ${elapsed.toFixed(1)}s = ${(total / 1048576 / elapsed).toFixed(2)} MiB/s`)
    } catch (e) {
      console.log(`${n} 连接并发失败:`, e instanceof Error ? e.message : String(e))
    }
  }

  Script.exit(0)
}

main().catch(e => { console.error("FAIL:", e); Script.exit(1) })
