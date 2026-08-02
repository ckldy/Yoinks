import { Script } from "scripting"
import { downloadMedia, probeMedia } from "./services/media"

async function main() {
  const url = "https://b23.tv/kPEW5is"
  const probe = await probeMedia(url)
  const choice = probe.choices.find((c) => c.height === 360) || probe.choices[probe.choices.length - 1]
  if (!choice) throw new Error("无格式")
  console.log("选择:", choice.label)
  const result = await downloadMedia({
    url,
    choice,
    concurrentFragments: 2,
    onProgress: (p) => console.log(`进度 ${(p.fraction * 100).toFixed(0)}% · ${p.stage}`),
    onCancelPath: () => {},
  })
  console.log("下载完成:", result.filePath)
  console.log("大小:", result.fileSizeBytes, "bytes")
  if (!(await FileManager.exists(result.filePath))) throw new Error("输出文件不存在")
}

main()
  .then(() => Script.exit(0))
  .catch(error => {
    console.error("FAIL:", error instanceof Error ? error.message : String(error))
    Script.exit(1)
  })
