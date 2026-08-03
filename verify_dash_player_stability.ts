// verify_dash_player_stability.ts — DASH 播放器稳定性修复验证（2026-08-03）
// 断言：
// 1. 模板 JS 语法合法（占位符替换后 new Function 检查）
// 2. 探测 Range 可扩大（dash.init.expand + 16MB）
// 3. 403 纳入重试（/\\b403\\b/）
// 4. audio 失败降级仅视频静音（dash.init.audio-muted-fallback + audioOk 分支）
// 5. dash.js CDN 兜底（loadFallbackDashJs + unpkg + pendingStart + 4s 超时）
// 6. duration 兜底（effectiveDuration）
// 7. buildMpd 支持无 audio（MPD 省略 audio AdaptationSet）
import { createDashPlayer } from "./services/player/dash-player-service"
import { createPlayer } from "./services/player/hls-player-service"
import { Script } from "scripting"

let passed = 0
let failed = 0

function check(name: string, condition: boolean, extra?: string) {
  if (condition) {
    passed++
    console.log(`PASS: ${name}`)
  } else {
    failed++
    console.log(`FAIL: ${name}${extra ? " — " + extra : ""}`)
  }
}

const service = createDashPlayer({})
const html = service.getHtmlForTesting()

// 提取主脚本（最后一个 <script> 块）
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
check("模板含主脚本块", scripts.length >= 1)
const mainScript = scripts.length ? scripts[scripts.length - 1][1] : ""
const js = mainScript
  .replace(/\{\{DASH_JS_URL\}\}/g, "https://example.com/dash.all.min.js")
  .replace(/\{\{DASH_CONFIG\}\}/g, "{}")
  .replace(/\{\{PLAYS_INLINE\}\}/g, "")
  .replace(/\{\{MUTED\}\}/g, "")
  .replace(/\{\{AUTOPLAY\}\}/g, "")

// 1. 模板 JS 语法
let syntaxOk = false
try {
  // eslint-disable-next-line no-new-func
  new Function(js)
  syntaxOk = true
} catch (error) {
  console.log(`  syntax error: ${error instanceof Error ? error.message : String(error)}`)
}
check("模板 JS 语法合法", syntaxOk)

// 2. 探测 Range 扩大
check("探测截断时扩大 Range (dash.init.expand)", js.includes("dash.init.expand"))
check("扩大探测上限 16MB", js.includes("16 * 1024 * 1024"))
check("探测上限参数化 (maxBytes)", js.includes("maxBytes"))

// 3. 403 重试
check("403 纳入可恢复重试", /\\\\b403\\\\b|\\b403\\b/.test(js))
check("Network error 仍重试", js.includes("/Network error/i"))

// 4. audio 降级
check("video/audio 独立探测", js.includes("videoProbe") && js.includes("audioProbe"))
check("audio 失败降级仅视频 (audio-muted-fallback)", js.includes("dash.init.audio-muted-fallback"))
check("降级时静音", js.includes("video.muted = true"))

// 5. CDN 兜底
check("jsdelivr 加载失败触发 fallback (onerror)", html.includes("onerror=\"loadFallbackDashJs()\""))
check("unpkg fallback", js.includes("unpkg.com/dashjs"))
check("pendingStart 等待机制", js.includes("pendingStart"))
check("主 CDN 4s 超时兜底", js.includes("4000"))

// 6. duration 兜底
check("duration 非法时 1h 兜底 (effectiveDuration)", js.includes("effectiveDuration") && js.includes("3600"))

// 7. buildMpd 无 audio 支持
check("MPD 音频轨可省略", js.includes("if (audioUrl && audioRanges)"))

// 8. 自绘控制条（MSE 播放替代 iOS 原生 controls——原生对 MSE 流会闪烁/调不出）
check("DASH 自绘控制条 (enableCustomControls)", js.includes("enableCustomControls"))
check("DASH 点击层 tapLayer", js.includes("tapLayer"))
check("DASH MSE 模式移除原生 controls", js.includes("video.removeAttribute('controls')"))
check("DASH 进度条 seek 支持", js.includes("seekFromEvent"))

const hlsService = createPlayer({})
const hlsHtml = (hlsService as any).getHtmlForTesting ? (hlsService as any).getHtmlForTesting() : ""
const hlsScripts = [...hlsHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
const hlsJs = hlsScripts.length ? hlsScripts[hlsScripts.length - 1][1] : ""
check("HLS 模板含自绘控制条 (enableCustomControls)", hlsJs.includes("enableCustomControls"))
check("HLS 模板含 tapLayer/bar", hlsJs.includes("tapLayer") && hlsHtml.includes("id=\"bar\""))
check("HLS 模板移除原生 controls", hlsJs.includes("video.removeAttribute('controls')"))
let hlsSyntaxOk = false
try {
  // eslint-disable-next-line no-new-func
  new Function(hlsJs)
  hlsSyntaxOk = true
} catch (error) {
  console.log(`  HLS syntax error: ${error instanceof Error ? error.message : String(error)}`)
}
check("HLS 模板 JS 语法合法", hlsSyntaxOk)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed === 0) {
  Script.exit(0)
} else {
  Script.exit(1)
}
