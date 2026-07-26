/**
 * Static checks: hard-codec detection, H.264-first auto select,
 * HEVC/AV1/VP9 → MKV merge extension, external-player labels.
 * Run: scripting-ts run verify_hard_codec_choice.ts
 */
import { Script } from "scripting"
import {
  buildChoices,
  formatVideoChoiceLabel,
  isDeviceHardVideoChoice,
  resolveAutomaticChoice,
  type MediaChoice,
} from "./services/media"

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

let passed = 0
function check(name: string, condition: boolean) {
  assert(condition, name)
  passed += 1
  console.log(`ok ${passed}: ${name}`)
}

const av1: MediaChoice = {
  id: "video-1440-400-with-140",
  label: "1440p · AV1 · 外部播放器 · 合并音频 · 容器·MKV",
  kind: "video",
  formatExpression: "400",
  height: 1440,
  videoCodec: "av1",
  mergeAudioFormat: "140",
  mergeExtension: "mkv",
}

const h264: MediaChoice = {
  id: "video-1080-137-with-140",
  label: "1080p · H.264 · 合并音频 · 容器·MP4",
  kind: "video",
  formatExpression: "137",
  height: 1080,
  videoCodec: "h264",
  mergeAudioFormat: "140",
  mergeExtension: "mp4",
}

const audio: MediaChoice = {
  id: "audio-140",
  label: "仅音频 · 容器·M4A",
  kind: "audio",
  formatExpression: "140",
}

check("AV1 choice is hard", isDeviceHardVideoChoice(av1))
check("H.264 choice is not hard", !isDeviceHardVideoChoice(h264))
check("label-only AV1 is hard", isDeviceHardVideoChoice({ label: "1440p · AV1 · 合并音频", videoCodec: undefined as never }))
check("empty is not hard", !isDeviceHardVideoChoice(null))

const choices = [h264, av1, audio]
const recommended = resolveAutomaticChoice(choices, "recommended", "mp4")
check("recommended prefers H.264 first", recommended.choice?.id === h264.id)

const highest = resolveAutomaticChoice([av1, h264, audio], "highest-video", "mp4")
check("highest-video still prefers H.264 over taller AV1", highest.choice?.id === h264.id)

const labeled = formatVideoChoiceLabel({
  height: 1080,
  codecLabel: "H.264",
  hardCodec: false,
  kindText: "合并音频",
  containerExt: "mp4",
  fps: 30,
  estimatedBytes: 12_000_000,
})
check(
  "label puts codec before container wording",
  labeled.startsWith("1080p · H.264 · 合并音频 · 容器·MP4") && labeled.includes("30 fps"),
)

const unknown = formatVideoChoiceLabel({
  height: 720,
  codecLabel: "",
  hardCodec: false,
  kindText: "视频",
  containerExt: "mp4",
})
check("missing codec becomes 编码未知", unknown.includes("编码未知") && unknown.includes("容器·MP4"))

const hardLabel = formatVideoChoiceLabel({
  height: 1440,
  codecLabel: "AV1",
  hardCodec: true,
  kindText: "合并音频",
  containerExt: "mkv",
})
check("hard codec shows external-player + MKV", hardLabel.includes("1440p · AV1 · 外部播放器 · 合并音频 · 容器·MKV"))

// Same height, different codecs → both listed (plus best-of-each bitrate variants collapsed).
const multi = buildChoices([
  { formatId: "137", ext: "mp4", vcodec: "avc1.640028", acodec: "none", height: 1080, fps: 30, tbr: 4000, filesize: 40_000_000 },
  { formatId: "299", ext: "mp4", vcodec: "avc1.64002a", acodec: "none", height: 1080, fps: 60, tbr: 5000, filesize: 50_000_000 },
  { formatId: "399", ext: "mp4", vcodec: "av01.0.08M.08", acodec: "none", height: 1080, fps: 30, tbr: 3000, filesize: 30_000_000 },
  { formatId: "400", ext: "mp4", vcodec: "av01.0.12M.08", acodec: "none", height: 1440, fps: 25, tbr: 6000, filesize: 60_000_000 },
  { formatId: "30077", ext: "mp4", vcodec: "hev1.1.6.L120.90", acodec: "none", height: 1080, fps: 30, tbr: 2800, filesize: 28_000_000 },
  { formatId: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", abr: 128, filesize: 5_000_000 },
] as any)

const videoChoices = multi.filter((item) => item.kind === "video")
const codecs1080 = videoChoices.filter((item) => item.height === 1080).map((item) => item.videoCodec).sort()
check("same height expands H.264 / AV1 / HEVC", codecs1080.join(",") === "av1,h264,hevc")
check(
  "same height keeps one entry per codec family",
  videoChoices.filter((item) => item.height === 1080).length === 3,
)
check(
  "labels include codec names for multi list",
  videoChoices.some((item) => item.label.includes("H.264")) && videoChoices.some((item) => item.label.includes("AV1")),
)
check(
  "default first video remains H.264 not tall AV1",
  multi.find((item) => item.kind === "video")?.videoCodec === "h264",
)

const av1Built = videoChoices.find((item) => item.videoCodec === "av1" && item.height === 1080)
const hevcBuilt = videoChoices.find((item) => item.videoCodec === "hevc" && item.height === 1080)
const h264Built = videoChoices.find((item) => item.videoCodec === "h264" && item.height === 1080)
check("AV1 merge container is MKV", av1Built?.mergeExtension === "mkv" && (av1Built?.label || "").includes("容器·MKV"))
check("HEVC merge container is MKV", hevcBuilt?.mergeExtension === "mkv" && (hevcBuilt?.label || "").includes("容器·MKV"))
check("H.264 merge container stays MP4", h264Built?.mergeExtension === "mp4")
check("hard choices advertise external player", (av1Built?.label || "").includes("外部播放器") && (hevcBuilt?.label || "").includes("外部播放器"))
check("hard labels no longer say iOS可能无画面", !videoChoices.some((item) => item.label.includes("iOS可能无画面")))

console.log(`\nverify_hard_codec_choice: ${passed}/18 passed`)
Script.exit({ passed })
