import { Script } from "scripting"

// 锁定 sxyprn .vid 捕获修复（2026-08-01）：
// 1) browser.tsx 媒体名单含 .vid、classify 归为 video、bkcdn 预览降权、主媒体未就绪进入监听
// 2) media.ts 对 .vid/无扩展名端点做 302 重定向解析（Range 0-1 + Referer + Safari UA）出直链 choice
// 3) index.tsx .vid 候选直接走 candidate-direct，跳过"页面优先"必然失败

const root = Script.directory
const browser = FileManager.readAsStringSync(`${root}/browser.tsx`)
const media = FileManager.readAsStringSync(`${root}/services/media.ts`)
const index = FileManager.readAsStringSync(`${root}/index.tsx`)

const checks: Array<[string, boolean]> = [
  // browser.tsx：收集与诊断媒体名单加 vid
  ["browser collects .vid in media-like URLs", browser.includes("m3u8|mpd|mp4|m4v|mov|webm|mkv|ts|m4s|vid")],
  ["browser diagnostic counts .vid", browser.includes("m4a|mp3|aac|opus|ogg|wav|vid")],
  ["browser VIDEO_PATTERN includes .vid (classify -> video)", browser.includes("mp4|m4v|mov|webm|mkv|avi|flv|vid")],
  // browser.tsx：主媒体 src 未就绪也进入监听循环（预览候选存在时等正片 .vid）
  ["browser listens when main media src unresolved", browser.includes("if (hasMediaElement() && !mainMediaResolved())")],
  ["browser mainMediaResolved reads currentSrc/src", browser.includes("function mainMediaResolved") && browser.includes("currentSrc || element.src")],
  // media.ts：.vid 重定向解析 helper + 接入 catch 分支
  ["media has isVidURL helper", media.includes("function isVidURL") && media.includes(".vid(?:$|[?#])")],
  ["media resolves redirected .vid to final direct choice", media.includes("async function resolveRedirectedDirectMedia") && media.includes('Range: "bytes=0-1"') && media.includes("choice.sourceURL = finalURL")],
  ["media requires video/audio content-type for redirect resolve", media.includes("/^(?:video|audio)")],
  ["probe catch hooks .vid redirect resolution before public fallback", media.includes("resolveRedirectedDirectMedia") && media.includes("probe.vid.redirect-resolved") && media.includes("const extracted = await tryPublicPlayerFallback")],
  // media.ts：.vid 跳过 HLS sniff（避免无 Range 触发数百 MB 下载拖垮后续）+ 失败直链兜底
  ["media skips HLS sniff for .vid and falls back to source direct", media.includes("if (referer && isVidURL(sourceURL))") && media.includes("probe.vid.direct-fallback") && media.includes("if (referer && !isVidURL(sourceURL))")],
  // media.ts：重定向直链从来源页回填分辨率（sxyprn 页面 resolution:HD 720 → 720p）
  ["media backfills height from page resolution hint", media.includes("async function fetchPageResolutionHint") && media.includes("choice.label = `原始视频 · 容器·") && media.includes("resolution[^0-9]{0,40}?")],
  // browser.tsx：bkcdn.net/library 与 trafficdeposit /pivi/ vidthumb.mp4 预览直接从候选过滤
  ["browser deprioritizes preview noise in priority", browser.includes("NOISE_PREVIEW_RE") && browser.includes("trafficdeposit\\\.com\\/pivi") && browser.includes("NOISE_PREVIEW_RE.test(pathname) || NOISE_VIDEO_THUMB_RE.test(pathname) ? 6 : base")],
  ["browser filters preview noise from candidates", browser.includes("if (NOISE_PREVIEW_RE.test(url) || NOISE_VIDEO_THUMB_RE.test(url)) continue") && browser.includes("const NOISE_VIDEO_THUMB_RE = /vidthumb\\.mp4")],
  // index.tsx：.vid 候选直接分析直链
  ["index detects .vid redirect candidates", index.includes("safariCandidateIsVidRedirect") && index.includes(".vid(?:$|[?#])")],
  ["index passes directOnly for .vid candidates", index.includes("analyzeSafariCandidate(candidate, envelope.playerFrameURL, safariCandidateIsVidRedirect(candidate))") && index.includes("analyzeSafariCandidate(envelope.candidates[0], envelope.playerFrameURL, safariCandidateIsVidRedirect(envelope.candidates[0]))")],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Vid redirect capture checks failed: ${failed.join(", ")}`)
console.log(`Vid redirect capture checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
