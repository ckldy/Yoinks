import { Script, fetch } from "scripting"

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

async function tryProbe(videoId: string, label: string, ua: string, url: string) {
  try {
    const started = Date.now()
    const resp = await fetch(url, { headers: { "User-Agent": ua, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" } })
    const text = await resp.text()
    console.log(`[${label}] status=${resp.status} size=${(text.length / 1024 / 1024).toFixed(2)}MB 耗时=${((Date.now() - started) / 1000).toFixed(1)}s`)
    // 提取 ytInitialPlayerResponse
    const markers = ["ytInitialPlayerResponse"]
    for (const m of markers) {
      const idx = text.indexOf(m)
      if (idx < 0) {
        console.log(`  ${m}: 未找到`)
        continue
      }
      const start = text.indexOf("{", idx)
      let depth = 0
      let quoted = false
      let escaped = false
      let end = -1
      for (let i = start; i < text.length; i += 1) {
        const c = text[i]
        if (quoted) {
          if (escaped) escaped = false
          else if (c === "\\") escaped = true
          else if (c === '"') quoted = false
          continue
        }
        if (c === '"') { quoted = true; continue }
        if (c === "{") depth += 1
        else if (c === "}") { depth -= 1; if (depth === 0) { end = i; break } }
      }
      if (end < 0) { console.log(`  ${m}: 无法定位 JSON`); continue }
      try {
        const parsed = JSON.parse(text.slice(start, end + 1))
        const ps = parsed.playabilityStatus || {}
        console.log(`  playability: ${ps.status} | ${String(ps.reason || "").slice(0, 60)}`)
        const sd = parsed.streamingData || {}
        const all = [...(sd.formats || []), ...(sd.adaptiveFormats || [])]
        console.log(`  streamingData: formats=${sd.formats?.length || 0} adaptive=${sd.adaptiveFormats?.length || 0} hls=${Boolean(sd.hlsManifestUrl)}`)
        if (all.length) {
          let withUrl = 0, urlNoN = 0, withCipher = 0
          for (const f of all.slice(0, 30)) {
            const u = f.url || ""
            if (u) { withUrl += 1; if (!u.includes("n=")) urlNoN += 1 }
            if (f.signatureCipher || f.cipher) withCipher += 1
          }
          console.log(`  前 30: 有url=${withUrl} url无n=${urlNoN} 有cipher=${withCipher}`)
          for (const f of all.slice(0, 3)) {
            const u = f.url || ""
            console.log(`  itag=${f.itag} h=${f.height || "?"} url=${u ? u.slice(0, 100) : "(空)"} cipher=${Boolean(f.signatureCipher || f.cipher)}`)
          }
        } else {
          console.log(`  无流地址`)
        }
      } catch (e) {
        console.log(`  ${m}: JSON 解析失败 ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } catch (e) {
    console.log(`[${label}] 失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function main() {
  const videoId = "X_JkN6bnCwU"
  await tryProbe(videoId, "watch-Chrome", CHROME_UA, `https://www.youtube.com/watch?v=${videoId}`)
  await tryProbe(videoId, "watch-iPhone", IPHONE_UA, `https://www.youtube.com/watch?v=${videoId}`)
  Script.exit(0)
}

main().catch(e => { console.error("FAIL:", e); Script.exit(1) })
