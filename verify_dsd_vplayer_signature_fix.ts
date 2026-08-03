import { Script } from "scripting"
import { publishBrowserUserscript, stripBrowserTypeScript } from "./services/browser-script"

void (async () => {
// dsd.com.se（MacCMS vplayer）签名清单修复验证：
// 1) browser.tsx.src 采集器递归读取同源嵌套 iframe 的 <video> currentSrc（签名 URL）+ 去重优选；
// 2) media.ts 分析侧 vplayer 签名解析（WebView 加载 /addons/vplayer/ 读取签名地址）；
// 3) 发布 Safari 插件 v1.3.2（转换器 + node 语法自检）。

const browserSource = FileManager.readAsStringSync(`${Script.directory}/browser.tsx.src`)
const mediaSource = FileManager.readAsStringSync(`${Script.directory}/services/media.ts`)

const checks: Array<[string, boolean]> = [
  // —— 采集器 browser.tsx.src ——
  ["browser version bumped to 1.3.3", /\/\/\s*@version\s+1\.3\.3/.test(browserSource)],
  ["browser adds sameOriginFrameMediaURLs", /function sameOriginFrameMediaURLs\(\)/.test(browserSource)],
  ["browser recurses same-origin iframe media", /for \(const value of sameOriginFrameMediaURLs\(\)\)/.test(browserSource)],
  ["browser prefers queried (signed) candidate", /function preferQueriedCandidates\(candidates[^)]*\)/.test(browserSource)],
  ["browser sortCandidates dedupes", /function sortCandidates\(candidates[^)]*\)[^\n]*return preferQueriedCandidates\(candidates\)/.test(browserSource)],
  ["browser detects VIP gate", /function detectPageGate\(\)/.test(browserSource)],
  ["browser writes gate into envelope", /gate \? \{ gate \} : \{\}/.test(browserSource)],
  // —— 分析侧 media.ts ——
  ["media adds DESKTOP_SAFARI_UA", /const DESKTOP_SAFARI_UA = "Mozilla\/5\.0 \(Macintosh/.test(mediaSource)],
  ["media adds isMaccmsVPlayerCandidate", /function isMaccmsVPlayerCandidate\(sourceURL: string, referer\?: string\)/.test(mediaSource)],
  ["media adds resolveMaccmsVPlayerSignedURL", /function resolveMaccmsVPlayerSignedURL\(sourceURL: string, referer: string, taskId: string\)/.test(mediaSource)],
  ["media fast-path hook (vplayer)", /probe\.hls\.vplayer-native-fast-path/.test(mediaSource)],
  ["media catch fallback hook (vplayer)", /probe\.safari-hls\.vplayer-fallback/.test(mediaSource)],
  ["media vplayer WebView reads video currentSrc", /document\.querySelector\('video'\)\.currentSrc/.test(mediaSource) || /v\.currentSrc \|\| v\.src/.test(mediaSource)],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`DSD vplayer fix checks failed: ${failed.join(", ")}`)
console.log(`DSD vplayer fix source checks passed (${checks.length})`)

// 转换器自检（与 verify_browser_publish 一致）
const js = stripBrowserTypeScript(browserSource)
const leftover = js.match(/\b(?:CandidateKind|CaptureSession|FrameReport|Promise<|Array<|Record<|Set<|Map<)\b/)
if (leftover) throw new Error(`stripBrowserTypeScript leftover: ${leftover[0]}`)
console.log("Browser converter output OK")

// 发布 Safari 插件（真实部署到 userscripts/Yoinks.user.js）
const result = await publishBrowserUserscript()
if (!result.ok) throw new Error(`publishBrowserUserscript failed: ${result.error || "unknown"}`)
console.log(`PUBLISHED version=${result.version} path=${result.path}`)

Script.exit({ passed: checks.length + 1 })
})().catch((error) => {
  console.error(String((error && error.message) || error))
  Script.exit({ failed: 1 })
})
