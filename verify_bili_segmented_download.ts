import { Script } from "scripting"
import { downloadMedia, probeMedia } from "./services/media"

async function main() {
  const url = "https://b23.tv/kPEW5is"
  const probe = await probeMedia(url)
  const top = probe.choices
    .filter((c) => c.id.startsWith("bilibili-direct"))
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0]
  if (!top) throw new Error("无 B站 durl choice")
  console.log("选择:", top.label, `预计 ${top.estimatedBytes ? (top.estimatedBytes / 1048576).toFixed(1) : "?"}MB`)
  const started = Date.now()
  let peak = 0
  let lastPct = -1
  const result = await downloadMedia({
    url,
    choice: top,
    concurrentFragments: 4,
    onProgress: (p) => {
      if (p.speed) peak = Math.max(peak, p.speed / 1048576)
      const pct = Math.round((p.fraction || 0) * 100)
      if (pct >= lastPct + 10) {
        lastPct = pct
        console.log(`进度 ${pct}% · ${p.stage}`)
      }
    },
    onCancelPath: () => {},
  })
  const elapsed = (Date.now() - started) / 1000
  console.log("下载完成:", result.filePath)
  console.log(`大小: ${(result.fileSizeBytes / 1048576).toFixed(1)}MB · 耗时 ${elapsed.toFixed(1)}s · 平均 ${(result.fileSizeBytes / 1048576 / elapsed).toFixed(2)} MiB/s · 峰值 ${peak.toFixed(2)} MiB/s`)
  if (!(await FileManager.exists(result.filePath))) throw new Error("输出文件不存在")
  // 与探测的预计大小对比（允许 ±1% 偏差）
  if (top.estimatedBytes) {
    const ratio = result.fileSizeBytes / top.estimatedBytes
    if (ratio < 0.99 || ratio > 1.01) throw new Error(`大小异常: ${result.fileSizeBytes} vs 预计 ${top.estimatedBytes}`)
  }
  await FileManager.remove(result.filePath)
  console.log("验证文件已清理")
}

main()
  .then(() => Script.exit(0))
  .catch(error => {
    console.error("FAIL:", error instanceof Error ? error.message : String(error))
    Script.exit(1)
  })
