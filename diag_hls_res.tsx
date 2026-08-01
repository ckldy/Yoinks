import { Script } from "scripting"
import { probeMedia } from "./services/media"

// 临时诊断：HLS 单清单 ffprobe 分辨率探测端到端
async function main(): Promise<void> {
  const m3u8 = "https://r4x.cdn77.shop/178554147553998/index.m3u8"
  const page = "https://xmoviesforyou.com/cuckhunter-carly-kiss-sucks-big-black-cock-while-husband-watches"
  const s = Date.now()
  try {
    const probe = await probeMedia(m3u8, { referer: page, safariMediaKind: "video" })
    console.log(`[hls] ${Date.now() - s}ms choices=${probe.choices.length}`)
    for (const c of probe.choices) console.log(`  ${c.id} | ${c.label} | height=${c.height || "?"} | fmt=${c.formatExpression}`)
  } catch (error) {
    console.log(`[hls] ${Date.now() - s}ms ERROR ${String(error)}`)
  }
  Script.exit({ done: true })
}

void main()
