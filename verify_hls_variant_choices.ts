import { Script } from "scripting"
import { hlsEndpointChoices, listHlsVariants, resolveInitialMediaChoice } from "./services/media"

const EPORNER_MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=420000,RESOLUTION=426x240
240p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=840000,RESOLUTION=640x360
360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480
480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5400000,RESOLUTION=1920x1080
1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=2560x1440
1440p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=25000000,RESOLUTION=3840x2160
2160p.m3u8
`

const DIRECT_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:2,
https://cdn.example/seg-001.ts
#EXT-X-ENDLIST
`

// beeg 风格 master：变体是协议相对 URL（//ipXXX.video.beeg.com/.../index.m3u8），
// 带签名参数（key=,s=,end=,limit=,data=,state=,reftag=）与 CODECS 属性。
const BEEG_MASTER = `#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,AVERAGE-BANDWIDTH=375346,BANDWIDTH=563019,RESOLUTION=426x240,CODECS="avc1.640015,mp4a.40.2"
//ip179688276.video.beeg.com/key=TKAgfVulLfr8r0oQd3gakQ,s=,end=1785649169,limit=3/data=xmFY5mS1zM/state=am2Gawby/reftag=20037190/media=hls4A/ssd7/23/9/502611719.mp4/index.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1,AVERAGE-BANDWIDTH=630300,BANDWIDTH=945450,RESOLUTION=640x360,CODECS="avc1.64001E,mp4a.40.2"
//ip254336198.video.beeg.com/key=SfUWZiUhbkRc4XtAnvK4ig,s=,end=1785649169,limit=3/data=xmFY5mS1zM/state=am2Gawby/reftag=20037190/media=hls4A/ssd9/23/0/502611800.mp4/index.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1,AVERAGE-BANDWIDTH=948047,BANDWIDTH=1422071,RESOLUTION=854x480,CODECS="avc1.64001F,mp4a.40.2"
//ip381253095.video.beeg.com/key=HZb9KBfv8p+VZ5AoUHVjyw,s=,end=1785649169,limit=3/data=xmFY5mS1zM/state=am2Gawby/reftag=20037190/media=hls4A/ssd4/23/2/502611872.mp4/index.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1,AVERAGE-BANDWIDTH=1693711,BANDWIDTH=2540566,RESOLUTION=1280x720,CODECS="avc1.640020,mp4a.40.2"
//ip179688276.video.beeg.com/key=jEN8J6f5br8k7AGunPQ4TQ,s=,end=1785649169,limit=3/data=xmFY5mS1zM/state=am2Gawby/reftag=20037190/media=hls4A/ssd8/23/1/502611941.mp4/index.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1,AVERAGE-BANDWIDTH=3329992,BANDWIDTH=4994988,RESOLUTION=1920x1080,CODECS="avc1.640029,mp4a.40.2"
//ip179688276.video.beeg.com/key=Ii4r54OryT25NB0mxEF8nQ,s=,end=1785649169,limit=3/data=xmFY5mS1zM/state=am2Gawby/reftag=20037190/media=hls4A/ssd7/23/0/502611650.mp4/index.m3u8
`

const BEEG_MASTER_URL = "https://video.beeg.com/key=psCEaid3mMbbUy+QgnWAwA,end=1785649169,limit=3/data=xmFY5mS1zM/media=hls4A/multi=426x240:240p:YXZjMS42NDAwMTUsbXA0YS40MC4y,640x360:360p:YXZjMS42NDAwMUUsbXA0YS40MC4y,854x480:480p:YXZjMS42NDAwMUYsbXA0YS40MC4y,1280x720:720p:YXZjMS42NDAwMjAsbXA0YS40MC4y,1920x1080:1080p:YXZjMS42NDAwMjksbXA0YS40MC4y/_TPL_/985214607641126.mp4.m3u8"

const mediaSource = FileManager.readAsStringSync(`${Script.directory}/services/media.ts`)
// 下载器已拆分到 services/hls.ts；variantURI 消费断言读 hls.ts。
const hlsSource = FileManager.readAsStringSync(`${Script.directory}/services/hls.ts`)

const variants = listHlsVariants(EPORNER_MASTER)
const choices = hlsEndpointChoices("https://cdn.example/master.m3u8", EPORNER_MASTER)
const directChoices = hlsEndpointChoices("https://cdn.example/play.php?id=1", DIRECT_PLAYLIST)
const beegChoices = hlsEndpointChoices(BEEG_MASTER_URL, BEEG_MASTER)

const checks: Array<[string, boolean]> = [
  ["lists all master variants highest-first", variants.length === 7 && variants[0]?.height === 2160 && variants[6]?.height === 240],
  ["variant list dedupes repeated URIs", listHlsVariants(`${EPORNER_MASTER}\n#EXT-X-STREAM-INF:BANDWIDTH=999\n2160p.m3u8`).length === 7],
  ["builds one choice per variant", choices.length === 7],
  ["top choice keeps the m3u8 id for HLS routing", choices[0]?.id === "m3u8"],
  ["variant choices label quality", choices[0]?.label.includes("2160p") && choices[1]?.label.includes("1440p")],
  ["variant choices carry height", choices[0]?.height === 2160 && choices[5]?.height === 360],
  ["variant choices carry the selected variant URI", choices[0]?.hlsVariantURI === "2160p.m3u8" && choices[6]?.hlsVariantURI === "240p.m3u8"],
  ["variant choice preview points at the variant playlist", choices[0]?.previewURL === "https://cdn.example/2160p.m3u8"],
  ["direct playlists yield a single adaptive choice", directChoices.length === 1 && !directChoices[0]?.hlsVariantURI],
  ["multiple HLS choices are not auto-loaded", resolveInitialMediaChoice(choices) === null],
  // 下载按用户所选 variant 传递
  ["native downloader accepts variantURI", /variantURI\?: string/.test(hlsSource)],
  ["download passes the selected variant", /variantURI: options\.choice\.hlsVariantURI/.test(mediaSource)],
  ["downloader uses the explicit variant first", /if \(options\.variantURI\) \{[\s\S]{0,200}new URL\(options\.variantURI, options\.sourceURL\)/.test(hlsSource)],
  ["sniffed endpoint lists variants instead of one choice", /for \(const hlsChoice of hlsEndpointChoices\(sourceURL, sniffedMaster\)\)/.test(mediaSource)],
  // beeg 协议相对变体（//ipXXX.video.beeg.com/...）可解析且带签名参数不被误伤
  ["beeg master lists five variants highest-first", listHlsVariants(BEEG_MASTER).length === 5 && listHlsVariants(BEEG_MASTER)[0]?.height === 1080 && listHlsVariants(BEEG_MASTER)[4]?.height === 240],
  ["beeg master builds five choices", beegChoices.length === 5],
  ["beeg top choice is 1080p", beegChoices[0]?.height === 1080 && beegChoices[0]?.label.includes("1080p")],
  ["beeg variant URI resolves to absolute preview", Boolean(beegChoices[0]?.previewURL?.startsWith("https://ip179688276.video.beeg.com/") && beegChoices[0]?.previewURL?.includes("/index.m3u8"))],
  ["beeg variant URI keeps signature params", Boolean(beegChoices[0]?.hlsVariantURI?.includes("key=") && beegChoices[0]?.hlsVariantURI?.includes("reftag="))],
  ["beeg direct-fallback branch sniffs variants before single choice", /if \(safariHlsChoice && referer\) \{[\s\S]{0,600}sniffHlsManifest\(sourceURL, referer, safariUserAgent \|\| MOBILE_SAFARI_UA\)[\s\S]{0,500}probe\.safari-hls\.sniffed-variants/.test(mediaSource)],
  ["beeg single-choice fallback still exists", /probe\.safari-hls\.direct-fallback[\s\S]{0,400}choices: \[safariHlsChoice\]/.test(mediaSource)],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`HLS variant-choice checks failed: ${failed.join(", ")}`)
console.log(`HLS variant-choice checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
