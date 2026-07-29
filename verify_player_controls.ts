import { Script } from "scripting"
import { createPlayer } from "./services/player/hls-player-service"
import { createDashPlayer } from "./services/player/dash-player-service"

// Regression: 倍速 + 画质控件注入两个播放器 HTML 模板。
// 断言：倍速 6 档、双流下 audio.playbackRate 被设、画质受 levels 门控、
//       画质含「自动」(level -1)、无模板占位符泄漏。

const hlsHtml = createPlayer({ baseUrl: "https://example.com" }).getHtmlForTesting()
const dashHtml = createDashPlayer({ baseUrl: "https://example.com" }).getHtmlForTesting()

const SPEEDS = ["0.5", "0.75", "1.0", "1.25", "1.5", "2.0"]
let failures = 0

function check(label: string, cond: boolean) {
  if (cond) {
    console.log("PASS: " + label)
  } else {
    console.log("FAIL: " + label)
    failures++
  }
}

// --- HLS 模板 ---
check("HLS 倍速 6 档齐全", SPEEDS.every(s => hlsHtml.includes(s)))
check("HLS 双流倍速同步 audio.playbackRate", hlsHtml.includes("audio.playbackRate = rate"))
check("HLS 画质受 levels>=2 门控", hlsHtml.includes("levels.length >= 2"))
check("HLS 画质含自动档 selectQuality(-1)", hlsHtml.includes("selectQuality(-1)") && hlsHtml.includes("自动"))
check("HLS 画质按钮初始隐藏 display:none", hlsHtml.includes('id="qualityHost" style="display:none"'))
check("HLS 控件阻断触摸冒泡", hlsHtml.includes("['pointerdown', 'touchstart', 'click']") && hlsHtml.includes("controls.addEventListener(type, function(e) { e.stopPropagation(); })"))
check("HLS 菜单忽略控件内点击", hlsHtml.includes("e.target.closest('.ctrl-wrap')"))
check("HLS 无占位符泄漏", !/\{\{[A-Z_]+\}\}/.test(hlsHtml))

// --- DASH 模板 ---
check("DASH 倍速 6 档齐全", SPEEDS.every(s => dashHtml.includes(s)))
check("DASH 无画质控件", !dashHtml.includes("qualityHost"))
check("DASH 控件阻断触摸冒泡", dashHtml.includes("['pointerdown', 'touchstart', 'click']") && dashHtml.includes("controls.addEventListener(type, function(e) { e.stopPropagation(); })"))
check("DASH 菜单忽略控件内点击", dashHtml.includes("e.target.closest('.ctrl-wrap')"))
check("DASH 无占位符泄漏", !/\{\{[A-Z_]+\}\}/.test(dashHtml))

if (failures === 0) {
  console.log("\n全部通过 (13/13)")
  Script.exit(0)
} else {
  console.log("\n失败 " + failures + " 项")
  Script.exit(1)
}
