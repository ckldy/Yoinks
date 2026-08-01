import { Script } from "scripting"

// 验证 browser.tsx 对 porntrex 类页面（kt_player flashvars 直链 + 全广告 iframe）的捕获逻辑。
// 把修改后的核心正则/函数内联复制一份（与 browser.tsx 保持同步），不依赖 DOM 环境。

// ---- browser.tsx 修改后的正则与函数（复制同步） ----
const VIDEO_PATTERN = /\.(?:mp4|m4v|mov|webm|mkv|avi|flv|vid)(?:$|[?#/])/i
const AUDIO_PATTERN = /\.(?:m4a|aac|mp3|opus|ogg|wav)(?:$|[?#/])/i
const SEGMENT_PATTERN = /\.(?:ts|m4s)(?:$|[?#/])/i
const PLAYER_CONFIG_URL_PATTERN = /(?:video_url|video_alt_url|video_alt_url2|file)\s*[:=]\s*["'`](https?:\/\/[^"'`]+)["'`]|src\s*[:=]\s*["'`](https?:\/\/[^"'`]*\.(?:mp4|m3u8|mpd|mov|webm|mkv|vid)(?:[\/?#][^"'`]*)?)["'`]/gi
const AD_FRAME_HOST_RE = /(?:\.|^)(?:adtng|mavrtracktor|magsrv|whitetrafsa|gsrv|doubleclick|googlesyndication|googletagservices|adnxs|taboola|outbrain|amazon-adsystem|adform|criteo|pubmatic|rubiconproject|openx|casalemedia|serving-sys|zedo)(?:\.|$)/i
const PLAYER_FRAME_PATH_RE = /(?:^|[\/_.-])(?:video|embed|player|watch|stream|play|episode|share|e)(?:[\/_.-]|$)/i

function classify(value: string): string | null {
  try {
    const url = new URL(value)
    const pathname = url.pathname.toLowerCase()
    if (SEGMENT_PATTERN.test(pathname)) return null
    if (/\.m3u8$/.test(pathname)) return "hls"
    if (/\.mpd$/.test(pathname)) return "dash"
    if (VIDEO_PATTERN.test(pathname)) return "video"
    if (AUDIO_PATTERN.test(pathname)) return "audio"
    return /(?:^|[?&])(?:manifest|playlist|m3u8|mpd)=/i.test(url.search) ? "inferred" : null
  } catch { return null }
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

function frameURLScore(url: string): number {
  try {
    const parsed = new URL(url)
    if (AD_FRAME_HOST_RE.test(parsed.hostname)) return -1
    return PLAYER_FRAME_PATH_RE.test(parsed.pathname) ? 2 : 0
  } catch { return 0 }
}

function firstPublicFrameURL(frameSrcs: string[]): string | undefined {
  let best: string | undefined, bestScore = -1
  for (const url of frameSrcs) {
    if (!url) continue
    const score = frameURLScore(url)
    if (score > bestScore) { bestScore = score; best = url }
  }
  return best
}

// ---- index.tsx 修改后的 safariCandidateIsVidRedirect 逻辑 ----
function safariCandidateIsVidRedirect(url: string): boolean {
  try {
    const pathname = new URL(url).pathname
    return /\.vid(?:$|[?#])/i.test(pathname) || /\.(?:mp4|m4v|mov|webm|mkv)\/$/i.test(pathname)
  } catch { return false }
}

// ---- 测试数据 ----

// porntrex 真实 flashvars（截取自页面内联脚本）
const porntrexFlashvars = `
var flashvars = {
  video_id: '3002115',
  video_title: 'Three BBWs VS One Dick',
  video_url: 'https://www.porntrex.com/get_file/29/60018ab4e263aaa79fdea5c70bb7baf4c139ef8845/3002000/3002115/3002115.mp4/',
  postfix: '.mp4',
  video_url_text: '480p',
  video_alt_url: 'https://www.porntrex.com/get_file/29/12867aa59cd5f0bb5e7654903e25230e95e40dfdc8/3002000/3002115/3002115_720p.mp4/',
  video_alt_url_text: '720p HD',
  video_alt_url2: 'https://www.porntrex.com/get_file/29/b1a6a9d6a651cc368a13f7d62140ecf434eea7a090/3002000/3002115/3002115_1080p.mp4/',
  video_alt_url2_text: '1080p FHD',
};
function getEmbed(width, height) {
  return '<iframe src="https://www.porntrex.com/embed/3002115" frameborder="0"></iframe>';
}
var related = { src: 'https://www.porntrex.com/related_videos_html/3002115/' };
`

// 全广告 iframe（porntrex 实际只有 go.gsrv.dev banner）
const porntrexFrames = [
  "//go.gsrv.dev/banner.go?spaceid=11829036",
  "//go.gsrv.dev/banner.go?spaceid=11829037",
  "//go.gsrv.dev/banner.go?spaceid=11829038",
  "//go.gsrv.dev/banner.go?spaceid=11829033",
  "//go.gsrv.dev/banner.go?spaceid=11829034",
  "//go.gsrv.dev/banner.go?spaceid=11829035",
].map(s => `https:${s}`)

// hqporner 回归数据：广告 + 正片播放器 iframe
const hqpornerFrames = [
  "https://a.adtng.com/get/10016931?x=1",
  "https://mydaddy.cc/video/1bc95b50343fa934ca/",
  "https://mavrtracktor.com/some/path",
]

const checks: Array<[string, boolean]> = [
  // 尾部斜杠媒体 URL 识别为 video（porntrex get_file 风格）
  ["classifies trailing-slash get_file mp4 as video", classify("https://www.porntrex.com/get_file/29/hash/3002000/3002115/3002115.mp4/") === "video"],
  ["classifies trailing-slash 720p mp4 as video", classify("https://www.porntrex.com/get_file/29/hash/3002000/3002115/3002115_720p.mp4/") === "video"],
  ["rejects plain trailing-slash non-media path", classify("https://www.porntrex.com/related_videos_html/3002115/") === null],
  // flashvars 提取：只提取 3 个直链，不提取 embed/related 等 src: 非媒体
  ["extracts exactly three flashvars direct links", playerScriptSourceURLs([porntrexFlashvars]).length === 3],
  ["extracted direct links are get_file media URLs", playerScriptSourceURLs([porntrexFlashvars]).every(u => u.includes("/get_file/") && u.endsWith(".mp4/"))],
  ["does not extract embed iframe src as media", !playerScriptSourceURLs([porntrexFlashvars]).some(u => u.includes("/embed/"))],
  ["does not extract related_videos_html src as media", !playerScriptSourceURLs([porntrexFlashvars]).some(u => u.includes("related_videos_html"))],
  // flowplayer sources[].src 媒体形式仍可提取（回归）
  ["extracts flowplayer sources src media", playerScriptSourceURLs([`flowplayer("#p", { clip: { sources: [{ type: "video/mp4", src: "https://cdn.example/pubs/hash/1080.mp4" }] } })`]).includes("https://cdn.example/pubs/hash/1080.mp4")],
  // 全广告 iframe：不选中任何广告线索
  ["returns no playerFrameURL for all-ad iframes", firstPublicFrameURL(porntrexFrames) === undefined],
  ["gsrv banner scores as ad", frameURLScore("https://go.gsrv.dev/banner.go?spaceid=1") === -1],
  // hqporner 回归：正片播放器 iframe 仍被选中
  ["still picks real player iframe over ads", firstPublicFrameURL(hqpornerFrames) === "https://mydaddy.cc/video/1bc95b50343fa934ca/"],
  ["picks nothing when only ads present", firstPublicFrameURL(["https://a.adtng.com/get/1", "https://go.gsrv.dev/banner.go?x=1"]) === undefined],
  // index.tsx 重定向直链判断：porntrex get_file 直接走直链
  ["vid URL is direct redirect", safariCandidateIsVidRedirect("https://sxyprn.com/cdn8/xxx.vid") === true],
  ["trailing-slash mp4 is direct redirect", safariCandidateIsVidRedirect("https://www.porntrex.com/get_file/29/hash/3002115.mp4/") === true],
  ["plain mp4 with query is not forced direct", safariCandidateIsVidRedirect("https://cdn.example/video.mp4?token=1") === false],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Porntrex capture checks failed: ${failed.join(", ")}`)
console.log(`Porntrex capture checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
