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

const EXPECTED_ENDPOINT = "https://m.892539.xyz/play.php?site_id=20&source_id=206169"

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

const source = FileManager.readAsStringSync(`${Script.directory}/browser.tsx`)
const mediaSource = FileManager.readAsStringSync(`${Script.directory}/services/media.ts`)

const checks: Array<[string, boolean]> = [
  // browser.tsx plugin-side changes
  ["browser.tsx bumps to 1.1.6", /\/\/ @version 1\.1\.6/.test(source)],
  ["media element scan reads JS-set src via IDL", /function mediaElementURLs\([\s\S]*element\.currentSrc \|\| element\.src/.test(source)],
  ["<source> scan is restricted to video/audio parents", /querySelectorAll\("video source, audio source"\)/.test(source)],
  ["player script extraction is present", /function playerScriptSourceURLs\(\)/.test(source)],
  ["player script extraction requires a media element", /if \(document\.querySelector\("video, audio"\)\) \{ for \(const value of playerScriptSourceURLs\(\)\)/.test(source)],
  ["mergeCandidates no longer re-classifies by URL shape", !/mergeCandidates[\s\S]{0,400}!classify\(candidate\.url\)/.test(source)],
  // regex behavior against the real 8xx3 player script
  ["hls.js loadSource literal is extracted", literalMatches(REAL_PLAYER_SCRIPT).includes(EXPECTED_ENDPOINT)],
  ["native video.src assignment is extracted", literalMatches(REAL_PLAYER_SCRIPT).includes(EXPECTED_ENDPOINT)],
  ["identifier binding is resolved when used by loadSource", bindingMatches("const u = 'https://cdn.example/v.m3u8'; hls.loadSource(u);").includes("https://cdn.example/v.m3u8")],
  ["identifier binding is ignored when not used by a player", !bindingMatches("const u = 'https://cdn.example/analytics.gif'; foo(u);").length],
  ["picture/source ad URLs stay non-candidates", classifySafariMediaURL("https://www.8xx3.lol/ad/8728.gif") === null],
  // media.ts app-side changes
  ["hlsEndpointChoice routes non-.m3u8 endpoints to m3u8", hlsEndpointChoice("https://m.892539.xyz/play.php?site_id=20&source_id=206169").formatExpression === "m3u8" && hlsEndpointChoice("https://m.892539.xyz/play.php?site_id=20&source_id=206169").sourceURL === EXPECTED_ENDPOINT],
  ["hlsMediaChoice still guards on .m3u8 shape", hlsMediaChoice(EXPECTED_ENDPOINT) === null],
  ["plugin classify still rejects the extensionless endpoint (root cause)", classifySafariMediaURL(EXPECTED_ENDPOINT) === null],
  ["empty-formats branch sniffs for #EXTM3U", /const sniffedMaster = referer \? await sniffHlsManifest\(/.test(mediaSource) && /probe\.safari-hls\.sniffed-endpoint/.test(mediaSource)],
  ["failed-probe branch also sniffs for #EXTM3U", /if \(referer\) \{\n\s*const sniffedMaster = await sniffHlsManifest\(/.test(mediaSource)],
  ["sniff bounds body to 256 KB", /contentLength > 262144/.test(mediaSource) && /text\.length <= 262144/.test(mediaSource)],
  ["sniff sends only Referer + UA (no cookies)", /headers: \{ Accept: "\*\/\*", Referer: referer, "User-Agent": userAgent \}/.test(mediaSource)],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Safari player-script capture checks failed: ${failed.join(", ")}`)
console.log(`Safari player-script capture checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
