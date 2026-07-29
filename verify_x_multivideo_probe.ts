/**
 * Static checks for X/Twitter multi-video bare status URL pinning.
 * Run: scripting-ts run verify_x_multivideo_probe.ts
 */
import { Script } from "scripting"
import { pinXStatusVideoURL, buildChoices } from "./services/media"

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

let passed = 0
function check(name: string, condition: boolean) {
  assert(condition, name)
  passed += 1
  console.log(`ok ${passed}: ${name}`)
}

check(
  "bare /i/status pins to /video/1",
  pinXStatusVideoURL("https://x.com/i/status/2081601740965593356") ===
    "https://x.com/i/status/2081601740965593356/video/1",
)

check(
  "bare @user/status pins to /video/1",
  pinXStatusVideoURL("https://x.com/AYi_AInotes/status/2081601740965593356") ===
    "https://x.com/AYi_AInotes/status/2081601740965593356/video/1",
)

check(
  "existing /video/2 kept",
  pinXStatusVideoURL("https://x.com/i/status/2081601740965593356/video/2") ===
    "https://x.com/i/status/2081601740965593356/video/2",
)

check(
  "query string preserved",
  pinXStatusVideoURL("https://x.com/i/status/2081601740965593356?s=61") ===
    "https://x.com/i/status/2081601740965593356/video/1?s=61",
)

check(
  "non-X URL unchanged",
  pinXStatusVideoURL("https://youtu.be/abc") === "https://youtu.be/abc",
)

check(
  "twitter.com host also pinned",
  pinXStatusVideoURL("https://twitter.com/i/status/1") ===
    "https://twitter.com/i/status/1/video/1",
)

// Formats returned by fixed probe for multi-video entry 0 should build choices.
const xFormats = [
  { formatId: "hls-audio-128000-Audio", ext: "mp4", vcodec: "none", acodec: null, height: null, width: null, fps: null, abr: 128, tbr: 128, filesize: null, previewURL: "https://video.twimg.com/amplify_video/1/pl/mp4a/128000/a.m3u8" },
  { formatId: "http-256", ext: "mp4", vcodec: null, acodec: null, height: 270, width: 360, fps: null, abr: null, tbr: 256, filesize: 1000, previewURL: "https://video.twimg.com/amplify_video/1/vid/avc1/360x270/p.mp4" },
  { formatId: "hls-64", ext: "mp4", vcodec: "avc1.4D400D", acodec: "none", height: 270, width: 360, fps: null, abr: 0, tbr: 64, filesize: null, previewURL: "https://video.twimg.com/amplify_video/1/pl/avc1/360x270/v.m3u8" },
]
const choices = buildChoices(xFormats as any)
check("multi-video formats still build choices", choices.some((c) => c.kind === "video") && choices.some((c) => c.kind === "audio"))

console.log(`\nverify_x_multivideo_probe: ${passed}/7 passed`)
Script.exit({ passed })
