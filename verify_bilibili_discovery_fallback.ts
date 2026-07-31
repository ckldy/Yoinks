import { Script } from "scripting"
import {
  bilibiliMobileFallbackURL,
  isBilibiliDiscovery412,
} from "./services/discovery"

let passed = 0

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`)
  passed += 1
  console.log(`✓ ${message}`)
}

async function main() {
  const desktop = "https://www.bilibili.com/video/BV1dZgX6zEqr?spm_id_from=333.1007"
  assert(
    bilibiliMobileFallbackURL(desktop) === "https://m.bilibili.com/video/BV1dZgX6zEqr?spm_id_from=333.1007",
    "桌面 B站单视频 URL 可转换为同路径 m站 URL",
  )
  assert(
    bilibiliMobileFallbackURL("https://bilibili.com/video/av170001") === "https://m.bilibili.com/video/av170001",
    "裸 B站域名单视频 URL 可转换为 m站 URL",
  )
  assert(bilibiliMobileFallbackURL("https://m.bilibili.com/video/BV1dZgX6zEqr") == null, "m站 URL 不重复回退")
  assert(bilibiliMobileFallbackURL("https://www.bilibili.com/read/cv1") == null, "非视频路径不回退")
  assert(bilibiliMobileFallbackURL("https://space.bilibili.com/1/video") == null, "作者主页不回退")
  assert(isBilibiliDiscovery412("HTTP Error 412: Precondition Failed"), "识别 HTTP 412 错误")
  assert(!isBilibiliDiscovery412("HTTP Error 403: Forbidden"), "不将非 412 错误判为回退条件")
  console.log(`PASS: bilibili 412 fallback behavior (${passed} assertions)`)
}

main()
  .then(() => Script.exit(0))
  .catch(error => {
    console.error(error)
    Script.exit(1)
  })
