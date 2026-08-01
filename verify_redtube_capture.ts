import { Script } from "scripting"

// 验证 browser.tsx 对 PH 系（redtube/YouPorn 等）签名清单端点的捕获逻辑：
// mediaDefinition 的 videoUrl 是相对路径 /media/hls?s=...（驼峰键、无扩展名，YouPorn 为 /media/hls/?s=...
// 多一个尾部斜杠），播放器点击播放后才 fetch 该端点，返回 200 JSON（各清晰度 master.m3u8 / mp4 直链）。
// 捕获器应主动识别端点并解析出真实媒体 URL，不依赖播放时序。
// 把修改后的核心正则/函数内联复制一份（与 browser.tsx 保持同步），不依赖 DOM 环境。

// ---- browser.tsx 修改后的正则与函数（复制同步） ----
const VIDEO_PATTERN = /\.(?:mp4|m4v|mov|webm|mkv|avi|flv|vid)(?:$|[?#/])/i
const AUDIO_PATTERN = /\.(?:m4a|aac|mp3|opus|ogg|wav)(?:$|[?#/])/i
const SEGMENT_PATTERN = /\.(?:ts|m4s)(?:$|[?#/])/i
const PLAYER_CONFIG_URL_PATTERN = /(?:video_url|video_alt_url|video_alt_url2|file)\s*[:=]\s*["'`](https?:\/\/[^"'`]+)["'`]|src\s*[:=]\s*["'`](https?:\/\/[^"'`]*\.(?:mp4|m3u8|mpd|mov|webm|mkv|vid)(?:[\/?#][^"'`]*)?)["'`]/gi
// 尾部斜杠可选：redtube /media/hls?s=...；YouPorn /media/hls/?s=...
const PH_MEDIA_ENDPOINT_RE = /\/media\/(?:hls|mp4|dash|mpd)\/?(?:$|\?)/
const PLAYER_MEDIA_DEFINITION_PATTERN = /["'`]?(?:videoUrl|video_url|video_alt_url|video_alt_url2|file)["'`]?\s*[:=]\s*["'`]([^"'`]+)["'`]/gi
const MAX_MEDIA_ENDPOINT_FETCHES = 3

const PAGE_URL = "https://www.redtube.com/189939931"

function normalizeURL(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value, PAGE_URL)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    url.hash = ""
    return url.toString()
  } catch { return null }
}

function classify(value: string): string | null {
  const normalized = normalizeURL(value); if (!normalized) return null
  const url = new URL(normalized), pathname = url.pathname.toLowerCase()
  if (SEGMENT_PATTERN.test(pathname)) return null
  if (/\.m3u8$/.test(pathname)) return "hls"
  if (/\.mpd$/.test(pathname)) return "dash"
  if (VIDEO_PATTERN.test(pathname)) return "video"
  if (AUDIO_PATTERN.test(pathname)) return "audio"
  return /(?:^|[?&])(?:manifest|playlist|m3u8|mpd)=/i.test(url.search) ? "inferred" : null
}

function playerScriptSourceURLs(scriptTexts: string[]): string[] {
  const values: string[] = []
  for (const text of scriptTexts) {
    if (text.length > 100000) continue
    for (const match of text.matchAll(PLAYER_CONFIG_URL_PATTERN)) {
      const url = match[1] || match[2]
      if (url) values.push(url)
    }
  }
  return [...new Set(values)]
}

function playerMediaEndpointURLs(scriptTexts: string[]): string[] {
  const values: string[] = []
  for (const text of scriptTexts) {
    if (text.length > 100000) continue
    for (const match of text.matchAll(PLAYER_MEDIA_DEFINITION_PATTERN)) {
      // JSON 转义：\/media\/hls?s=... 还原为 /media/hls?s=...
      const url = normalizeURL(match[1].replace(/\\\//g, "/"))
      if (url && PH_MEDIA_ENDPOINT_RE.test(new URL(url).pathname)) values.push(url)
    }
  }
  return [...new Set(values)]
}

// 模拟 resolvePHMediaEndpoint 的 JSON 解析部分（browser.tsx 里 fetch 后 JSON.parse + 遍历提取）
function resolvePHMediaEndpointJSON(jsonText: string): string[] {
  let json: unknown
  try { json = JSON.parse(jsonText) } catch { return [] }
  const urls: string[] = []
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (/^https?:\/\//i.test(node) && /\.(?:m3u8|mpd|mp4|m4v|mov|webm|mkv)(?:$|[?#/])/i.test(node)) urls.push(node)
      return
    }
    if (Array.isArray(node)) { for (const item of node) visit(item); return }
    if (node && typeof node === "object") { for (const value of Object.values(node as Record<string, unknown>)) visit(value) }
  }
  visit(json)
  return [...new Set(urls)]
}

// ---- 测试数据 ----

// redtube 真实内联脚本片段（page_params.mainRoll.adaptive.mediaDefinition，驼峰 videoUrl + 相对路径签名端点）
const redtubeScript = `
page_params = {
  mainRoll: {
    mediaPriority: 'hls',
    adaptive: {
      prebufferGoal: 40,
      mediaDefinition: [{"format":"hls","videoUrl":"\\/media\\/hls?s=eyJ2a2V5IjoxODk5Mzk5MzEsInMiOiIxZmFkNDZjNzU3MjVmMjY2OTI3NGQwYTEzMGRlNGU3NTRhZDg4ZDJlNzcyZWQyYzMzMGQ4MTAxNzE5N2NkOGEwIiwiZ3QiOjE3ODU1NzkyMTUsImUiOmZhbHNlfQ","remote":true,"segmentFormats":{"video":"fmp4","audio":"aac"}},{"format":"mp4","videoUrl":"\\/media\\/mp4?s=eyJ2a2V5IjoxODk5Mzk5MzEsInMiOiIxZmFkNDZjNzU3MjVmMjY2OTI3NGQwYTEzMGRlNGU3NTRhZDg4ZDJlNzcyZWQyYzMzMGQ4MTAxNzE5N2NkOGEwIiwiZ3QiOjE3ODU1NzkyMTUsImUiOmZhbHNlfQ","remote":true,"segmentFormats":{"video":"mp4","audio":"aac"}}],
      poster: "https://ei-ph.rdtcdn.com/videos/202310/15/441260351/original/(m=eah-8f)0.jpg"
    }
  },
  videoUrl: "https://www.redtube.com/189939931",
  title: "A neighbor gave a blowjob on camera",
};
`

// YouPorn 同构页面：videoUrl 为绝对 URL，且 /media/hls/ 与 /media/mp4/ 尾部多一个斜杠
const youpornScript = `
page_params = {
  mainRoll: {
    mediaPriority: 'hls',
    adaptive: {
      prebufferGoal: 40,
      mediaDefinition: [{"format":"hls","videoUrl":"https:\\/\\/www.youporn.com\\/media\\/hls\\/?s=eyJ2a2V5Ijo0ODIwMTI3MSJ9","remote":true},{"format":"mp4","videoUrl":"https:\\/\\/www.youporn.com\\/media\\/mp4\\/?s=eyJ2a2V5Ijo0ODIwMTI3MSJ9","remote":true}],
    }
  },
  videoUrl: "https://www.youporn.com/watch/16698092/polyamory-video-52-started-with-one-finished-with-two/",
  title: "Started with one - finished with two *Poly-amory*",
};
`

// /media/hls 端点真实返回的 JSON（4 档 master.m3u8，签名 URL）
const redtubeHlsJSON = JSON.stringify([
  { defaultQuality: true, format: "hls", height: 404, width: 720, videoUrl: "https://em-h-ph.rdtcdn.com/hls/videos/202310/15/441260351/720P_4000K_441260351.mp4/master.m3u8?validfrom=1785575734&validto=1785582934&hdl=-1&hash=abc", quality: "720" },
  { defaultQuality: false, format: "hls", height: 404, width: 720, videoUrl: "https://em-h-ph.rdtcdn.com/hls/videos/202310/15/441260351/480P_2000K_441260351.mp4/master.m3u8?validfrom=1785575734&validto=1785582934&hdl=-1&hash=def", quality: "480" },
  { defaultQuality: false, format: "hls", height: 404, width: 720, videoUrl: "https://em-h-ph.rdtcdn.com/hls/videos/202310/15/441260351/240P_1000K_441260351.mp4/master.m3u8?validfrom=1785575734&validto=1785582934&hdl=-1&hash=ghi", quality: "240" },
  { defaultQuality: false, format: "hls", height: 404, width: 720, videoUrl: "https://em-h-ph.rdtcdn.com/hls/videos/202310/15/441260351/1080P_4000K_441260351.mp4/master.m3u8?validfrom=1785575734&validto=1785582934&hdl=-1&hash=jkl", quality: "1080" },
])

// porntrex 回归数据：下划线键 flashvars 直链（browser.tsx 1.2.0 已支持，不应被新逻辑破坏）
const porntrexFlashvars = `
var flashvars = {
  video_url: 'https://www.porntrex.com/get_file/29/hash/3002000/3002115/3002115.mp4/',
  video_alt_url: 'https://www.porntrex.com/get_file/29/hash/3002000/3002115/3002115_720p.mp4/',
  video_alt_url2: 'https://www.porntrex.com/get_file/29/hash/3002000/3002115/3002115_1080p.mp4/',
};
var related = { src: 'https://www.porntrex.com/related_videos_html/3002115/' };
`

const checks: Array<[string, boolean]> = [
  // PH 系端点识别
  ["识别出 hls + mp4 两个签名端点", playerMediaEndpointURLs([redtubeScript]).length === 2],
  ["端点路径是 /media/hls 与 /media/mp4（带 ?s=）", playerMediaEndpointURLs([redtubeScript]).every(u => /\/media\/(?:hls|mp4)\?s=/.test(u))],
  ["端点 normalize 为绝对 URL（同源）", playerMediaEndpointURLs([redtubeScript]).every(u => u.startsWith("https://www.redtube.com/media/"))],
  ["非 /media/ 路径的 videoUrl（页面 canonical）不被识别", playerMediaEndpointURLs([`videoUrl: "https://www.redtube.com/189939931"`]).length === 0],
  ["下划线键 /media/ 端点同样可识别（转义形式）", playerMediaEndpointURLs([`video_url: '\\/media\\/mp4?s=abc'`]).length === 1],
  // YouPorn 尾部斜杠形态（/media/hls/?s=）回归
  ["YouPorn 尾部斜杠端点同样识别出 hls + mp4", playerMediaEndpointURLs([youpornScript]).length === 2],
  ["YouPorn 端点全部含 /media/ 与 ?s=", playerMediaEndpointURLs([youpornScript]).every(u => /\/media\/(?:hls|mp4)\/\?s=/.test(u))],
  ["YouPorn 端点 normalize 为绝对 URL", playerMediaEndpointURLs([youpornScript]).every(u => u.startsWith("https://www.youporn.com/media/"))],
  // 端点 fetch 解析
  ["JSON 解析出 4 档 master.m3u8", resolvePHMediaEndpointJSON(redtubeHlsJSON).length === 4],
  ["解析结果全部是 .m3u8 绝对 URL", resolvePHMediaEndpointJSON(redtubeHlsJSON).every(u => u.startsWith("https://") && u.includes("master.m3u8"))],
  ["重复项去重（同一 JSON 拼两次仍为 4）", resolvePHMediaEndpointJSON(JSON.stringify([...JSON.parse(redtubeHlsJSON), ...JSON.parse(redtubeHlsJSON)])).length === 4],
  ["非 JSON 文本解析为空", resolvePHMediaEndpointJSON("not json").length === 0],
  ["JSON 里非媒体字符串被忽略", resolvePHMediaEndpointJSON(JSON.stringify([{ videoUrl: "https://www.redtube.com/189939931" }, { poster: "https://ei-ph.rdtcdn.com/x.jpg" }])).length === 0],
  // 候选归类
  ["master.m3u8 classify 为 hls", classify(resolvePHMediaEndpointJSON(redtubeHlsJSON)[0]) === "hls"],
  ["签名端点本身不被 classify 成候选", classify("https://www.redtube.com/media/hls?s=abc") === null],
  // 回归：porntrex flashvars 直链不受影响
  ["porntrex flashvars 仍提取 3 个直链", playerScriptSourceURLs([porntrexFlashvars]).length === 3],
  ["porntrex 直链仍是 get_file mp4", playerScriptSourceURLs([porntrexFlashvars]).every(u => u.includes("/get_file/") && u.endsWith(".mp4/"))],
  ["porntrex related_videos_html src 不误提取", !playerScriptSourceURLs([porntrexFlashvars]).some(u => u.includes("related_videos_html"))],
  // 完整捕获模拟：端点解析出的 URL 全部能成为候选
  ["解析出的 4 个 URL 全部 classify 通过", resolvePHMediaEndpointJSON(redtubeHlsJSON).every(u => classify(u) !== null)],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Redtube capture checks failed: ${failed.join(", ")}`)
console.log(`Redtube capture checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
