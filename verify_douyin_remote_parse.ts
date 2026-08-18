// verify_douyin_remote_parse.ts — 用 DSH 本地 Camoufox 捕获的真实 detail 响应验证提取逻辑
import { extractDetailQualities } from "./services/douyin-remote"
import { Script } from "scripting"
import fs from "fs"

const RAW = "/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripting-agent/workspace/6ED9B49B-4F31-4EFB-A9BE-AA98FC666578/tmp/mcp_get_network_request_F9D89130-CFF5-42A7-B3B7-C990247D8A63.txt"

function main() {
  const data = fs.readFileSync(RAW, "utf8")
  const idx = data.indexOf('"response_body":')
  if (idx < 0) throw new Error("response_body not found")
  const q = data.indexOf('"', idx + '"response_body":'.length)
  let body = ""
  let i = q + 1
  while (i < data.length) {
    const c = data[i]
    if (c === "\\") { body += data.slice(i, i + 2); i += 2; continue }
    if (c === '"') break
    body += c
    i += 1
  }
  const unescaped = JSON.parse('"' + body + '"')
  const detail = JSON.parse(unescaped)
  const result = extractDetailQualities(detail)
  if (!result) throw new Error("extract returned null")
  console.log("awemeId:", result.awemeId)
  console.log("desc:", result.desc)
  console.log("qualities:", result.qualities.length)
  for (const q of result.qualities) {
    console.log(`  ${q.label} | ${q.width}x${q.height} | ${q.bitrate ? Math.round(q.bitrate / 1000) + "k" : "-"} | ${q.codec} | ${q.format}`)
  }
  const heights = result.qualities.map((x) => x.height ?? 0)
  console.log("max height:", Math.max(...heights))
}

try {
  main()
  Script.exit("VERIFY_OK")
} catch (e) {
  console.error("VERIFY_FAIL:", e instanceof Error ? e.message : String(e))
  Script.exit("VERIFY_FAIL")
}
