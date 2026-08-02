import { Script } from "scripting"
import { detectMediaPlatform, normalizeBilibiliURL } from "./services/media"
import {
  bilibiliMobileFallbackURL,
  isBilibiliDiscovery412,
  isBilibiliShortLink,
} from "./services/discovery"

let passed = 0

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`)
  passed += 1
  console.log(`✓ ${message}`)
}

async function main() {
  // 方案 B：detectMediaPlatform 识别 B站
  assert(detectMediaPlatform("https://b23.tv/kPEW5is") === "bilibili", "b23.tv 短链识别为 bilibili")
  assert(detectMediaPlatform("https://www.bilibili.com/video/BV1ArNb6iEmJ") === "bilibili", "桌面视频页识别为 bilibili")
  assert(detectMediaPlatform("https://m.bilibili.com/video/BV1ArNb6iEmJ") === "bilibili", "m站视频页识别为 bilibili")
  assert(detectMediaPlatform("https://space.bilibili.com/290548469") === "bilibili", "作者主页识别为 bilibili")
  assert(detectMediaPlatform("https://www.youtube.com/watch?v=x") === "youtube", "YouTube 仍识别为 youtube")
  assert(detectMediaPlatform("https://example.com/video/1") === "generic", "普通站点仍为 generic")

  // 方案 B：normalizeBilibiliURL 剥离 App 分享追踪参数
  const sharedDesktop = "https://www.bilibili.com/video/BV1ArNb6iEmJ?buvid=Y34FF535A4503AE0484B84CDB8F0758119B6&is_story_h5=false&mid=6%2BZUvg%2FRKWyiZFG0SHupkg%3D%3D&p=1&plat_id=114&share_from=ugc&share_medium=ipad&share_plat=ios&share_source=COPY&share_tag=s_i&timestamp=1785619199&unique_k=kPEW5is&up_id=290548469"
  assert(
    normalizeBilibiliURL(sharedDesktop) === "https://www.bilibili.com/video/BV1ArNb6iEmJ?p=1",
    "桌面视频页剥离分享追踪参数并保留 p=1",
  )
  const plain = "https://www.bilibili.com/video/BV1ArNb6iEmJ?spm_id_from=333.1007&vd_source=abc"
  assert(normalizeBilibiliURL(plain) === plain, "无分享追踪参数时 URL 不变")
  assert(normalizeBilibiliURL("https://b23.tv/kPEW5is") === "https://b23.tv/kPEW5is", "b23 短链不误改（探测时网络解析）")
  assert(normalizeBilibiliURL("https://www.youtube.com/watch?v=x") === "https://www.youtube.com/watch?v=x", "非 B站 URL 返回原值")

  // 方案 A：短链识别 + 412 回退联动
  assert(isBilibiliShortLink("https://b23.tv/kPEW5is"), "识别 b23.tv 短链")
  assert(!isBilibiliShortLink("https://www.bilibili.com/video/BV1ArNb6iEmJ"), "完整视频页不是短链")
  assert(isBilibiliDiscovery412("HTTP Error 412: Precondition Failed"), "识别 HTTP 412 错误")
  assert(
    bilibiliMobileFallbackURL("https://www.bilibili.com/video/BV1ArNb6iEmJ?p=1") === "https://m.bilibili.com/video/BV1ArNb6iEmJ?p=1",
    "归一化后的桌面 URL 可转换为 m站 URL（412 回退链路）",
  )

  console.log(`PASS: bilibili probe normalize behavior (${passed} assertions)`)
}

main()
  .then(() => Script.exit(0))
  .catch(error => {
    console.error(error)
    Script.exit(1)
  })
