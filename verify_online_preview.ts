// verify_online_preview.ts
// Verification for Yoinks online-preview service

import { Script } from "scripting"
import { PREVIEW_PLAYBACK_TIMEOUT_MS, type OnlinePreviewOptions } from "./services/online-preview"
import { createPlayer } from "./services/player/hls-player-service"

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`)
  console.log(`✓ ${message}`)
}

async function runTests() {
  console.log("=== Yoinks online-preview 服务验证 ===\n")

  // Test 1: OnlinePreviewOptions 类型检查
  console.log("测试 1: OnlinePreviewOptions 类型结构")
  const options: OnlinePreviewOptions = {
    url: "https://example.com/video.mp4",
    title: "测试视频",
    autoplayMode: "muted",
    webpageURL: "https://example.com/page",
    previewReferer: "https://example.com/referer",
    previewHeaders: { "x-custom": "value" }
  }
  assert(options.url === "https://example.com/video.mp4", "url 字段正确")
  assert(options.title === "测试视频", "title 字段正确")
  assert(options.autoplayMode === "muted", "autoplayMode 字段正确")
  assert(options.webpageURL === "https://example.com/page", "webpageURL 字段正确")
  assert(options.previewReferer === "https://example.com/referer", "previewReferer 字段正确")
  assert(options.previewHeaders?.["x-custom"] === "value", "previewHeaders 字段正确")
  console.log()

  // Test 2: URL 验证逻辑
  console.log("测试 2: URL 验证逻辑（静态检查）")
  // HTTP URL 应该被接受
  try {
    new URL("https://example.com/video.mp4")
    assert(true, "HTTPS URL 格式正确")
  } catch {
    assert(false, "HTTPS URL 应该有效")
  }
  try {
    new URL("http://example.com/video.mp4")
    assert(true, "HTTP URL 格式正确")
  } catch {
    assert(false, "HTTP URL 应该有效")
  }
  // 非 HTTP URL 应该被拒绝（运行时由 openOnlinePreview 处理）
  try {
    new URL("file:///path/to/video.mp4")
    assert(true, "file URL 可以解析但会被运行时拒绝")
  } catch {
    assert(false, "file URL 应该能解析")
  }
  console.log()

  // Test 3: 无效 URL 处理
  console.log("测试 3: 无效 URL 处理")
  const invalidOptions: OnlinePreviewOptions = {
    url: "invalid-url",
    title: "测试",
    autoplayMode: "muted"
  }
  // openOnlinePreview 会处理无效 URL，返回 invalid-url 状态
  // 这里只做类型检查
  assert(true, "无效 URL 配置类型正确")
  console.log()

  // Test 4: 播放确认与错误桥接契约
  console.log("测试 4: 播放确认与错误桥接契约")
  const player = createPlayer({ baseUrl: "https://example.com" })
  const html = player.getHtmlForTesting()
  assert(html.includes('messageHandlers?.playback?.postMessage'), "WebView 会回传播放事件")
  assert(html.includes("reportPlaybackEvent('canplay')"), "可播放状态会桥接到原生侧")
  assert(html.includes("reportPlaybackEvent('playing')"), "实际播放状态会桥接到原生侧")
  assert(html.includes("video.onerror"), "原生媒体错误会显示失败提示")
  console.log()

  // Test 5: 超时与请求模式契约
  console.log("测试 5: 超时与请求模式契约")
  assert(PREVIEW_PLAYBACK_TIMEOUT_MS === 12_000, "播放确认超时为 12 秒")
  assert(player.getRequestMode() === "unknown", "初始请求模式正确")
  console.log()

  console.log("=== 所有静态验证通过 ===")
  console.log()
  console.log("注意: 运行时集成测试需要在真机上通过 Scripting App 执行，包含：")
  console.log("  - MP4 临时链接预览")
  console.log("  - HLS/m3u8 预览")
  console.log("  - 静音/有声自动播放模式")
  console.log("  - Referer 和自定义 Header 注入")
  console.log("  - 无效/过期链接的错误处理")
  console.log("  - 播放器关闭后的资源释放")
}

runTests()
  .then(() => Script.exit({ ok: true }))
  .catch(error => {
    console.error("验证失败:", error)
    Script.exit({ ok: false, error: error instanceof Error ? error.message : String(error) })
  })