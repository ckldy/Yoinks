import { Script } from "scripting"
import {
  classifyPublicMediaURL,
  extractAllowedIframeURLs,
  extractPublicPlayerSources,
  extractPublicPlayerFrameSources,
  extractPublicPlayerSourcesFromHTML,
  isSamePublicSite,
  normalizePublicURL,
} from "./services/public-player-source"

void (async () => {
const checks: Array<[string, boolean]> = []
const check = (name: string, passed: boolean) => checks.push([name, passed])
const kindOf = (url: string) => {
  const classified = classifyPublicMediaURL(url)
  return classified.accepted ? classified.kind : null
}

check("normalizes relative URL and removes fragment", normalizePublicURL("/media/a.mp4?sig=1#part", "https://www.example.com/watch/x") === "https://www.example.com/media/a.mp4?sig=1")
check("rejects CRLF URL", normalizePublicURL("https://cdn.example/a.mp4\r\nX: y") === null)
check("classifies HLS", kindOf("https://cdn.example/master.m3u8") === "hls")
check("classifies DASH", kindOf("https://cdn.example/manifest.mpd") === "dash")
check("classifies MP4", kindOf("https://cdn.example/video.MP4?token=ok") === "video")
check("allows signed public URL", classifyPublicMediaURL("https://cdn.example/video.mp4?token=ok&expires=1").accepted)
check("rejects segment", !classifyPublicMediaURL("https://cdn.example/part.m4s").accepted)
check("rejects protected configuration URL", !classifyPublicMediaURL("https://cdn.example/video.mp4?license=x").accepted)
check("allows same registrable domain", isSamePublicSite("https://www.example.com/a", "https://player.example.com/embed"))
check("allows co.uk sibling", isSamePublicSite("https://video.example.co.uk/a", "https://www.example.co.uk/embed"))
check("rejects cross-site iframe", !isSamePublicSite("https://example.com/a", "https://third-party.net/embed"))

const iframeHTML = '<iframe src="https://ads.other.net/x"></iframe><iframe src="/embed/one"></iframe><iframe src="https://player.example.com/two"></iframe><iframe src="https://player.example.com/two"></iframe><iframe src="https://video.example.com/three"></iframe><iframe src="https://video.example.com/four"></iframe>'
const frames = extractAllowedIframeURLs("https://www.example.com/watch/1", iframeHTML)
check("allows same-site iframe and skips third party", frames[0] === "https://www.example.com/embed/one" && frames[1] === "https://player.example.com/two")
check("dedupes and caps iframes", frames.length === 3 && !frames.includes("https://video.example.com/four"))

const html = '<title>Page Title</title><video src="/v.mp4?x=1&amp;y=2"></video><meta property="og:video" content="https:\/\/cdn.example\/master.m3u8"><source src="https://cdn.example/part.m4s"><script>const source = "https:\\/\\/cdn.example\\/manifest.mpd"</script>'
const pageSources = extractPublicPlayerSourcesFromHTML({ url: "https://www.example.com/watch/1", html, title: "Page Title", origin: "page" })
check("extracts and ranks static HLS DASH video", pageSources.map((item) => item.kind).join(",") === "hls,dash,video")
check("decodes entities and preserves query", pageSources.some((item) => item.url === "https://www.example.com/v.mp4?x=1&y=2"))
check("uses page as referer", pageSources.every((item) => item.referer === "https://www.example.com/watch/1"))
const repeatedQuality = extractPublicPlayerSourcesFromHTML({
  url: "https://www.example.com/watch/1", origin: "page", html: '<video src="https://a.example/240P_one.mp4"></video><source src="https://b.example/240p_two.mp4"><source src="https://cdn.example/720P_main.mp4"><source src="https://cdn.example/no-quality.mp4"><source src="https://other.example/also-no-quality.mp4">',
})
check("dedupes progressive URLs by inferred quality", repeatedQuality.length === 3 && repeatedQuality.map((item) => item.height || 0).join(",") === "720,240,0")

const calls: string[] = []
const result = await extractPublicPlayerSources({
  pageURL: "https://www.example.com/watch/1",
  fetchHTML: async (url) => {
    calls.push(url)
    if (url.includes("watch")) return { finalURL: url, html: '<iframe src="https://player.example.com/embed"></iframe>', title: "Outer" }
    return { finalURL: url, html: '<video src="https://cdn.example/iframe.mp4"></video>', title: "Inner" }
  },
})
check("checks iframe only after empty page", calls.length === 2 && result?.checkedIframes === 1)
check("prefers outer title and iframe referer", result?.title === "Outer" && result.sources[0]?.referer === "https://player.example.com/embed")

const noIframeCalls: string[] = []
await extractPublicPlayerSources({ pageURL: "https://example.com/a", fetchHTML: async (url) => { noIframeCalls.push(url); return { finalURL: url, html: '<video src="/ok.mp4"></video>' } } })
check("does not fetch iframe after page hit", noIframeCalls.length === 1)

const frameCalls: string[] = []
const frameResult = await extractPublicPlayerFrameSources({
  frameURL: "https://player.example/embed/one",
  pageTitle: "Outer title",
  fetchText: async (url) => {
    frameCalls.push(url)
    if (url.endsWith("/embed/one")) return { finalURL: url, text: '<script src="/assets/player.js"></script>' }
    if (url.endsWith("/assets/player.js")) return { finalURL: url, text: 'fetch("/stream?id=abc")' }
    if (url.includes("/stream?")) return { finalURL: url, text: '{"media":{"stream":"https://cdn.example/video.m3u8?sig=ok"},"token":"must-not-be-a-candidate"}' }
    return null
  },
})
check("follows one same-origin script to one public JSON media field", frameCalls.length === 3 && frameResult?.sources.length === 1 && frameResult.sources[0]?.kind === "hls")
check("uses frame URL as public media referer", frameResult?.sources[0]?.referer === "https://player.example/embed/one")

const variableCalls: string[] = []
const variableResult = await extractPublicPlayerFrameSources({
  frameURL: "https://player.example/e/abc?poster=https%3A%2F%2Fcover.example%2Fa.jpg",
  fetchText: async (url) => {
    variableCalls.push(url)
    if (url.includes("/e/abc")) return { finalURL: url, text: '<script src="/assets/embed.js"></script>' }
    if (url.endsWith("/assets/embed.js")) return { finalURL: url, text: 'function o(e){let t=new URL(`/stream`,location.origin);new URLSearchParams(location.search).forEach((value,key)=>t.searchParams.set(key,value));t.searchParams.set(`id`,e);return t.toString()} (function(){let e=document.location.pathname.match(/\/e\/([a-z0-9_]+)/i);e&&fetch(o(e[1]))})()' }
    if (url.includes("/stream?")) return { finalURL: url, text: '{"media":{"stream":"https://cdn.example/variable.m3u8"}}' }
    return null
  },
})
check("follows a fetch variable built from a same-origin stream path", variableCalls.length === 3 && variableCalls[2]?.includes("/stream?") && variableResult?.sources[0]?.kind === "hls")

const unrelatedCalls: string[] = []
await extractPublicPlayerFrameSources({
  frameURL: "https://player.example/e/abc",
  fetchText: async (url) => {
    unrelatedCalls.push(url)
    if (url.includes("/e/abc")) return { finalURL: url, text: '<script src="/assets/embed.js"></script>' }
    if (url.endsWith("/assets/embed.js")) return { finalURL: url, text: 'function o(e){let t=new URL(`/stream`,location.origin);return t.toString()} function load(){return {}} fetch(load())' }
    return null
  },
})
check("rejects a constructed path not consumed by the fetch call", unrelatedCalls.length === 2)

const crossOriginCalls: string[] = []
await extractPublicPlayerFrameSources({
  frameURL: "https://player.example/e/abc",
  fetchText: async (url) => {
    crossOriginCalls.push(url)
    if (url.includes("/e/abc")) return { finalURL: url, text: '<script src="/assets/embed.js"></script>' }
    if (url.endsWith("/assets/embed.js")) return { finalURL: url, text: 'function o(e){let t=new URL(`https://other.example/stream`,location.origin);return t.toString()} fetch(o(e))' }
    return null
  },
})
check("rejects an absolute cross-origin constructed path", crossOriginCalls.length === 2)

const noKeywordCalls: string[] = []
await extractPublicPlayerFrameSources({
  frameURL: "https://player.example/e/abc",
  fetchText: async (url) => {
    noKeywordCalls.push(url)
    if (url.includes("/e/abc")) return { finalURL: url, text: '<script src="/assets/embed.js"></script>' }
    if (url.endsWith("/assets/embed.js")) return { finalURL: url, text: 'function o(e){let t=new URL(`/api`,location.origin);return t.toString()} fetch(o(e))' }
    return null
  },
})
check("rejects a constructed path without stream/player/media keyword", noKeywordCalls.length === 2)

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Public player source checks failed: ${failed.join(", ")}`)
console.log(`Public player source checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
})().catch((error) => Script.exit({ error: error instanceof Error ? error.message : String(error) }))
