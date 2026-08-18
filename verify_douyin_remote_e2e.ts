import { Script } from "scripting"
import { resolveDouyinViaRemote } from "./services/douyin-remote"
import { getPreferences } from "./services/preferences"

// 端到端验证：真实调用远程 Camoufox MCP 解析抖音视频（Token 从本机偏好读取，不硬编码）。
// 用法：scripting-ts run verify_douyin_remote_e2e.ts

async function main() {
  const preferences = getPreferences()
  if (!preferences.douyinRemoteToken) {
    console.log("SKIP: 未配置 douyinRemoteToken（先运行一次设置写入）")
    Script.exit("skipped")
    return
  }
  const started = Date.now()
  const result = await resolveDouyinViaRemote({
    config: { enabled: true, endpoint: preferences.douyinRemoteEndpoint, token: preferences.douyinRemoteToken },
    pageURL: "https://www.douyin.com/video/7674423673071296878",
    log: (message) => console.log(`[remote] ${message}`),
  })
  console.log(`TOTAL: ${((Date.now() - started) / 1000).toFixed(1)}s`)
  if (!result) {
    console.log("RESULT: null（远程解析失败）")
    Script.exit("failed")
    return
  }
  console.log(`RESULT: ${result.qualities.length} 档 — ${result.desc.slice(0, 40)}`)
  for (const q of result.qualities.slice(0, 10)) {
    console.log(`  ${q.codec.padEnd(5)} ${String(q.height ?? 0).padStart(4)}p ${q.format.padEnd(4)} ${q.bitrate ? `${(q.bitrate / 1e6).toFixed(2)}Mbps` : "     "} ${q.url.slice(0, 90)}`)
  }
  Script.exit("done")
}

main().catch((error) => {
  console.log(`main error ${error instanceof Error ? error.message : String(error)}`)
  Script.exit("failed")
})
