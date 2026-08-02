import { Script } from "scripting"
import { probeMedia } from "./services/media"

async function main() {
  const url = "https://b23.tv/kPEW5is"
  console.log("探测:", url)
  const probe = await probeMedia(url)
  console.log("标题:", probe.title)
  console.log("网页:", probe.webpageURL)
  console.log("格式数:", probe.choices.length)
  for (const c of probe.choices.slice(0, 8)) {
    console.log(" -", c.label, c.formatExpression, c.height ? `${c.height}p` : "")
  }
  if (!probe.choices.length) throw new Error("未解析出任何格式")
}

main()
  .then(() => Script.exit(0))
  .catch(error => {
    console.error("FAIL:", error instanceof Error ? error.message : String(error))
    Script.exit(1)
  })
