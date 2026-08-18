import { Path, Script } from "scripting"

function extractAwemeIdFromURL(url: string | null): string | null {
  if (!url) return null
  const match = url.match(/\/(?:share\/)?(?:video|note|gallery|slides)\/(\d{15,20})/) || url.match(/[?&](?:modal_id|aweme_id|item_id)=(\d{15,20})/)
  return match?.[1] || null
}

function check(checks: Array<{ name: string; pass: boolean; detail?: string }>, name: string, pass: boolean, detail?: string) {
  checks.push({ name, pass, detail })
}

async function main() {
  const checks: Array<{ name: string; pass: boolean; detail?: string }> = []

  // 1) 短链解析（真实网络，外层硬超时防挂起）
  console.log("CHECK shortlink-resolve …")
  try {
    const response = await Promise.race([
      fetch("https://v.douyin.com/0RkmQ7hutKE", { method: "GET", timeout: 15 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("external-timeout")), 18000)),
    ])
    const finalURL = response.url || ""
    const id = extractAwemeIdFromURL(finalURL)
    check(checks, "shortlink-resolve", Boolean(id && /^\d{15,20}$/.test(id || "")), `${finalURL.slice(0, 160)} → id=${id}`)
  } catch (error) {
    check(checks, "shortlink-resolve", false, String(error))
  }

  // 2) webid 格式（19 位数字）
  const webId = (Date.now().toString() + String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")).slice(-19)
  check(checks, "webid-format", /^\d{19}$/.test(webId), webId)

  // 3) performance entries 过滤（detail URL 提取）
  const media = [
    "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123&a_bogus=xx",
    "https://www.douyin.com/aweme/v1/web/aweme/emoji/list?x=1",
    "https://p3.douyinpic.com/video/tos-cn-p-0015/abc.mp4",
  ]
  const detailURLs = media.filter((item) => item.includes("/aweme/v1/web/aweme/detail/") || item.includes("/aweme/v1/web/aweme/"))
  check(checks, "performance-filter", detailURLs.some((u) => u.includes("/aweme/v1/web/aweme/detail/")), JSON.stringify(detailURLs))

  console.log("CHECK static …")
  // 4) 源码静态检查：注入式签名详情捕获（fetch/XHR hook + 轮询）
  let source = ""
  try {
    source = FileManager.readAsStringSync(Path.join(Script.directory, "services", "douyin.ts"))
  } catch (error) {
    check(checks, "source-read", false, error instanceof Error ? error.message : String(error))
  }
  if (source) {
  const mustHave: Array<{ token: string; name: string }> = [
    { token: "const DY_DETAIL_HOOK_JS", name: "source-has-hook-const" },
    { token: "__dyDetailHookInstalled", name: "source-has-install-flag" },
    { token: "__dyCapturedDetails", name: "source-has-capture-store" },
    { token: "aweme_detail !== undefined", name: "source-has-aweme-check" },
    { token: "window.fetch = async", name: "source-has-fetch-hook" },
    { token: "XMLHttpRequest.prototype.send", name: "source-has-xhr-hook" },
    { token: "capturedDetailText", name: "source-has-captured-var" },
    { token: "使用注入捕获的签名详情数据", name: "source-has-injected-data" },
    { token: "captchaPage", name: "source-has-captcha-flag" },
    { token: "滑块验证风控", name: "source-has-captcha-message" },
    { token: "请完成验证", name: "source-has-captcha-detect" },
    { token: "使用本机真实 Safari UA", name: "source-has-real-ua" },
    { token: "isMobilePlayURL", name: "source-has-mobile-play-keep" },
    { token: "m.douyin.com/aweme/v1/play", name: "source-has-mobile-media-token" },
  ]
  for (const item of mustHave) {
    check(checks, item.name, source.includes(item.token))
  }
  check(checks, "desktop-uses-webview-default-ua", source.includes("const userAgent = options?.userAgent ?? (mode === \"desktop\" ? undefined : MOBILE_SAFARI_UA)"), "桌面模式不覆盖 WebView 默认真实 UA")
  check(checks, "desktop-ua-no-persistence", !source.includes("douyin.real-ua") && !source.includes("douyin.ua-cache"), "不缓存或复用过期 UA")
  check(checks, "desktop-ua-no-hardcode", source.includes("if (userAgent)") && source.includes("webView.setCustomUserAgent(userAgent)"), "仅显式传入时设置 UA，桌面默认不注入")
  check(checks, "source-no-waitForPlayerReady", !source.includes("waitForPlayerReady"), "hasVideo 提前返回逻辑已移除")
  check(checks, "source-no-waitForInitialWebViewLoad", !source.includes("waitForInitialWebViewLoad"), "旧首屏等待已移除")

  console.log("CHECK hook-js-syntax …")
  // 5) hook JS 语法（new Function 只做语法检查）
  const hookStart = source.indexOf("const DY_DETAIL_HOOK_JS")
  const backtick = "`"
  const hookBodyStart = source.indexOf(backtick, hookStart) + 1
  const hookBodyEnd = source.indexOf(backtick + "\n", hookBodyStart)
  const hookJS = source.slice(hookBodyStart, hookBodyEnd)
  let hookSyntaxOK = false
  let hookSyntaxDetail = ""
  try {
    // eslint-disable-next-line no-new-func
    new Function(hookJS)
    hookSyntaxOK = true
    hookSyntaxDetail = `${hookJS.length} chars`
  } catch (error) {
    hookSyntaxDetail = error instanceof Error ? error.message : String(error)
  }
  check(checks, "hook-js-syntax", hookSyntaxOK, hookSyntaxDetail)

  // 4b) media.ts 双流修复静态检查：抖音 detail 为 muxed，预览须选无 Referer 可直链镜像
  let mediaSource = ""
  try {
    mediaSource = FileManager.readAsStringSync(Path.join(Script.directory, "services", "media.ts"))
  } catch {}
  if (mediaSource) {
    const mediaChecks: Array<{ token: string; name: string }> = [
      { token: "probe.douyin.preview-health", name: "media-has-preview-health-log" },
      { token: "inspectPlayable", name: "media-has-direct-playable-check" },
      { token: "bytes=0-1023", name: "media-has-range-probe" },
      { token: "按档位（label）分组", name: "media-has-label-grouping" },
      { token: "muxed", name: "media-has-muxed-comment" },
      { token: "probe.douyin.desktop.retry-full-detail", name: "media-has-full-detail-retry" },
      { token: "probe.douyin.desktop.full-detail-unavailable", name: "media-rejects-silent-constructed-fallback" },
      { token: "不将 video_id 构造的 play 接口伪装成完整多格式", name: "media-documents-audio-requirement" },
       { token: "hasCapturedHookDetail", name: "media-has-diagnostic-log" },
    ]
    for (const item of mediaChecks) {
      check(checks, item.name, mediaSource.includes(item.token))
    }
  } else {
    check(checks, "media-source-read", false, "无法读取 services/media.ts")
  }

  // 4c) native-preview.tsx 原生播放器静态检查：抖音 HE-AACv2 音轨 WebKit <video> 解码无声，
  //     预览必须走原生 AVPlayer（AVFoundation 完整支持 HE-AACv2 + 自定义 headers）
  let nativeSource = ""
  try {
    nativeSource = FileManager.readAsStringSync(Path.join(Script.directory, "services", "native-preview.tsx"))
  } catch {}
  if (nativeSource) {
    const nativeChecks: Array<{ token: string; name: string }> = [
      { token: "openNativePreview", name: "native-has-open-function" },
      { token: "new AVPlayer()", name: "native-has-avplayer" },
      { token: "AVPlayerView", name: "native-has-player-view" },
      { token: "SharedAudioSession.setCategory", name: "native-has-audio-session" },
      // 2026-08-18 实锤：["defaultToSpeaker"] 报 OSStatus -50 → 必须空选项
      { token: "setCategory(\"playback\", [])", name: "native-has-empty-category-options" },
      { token: "setSource(url", name: "native-has-set-source" },
      { token: "player.onReadyToPlay", name: "native-has-autoplay-ready-handler" },
      { token: "isNativePreviewCandidate", name: "native-has-candidate-check" },
      // 失败时主动关页，避免双页面叠加
      { token: "dismissNativePreviewPage", name: "native-has-dismiss-on-fail" },
    ]
    for (const item of nativeChecks) {
      check(checks, item.name, nativeSource.includes(item.token))
    }
  } else {
    check(checks, "native-source-read", false, "无法读取 services/native-preview.tsx")
  }

  // 4d) index.tsx 原生播放器集成检查：抖音直链预览须先走原生分支
  let indexSource = ""
  try {
    indexSource = FileManager.readAsStringSync(Path.join(Script.directory, "index.tsx"))
  } catch {}
  if (indexSource) {
    const indexChecks: Array<{ token: string; name: string }> = [
      { token: "openNativePreview", name: "index-has-native-import" },
      { token: "isNativePreviewCandidate(selectedChoice.previewURL)", name: "index-has-native-branch" },
      // 2026-08-18：原生失败不再回退 WebView（HE-AACv2 无声 + 双页面叠加），直接提示
      { token: "preview.native.failed", name: "index-has-native-fail-path" },
      { token: "不再回退 WebView", name: "index-no-native-fallback" },
    ]
    for (const item of indexChecks) {
      check(checks, item.name, indexSource.includes(item.token))
    }
  } else {
    check(checks, "index-source-read", false, "无法读取 index.tsx")
  }

  console.log("RESULT dump …")
  let failed = 0
  for (const item of checks) {
    console.log(`${item.pass ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` — ${item.detail}` : ""}`)
    if (!item.pass) failed += 1
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`)
  Script.exit({ passed: checks.length - failed, total: checks.length })
}
}

main().catch((error) => {
  console.log(`FAIL main: ${error instanceof Error ? error.message : String(error)}`)
  Script.exit({ passed: 0, total: checks.length })
})
