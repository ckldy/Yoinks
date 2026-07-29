import { Script } from "scripting"
import { buildChoices } from "./services/media"

// Regression: X/Twitter HLS video-only + separate HLS audio must preview via muxed progressive MP4,
// otherwise WKWebView plays video without sound.
const xFormats = [
  { formatId: "hls-audio-128000-Audio", ext: "mp4", vcodec: "none", acodec: null, height: null, width: null, fps: null, abr: 128, tbr: 128, filesize: null, previewURL: "https://video.twimg.com/amplify_video/2081379239232745472/pl/mp4a/128000/audio.m3u8", previewHeaders: {}, previewReferer: "https://x.com/" },
  { formatId: "http-256", ext: "mp4", vcodec: null, acodec: null, height: 270, width: 360, fps: null, abr: null, tbr: 256, filesize: 6355200, previewURL: "https://video.twimg.com/amplify_video/2081379239232745472/vid/avc1/360x270/progressive.mp4?tag=29", previewHeaders: {}, previewReferer: "https://x.com/" },
  { formatId: "hls-64", ext: "mp4", vcodec: "avc1.4D400D", acodec: "none", height: 270, width: 360, fps: null, abr: 0, tbr: 64.91, filesize: null, previewURL: "https://video.twimg.com/amplify_video/2081379239232745472/pl/avc1/360x270/video.m3u8", previewHeaders: {}, previewReferer: "https://x.com/" },
]

const choices = buildChoices(xFormats as any)
const firstVideo = choices.find((c) => c.kind === "video")
const audioChoices = choices.filter((c) => c.kind === "audio")

let ok = true

if (audioChoices.length === 0) {
  console.log("FAIL: HLS audio-only formats were not recognized as audio choices")
  ok = false
}

if (!firstVideo) {
  console.log("FAIL: no video choice generated")
  ok = false
  Script.exit(1)
  // TypeScript does not know Script.exit terminates the process.
  throw new Error("no video choice")
}

if (!firstVideo.previewURL || firstVideo.previewURL.endsWith(".m3u8")) {
  console.log("FAIL: default video preview is still HLS video-only (silent)")
  console.log("  previewURL:", firstVideo.previewURL)
  ok = false
}

if (firstVideo.mergeAudioFormat !== "hls-audio-128000-Audio") {
  console.log("FAIL: video choice did not pair with HLS audio for download")
  console.log("  mergeAudioFormat:", firstVideo.mergeAudioFormat)
  ok = false
}

if (ok) {
  console.log("PASS: X video default preview uses muxed progressive MP4 with audio paired")
  console.log("  firstVideo.id:", firstVideo.id)
  console.log("  firstVideo.previewURL:", firstVideo.previewURL)
  console.log("  audioChoices:", audioChoices.length)
  Script.exit(0)
} else {
  Script.exit(1)
}
