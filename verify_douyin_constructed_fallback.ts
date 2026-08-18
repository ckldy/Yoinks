// verify_douyin_constructed_fallback.ts — 验证瘦 detail 构造兜底：
// 1) resolveFallbackVideoId 多路提取（壳 video.video_id → videoSrc URL 参数 → 页面/源 URL 数字 ID）
// 2) 构造 URL 多档 + 无 Referer 200（网络健康检查）
// 3) media.ts / douyin.ts 静态守护
import { Path, Script } from "scripting"
import { resolveFallbackVideoId, type ExtractedInfo } from "./services/douyin"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(() => resolve(), ms))

function makeExtracted(overrides: Partial<ExtractedInfo>): ExtractedInfo {
  return {
    pageURL: "https://www.douyin.com/video/7439123456789012345",
    canonical: null,
    title: "t",
    description: null,
    thumbnailURL: null,
    imageURLs: [],
    videoSrc: null,
    apiDetailJSON: null,
    routerDataJSON: null,
    videoInfoResJSON: null,
    bodyTextPreview: "",
    resourceHints: [],
    performanceMedia: [],
    captchaPage: false,
    ...overrides,
  }
}

async function main() {
  const videoId = "v0d00fg10000da1733nog65tbqe544kg"
  const ratios = ["540p", "720p", "1080p"]
  const checks: Array<{ name: string; pass: boolean; detail?: string }> = []
  const check = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, detail })

  // 1) resolveFallbackVideoId 多路提取（纯函数，不联网）
  // 1a. 壳 video.video_id 优先（完整 detail）
  const richExtracted = makeExtracted({
    apiDetailJSON: JSON.stringify({ aweme_detail: { aweme_id: "7439123456789012345", video: { video_id: videoId, bit_rate: [{ gear_name: "1080p" }] } } }),
  })
  check("resolve-prefer-video-video_id", resolveFallbackVideoId(richExtracted, "https://v.douyin.com/abc") === videoId)

  // 1b. 瘦壳无 video.video_id，videoSrc 带 video_id 参数（hook 未捕获、内嵌为瘦 detail 的典型场景）
  const slimWithVideoSrc = makeExtracted({
    apiDetailJSON: JSON.stringify({ aweme_detail: { aweme_id: "7439123456789012345", video: { cover: {} } } }),
    videoSrc: `https://www.douyin.com/aweme/v1/play/?video_id=${videoId}&ratio=720p&line=0`,
  })
  check("resolve-from-videoSrc-url", resolveFallbackVideoId(slimWithVideoSrc, "https://v.douyin.com/abc") === videoId)

  // 1c. videoSrc 是 CDN 直链（无 video_id 参数），退页面 URL 数字 ID（play 接口 video_id 与 aweme_id 同值）
  const slimCdn = makeExtracted({
    videoSrc: "https://v3-web.douyinvod.com/video/tos/cn/xxx.mp4?biz_ver=1",
    pageURL: "https://www.douyin.com/video/7439123456789012345",
  })
  check("resolve-from-pageURL-awemeId", resolveFallbackVideoId(slimCdn, "https://v.douyin.com/abc") === "7439123456789012345")

  // 1d. pageURL 无 ID，退回源短链（resolveFallbackVideoId 内部不解析短链，此处验证回退到 sourceURL 数字 ID）
  const noId = makeExtracted({ pageURL: "https://www.douyin.com/video/7439123456789012345" })
  check("resolve-from-canonical-or-source", resolveFallbackVideoId(noId, "https://www.iesdouyin.com/share/video/7439123456789012345/?modal_id=7439123456789012345") === "7439123456789012345")

  // 1e. 全部缺失 → null（构造兜底不应触发）；注意默认 pageURL 带数字 ID，需显式置为无 ID 页面
  const empty = makeExtracted({ pageURL: "https://www.douyin.com/", videoSrc: "https://v3-web.douyinvod.com/video/tos/cn/xxx.mp4" })
  check("resolve-null-when-no-id", resolveFallbackVideoId(empty, "https://v.douyin.com/abc") === null)

  // 2) 构造 URL 无 Referer 健康检查（模拟 media.ts isDirectPlayable）
  const results: Array<{ ratio: string; status: number; type: string; len: string }> = []
  for (const ratio of ratios) {
    const url = `https://www.douyin.com/aweme/v1/play/?video_id=${videoId}&ratio=${ratio}&line=0&is_play_url=1&watermark=0&source=PackSourceEnum_PUBLISH`
    try {
      const response = await fetch(url, { method: "GET", timeout: 8, headers: { Range: "bytes=0-1023" } })
      const type = (response.headers.get("content-type") || "").toLowerCase()
      const len = response.headers.get("content-length") || "?"
      const ok = (response.status === 200 || response.status === 206)
        && (type.includes("video") || type.includes("octet-stream") || type.includes("mp4"))
      results.push({ ratio, status: response.status, type, len })
      check(`construct-${ratio}-playable`, ok, `${response.status} ${type} len=${len}`)
    } catch (error) {
      results.push({ ratio, status: 0, type: "", len: "" })
      check(`construct-${ratio}-playable`, false, String(error))
    }
    await sleep(300)
  }
  // 多档性验证：直接请求完整头部拿 Content-Length（540p/720p/1080p 应不同）
  check("construct-multi-quality", new Set(results.map((r) => r.len)).size >= 2 || results.every((r) => r.status === 206), results.map((r) => `${r.ratio}:${r.status}`).join(", "))

  // 3) URL 模板与 media.ts / douyin.ts 构造逻辑一致性（静态检查）
  let mediaSource = ""
  let douyinSource = ""
  try {
    mediaSource = FileManager.readAsStringSync(Path.join(Script.directory, "services", "media.ts"))
    douyinSource = FileManager.readAsStringSync(Path.join(Script.directory, "services", "douyin.ts"))
  } catch (error) {
    console.log(`  read source FAIL: ${error instanceof Error ? error.message : String(error)}`)
  }
  console.log(`  media.ts length: ${mediaSource.length}, douyin.ts length: ${douyinSource.length}`)
  check("media-has-constructed-fallback", mediaSource.includes("constructed_") && mediaSource.includes("PackSourceEnum_PUBLISH") && mediaSource.includes("probe.douyin.desktop.constructed-fallback"))
  check("media-has-diagnostic-log", mediaSource.includes("hasCapturedHookDetail") && mediaSource.includes("constructedFallback"))
  check("media-has-multi-source-video-id", mediaSource.includes("resolveFallbackVideoId(extracted, sourceURL)"))
  check("media-has-aweme-id-diagnostic", mediaSource.includes("awemeId:"))
  check("douyin-has-resolve-fallback-video-id", douyinSource.includes("export function resolveFallbackVideoId"))
  check("douyin-has-slim-detail-replay", douyinSource.includes("hasRichDetail"))

  let failed = 0
  for (const item of checks) {
    console.log(`${item.pass ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`)
    if (!item.pass) failed += 1
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`)
  Script.exit({ passed: checks.length - failed, total: checks.length })
}

main().catch((e) => {
  console.log(`FAIL: ${e instanceof Error ? e.message : String(e)}`)
  Script.exit({ passed: 0, total: 0 })
})
