import { Script } from "scripting"
import { discover } from "./services/discovery"

let ok = true

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.log(`FAIL: ${message}`)
    ok = false
  }
}

async function main() {
  // 1. b23.tv 普通视频短链 + playlist 应该走 yt-dlp 并返回至少一个视频
  try {
    const result = await discover({
      kind: "playlist",
      sourceURL: "https://b23.tv/pzBhlhf",
      maxItems: 5,
      experimentalEnabled: false,
    })
    assert(result.items.length > 0, "b23 video short link should return at least one item")
    assert(result.items[0].url.includes("/video/BV"), `b23 video result should have BV URL: ${result.items[0].url}`)
    assert(
      Boolean(result.items[0].title && result.items[0].title !== "未命名视频"),
      `b23 video result should have real title: ${result.items[0].title}`,
    )
    assert(result.items[0].uploader != null, `b23 video result should have uploader: ${result.items[0].uploader}`)
    assert(
      typeof result.items[0].duration === "number" && result.items[0].duration > 0,
      `b23 video result should have positive duration: ${result.items[0].duration}`,
    )
    assert(result.items[0].thumbnail != null, `b23 video result should have thumbnail: ${result.items[0].thumbnail}`)
    console.log(`PASS: b23 video short link returned "${result.items[0].title}"`)
  } catch (error) {
    console.log(`FAIL: b23 video short link discovery failed: ${error instanceof Error ? error.message : String(error)}`)
    ok = false
  }

  // 2. 作者主页 + author 应该成功
  try {
    const result = await discover({
      kind: "author",
      sourceURL: "https://space.bilibili.com/520503124/video",
      maxItems: 3,
      experimentalEnabled: false,
    })
    assert(result.kind === "author", "space URL with author kind should return author kind")
    assert(result.items.length > 0, "author homepage should return videos")
    console.log(`PASS: space author returned ${result.items.length} videos`)
  } catch (error) {
    console.log(`FAIL: space author discovery failed: ${error instanceof Error ? error.message : String(error)}`)
    ok = false
  }

  // 3. 作者主页 + playlist 应该也成功（同一条 URL 不应因 kind 不同而失败）
  try {
    const result = await discover({
      kind: "playlist",
      sourceURL: "https://space.bilibili.com/520503124/video",
      maxItems: 3,
      experimentalEnabled: false,
    })
    assert(result.items.length > 0, "space URL with playlist kind should return videos")
    console.log(`PASS: space playlist returned ${result.items.length} videos`)
  } catch (error) {
    console.log(`FAIL: space playlist discovery failed: ${error instanceof Error ? error.message : String(error)}`)
    ok = false
  }

  if (ok) {
    console.log("PASS: bilibili discovery behavior")
    Script.exit(0)
  } else {
    console.log("FAIL: bilibili discovery behavior verification")
    Script.exit(1)
  }
}

void main()
