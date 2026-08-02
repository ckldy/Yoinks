import { Script, fetch } from "scripting"

const MWEB_UA = "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)"

async function callPlayer(client: { clientName: string; clientVersion: string; [k: string]: unknown }, ua: string, label: string) {
  try {
    const resp = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": ua },
      body: JSON.stringify({
        context: { client: { ...client, hl: "en" } },
        videoId: "X_JkN6bnCwU",
      }),
    })
    const text = await resp.text()
    let d: any = null
    try { d = JSON.parse(text) } catch { console.log(`[${label}] 非 JSON, status=${resp.status} size=${text.length} head=${text.slice(0, 120)}`); return }
    const ps = d.playabilityStatus || {}
    console.log(`[${label}] status=${resp.status} playability=${ps.status} | ${String(ps.reason || "").slice(0, 60)}`)
    const sd = d.streamingData || {}
    const all = [...(sd.formats || []), ...(sd.adaptiveFormats || [])]
    console.log(`  formats=${sd.formats?.length || 0} adaptive=${sd.adaptiveFormats?.length || 0} hls=${Boolean(sd.hlsManifestUrl)}`)
    for (const f of all.slice(0, 4)) {
      const u = f.url || ""
      console.log(`  itag=${f.itag} h=${f.height || "?"} mime=${String(f.mimeType || "").slice(0, 28)} url_len=${u.length} n=${u.includes("n=")} cipher=${Boolean(f.signatureCipher || f.cipher)}`)
    }
    if (sd.hlsManifestUrl) console.log(`  hls_url=${String(sd.hlsManifestUrl).slice(0, 120)}`)
  } catch (e) {
    console.log(`[${label}] 失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function main() {
  await callPlayer({ clientName: "MWEB", clientVersion: "2.20260708.05.00" }, MWEB_UA, "mweb")
  await callPlayer(
    { clientName: "ANDROID_VR", clientVersion: "1.65.10", deviceMake: "Oculus", deviceModel: "Quest 3", androidSdkVersion: 32, osName: "Android", osVersion: "12L" },
    "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
    "android_vr",
  )
  Script.exit(0)
}

main().catch(e => { console.error("FAIL:", e); Script.exit(1) })
