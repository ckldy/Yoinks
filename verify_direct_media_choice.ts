import { Script } from "scripting"
import { directMediaChoice } from "./services/media"

const checks: Array<[string, boolean]> = [
  ["recognizes signed MP4 direct media", directMediaChoice("https://cdn.example/video.mp4?token=secret")?.formatExpression === "direct"],
  ["classifies MP4 as video", directMediaChoice("https://cdn.example/video.mp4")?.kind === "video"],
  ["classifies M4A as audio", directMediaChoice("https://cdn.example/audio.m4a?signature=needed")?.kind === "audio"],
  ["rejects webpage URLs", directMediaChoice("https://example.com/watch?id=1") === null],
  ["accepts Safari-known video without extension", directMediaChoice("https://fast-stream.example/p/opaque-resource", "video")?.container === "mp4"],
  ["does not treat domain suffix as media extension", directMediaChoice("https://fast-stream.jav.si/p/opaque-resource", "video")?.container === "mp4"],
  ["direct media has preview URL", directMediaChoice("https://fast-stream.example/p/opaque-resource", "video")?.previewURL === "https://fast-stream.example/p/opaque-resource"],
  ["accepts Safari-known audio without extension", directMediaChoice("https://audio.example/p/opaque-resource", "audio")?.container === "m4a"],
  ["rejects HLS manifests", directMediaChoice("https://cdn.example/master.m3u8?token=needed") === null],
]
const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Direct media checks failed: ${failed.join(", ")}`)
console.log(`Direct media checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
