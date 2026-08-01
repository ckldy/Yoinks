import { Script } from "scripting"

// 锁定通用清晰度补全流程（2026-08-01）：
// probeMedia 外层统一 enrich：对无 height 的 direct 视频 choice 依次尝试
// 页面 metadata（og:video:height / resolution 文本 / WxH）→ MP4 moov 文件本体解析。
// 这样所有直链（普通 MP4、.vid 302 直链、公开播放器抽取）都能尽量拿到清晰度，不再逐站打补丁。

const root = Script.directory
const media = FileManager.readAsStringSync(`${root}/services/media.ts`)

const checks: Array<[string, boolean]> = [
  // MP4 moov 解析（通用核心）
  ["media sniffs MP4 resolution from file head", media.includes("async function sniffMp4Resolution") && media.includes("fetchRangeBytes")],
  ["media finds top-level moov (FastStart)", media.includes("function findTopLevelMoov") && media.includes("boxTypeOf(buf, offset + 4) === \"moov\"")],
  ["media finds moov in tail slices (non-FastStart)", media.includes("function findMoovBoxAnywhere")],
  ["media reads visual sample entry width/height at +32/+34", media.includes("readU16BE(buf, i + 32)") && media.includes("readU16BE(buf, i + 34)")],
  ["media fetches full moov when it exceeds the 64KB head", media.includes("moov 超出 64KB") && media.includes("headMoov + moovSize - 1")],
  ["media sniffs both common video codec entries", media.includes("\"avc1\", \"hvc1\", \"hev1\", \"av01\", \"vp09\", \"mp4v\"")],
  // 页面 metadata 扩展
  ["page hint prefers og:video:height / itemprop / WxH", media.includes("og:video:height") && media.includes("itemprop=[\"'](?:width|height)") && media.includes("(\\d{3,4})[x×](\\d{3,4})")],
  // 统一 enrich 入口
  ["probeMedia wraps core with resolution enrichment", media.includes("export async function probeMedia") && media.includes("async function probeMediaCore") && media.includes("enrichProbeResolutions(probe, url, options)")],
  ["enrich only touches video choices without height", media.includes("choice.kind !== \"video\" || choice.height") && media.includes("choice.formatExpression === \"direct\"") && media.includes("choice.formatExpression === \"m3u8\"")],
  ["enrich tries page hint then mp4 sniff", media.includes("pageHint = await fetchPageResolutionHint(referer)") && media.includes("await sniffMp4Resolution(target, referer, userAgent)")],
  // HLS 单清单：TS 分片 H.264 SPS 解析（主）+ ffprobe（兜底）
  ["enrich probes HLS media playlist resolution", media.includes("probeHlsTsResolution") && media.includes("choice.formatExpression === \"m3u8\"") && media.includes("source = \"hls-sps\"") && media.includes("probeHlsResolutionWithFfprobe")],
  ["HLS SPS parser reads real width/height", media.includes("class H264BitReader") && media.includes("function parseH264Sps") && media.includes("function findH264Sps") && media.includes("picWidthInMbs")],
  ["HLS label carries height", media.includes("`HLS 原始清单 · ${height}p`")],
  ["enrich updates label with height", media.includes("choice.label = `原始视频 · 容器·") && media.includes("· ${height}p`")],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Resolution enrichment checks failed: ${failed.join(", ")}`)
console.log(`Resolution enrichment checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
