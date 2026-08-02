// DASH MPD → m3u8 桥接：轻量解析 MPD（SegmentTemplate / SegmentList VOD 子集），
// 把视频轨（与音频轨）合成 HLS 清单，复用 services/hls.ts 的原生分片下载/解密/合成管线。
// 参考 cat-catch mpd.js 的 MPD→m3u8 思路；on-demand（SegmentBase/sidx）暂不支持，回落 yt-dlp/ffmpeg。

import { AbortController, fetch } from "scripting"
import { downloadHlsMediaPlaylistText, type HlsManifestSummary } from "./hls"
import { MOBILE_SAFARI_UA } from "./douyin"
import { quote, runCommand } from "./shell-utils"
import { Path } from "scripting"
import { logEvent } from "./logs"

/** MPD URL 识别：.mpd 扩展名（含尾部斜杠/查询）或 DASH MIME 特征。 */
export function isMPDURL(url: string): boolean {
  const lower = String(url || "").toLowerCase()
  if (/\.mpd(?:$|[?#/])/.test(lower)) return true
  return lower.includes("application/dash+xml") || lower.includes("urn:mpeg:dash:schema:mpd")
}

/** 拉取 MPD 文本并用 DASH 特征串校验（urn:mpeg:dash:schema:mpd 或 <MPD）。 */
export async function fetchMPDText(url: string, referer?: string, userAgent?: string): Promise<string | null> {
  const ua = userAgent || MOBILE_SAFARI_UA
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const headers: Record<string, string> = { Accept: "application/dash+xml, application/xml, */*;q=0.9" }
      if (ua) headers["User-Agent"] = ua
      if (referer) headers.Referer = referer
      const response = await fetch(url, { headers, signal: controller.signal })
      if (!response.ok) return null
      const text = await response.text()
      if (!/urn:mpeg:dash:schema:mpd/.test(text) && !/<(?:MPD|mpd)\b/.test(text)) return null
      return text
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    return null
  }
}

function parseDurationSeconds(text: string | undefined): number | undefined {
  if (!text) return undefined
  const match = String(text).trim().match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/)
  if (!match) return undefined
  const hours = Number(match[1] || 0)
  const minutes = Number(match[2] || 0)
  const seconds = Number(match[3] || 0)
  return hours * 3600 + minutes * 60 + seconds
}

function attributeValue(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

function resolveURL(uri: string, baseURL: string): string | undefined {
  try {
    return new URL(uri, baseURL).toString()
  } catch {
    return undefined
  }
}

export type MPDTrack = {
  kind: "video" | "audio"
  width?: number
  height?: number
  bandwidth: number
  /** 分片绝对 URL（SegmentTemplate 展开或 SegmentList）。 */
  segments: string[]
  /** init 段绝对 URL（EXT-X-MAP 对应）。 */
  initURL?: string
  /** init 段字节范围（range="start-end" → { offset, length }）。 */
  initRange?: { offset: number; length: number }
  /** 单分片时长秒（进度/EXTINF 用，可缺省）。 */
  segmentDuration?: number
}

export type MPDPlan = { video: MPDTrack; audio?: MPDTrack }

function parseRange(range: string | undefined): { offset: number; length: number } | undefined {
  if (!range) return undefined
  const match = String(range).trim().match(/^(\d+)-(\d+)$/)
  if (!match) return undefined
  const start = Number(match[1])
  const end = Number(match[2])
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  return { offset: start, length: end - start + 1 }
}

/** 模板替换：$RepresentationID$ / $Number$ / $Bandwidth$；含 $Time$ 时返回 null（不支持时间线）。 */
function expandTemplate(template: string, repId: string, bandwidth: number, numberValue: number): string | null {
  if (template.includes("$Time$")) return null
  return template
    .replace(/\$RepresentationID\$/g, repId)
    .replace(/\$Bandwidth\$/g, String(bandwidth))
    .replace(/\$Number(?:%\d+d)?\$/g, (token) => {
      const widthMatch = token.match(/%(\d+)d/)
      const value = String(numberValue)
      return widthMatch ? value.padStart(Number(widthMatch[1]), "0") : value
    })
}

/** 解析 MPD 文本为视频/音频轨计划（支持 SegmentTemplate / SegmentList VOD 子集）。 */
export function parseMPD(mpdText: string, baseURL: string): MPDPlan | null {
  const text = String(mpdText || "")
  const mpdMatch = text.match(/<MPD\b([^>]*)>([\s\S]*?)<\/MPD>/i)
  if (!mpdMatch) return null
  const mpdAttrs = mpdMatch[1]
  const mpdBody = mpdMatch[2]
  const totalSeconds = parseDurationSeconds(attributeValue(mpdAttrs, "mediaPresentationDuration"))
  const periodMatch = mpdBody.match(/<Period\b([^>]*)>([\s\S]*?)<\/Period>/i)
  const periodBody = periodMatch ? periodMatch[2] : mpdBody
  const periodSeconds = periodMatch ? parseDurationSeconds(attributeValue(periodMatch[1], "duration")) : undefined
  const durationSeconds = totalSeconds ?? periodSeconds

  const tracks: MPDTrack[] = []
  const adaptationBlocks = periodBody.match(/<AdaptationSet\b[^>]*>[\s\S]*?<\/AdaptationSet>/gi) || []
  for (const adaptationBlock of adaptationBlocks) {
    const adaptationTag = adaptationBlock.match(/^<AdaptationSet\b([^>]*)>/i)?.[1] || ""
    const mimeType = attributeValue(adaptationTag, "mimeType") || ""
    const contentType = attributeValue(adaptationTag, "contentType") || ""
    const kind: "video" | "audio" | null = /video/i.test(mimeType) || /^video$/i.test(contentType) ? "video" : /audio/i.test(mimeType) || /^audio$/i.test(contentType) ? "audio" : null
    if (!kind) continue
    // AdaptationSet 级 SegmentTemplate（Representation 未覆盖时继承）
    const adaptationTemplateMatch = adaptationBlock.match(/<SegmentTemplate\b([^>]*)\/?>/i)
    const adaptationTemplate = adaptationTemplateMatch ? adaptationTemplateMatch[1] : undefined
    // 支持自闭合（<Representation .../>）与块（<Representation ...>...</Representation>）两种形态
    const representationTags = adaptationBlock.match(/<Representation\b[^>]*\/?>/gi) || []
    let searchIndex = 0
    for (const repOpen of representationTags) {
      const openIndex = adaptationBlock.indexOf(repOpen, searchIndex)
      const selfClosing = /\/>$/.test(repOpen)
      const repTag = repOpen.replace(/^<Representation\b/, "").replace(/\/?>$/, "")
      const repId = attributeValue(repTag, "id") || ""
      const bandwidth = Number(attributeValue(repTag, "bandwidth") || 0)
      const width = Number(attributeValue(repTag, "width") || 0) || undefined
      const height = Number(attributeValue(repTag, "height") || 0) || undefined
      let repBody = ""
      if (selfClosing) {
        searchIndex = openIndex + repOpen.length
      } else {
        const closeIndex = adaptationBlock.indexOf("</Representation>", openIndex + repOpen.length)
        repBody = closeIndex >= 0 ? adaptationBlock.slice(openIndex + repOpen.length, closeIndex) : ""
        searchIndex = closeIndex >= 0 ? closeIndex + "</Representation>".length : openIndex + repOpen.length
      }
      const track: MPDTrack = { kind, bandwidth: Number.isFinite(bandwidth) ? bandwidth : 0, segments: [], ...(width ? { width } : {}), ...(height ? { height } : {}) }
      const baseURLMatch = repBody.match(/<BaseURL\b[^>]*>([\s\S]*?)<\/BaseURL>/i)
      const baseURLValue = baseURLMatch ? baseURLMatch[1].trim() : undefined
      // SegmentList
      const segmentListMatch = repBody.match(/<SegmentList\b([^>]*)>([\s\S]*?)<\/SegmentList>/i) || adaptationBlock.match(/<SegmentList\b([^>]*)>([\s\S]*?)<\/SegmentList>/i)
      if (segmentListMatch) {
        const listAttrs = segmentListMatch[1]
        const listBody = segmentListMatch[2]
        const initAttr = attributeValue(listAttrs, "initialization")
        const initRange = parseRange(attributeValue(listAttrs, "indexRange"))
        const segmentURLs = listBody.match(/<SegmentURL\b[^>]*>/gi) || []
        for (const segmentURL of segmentURLs) {
          const media = attributeValue(segmentURL, "media")
          if (!media) continue
          const resolved = resolveURL(media, baseURLValue ? resolveURL(baseURLValue, baseURL) || baseURL : baseURL)
          if (resolved) track.segments.push(resolved)
        }
        if (initAttr) track.initURL = resolveURL(initAttr, baseURLValue ? resolveURL(baseURLValue, baseURL) || baseURL : baseURL)
        if (initRange) track.initRange = initRange
        if (track.segments.length) tracks.push(track)
        continue
      }
      // SegmentTemplate
      const templateMatch = repBody.match(/<SegmentTemplate\b([^>]*)\/?>/i)
      const templateTag = (templateMatch ? templateMatch[1] : undefined) || adaptationTemplate
      if (templateTag) {
        const mediaTemplate = attributeValue(templateTag, "media")
        const initializationTemplate = attributeValue(templateTag, "initialization")
        const startNumber = Number(attributeValue(templateTag, "startNumber") || 0)
        const templateDuration = Number(attributeValue(templateTag, "duration") || 0)
        const timescale = Number(attributeValue(templateTag, "timescale") || 1)
        if (mediaTemplate && templateDuration > 0 && durationSeconds !== undefined) {
          const count = Math.ceil((durationSeconds * timescale) / templateDuration)
          if (count > 0 && count <= 10000) {
            const repBase = baseURLValue ? resolveURL(baseURLValue, baseURL) : undefined
            for (let i = 0; i < count; i += 1) {
              const expanded = expandTemplate(mediaTemplate, repId, bandwidth, startNumber + i)
              if (!expanded) break
              const resolved = resolveURL(expanded, repBase || baseURL)
              if (resolved) track.segments.push(resolved)
            }
            if (initializationTemplate) {
              const expandedInit = expandTemplate(initializationTemplate, repId, bandwidth, startNumber)
              if (expandedInit) track.initURL = resolveURL(expandedInit, repBase || baseURL)
            }
            if (track.segments.length) {
              track.segmentDuration = templateDuration / timescale
              tracks.push(track)
            }
          }
        }
        continue
      }
      // 仅有 BaseURL（单文件 on-demand / progressive）：不支持（需要 sidx 解析），跳过
    }
  }
  if (!tracks.length) return null
  const videoTracks = tracks.filter((t) => t.kind === "video").sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth)
  const audioTracks = tracks.filter((t) => t.kind === "audio").sort((a, b) => b.bandwidth - a.bandwidth)
  const video = videoTracks[0]
  if (!video) return null
  const plan: MPDPlan = { video }
  const audio = audioTracks[0]
  if (audio) plan.audio = audio
  return plan
}

function quoteHlsURI(value: string): string {
  return value.replace(/"/g, "%22").replace(/\r?\n/g, "")
}

/** 把 MPD 轨合成 HLS 媒体清单文本（EXT-X-MAP + EXTINF + 分片 URL）。 */
export function buildHlsPlaylistFromMPDTrack(track: MPDTrack): string | null {
  if (!track.segments.length) return null
  const lines: string[] = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:4"]
  if (track.initURL) {
    const rangeAttr = track.initRange ? `,BYTERANGE="${track.initRange.length}@${track.initRange.offset}"` : ""
    lines.push(`#EXT-X-MAP:URI="${quoteHlsURI(track.initURL)}"${rangeAttr}`)
  }
  const duration = track.segmentDuration && track.segmentDuration > 0 ? track.segmentDuration.toFixed(2) : "2.0"
  for (const url of track.segments) lines.push(`#EXTINF:${duration},`, url)
  lines.push("#EXT-X-ENDLIST")
  return lines.join("\n")
}

/**
 * DASH MPD 原生下载：视频轨（与音频轨）分别合成 m3u8 → 复用 HLS 分片管线下载，
 * 存在独立音频轨时用 ffmpeg 合并；只有视频轨时直接作为结果。
 * 返回视频轨清单摘要（供完整性校验）；不支持（on-demand/无分片）返回 undefined。
 */
export async function downloadMpdNative(options: {
  sourceURL: string
  destination: string
  workDirectory: string
  referer?: string
  userAgent?: string
  onProgress?: (value: { fraction: number; stage: string; downloadedBytes?: number; totalBytes?: number; speed?: number }) => void
  isCancelFlagSet?: () => boolean
}): Promise<HlsManifestSummary | undefined> {
  const userAgent = options.userAgent || MOBILE_SAFARI_UA
  const mpdText = await fetchMPDText(options.sourceURL, options.referer, userAgent)
  if (!mpdText) return undefined
  const plan = parseMPD(mpdText, options.sourceURL)
  if (!plan) return undefined
  const baseOptions = {
    workDirectory: options.workDirectory,
    referer: options.referer,
    userAgent,
    onProgress: options.onProgress,
    isCancelFlagSet: options.isCancelFlagSet,
  }
  const videoText = buildHlsPlaylistFromMPDTrack(plan.video)
  if (!videoText) return undefined
  const videoDestination = Path.join(options.workDirectory, "mpd_video.mp4")
  options.onProgress?.({ fraction: 0.1, stage: "正在下载 DASH 视频轨" })
  const videoManifest = await downloadHlsMediaPlaylistText({ ...baseOptions, destination: videoDestination }, videoText, options.sourceURL)
  if (!videoManifest) return undefined
  // 音频轨：分别下载后用 ffmpeg 合并（-c copy，不重编码）。
  if (plan.audio) {
    const audioText = buildHlsPlaylistFromMPDTrack(plan.audio)
    if (audioText) {
      options.onProgress?.({ fraction: 0.6, stage: "正在下载 DASH 音频轨" })
      const audioDestination = Path.join(options.workDirectory, "mpd_audio.mp4")
      const audioManifest = await downloadHlsMediaPlaylistText({ ...baseOptions, destination: audioDestination }, audioText, options.sourceURL)
      if (audioManifest && FileManager.existsSync(audioDestination)) {
        options.onProgress?.({ fraction: 0.9, stage: "正在合并 DASH 音视频轨" })
        if (FileManager.existsSync(options.destination)) FileManager.removeSync(options.destination)
        const merge = await runCommand(
          `ffmpeg -nostdin -y -i ${quote(videoDestination)} -i ${quote(audioDestination)} -c copy -movflags +faststart ${quote(options.destination)}`,
          1800,
        )
        if (merge.exitCode !== 0 || !FileManager.existsSync(options.destination)) throw new Error("DASH 音视频合并失败")
        await logEvent({ level: "info", event: "download.mpd.merged", taskId: "", details: { safariRefererApplied: Boolean(options.referer) } })
      }
    }
  } else if (FileManager.existsSync(videoDestination)) {
    // 无独立音频轨：视频轨（可能 muxed）直接作为结果。
    if (FileManager.existsSync(options.destination)) FileManager.removeSync(options.destination)
    await FileManager.rename(videoDestination, options.destination)
  }
  if (!FileManager.existsSync(options.destination)) return undefined
  return videoManifest
}
