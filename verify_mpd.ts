import { Script } from "scripting"
import { buildHlsPlaylistFromMPDTrack, isMPDURL, parseMPD } from "./services/mpd"

const checks: Array<[string, boolean]> = []

// 1. SegmentTemplate：视频轨选最高 height，分片展开 $Number$，initURL 解析，音频轨存在
const TEMPLATE_MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S">
  <Period id="0" start="PT0S">
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <SegmentTemplate timescale="1000" initialization="init_v.mp4" media="v-$Number%05d$.m4s" startNumber="0" duration="2000"/>
      <Representation id="vlow" bandwidth="100000" width="320" height="180"/>
      <Representation id="vhigh" bandwidth="300000" width="320" height="240"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" contentType="audio">
      <SegmentTemplate timescale="1000" initialization="init_a.mp4" media="a-$Number$.m4s" startNumber="0" duration="2000"/>
      <Representation id="a0" bandwidth="64000"/>
    </AdaptationSet>
  </Period>
</MPD>`
{
  const plan = parseMPD(TEMPLATE_MPD, "https://cdn.example/v/manifest.mpd")
  checks.push(["SegmentTemplate 解析成功", plan !== null])
  checks.push(["视频轨选最高 height", plan?.video.height === 240 && plan?.video.bandwidth === 300000])
  checks.push(["视频分片按模板展开（%05d 补零）", plan?.video.segments.length === 2 && plan?.video.segments[0] === "https://cdn.example/v/v-00000.m4s" && plan?.video.segments[1] === "https://cdn.example/v/v-00001.m4s"])
  checks.push(["视频 initURL 解析", plan?.video.initURL === "https://cdn.example/v/init_v.mp4"])
  checks.push(["音频轨存在", plan?.audio !== undefined && plan?.audio.segments.length === 2])
  checks.push(["音频 initURL 解析", plan?.audio?.initURL === "https://cdn.example/v/init_a.mp4"])
  checks.push(["segmentDuration 计算", plan?.video.segmentDuration === 2])
}

// 2. SegmentList：SegmentURL + initialization
const LIST_MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <SegmentList timescale="1000" duration="2000" initialization="init.mp4">
        <SegmentURL media="seg-0.m4s"/>
        <SegmentURL media="seg-1.m4s"/>
      </SegmentList>
      <Representation id="v0" bandwidth="200000" width="320" height="240"/>
    </AdaptationSet>
  </Period>
</MPD>`
{
  const plan = parseMPD(LIST_MPD, "https://cdn.example/v/manifest.mpd")
  checks.push(["SegmentList 解析成功", plan !== null && plan.video.segments.length === 2])
  checks.push(["SegmentList 分片 URL", plan?.video.segments[1] === "https://cdn.example/v/seg-1.m4s"])
  checks.push(["SegmentList initURL", plan?.video.initURL === "https://cdn.example/v/init.mp4"])
}

// 3. on-demand（SegmentBase 无 SegmentTemplate/SegmentList）：不支持 → 解析失败
const ON_DEMAND_MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S">
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="v0" bandwidth="500000" width="320" height="240">
        <BaseURL>video.mp4</BaseURL>
        <SegmentBase indexRange="708-1133" timescale="15360">
          <Initialization range="0-707"/>
        </SegmentBase>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`
{
  const plan = parseMPD(ON_DEMAND_MPD, "https://cdn.example/v/manifest.mpd")
  checks.push(["on-demand（SegmentBase）解析返回 null", plan === null])
}

// 4. 非 MPD 文本 / 损坏 XML
{
  checks.push(["非 MPD 文本解析返回 null", parseMPD("<html></html>", "https://x/y") === null])
  checks.push(["空文本解析返回 null", parseMPD("", "https://x/y") === null])
}

// 5. isMPDURL
{
  checks.push(["isMPDURL 识别 .mpd", isMPDURL("https://cdn.example/manifest.mpd?token=1")])
  checks.push(["isMPDURL 识别尾部斜杠", isMPDURL("https://cdn.example/dash/manifest.mpd/")])
  checks.push(["isMPDURL 拒绝 .m3u8", !isMPDURL("https://cdn.example/playlist.m3u8")])
}

// 6. buildHlsPlaylistFromMPDTrack
{
  const plan = parseMPD(TEMPLATE_MPD, "https://cdn.example/v/manifest.mpd")
  const text = plan ? buildHlsPlaylistFromMPDTrack(plan.video) : null
  checks.push(["合成 m3u8 含 EXT-X-MAP", text !== null && /#EXT-X-MAP:URI="https:\/\/cdn\.example\/v\/init_v\.mp4"/.test(text)])
  checks.push(["合成 m3u8 含分片与 ENDLIST", text !== null && text.includes("#EXTINF:2.00,") && text.includes("https://cdn.example/v/v-00000.m4s") && /#EXT-X-ENDLIST/.test(text)])
}

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`MPD checks failed: ${failed.join(", ")}`)
console.log(`MPD checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
