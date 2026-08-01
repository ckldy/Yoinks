import { Script } from "scripting"
import { hlsEndpointChoice, hlsMediaChoice } from "./services/media"
import { classifySafariMediaURL } from "./services/safari-media-candidates"

// Real inline player script from https://www.8xx3.lol/video/1207050208.html (hls.js + native fallback).
const REAL_PLAYER_SCRIPT = `
    var video = document.getElementById('video');
    if (Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource('https://m.892539.xyz/play.php?site_id=20&source_id=206169');
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, function () {
            video.play();
        });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = 'https://m.892539.xyz/play.php?site_id=20&source_id=206169';
        video.addEventListener('loadedmetadata', function () {
            video.play();
        });
    }
`

// Real inline player script from https://avtoday.io/player?s=FC2PPV-4934366: the top-level
// page has no media element, and the m3u8 lives only in this same-origin iframe script as a
// var binding consumed by hls.loadSource(m3u8_url).
const AVTODAY_PLAYER_SCRIPT = `
    var m3u8_url = 'https://avtoday.io/streaming/FC2PPV-4934366/7cab89a1119ccd7b5cae08f05569a9d0.m3u8';
    var cover = '/pic/2026/08/FC2PPV-4934366-1785585378.jpg';
    var spcode = 'FC2PPV-4934366';
    var hls = new Hls();
    hls.loadSource(m3u8_url);
    hls.attachMedia(video);
`

const EXPECTED_ENDPOINT = "https://m.892539.xyz/play.php?site_id=20&source_id=206169"
const EXPECTED_AVTODAY = "https://avtoday.io/streaming/FC2PPV-4934366/7cab89a1119ccd7b5cae08f05569a9d0.m3u8"

// Mirrors browser.tsx: PLAYER_LITERAL_PATTERN / PLAYER_BINDING_PATTERN.
const PLAYER_LITERAL_PATTERN = /(?:loadSource\s*\(\s*|(?:video|audio|player|hls|media)\.src\s*=\s*)["'`]([^"'`]+)["'`]/gi
const PLAYER_BINDING_PATTERN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["'`](https?:\/\/[^"'`]+)["'`]/gi

function normalizeURL(value: string | null | undefined): string | null {
  if (!value) return null
  try { const url = new URL(value, "https://www.8xx3.lol/video/1207050208.html"); if (url.protocol !== "http:" && url.protocol !== "https:") return null; url.hash = ""; return url.toString() } catch { return null }
}

function literalMatches(text: string): string[] {
  const values: string[] = []
  for (const match of text.matchAll(PLAYER_LITERAL_PATTERN)) { const url = normalizeURL(match[1]); if (url) values.push(url) }
  return values
}

function bindingMatches(text: string): string[] {
  const values: string[] = []
  for (const match of text.matchAll(PLAYER_BINDING_PATTERN)) {
    const url = normalizeURL(match[2]); if (!url) continue
    const id = match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (new RegExp(`(?:loadSource\\s*\\(\\s*|(?:video|audio|player|hls|media)\\.src\\s*=\\s*)${id}\\b`).test(text)) values.push(url)
  }
  return values
}

const source = FileManager.readAsStringSync(`${Script.directory}/browser.tsx.src`)
const mediaSource = FileManager.readAsStringSync(`${Script.directory}/services/media.ts`)

const checks: Array<[string, boolean]> = [
  // browser.tsx plugin-side changes
  ["browser.tsx bumps to 1.2.9", /\/\/ @version 1\.2\.9/.test(source)],
  ["media element scan reads JS-set src via IDL", /function mediaElementURLs\([\s\S]*element\.currentSrc \|\| element\.src/.test(source)],
  ["<source> scan is restricted to video/audio parents", /querySelectorAll\("video source, audio source"\)/.test(source)],
  ["player script extraction is present", /function playerScriptSourceURLs\(\)/.test(source)],
  ["same-origin iframe script extraction is present", /function sameOriginFrameScriptSourceURLs\(\)/.test(source)],
  ["same-origin iframe read runs in collectCandidates", /for \(const value of sameOriginFrameScriptSourceURLs\(\)\)/.test(source)],
  ["Vue component media extraction is present", /function vueComponentMediaURLs\(\)/.test(source) && /VUE_MEDIA_DETAIL_KEYS/.test(source)],
  ["Vue component media read runs in collectCandidates", /for \(const value of vueComponentMediaURLs\(\)\)/.test(source)],
  ["capture clears stale candidates before re-capture", /await GM\.setValue\(STORAGE_KEY, null\)/.test(source)],
  ["capture clears before playback trigger", /await GM\.setValue\(STORAGE_KEY, null\)[\s\S]{0,220}triggerPlaybackIfIdle\(\)/.test(source)],
  ["player script extraction runs for media element or player container", /if \(document\.querySelector\("video, audio, \.fp-player, \.kt_player, \.kt-player, \.player-wrap, \.player-holder, \.premium-player, \[class\*='player' i\]"\)\) \{ for \(const value of playerScriptSourceURLs\(\)\)/.test(source)],
  ["mergeCandidates no longer re-classifies by URL shape", !/mergeCandidates[\s\S]{0,400}!classify\(candidate\.url\)/.test(source)],
  // regex behavior against the real 8xx3 player script
  ["hls.js loadSource literal is extracted", literalMatches(REAL_PLAYER_SCRIPT).includes(EXPECTED_ENDPOINT)],
  ["native video.src assignment is extracted", literalMatches(REAL_PLAYER_SCRIPT).includes(EXPECTED_ENDPOINT)],
  ["identifier binding is resolved when used by loadSource", bindingMatches("const u = 'https://cdn.example/v.m3u8'; hls.loadSource(u);").includes("https://cdn.example/v.m3u8")],
  ["avtoday same-origin iframe var binding is resolved", bindingMatches(AVTODAY_PLAYER_SCRIPT).includes(EXPECTED_AVTODAY)],
  ["avtoday m3u8 var is classified as hls", classifySafariMediaURL(EXPECTED_AVTODAY) === "hls"],
  ["identifier binding is ignored when not used by a player", !bindingMatches("const u = 'https://cdn.example/analytics.gif'; foo(u);").length],
  ["picture/source ad URLs stay non-candidates", classifySafariMediaURL("https://www.8xx3.lol/ad/8728.gif") === null],
  // media.ts app-side changes
  ["hlsEndpointChoice routes non-.m3u8 endpoints to m3u8", hlsEndpointChoice("https://m.892539.xyz/play.php?site_id=20&source_id=206169").formatExpression === "m3u8" && hlsEndpointChoice("https://m.892539.xyz/play.php?site_id=20&source_id=206169").sourceURL === EXPECTED_ENDPOINT],
  ["hlsMediaChoice still guards on .m3u8 shape", hlsMediaChoice(EXPECTED_ENDPOINT) === null],
  ["plugin classify still rejects the extensionless endpoint (root cause)", classifySafariMediaURL(EXPECTED_ENDPOINT) === null],
  ["empty-formats branch sniffs for #EXTM3U", /const sniffedMaster = referer \? await sniffHlsManifest\(/.test(mediaSource) && /probe\.safari-hls\.sniffed-endpoint/.test(mediaSource)],
  ["failed-probe branch also sniffs for #EXTM3U", /if \(safariHlsChoice && referer\) \{\n[\s\S]{0,300}const sniffedMaster = await sniffHlsManifest\(/.test(mediaSource)],
  ["sniff bounds body to 256 KB", /contentLength > 262144/.test(mediaSource) && /text\.length <= 262144/.test(mediaSource)],
  ["sniff sends only Referer + UA (no cookies)", /headers: \{ Accept: "\*\/\*", Referer: referer, "User-Agent": userAgent \}/.test(mediaSource)],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Safari player-script capture checks failed: ${failed.join(", ")}`)
console.log(`Safari player-script capture checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
