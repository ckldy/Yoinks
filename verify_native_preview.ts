// verify_native_preview.ts — 验证 native-preview 模块编译与候选判断
import { Path, Script } from "scripting"
import { isNativePreviewCandidate } from "./services/native-preview"

async function main() {
  const checks: Array<{ name: string; pass: boolean; detail?: string }> = []
  const check = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, detail })

  let source = ""
  try {
    source = FileManager.readAsStringSync(Path.join(Script.directory, "services", "native-preview.tsx"))
  } catch (error) {
    console.log(`read native-preview.tsx FAIL: ${error instanceof Error ? error.message : String(error)}`)
  }
  check("no-startup-timeout", !source.includes("NATIVE_PREVIEW_TIMEOUT_MS") && !source.includes("12 秒内未能开始播放"))
  check("autoplay-on-ready", source.includes("player.onReadyToPlay") && source.includes("player.play()"))
  check("separate-audio-mutes-video", source.includes("player.volume = audioPlayer ? 0 : 1"))
  check("separate-audio-single-start", source.includes("let audioStarted = false") && source.includes("audioPlayer && !audioStarted"))
  check("dispose-after-dismiss", source.includes("presentTask.then") && source.includes("player.dispose()"))
  check("close-dismisses-page", source.includes("title=\"关闭\"") && source.includes("onClose(); dismiss()"))
  check("douyinvod-candidate", isNativePreviewCandidate("https://v11-weba.douyinvod.com/x/y.mp4?a=1"), "v11-weba")
  check("douyinvod-v26", isNativePreviewCandidate("https://v26-web.douyinvod.com/x/y.mp4"), "v26-web")
  check("douyin-www", isNativePreviewCandidate("https://www.douyin.com/aweme/v1/play/?video_id=xx"), "www.douyin.com")
  check("non-douyin", !isNativePreviewCandidate("https://cdn.bilibili.com/x/y.m4s"), "bilibili 不匹配")
  check("non-douyin-youtube", !isNativePreviewCandidate("https://rr2---sn.googlevideo.com/videoplayback"), "youtube 不匹配")
  check("invalid-url", !isNativePreviewCandidate("not-a-url"), "非法 URL 不匹配")

  let failed = 0
  for (const item of checks) {
    console.log(`${item.pass ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`)
    if (!item.pass) failed += 1
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`)
  Script.exit({ passed: checks.length - failed, total: checks.length })
}

main().catch((e) => {
  console.log(`FAIL main: ${e instanceof Error ? e.message : String(e)}`)
  Script.exit({ passed: 0, total: 0 })
})
