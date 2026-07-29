// verify_bilibili_cdn.ts
// Quick static verification for Bilibili CDN URL rewriting.

import { Script } from "scripting"
import {
  BILIBILI_CORS_FREE_HOST,
  BILIBILI_DESKTOP_UA,
  isBilibiliCdnUrl,
  rewriteBilibiliCdnUrl,
} from "./services/player/bilibili-cdn"

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`)
  console.log(`✓ ${message}`)
}

async function runTests() {
  console.log("=== Bilibili CDN 重写验证 ===\n")

  assert(
    BILIBILI_DESKTOP_UA.includes("Chrome/131"),
    "默认 UA 为桌面 Chrome"
  )
  assert(
    BILIBILI_CORS_FREE_HOST === "upos-sz-mirrorhw.bilivideo.com",
    "CORS-free host 为社区 reported 的 hw mirror"
  )

  // upos .m4s URL
  const uposUrl =
    "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/xx/xx/xx-xx.m4s?param=1"
  assert(isBilibiliCdnUrl(uposUrl), "识别 upos bilivideo.com URL")
  assert(
    rewriteBilibiliCdnUrl(uposUrl).startsWith(
      `https://${BILIBILI_CORS_FREE_HOST}/upgcxcode/`
    ),
    "upos URL host 被重写为 hw mirror"
  )

  // mcdn URL with non-standard port
  const mcdnUrl =
    "https://xy123x456x78x123xy.mcdn.bilivideo.cn:4483/upgcxcode/yy/yy/yy-yy.m4s?deadline=123&gen=playurl&os=mcdn&oi=0&trid=xxx&platform=pc&upsig=yyy"
  assert(isBilibiliCdnUrl(mcdnUrl), "识别 mcdn bilivideo.cn URL")
  const rewritten = rewriteBilibiliCdnUrl(mcdnUrl)
  assert(
    rewritten.startsWith(`https://${BILIBILI_CORS_FREE_HOST}/upgcxcode/`),
    "mcdn URL host 被重写并去掉非标准端口"
  )
  assert(!rewritten.includes(":4483"), "非标准端口被移除")
  assert(rewritten.includes("deadline="), "查询参数被保留")

  // Non-Bilibili URL unchanged
  const other = "https://example.com/video.mp4"
  assert(!isBilibiliCdnUrl(other), "非 Bilibili URL 不被识别")
  assert(rewriteBilibiliCdnUrl(other) === other, "非 Bilibili URL 保持不变")

  // Empty/malformed unchanged
  assert(rewriteBilibiliCdnUrl("") === "", "空 URL 保持不变")
  assert(rewriteBilibiliCdnUrl("not-a-url") === "not-a-url", "非法 URL 保持不变")

  console.log("\n=== 所有验证通过 ===")
}

runTests()
  .then(() => Script.exit({ ok: true }))
  .catch(error => {
    console.error("验证失败:", error)
    Script.exit({ ok: false, error: error instanceof Error ? error.message : String(error) })
  })
