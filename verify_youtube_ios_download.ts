import { Script } from "scripting"
import { probeYouTubeDirect } from "./services/youtube"
import { downloadMedia } from "./services/media"

// 验证 YouTube 原生探测 → 原生合并下载闭环：
// 选最小 H.264 清晰度（native 直链视频轨 + 音频轨 + ffmpeg 合并），
// 文件必须存在且含 video+audio 双流（验证新扩展的 direct 分支合并路径）。

void (async () => {
  const checks: Array<[string, boolean]> = []
  const check = (name: string, ok: boolean) => {
    checks.push([name, ok])
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`)
  }

  // 19s 老视频，最小清晰度最小体积
  const probe = await probeYouTubeDirect("https://www.youtube.com/watch?v=jNQXAC9IVRw")
  check("probe ok", Boolean(probe && probe.choices.length > 0))
  if (!probe) { Script.exit({ passed: 0, total: checks.length }); return }

  // 选 H.264 且高度最低的 DASH 合并档
  const h264 = probe.choices.filter((c) => c.videoCodec === "h264" && c.mergeAudioFormat)
  const target = h264.length ? h264[h264.length - 1] : probe.choices[probe.choices.length - 1]
  console.log("target:", target.label, "| height:", target.height, "| id:", target.id)

  const startedAt = Date.now()
  try {
    const result = await downloadMedia({
      url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      choice: target,
      concurrentFragments: 1,
      outputTitle: "verify-yt-native",
      onProgress: (value) => { if (value.fraction && Math.floor(value.fraction * 20) !== Math.floor((value.fraction || 0) * 20)) console.log(`  ${Math.round((value.fraction || 0) * 100)}% ${value.stage || ""}`) },
      onCancelPath: () => {},
    })
    const elapsed = Date.now() - startedAt
    check("download result file exists", Boolean(result.filePath) && FileManager.existsSync(result.filePath))
    check("download size > 0", result.fileSizeBytes > 0)
    console.log("  file:", result.fileName, "| size:", Math.round(result.fileSizeBytes / 1024), "KB | ms:", elapsed)
    if (FileManager.existsSync(result.filePath)) {
      // 用默认详细度 ffprobe（Stream #... Video:/Audio: 摘要行）验证双流；
      // 此 LGPL build 的 `-v error -show_entries` 会漏报 DASH fMP4 的 AAC 流。
      const { runCommand, quote } = await import("./services/shell-utils")
      const probeRes = await runCommand(`ffprobe -hide_banner -i ${quote(result.filePath)}`, 60)
      const output = String(probeRes.output || "")
      check("merged has video stream", /Stream #.*:\s*Video:/i.test(output))
      check("merged has audio stream", /Stream #.*:\s*Audio:/i.test(output))
      console.log("  stream lines:", (output.match(/Stream #\d+:\d+.*?:\s*Video:|Stream #\d+:\d+.*?:\s*Audio:/g) || []).map((s) => s.trim()).join(" | "))
    }
  } catch (e) {
    console.log("download error:", e instanceof Error ? e.message : String(e))
    check("download result file exists", false)
  }

  Script.exit({ passed: checks.filter(([, ok]) => ok).length, total: checks.length })
})()
