import { Script } from "scripting"
import { compactMessage, directMediaChoice, hlsMediaChoice, isCloudflareAntiBotFailure, isRemoteHlsManifestDisconnect, isSafariHlsDirectFallbackFailure } from "./services/media"

const checks: Array<[string, boolean]> = [
  ["recognizes signed MP4 direct media", directMediaChoice("https://cdn.example/video.mp4?token=secret")?.formatExpression === "direct"],
  ["classifies MP4 as video", directMediaChoice("https://cdn.example/video.mp4")?.kind === "video"],
  ["classifies M4A as audio", directMediaChoice("https://cdn.example/audio.m4a?signature=needed")?.kind === "audio"],
  ["rejects webpage URLs", directMediaChoice("https://example.com/watch?id=1") === null],
  ["accepts Safari-known video without extension", directMediaChoice("https://fast-stream.example/p/opaque-resource", "video")?.container === "mp4"],
  ["does not treat domain suffix as media extension", directMediaChoice("https://fast-stream.jav.si/p/opaque-resource", "video")?.container === "mp4"],
  ["direct media has preview URL", directMediaChoice("https://fast-stream.example/p/opaque-resource", "video")?.previewURL === "https://fast-stream.example/p/opaque-resource"],
  ["labels public player MP4 with height", directMediaChoice("https://s39.bigcdn.cc/pubs/6a6d7d3990ceb4.17944547/1080.mp4")?.label === "原始视频 · 容器·MP4 · 1080p"],
  ["parses public player height from filename", directMediaChoice("https://s39.bigcdn.cc/pubs/6a6d7d3990ceb4.17944547/1080.mp4")?.height === 1080],
  ["does not mistake hash digits for height", directMediaChoice("https://s15.bigcdn.cc/pubs/6a6d76cd9f3894.42280952/360.mp4")?.height === 360],
  ["accepts Safari-known audio without extension", directMediaChoice("https://audio.example/p/opaque-resource", "audio")?.container === "m4a"],
  ["rejects HLS manifests", directMediaChoice("https://cdn.example/master.m3u8?token=needed") === null],
  ["creates HLS direct fallback choice", hlsMediaChoice("https://cdn.example/master.m3u8?token=needed")?.formatExpression === "m3u8"],
  ["does not create HLS choice for a webpage", hlsMediaChoice("https://cdn.example/watch?id=1") === null],
  ["recognizes yt-dlp Cloudflare anti-bot failure", isCloudflareAntiBotFailure("ERROR: [generic] Got HTTP Error 403 caused by Cloudflare anti-bot challenge")],
  ["does not misclassify ordinary 403", !isCloudflareAntiBotFailure("HTTP Error 403: Forbidden")],
  ["recognizes HLS manifest remote disconnect", isRemoteHlsManifestDisconnect("ERROR: [generic] hls: Unable to download webpage: Remote end closed connection without response")],
  ["does not treat generic disconnect as HLS manifest disconnect", !isRemoteHlsManifestDisconnect("ERROR: [download] Remote end closed connection without response")],
  ["uses Safari HLS fallback for remote manifest disconnect", isSafariHlsDirectFallbackFailure("Failed to download m3u8 information: Remote end closed connection without response")],
  ["labels manifest-stage disconnect accurately", compactMessage("Unable to download webpage: Remote end closed connection without response") === "读取 HLS 清单时远端 CDN 连接中断，请稍后重试。"],
]
const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Direct media checks failed: ${failed.join(", ")}`)
console.log(`Direct media checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
