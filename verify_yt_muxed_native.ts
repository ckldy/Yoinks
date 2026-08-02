import { Script } from "scripting"
import { downloadMedia, probeMedia } from "./services/media"

async function main() {
  const url = "https://youtu.be/X_JkN6bnCwU?is=Me8CMd2l2OU_qvDs"
  const probe = await probeMedia(url)
  const muxed = probe.choices.find((c) => c.formatExpression === "18" && !c.mergeAudioFormat)
  if (!muxed) throw new Error("无 18 muxed 格式")
  console.log("选择:", muxed.label, "→ 应走 native 下载")
  const started = Date.now()
  let peak = 0
  const result = await downloadMedia({
    url,
    choice: muxed,
    concurrentFragments: 2,
    onProgress: (p) => {
      if (p.speed) peak = Math.max(peak, p.speed / 1048576)
      if (p.fraction && p.fraction % 0.25 < 0.02) console.log(`进度 ${(p.fraction * 100).toFixed(0)}% · ${p.stage}`)
    },
    onCancelPath: () => {},
  })
  const elapsed = (Date.now() - started) / 1000
  console.log("下载完成:", result.filePath)
  console.log(`大小: ${(result.fileSizeBytes / 1048576).toFixed(1)}MB · 耗时 ${elapsed.toFixed(1)}s · 峰值 ${peak.toFixed(2)} MiB/s`)
  if (!(await FileManager.exists(result.filePath))) throw new Error("输出文件不存在")
  await FileManager.remove(result.filePath)
  console.log("验证文件已清理")
}

main()
  .then(() => Script.exit(0))
  .catch(error => {
    console.error("FAIL:", error instanceof Error ? error.message : String(error))
    Script.exit(1)
  })
