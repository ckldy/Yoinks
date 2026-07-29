import { Script } from "scripting"
import { discoverBilibiliSpace } from "./services/discovery-engines/bilibili-space"

let ok = true

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.log(`FAIL: ${message}`)
    ok = false
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    console.log(`FAIL: ${message}`)
    console.log(`  expected: ${JSON.stringify(expected)}`)
    console.log(`  actual:   ${JSON.stringify(actual)}`)
    ok = false
  }
}

async function expectThrow(fn: () => Promise<unknown>, message: string) {
  try {
    await fn()
    console.log(`FAIL: ${message} (did not throw)`)
    ok = false
  } catch {
    // expected
  }
}

async function main() {
  // 1. 拒绝非 B 站空间链接
  await expectThrow(
    () => discoverBilibiliSpace({ sourceURL: "https://example.com/user/123", maxItems: 5 }),
    "should reject non-bilibili URL",
  )

  // 2. 真实 B 站空间发现（需要网络）
  try {
    const result = await discoverBilibiliSpace({
      sourceURL: "https://space.bilibili.com/520503124/video",
      maxItems: 3,
    })

    assertEqual(result.kind, "author", "result kind should be author")
    assert(result.items.length > 0, "should return at least one video")
    assert(result.items.length <= 3, "should respect maxItems")

    const first = result.items[0]
    assert(first.url.includes("/video/BV"), `first item should have BV URL: ${first.url}`)
    assert(Boolean(first.title && first.title !== "未命名视频"), `first item should have real title: ${first.title}`)
    assert(first.uploader != null, `first item should have uploader: ${first.uploader}`)
    assert(typeof first.duration === "number" && first.duration > 0, `first item should have positive duration: ${first.duration}`)
    assert(first.thumbnail != null, `first item should have thumbnail: ${first.thumbnail}`)

    console.log(`PASS: discovered ${result.items.length} videos from Bilibili space (total ${result.totalAvailable})`)
  } catch (error) {
    console.log(`FAIL: real Bilibili space discovery failed: ${error instanceof Error ? error.message : String(error)}`)
    ok = false
  }

  if (ok) {
    console.log("PASS: bilibili space discovery")
    Script.exit(0)
  } else {
    console.log("FAIL: bilibili space verification")
    Script.exit(1)
  }
}

void main()
