import { Script } from "scripting"
import { discover, discoveryKindLabel, normalizeDiscoveryURL } from "./services/discovery"
import { normalizeResult } from "./services/discovery-engines/playlist"

let ok = true

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
  // Label mapping
  assertEqual(discoveryKindLabel("playlist"), "播放列表 / 合集 / 频道", "playlist label")
  assertEqual(discoveryKindLabel("author"), "作者主页", "author label")
  assertEqual(discoveryKindLabel("search"),   "关键词搜索", "search label")
  assertEqual(discoveryKindLabel("related"),   "相关推荐", "related label")

  // Invalid URL rejection
  await expectThrow(
    () => discover({ kind: "playlist", sourceURL: "not-a-url", maxItems: 20, experimentalEnabled: false }),
    "discover should reject invalid URL",
  )

  // Experimental features require enabled flag
  await expectThrow(
    () => discover({ kind: "search", query: "test", maxItems: 20, experimentalEnabled: false }),
    "search should require experimental flag",
  )
  await expectThrow(
    () => discover({ kind: "related", sourceURL: "https://example.com/video", maxItems: 20, experimentalEnabled: false }),
    "related should require experimental flag",
  )

  // Experimental enabled: search/related are wired to real engines.
  // Empty query / invalid URL should still be rejected before network call.
  await expectThrow(
    () => discover({ kind: "search", query: "", maxItems: 20, experimentalEnabled: true }),
    "search should reject empty query",
  )
  await expectThrow(
    () => discover({ kind: "related", sourceURL: "not-a-url", maxItems: 20, experimentalEnabled: true }),
    "related should reject invalid URL",
  )

  // URL normalization
  assertEqual(
    normalizeDiscoveryURL("https://www.youtube.com/watch?v=ABC&list=XYZ"),
    "https://www.youtube.com/playlist?list=XYZ",
    "youtube watch+list normalization",
  )
  assertEqual(
    normalizeDiscoveryURL("https://youtu.be/ABC?list=XYZ"),
    "https://www.youtube.com/playlist?list=XYZ",
    "youtu.be share+list normalization",
  )
  assertEqual(
    normalizeDiscoveryURL("https://example.com/playlist"),
    "https://example.com/playlist",
    "non-youtube URL unchanged",
  )

  // Platform detection in playlist normalization
  const mockPayload = {
    ok: true,
    items: [{ id: "1", url: "https://www.youtube.com/watch?v=abc", title: "T", index: 0 }],
  } as Record<string, unknown>
  assertEqual(
    normalizeResult(mockPayload, "playlist", "https://www.youtube.com/playlist?list=XYZ").platform,
    "youtube",
    "youtube playlist platform detection",
  )
  assertEqual(
    normalizeResult(mockPayload, "playlist", "https://www.bilibili.com/video/BV1xx411c7mD").platform,
    "bilibili",
    "bilibili platform detection",
  )
  assertEqual(
    normalizeResult(mockPayload, "playlist", "https://www.tiktok.com/@user/video/123").platform,
    "tiktok",
    "tiktok platform detection",
  )

  if (ok) {
    console.log("PASS: discovery service behavior")
    Script.exit(0)
  } else {
    console.log("FAIL: discovery service verification")
    Script.exit(1)
  }
}

void main()
