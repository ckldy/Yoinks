import { Script } from "scripting"
import { selectHighestHlsVariant } from "./services/media"

// Real EPORNER-style master: 240p → 2160p variants.
const EPORNER_MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=420000,RESOLUTION=426x240,CODECS="avc1.42c00d,mp4a.40.2"
240p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=840000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"
480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5400000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=2560x1440,CODECS="avc1.640033,mp4a.40.2"
1440p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=25000000,RESOLUTION=3840x2160,CODECS="hev1.1.6.L153.B0,mp4a.40.2"
2160p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=426x240
lowest.m3u8
`

// No RESOLUTION attributes: highest BANDWIDTH wins.
const BANDWIDTH_ONLY_MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=500000
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000
high.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000
mid.m3u8
`

// xHamster-style master: 144p → 1080p.
const XHAMSTER_MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=256x144
144p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=426x240
240p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1600000,RESOLUTION=854x480
480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3200000,RESOLUTION=1280x720
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6400000,RESOLUTION=1920x1080
1080p.m3u8
`

// Direct media playlist: no #EXT-X-STREAM-INF.
const DIRECT_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=NONE
#EXTINF:2,
https://cdn.example/seg-001.ts
#EXTINF:2,
https://cdn.example/seg-002.ts
#EXT-X-ENDLIST
`

// HLS 下载器与清单摘要已拆分到 services/hls.ts；此处源码断言针对 selectHighestHlsVariant 的使用点。
const mediaSource = FileManager.readAsStringSync(`${Script.directory}/services/hls.ts`)

const checks: Array<[string, boolean]> = [
  ["picks the highest RESOLUTION variant", selectHighestHlsVariant(EPORNER_MASTER)?.uri === "2160p.m3u8"],
  ["resolves variant URI against the source base", selectHighestHlsVariant(EPORNER_MASTER)?.height === 2160],
  ["falls back to BANDWIDTH when RESOLUTION is absent", selectHighestHlsVariant(BANDWIDTH_ONLY_MASTER)?.uri === "high.m3u8"],
  ["picks highest even when low variant appears last", selectHighestHlsVariant(XHAMSTER_MASTER)?.uri === "1080p.m3u8"],
  ["returns undefined for direct media playlists", selectHighestHlsVariant(DIRECT_PLAYLIST) === undefined],
  ["skips STREAM-INF lines without a following URI", selectHighestHlsVariant("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\n") === undefined],
  ["native downloader uses selectHighestHlsVariant", /const variant = selectHighestHlsVariant\(master\)/.test(mediaSource)],
  ["manifest summary also uses selectHighestHlsVariant", /const variant = selectHighestHlsVariant\(master\)\n  if \(!variant\) return undefined/.test(mediaSource)],
  ["no first-variant regex remains in native downloader", !/const variant = master\.match\(\/\\^\\s\*#EXT-X-STREAM-INF/.test(mediaSource)],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`HLS highest-variant checks failed: ${failed.join(", ")}`)
console.log(`HLS highest-variant checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
