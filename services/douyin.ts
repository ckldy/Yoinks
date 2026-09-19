import { Path, fetch, type Response } from "scripting"
import { downloadURLToFileWithProgress } from "./background-download"
import { createTaskId, logEvent } from "./logs"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sanitizeFileName(input: string): string {
  return (input || "douyin_video")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "douyin_video"
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function safeJSONParse(text: string | null | undefined): unknown | null {
  if (!text) return null
  const candidates = [
    text,
    text.trim(),
    text.replace(/\u2028|\u2029/g, ""),
    text.replace(/\\u002F/g, "/"),
  ]
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (typeof parsed === "string") {
        try {
          return JSON.parse(parsed)
        } catch {
          return parsed
        }
      }
      return parsed
    } catch {}
  }
  return null
}

export type ExtractedInfo = {
  pageURL: string
  canonical: string | null
  title: string
  description: string | null
  thumbnailURL: string | null
  imageURLs: string[]
  videoSrc: string | null
  apiDetailJSON: string | null
  routerDataJSON: string | null
  videoInfoResJSON: string | null
  bodyTextPreview: string
  resourceHints: string[]
  performanceMedia: string[]
  captchaPage: boolean
}

export type DownloadedFile = {
  filePath: string
  fileName: string
  finalURL: string
  bytesWritten: number
  mediaType: "video" | "image"
}

export type DownloadSuccess = {
  id: string
  sourceURL: string
  filePath: string
  fileName: string
  files: DownloadedFile[]
  mediaType: "video" | "image"
  extracted: ExtractedInfo
  finalURL: string
  bytesWritten: number
  createdAt: string
  matchedCandidateLabel: string
}

export type DownloadProgress = {
  fraction: number
  stage: string
}

export type DownloadLogFn = (message: string) => void
export type DownloadProgressFn = (progress: DownloadProgress) => void

export type DownloadCandidate = {
  label: string
  url: string
  headers: Record<string, string>
  /** DASH 视频档位关联的独立音频镜像；仅在线预览使用。 */
  audioURLs?: string[]
}

export const ROOT_DIR = Path.join(FileManager.documentsDirectory, "Yoinks")
export const DOWNLOAD_DIR = Path.join(ROOT_DIR, "Downloads")
export const IMAGE_DOWNLOAD_DIR = Path.join(ROOT_DIR, "Downloads")
export const MOBILE_SAFARI_UA = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
  "AppleWebKit/605.1.15 (KHTML, like Gecko)",
  "Version/18.0 Mobile/15E148 Safari/604.1",
].join(" ")

export const DESKTOP_CHROME_UA = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  "AppleWebKit/537.36 (KHTML, like Gecko)",
  "Chrome/126.0.0.0 Safari/537.36",
].join(" ")

function getNestedRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key]
  return isRecord(value) ? value : null
}

export function extractVideoId(url: string | null): string | null {
  if (!url) return null
  const match = url.match(/[?&]video_id=([^&]+)/)
  return match?.[1] || null
}

export function extractAwemeIdFromURL(url: string | null): string | null {
  if (!url) return null
  const match = url.match(/\/(?:share\/)?(?:video|note|gallery|slides)\/(\d{15,20})/) || url.match(/[?&](?:modal_id|aweme_id|item_id)=(\d{15,20})/)
  return match?.[1] || null
}

function isGalleryURL(url: string | null): boolean {
  if (!url) return false
  return /\/(?:share\/)?(?:note|gallery|slides)\//.test(url)
}

function firstURLFromAddress(address: unknown): string | null {
  if (!isRecord(address)) return null

  const urls = getArray(address.url_list)
    .map((item: unknown) => getString(item))
    .filter((item: string | null): item is string => Boolean(item))
  if (urls.length) return urls[0]

  return getString(address.url) || getString(address.uri)
}

function urlsFromAddress(address: unknown): string[] {
  if (!isRecord(address)) return []

  const urls = getArray(address.url_list)
    .map((item: unknown) => getString(item))
    .filter((item: string | null): item is string => Boolean(item))
  const singleURL = getString(address.url) || getString(address.uri)
  if (singleURL) urls.push(singleURL)

  return urls
}

function dedupeStrings(items: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    if (!item || seen.has(item)) continue
    seen.add(item)
    result.push(item)
  }
  return result
}

function normalizeMediaURLForDedupe(url: string): string {
  const withoutQuery = url.split("?")[0]
  return withoutQuery
    .replace(/^https?:\/\//, "")
    .replace(/~tplv-[^./]+/g, "")
    .replace(/image-cut-tos-[^/]+\//g, "")
}

function dedupeMediaURLs(items: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    if (!item) continue
    const key = normalizeMediaURLForDedupe(item)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

function collectMediaURLs(source: unknown): string[] {
  if (!source) return []
  if (typeof source === "string") return source ? [source] : []
  if (Array.isArray(source)) return source.flatMap((item) => collectMediaURLs(item))
  if (!isRecord(source)) return []

  const urls: string[] = []
  for (const key of ["url_list", "urlList"]) {
    const list = getArray(source[key])
    for (const item of list) {
      const url = getString(item)
      if (url) urls.push(url)
    }
  }
  for (const key of ["url", "uri"]) {
    const url = getString(source[key])
    if (url) urls.push(url)
  }
  return urls.sort((a, b) => mediaURLPriority(a) - mediaURLPriority(b))
}

function mediaURLPriority(url: string): number {
  const lower = url.toLowerCase()
  const isWatermarked = [
    "tplv-dy-water",
    "dy-water",
    "owner_watermark",
    "watermark_image",
    "watermark=1",
    "playwm",
  ].some((hint) => lower.includes(hint))
  return (isWatermarked ? 100 : 0) + (lower.includes(".webp") ? 1 : 0)
}

export function extractImageURLs(extracted: ExtractedInfo): string[] {
  const inlineRoot = extractInlineDetailRoot(extracted)
  const urls: string[] = []

  if (inlineRoot) {
    const imagePostInfo = getNestedRecord(inlineRoot, "image_post_info")
    const postImages = imagePostInfo
      ? (getArray(imagePostInfo.images).length ? getArray(imagePostInfo.images) : getArray(imagePostInfo.image_list))
      : []
    const images = postImages.length
      ? postImages
      : (getArray(inlineRoot.images).length ? getArray(inlineRoot.images) : getArray(inlineRoot.image_list))
    for (const image of images) {
      if (!isRecord(image)) continue
      const imageCandidates: string[] = []
      for (const key of [
        "watermark_free_download_url_list",
        "origin_image",
        "display_image",
        "download_url",
        "download_addr",
        "download_url_list",
        "owner_watermark_image",
      ]) {
        imageCandidates.push(...collectMediaURLs(image[key]))
      }
      imageCandidates.push(...urlsFromAddress(image))
      for (const key of ["download_url", "origin_cover", "cover", "large", "medium", "url"]) {
        imageCandidates.push(...urlsFromAddress(image[key]))
        const directURL = getString(image[key])
        if (directURL) imageCandidates.push(directURL)
      }
      const sortedCandidates = dedupeStrings(imageCandidates).sort((a, b) => mediaURLPriority(a) - mediaURLPriority(b))
      if (sortedCandidates[0]) {
        urls.push(sortedCandidates[0])
      }
    }
  }

  const hasStructuredImages = urls.length > 0
  if (!hasStructuredImages) {
    urls.push(...filterFallbackDOMImageURLs(extracted.imageURLs || []))
  }

  return dedupeMediaURLs(
    urls.filter((url) => {
      const lower = url.toLowerCase()
      return (
        lower.startsWith("http") &&
        !lower.includes("avatar") &&
        !lower.includes("music-cover") &&
        !lower.includes("emoji") &&
        !lower.includes("emoticon") &&
        !lower.includes("sticker") &&
        !lower.includes("logo") &&
        !lower.includes("favicon") &&
        !lower.includes("webcast") &&
        !lower.includes("douyin-pc") &&
        (lower.includes("douyinpic") ||
          lower.includes("p3-sign") ||
          lower.includes("tos-cn") ||
          lower.includes(".jpeg") ||
          lower.includes(".jpg") ||
          lower.includes(".png") ||
          lower.includes(".webp"))
      )
    })
  )
}

function filterFallbackDOMImageURLs(urls: string[]) {
  return urls.filter((url) => {
    const lower = url.toLowerCase()
    return (
      lower.startsWith("http") &&
      !lower.includes("avatar") &&
      !lower.includes("emoji") &&
      !lower.includes("emoticon") &&
      !lower.includes("sticker") &&
      !lower.includes("logo") &&
      !lower.includes("favicon") &&
      !lower.includes("music-cover") &&
      !lower.includes("webcast") &&
      (lower.includes("douyinpic") || lower.includes("p3-sign") || lower.includes("tos-cn")) &&
      !lower.includes("resize,w_") &&
      !lower.includes("tplv-dy-res")
    )
  })
}

export function extractThumbnailURL(extracted: ExtractedInfo): string | null {
  if (extracted.thumbnailURL) return extracted.thumbnailURL

  const inlineRoot = extractInlineDetailRoot(extracted)
  if (!inlineRoot) return null

  const video = getNestedRecord(inlineRoot, "video")
  if (video) {
    for (const key of ["cover", "origin_cover", "dynamic_cover", "animated_cover"]) {
      const url = firstURLFromAddress(video[key])
      if (url) return url
    }
  }

  const images = getArray(inlineRoot.images)
  for (const image of images) {
    const url = firstURLFromAddress(image)
    if (url) return url
  }

  return null
}

export function extractAwemeDetailRoot(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data)) return null

  const record = data

  if (isRecord(record.aweme_detail)) return record.aweme_detail
  if (isRecord(record.video) || typeof record.aweme_id === "string") return record

  const itemList = getArray(record.item_list)
  if (itemList.length > 0 && isRecord(itemList[0])) return itemList[0]

  const nestedData = record.data
  if (isRecord(nestedData) && isRecord(nestedData.aweme_detail)) {
    return nestedData.aweme_detail
  }

  return null
}

export function extractInlineDetailRoot(extracted: ExtractedInfo): Record<string, unknown> | null {
  const directCandidates = [
    safeJSONParse(extracted.apiDetailJSON),
    safeJSONParse(extracted.videoInfoResJSON),
    safeJSONParse(extracted.routerDataJSON),
  ]

  for (const candidate of directCandidates) {
    const root = extractAwemeDetailRoot(candidate)
    if (root) return root

    if (isRecord(candidate)) {
      const loaderData = getNestedRecord(candidate, "loaderData")
      if (loaderData) {
        for (const rawValue of Object.values(loaderData)) {
          const value = rawValue
          const hit = extractAwemeDetailRoot(value)
          if (hit) return hit
          if (isRecord(value) && isRecord(value.data)) {
            const nested = extractAwemeDetailRoot(value.data)
            if (nested) return nested
          }
          if (isRecord(value)) {
            const nested = extractAwemeDetailRoot(value.videoInfoRes)
            if (nested) return nested
          }
        }
      }
    }
  }

  for (const hint of extracted.resourceHints) {
    const parsed = safeJSONParse(hint)
    const root = extractAwemeDetailRoot(parsed)
    if (root) return root
  }

  return null
}

/**
 * 2026-08-18 瘦 detail 韧性：多路提取可用于构造 play 地址的 video_id。
 * 1) aweme 壳 video.video_id（完整 detail 才有）；2) videoSrc URL 的 video_id 参数；
 * 3) 页面/源 URL 中的数字作品 ID（抖音 play 接口的 video_id 与 aweme_id 同值）。
 */
export function resolveFallbackVideoId(extracted: ExtractedInfo, sourceURL: string): string | null {
  const inlineRoot = extractInlineDetailRoot(extracted)
  const video = inlineRoot && typeof inlineRoot.video === "object" && inlineRoot.video !== null
    ? (inlineRoot.video as Record<string, unknown>)
    : null
  const fromVideo = video && typeof video.video_id === "string" ? video.video_id : null
  if (fromVideo) return fromVideo
  const fromVideoSrc = extractVideoId(extracted.videoSrc)
  if (fromVideoSrc) return fromVideoSrc
  return (
    extractAwemeIdFromURL(extracted.pageURL) ||
    extractAwemeIdFromURL(extracted.canonical) ||
    extractAwemeIdFromURL(sourceURL)
  )
}

export function buildDownloadCandidates(
  extracted: ExtractedInfo,
  preferNoWatermark: boolean
): DownloadCandidate[] {
  const baseHeaders = {
    "User-Agent": MOBILE_SAFARI_UA,
    Origin: "https://www.douyin.com",
    Accept: "*/*",
  }
  const pageReferer = extracted.pageURL
  const canonicalReferer = extracted.canonical || extracted.pageURL || "https://www.douyin.com/"
  const candidates: DownloadCandidate[] = []

  const inlineRoot = extractInlineDetailRoot(extracted)
  if (inlineRoot) {
    const video = getNestedRecord(inlineRoot, "video")
    if (video) {
      const pushAddress = (label: string, address: unknown, audioURLs?: string[]) => {
        if (!isRecord(address)) return
        const addressRecord = address
        const urls = getArray(addressRecord.url_list)
          .map((item: unknown) => getString(item))
          .filter((item: string | null): item is string => Boolean(item))
        for (const url of urls) {
          if (preferNoWatermark && url.includes("/playwm/")) {
            candidates.push({
              label: `${label}_replace_playwm_to_play`,
              url: url.replace("/playwm/", "/play/"),
              headers: {
                ...baseHeaders,
                Referer: pageReferer,
              },
              audioURLs,
            })
          }
          candidates.push({
            label,
            url,
            headers: {
              ...baseHeaders,
              Referer: pageReferer,
            },
            audioURLs,
          })
        }
      }

      pushAddress("inline_play_addr_h264", video.play_addr_h264)
      pushAddress("inline_play_addr", video.play_addr)
      pushAddress("inline_play_addr_265", video.play_addr_265)
      pushAddress("inline_download_addr", video.download_addr)

      const normalizeFileId = (value: unknown): string | null => {
        if (typeof value !== "string" && typeof value !== "number") return null
        const normalized = String(value).trim()
        return normalized || null
      }
      const collectAudioURLs = (source: Record<string, unknown>): string[] => {
        const urls: string[] = []
        const appendAddress = (address: unknown) => {
          if (Array.isArray(address)) {
            urls.push(...address.map((value) => getString(value)).filter((url): url is string => Boolean(url)))
            return
          }
          if (!isRecord(address)) return
          urls.push(...urlsFromAddress(address))
          urls.push(...[address.main_url, address.backup_url, address.fallback_url]
            .map((value) => getString(value))
            .filter((url): url is string => Boolean(url)))
        }

        appendAddress(source.url_list)
        for (const key of ["play_addr", "download_addr", "audio_addr", "audio_play_addr"]) {
          appendAddress(source[key])
        }
        return dedupeStrings(urls)
      }

      const audioURLsByFileId = new Map<string, string[]>()
      for (const item of getArray(video.bit_rate_audio)) {
        if (!isRecord(item)) continue
        const audioMeta = getNestedRecord(item, "audio_meta")
        const fileId = normalizeFileId(audioMeta?.file_id ?? item.file_id)
        if (!fileId) continue
        const urls = dedupeStrings([
          ...(audioMeta ? collectAudioURLs(audioMeta) : []),
          ...collectAudioURLs(item),
        ])
        if (urls.length) audioURLsByFileId.set(fileId, urls)
      }

      const bitRates = getArray(video.bit_rate)
      for (const item of bitRates) {
        if (!isRecord(item)) continue
        const gearName = getString(item.gear_name) || getString(item.quality_type) || "bit_rate"
        const videoExtra = safeJSONParse(getString(item.video_extra))
        const audioFileId = isRecord(videoExtra) ? normalizeFileId(videoExtra.audio_file_id) : null
        pushAddress(`inline_bit_rate_${gearName}`, item.play_addr, audioFileId ? audioURLsByFileId.get(audioFileId) : undefined)
      }
    }
  }

  if (!extracted.videoSrc || inlineRoot) {
    // 有内嵌 aweme 数据（detail API）时，videoSrc 可能是广告流，不再混入候选。
    return dedupeCandidates(candidates)
  }

  const videoId = extractVideoId(extracted.videoSrc)
  const isMobilePlayURL = extracted.videoSrc.includes("m.douyin.com/aweme/v1/play")

  if (preferNoWatermark) {
    if (extracted.videoSrc.includes("/playwm/") && !isMobilePlayURL) {
      // 桌面版 playwm→play 替换；移动版 m.douyin.com/aweme/v1/playwm/ 替换为 /play/ 会 404，保留原 URL。
      candidates.push({
        label: "replace_playwm_to_play",
        url: extracted.videoSrc.replace("/playwm/", "/play/"),
        headers: {
          ...baseHeaders,
          Referer: pageReferer,
        },
      })
    }

    if (videoId && !isMobilePlayURL) {
      candidates.push({
        label: "constructed_play_watermark0",
        url: `https://www.iesdouyin.com/aweme/v1/play/?video_id=${videoId}&ratio=720p&line=0&is_play_url=1&watermark=0&source=PackSourceEnum_PUBLISH`,
        headers: {
          ...baseHeaders,
          Referer: canonicalReferer,
        },
      })
    }
  }

  candidates.push({
    label: "videoSrc_pageReferer",
    url: extracted.videoSrc,
    headers: {
      ...baseHeaders,
      Referer: pageReferer,
    },
  })

  candidates.push({
    label: "videoSrc_canonicalReferer",
    url: extracted.videoSrc,
    headers: {
      ...baseHeaders,
      Referer: canonicalReferer,
    },
  })

  return dedupeCandidates(candidates)
}

function dedupeCandidates(candidates: DownloadCandidate[]) {
  const seen = new Set<string>()
  const result: DownloadCandidate[] = []
  for (const item of candidates) {
    if (!item.url || seen.has(item.url)) continue
    seen.add(item.url)
    result.push(item)
  }
  return result
}

async function ensureDir(path: string) {
  if (!(await FileManager.exists(path))) {
    await FileManager.createDirectory(path, true)
  }
}

export async function ensureDownloadDirectories() {
  await ensureDir(ROOT_DIR)
  await ensureDir(DOWNLOAD_DIR)
  await ensureDir(IMAGE_DOWNLOAD_DIR)
}

export function isLikelyMediaResponse(finalURL: string, mimeType?: string): boolean {
  const mime = mimeType || ""
  if (mime.startsWith("video/")) return true
  if (mime === "application/octet-stream") return true
  return ["douyinvod", ".mp4", "video_mp4", "tos-cn", "aweme.snssdk.com/aweme/v1/play", "m.douyin.com/aweme/v1/play"].some((token) => finalURL.includes(token))
}

export function isLikelyImageResponse(finalURL: string, mimeType?: string): boolean {
  const mime = mimeType || ""
  if (mime.startsWith("image/")) return true
  const lower = finalURL.toLowerCase()
  return [".jpg", ".jpeg", ".png", ".webp", "douyinpic", "p3-sign", "tos-cn"].some((token) => lower.includes(token))
}

function imageExtensionFromResponse(finalURL: string, mimeType?: string): string {
  const mime = mimeType || ""
  if (mime.includes("png")) return "png"
  if (mime.includes("webp")) return "webp"
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg"
  const pathMatch = finalURL.toLowerCase().match(/\.(jpe?g|png|webp)(?:[?#]|$)/)
  return pathMatch?.[1]?.replace("jpeg", "jpg") || "jpg"
}

async function cancelResponseBody(response: Response) {
  try {
    await response.body.getReader().cancel("handled by BackgroundURLSession")
  } catch {}
}

async function downloadImageBatch(options: {
  sourceURL: string
  extracted: ExtractedInfo
  imageURLs: string[]
  onProgress: (fraction: number, stage: string) => void
  onLog: (message: string) => void
}): Promise<DownloadSuccess> {
  const { sourceURL, extracted, imageURLs, onProgress, onLog } = options
  const baseName = sanitizeFileName(extracted.title || "douyin_images")
  const files: DownloadedFile[] = []
  let lastError = "未开始下载图片"

  onLog(`检测到 ${imageURLs.length} 张图片，开始批量下载图文。`)
  onProgress(0.22, `检测到 ${imageURLs.length} 张图片`)

  for (let index = 0; index < imageURLs.length; index++) {
    const imageURL = imageURLs[index]
    const progressStart = 0.22 + (index / imageURLs.length) * 0.68
    const progressEnd = 0.22 + ((index + 1) / imageURLs.length) * 0.68
    onProgress(progressStart, `正在下载图片 ${index + 1}/${imageURLs.length}`)
    onLog(`下载图片 ${index + 1}/${imageURLs.length}`)

    try {
      const response = await fetch(imageURL, {
        method: "GET",
        timeout: 180,
        debugLabel: `douyin-downloader-image-${index + 1}`,
        headers: {
          "User-Agent": MOBILE_SAFARI_UA,
          Referer: extracted.pageURL,
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
      })

      if (!response.ok) {
        lastError = `image_${index + 1}: ${response.status} ${response.statusText}`
        onLog(`图片下载失败：${lastError}`)
        continue
      }

      if (!isLikelyImageResponse(response.url, response.mimeType)) {
        lastError = `image_${index + 1}: 响应不是图片资源 ${response.mimeType || "unknown"}`
        onLog(`图片跳过：${lastError}`)
        continue
      }

      const ext = imageExtensionFromResponse(response.url, response.mimeType)
      const fileName = `${baseName}_${String(files.length + 1).padStart(2, "0")}.${ext}`
      const filePath = Path.join(IMAGE_DOWNLOAD_DIR, fileName)
      await cancelResponseBody(response)
      await downloadURLToFileWithProgress({
        url: response.url,
        destination: filePath,
        headers: {
          "User-Agent": MOBILE_SAFARI_UA,
          Referer: extracted.pageURL,
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
        start: progressStart,
        end: progressEnd,
        stage: `正在下载图片 ${index + 1}/${imageURLs.length}`,
        onProgress: ({ fraction, stage }) => onProgress(fraction, stage),
      })
      const bytesWritten = FileManager.statSync(filePath).size
      if (bytesWritten === 0) {
        lastError = `image_${index + 1}: 图片响应为空`
        onLog(`图片跳过：${lastError}`)
        continue
      }
      files.push({
        filePath,
        fileName,
        finalURL: response.url,
        bytesWritten,
        mediaType: "image",
      })
      onLog(`图片写入完成：${fileName}，大小 ${formatBytes(bytesWritten)}`)
    } catch (error) {
      lastError = `image_${index + 1}: ${error instanceof Error ? error.message : String(error)}`
      onLog(`图片下载异常：${lastError}`)
    }
  }

  if (!files.length) {
    throw new Error(`图文图片下载失败：${lastError}`)
  }

  const bytesWritten = files.reduce((sum, file) => sum + file.bytesWritten, 0)
  onProgress(1, `图文下载完成：${files.length} 张图片`)

  return {
    id: createTaskId(),
    sourceURL,
    filePath: files[0].filePath,
    fileName: files.length === 1 ? files[0].fileName : `${baseName}（${files.length}张图片）`,
    files,
    mediaType: "image",
    extracted: {
      ...extracted,
      imageURLs,
    },
    finalURL: files.map((file) => file.finalURL).join("\n"),
    bytesWritten,
    createdAt: new Date().toISOString(),
    matchedCandidateLabel: `image_batch_${files.length}`,
  }
}

// 注入式签名详情接口捕获：在页面上下文中 hook fetch/XHR，把页面自身发出的
// /aweme/v1/web/aweme/ 响应（含完整 aweme_detail）缓存到 window.__dyCapturedDetails。
// 幂等：重复调用只检查已有缓存，不重复安装。页面加载后约 3 秒才发起签名请求，
// loadURL 返回后尽早轮询注入即可命中。
const DY_DETAIL_HOOK_JS = `
(() => {
  if (!window.__dyDetailHookInstalled) {
    window.__dyDetailHookInstalled = true
    window.__dyCapturedDetails = window.__dyCapturedDetails || []
    const pushDetail = (url, text) => {
      try {
        const json = JSON.parse(text)
        if (json && typeof json === 'object' && json.aweme_detail !== undefined) {
          window.__dyCapturedDetails.push({ url: url, text: text })
          if (window.__dyCapturedDetails.length > 5) window.__dyCapturedDetails.shift()
        }
      } catch (e) {}
    }
    const origFetch = window.fetch.bind(window)
    window.fetch = async (...args) => {
      const response = await origFetch(...args)
      try {
        const url = (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url)) || ''
        if (url.indexOf('/aweme/v1/web/aweme/') !== -1) {
          response.clone().text().then((text) => pushDetail(url, text)).catch(() => {})
        }
      } catch (e) {}
      return response
    }
    const origOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      try { this.__dyHookUrl = String(url) } catch (e) {}
      return origOpen.apply(this, [method, url, ...rest])
    }
    const origSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.send = function(...args) {
      try {
        const u = this.__dyHookUrl || ''
        if (u.indexOf('/aweme/v1/web/aweme/') !== -1) {
          this.addEventListener('load', () => {
            try { pushDetail(u, this.responseText || '') } catch (e) {}
          })
        }
      } catch (e) {}
      return origSend.apply(this, args)
    }
  }
})()
return {
  count: (window.__dyCapturedDetails || []).length,
  // 2026-08-18 实锤：TTGCaptcha 对象和 rc-verifycenter/rmc-nocaptcha iframe 在正常页面
  // 也存在（验证 SDK 预加载），均不能作为滑块判据；真实滑块页会显示验证文案。
  captcha: (document.title || '').indexOf('验证码') !== -1
    || (document.body && (document.body.innerText || '').indexOf('请完成验证') !== -1)
    || (document.body && (document.body.innerText || '').indexOf('拖动滑块') !== -1)
    || (document.body && (document.body.innerText || '').indexOf('安全验证') !== -1),
  hasVideo: document.querySelector('video') !== null,
}
`

export async function extractFromWebView(
  url: string,
  options?: {
    onLog?: DownloadLogFn
    onProgress?: DownloadProgressFn
    userAgent?: string
    mode?: "desktop" | "mobile"
    /** Persistent local login WebView; never serialized or sent remotely. */
    webView?: WebViewController
  }
): Promise<ExtractedInfo> {
  const log = options?.onLog
  const report = options?.onProgress
  const webView = options?.webView || new WebViewController()
  const ownsWebView = !options?.webView

  try {
    // 1) 解析短链 → 提取 aweme_id → 直接打开主站完整视频页（分享页已不再下发媒体数据）。
    const resolvedURL = url.includes("v.douyin.com") ? await resolveShortLink(url) : url
    const awemeId = extractAwemeIdFromURL(resolvedURL) || extractAwemeIdFromURL(url)
    const galleryHint =
      /\/(?:share\/)?(?:note|gallery|slides)\//.test(url) ||
      /\/(?:share\/)?(?:note|gallery|slides)\//.test(resolvedURL)
    const targetURL = awemeId
      ? (galleryHint ? `https://www.douyin.com/note/${awemeId}` : `https://www.douyin.com/video/${awemeId}`)
      : resolvedURL

    // 2) 收集页面自己发出的签名接口请求（带 a_bogus 等），供稍后重放。
    const signedDetailURLs: string[] = []
    webView.shouldAllowRequest = async (request) => {
      try {
        if (request.url.includes("/aweme/v1/web/") && !signedDetailURLs.includes(request.url)) {
          signedDetailURLs.push(request.url)
        }
      } catch {}
      return true
    }

    // 3) 预置匿名 webid cookie（s_v_web_id），降低匿名风控概率；持久数据存储可累积 ttwid。
    const webId = generateDouyinWebId()
    await webView.setCookie({
      name: "s_v_web_id",
      value: webId,
      domain: ".douyin.com",
      path: "/",
      isSecure: false,
      isHTTPOnly: false,
      isSessionOnly: false,
      expiresDate: new Date(Date.now() + 365 * 86400_000),
    })

    // UA 策略（2026-08-18 实锤）：伪造的桌面 UA 尾部（Version/18.0 Safari/605.1.15）与真实
    // WKWebView UA 不符会被抖音 secsdk 识别触发滑块风控；移动 iPhone UA 会被 302 到
    // m.douyin.com 分享引导页（无 detail）。使用系统默认真实 UA（本机 iPad Safari，桌面
    // 布局）页面正常打开并自签名 detail。因此 desktop 模式默认不设置自定义 UA；
    // mobile 模式保持 iPhone UA（页面会跳分享页但可兜底 playwm）。
    const mode = options?.mode || "mobile"
    const userAgent = options?.userAgent ?? (mode === "desktop" ? undefined : MOBILE_SAFARI_UA)
    if (userAgent) {
      log?.(mode === "desktop" ? "正在设置桌面 Safari UA…" : "正在创建 WebView 并设置 iPhone UA（指纹自洽，规避桌面伪装风控）…")
      webView.setCustomUserAgent(userAgent)
    } else {
      log?.("使用本机真实 Safari UA（不设置自定义 UA，规避伪造 UA 风控）…")
    }

    report?.({ fraction: 0.05, stage: "正在打开视频页面" })
    log?.(`开始加载页面：${targetURL}`)
    await webView.loadURL(targetURL)

    report?.({ fraction: 0.1, stage: "正在等待页面签名详情接口" })

    // 4) 尽早注入 fetch/XHR hook 捕获页面自身发出的签名详情接口响应（a_bogus/签名由页面
    //    JS 生成，捕获响应文本即拿到正片数据，无需重放、不依赖 performance entries）。
    //    轮询同时激活视频节点，辅助页面初始化播放器发起签名请求。
    let capturedDetailText: string | null = null
    let videoActivated = false
    let videoSeenAt = -1
    const maxPolls = mode === "desktop" ? 40 : 30
    for (let index = 0; index < maxPolls; index += 1) {
      let captured: Array<{ url: string; text: string }> | null = null
      let captchaDetected = false
      try {
        const state = await webView.evaluateJavaScript<{ count: number; captcha: boolean; hasVideo: boolean }>(DY_DETAIL_HOOK_JS)
        captchaDetected = Boolean(state && state.captcha)
        if (videoSeenAt < 0 && state && state.hasVideo) videoSeenAt = index
        if (state && state.count > 0) {
          captured = await webView.evaluateJavaScript<Array<{ url: string; text: string }>>(
            "return (window.__dyCapturedDetails || []).slice(-1)"
          )
        }
      } catch {}
      if (captured && captured.length && captured[0].text) {
        capturedDetailText = captured[0].text
        log?.("已捕获页面签名作品详情接口响应。")
        break
      }
      if (captchaDetected) {
        log?.("检测到抖音验证码中间页（风控），提前结束等待。")
        break
      }
      // 移动版页面通常不发送签名 detail 接口，video 节点出现后再等约 2 秒即可读取正片地址。
      if (mode !== "desktop" && videoSeenAt >= 0 && index - videoSeenAt >= 4) {
        log?.("页面视频节点已就绪，提前结束等待。")
        break
      }
      if (!videoActivated) {
        try {
          await webView.evaluateJavaScript(`
            (() => {
              const video = document.querySelector('video')
              if (video) {
                try {
                  video.muted = true
                  video.play().catch(() => {})
                } catch (e) {}
              }
              return Boolean(video)
            })()
          `)
          videoActivated = true
        } catch {}
      }
      await sleep(500)
    }
    if (!capturedDetailText) {
      log?.("等待页面签名详情接口超时，继续尝试重放或兜底接口。")
    } else {
      report?.({ fraction: 0.14, stage: "等待播放器使用详情数据" })
      await sleep(1200)
    }

    report?.({ fraction: 0.18, stage: "正在读取页面内嵌数据" })
    const data = await webView.evaluateJavaScript<ExtractedInfo>(`
      const mediaEntries = performance.getEntriesByType('resource')
        .map((item) => item.name)
        .filter((name) => ['video','playwm','/play/','mp4','m3u8','aweme','douyinvod','tos-cn','iteminfo','image','douyinpic'].some((token) => name.includes(token)))
      const scripts = Array.from(document.scripts)
        .map((s) => s.textContent || '')
        .filter((text) => ['aweme_detail','play_addr','bit_rate','playwm','video_id','iteminfo','_ROUTER_DATA','videoInfoRes','image_post_info','images'].some((token) => text.includes(token)))
        .slice(0, 8)
        .map((text) => text.slice(0, 12000))
      let routerDataJSON = null
      let videoInfoResJSON = null
      try {
        if (typeof window._ROUTER_DATA !== 'undefined') {
          routerDataJSON = JSON.stringify(window._ROUTER_DATA)
          const loaderValues = Object.values(window._ROUTER_DATA?.loaderData || {})
          const matched = loaderValues.find((item) => item?.videoInfoRes)?.videoInfoRes
          if (matched) {
            videoInfoResJSON = JSON.stringify(matched)
          }
        }
      } catch (e) {}
      try {
        if (!videoInfoResJSON && typeof window.videoInfoRes !== 'undefined') {
          videoInfoResJSON = JSON.stringify(window.videoInfoRes)
        }
      } catch (e) {}
      return {
        pageURL: location.href,
        canonical: document.querySelector('link[rel="canonical"]')?.href || null,
        title: document.title || '',
        description: document.querySelector('meta[name="description"]')?.content || null,
        thumbnailURL: document.querySelector('meta[property="og:image"]')?.content
          || document.querySelector('meta[name="twitter:image"]')?.content
          || document.querySelector('video')?.poster
          || null,
        imageURLs: Array.from(document.images)
          .map((img) => img.currentSrc || img.src)
          .filter(Boolean)
          .slice(0, 80),
        videoSrc: document.querySelector('video')?.currentSrc || document.querySelector('video')?.src || null,
        apiDetailJSON: null,
        routerDataJSON,
        videoInfoResJSON,
        bodyTextPreview: document.body?.innerText?.slice(0, 600) || '',
        resourceHints: scripts,
        performanceMedia: mediaEntries,
        captchaPage: (document.title || '').includes('验证码')
          || (document.body && (document.body.innerText || '').indexOf('请完成验证') !== -1)
          || (document.body && (document.body.innerText || '').indexOf('拖动滑块') !== -1)
          || (document.body && (document.body.innerText || '').indexOf('安全验证') !== -1),
      }
    `)

    log?.(`页面信息读取完成：title=${data.title || "(空)"}`)
    if (data.captchaPage) {
      throw new Error("抖音触发滑块验证风控：请稍后（建议 10 分钟以上）重试，或切换网络后再试；可在设置页使用本机抖音扫码登录后重新测试")
    }
    const preliminaryImages = extractImageURLs(data)
    const galleryLike = isGalleryURL(url) || isGalleryURL(data.canonical) || isGalleryURL(data.pageURL)
    let hasInlineRoot = Boolean(extractInlineDetailRoot(data))
    // 2026-08-18 瘦 detail 韧性：hook 竞态未捕获签名响应时，内嵌 routerData/videoInfoRes 可能只有
    // aweme 壳（video.bit_rate 为空、无 video_id）。此时仍要尝试 hook 赋值/重放/兑底拿完整 bit_rate，
    // 否则只回退 videoSrc 单档（本地解析偶发“只出 1 个格式”的根因之一）。
    let localBitRateCount = getArray(getNestedRecord(extractInlineDetailRoot(data) || {}, "video")?.bit_rate).length
    let hasRichDetail = hasInlineRoot && localBitRateCount > 0

    // 4.5) 优先使用注入 hook 捕获的页面签名详情响应（页面自生成签名，天然有效且无需重放）。
    if (capturedDetailText && !hasRichDetail) {
      data.apiDetailJSON = capturedDetailText
      hasInlineRoot = true
      localBitRateCount = getArray(getNestedRecord(extractInlineDetailRoot(data) || {}, "video")?.bit_rate).length
      hasRichDetail = localBitRateCount > 0
      log?.("使用注入捕获的签名详情数据。")
    }

    // 4) 兜底：重放页面自身发出的带签名 detail 请求（a_bogus 由页面 JS 生成，重放即可复用签名与 cookie）。
    //    注意：shouldAllowRequest 只拦截导航请求不拦截 fetch，真正可靠的 URL 来源是 performance entries。
    const detailURLsFromPerformance = (data.performanceMedia || []).filter((item) =>
      item.includes("/aweme/v1/web/aweme/detail/") || item.includes("/aweme/v1/web/aweme/")
    )
    const allDetailURLs = Array.from(new Set([...signedDetailURLs, ...detailURLsFromPerformance]))
    if (!hasRichDetail && allDetailURLs.length) {
      report?.({ fraction: 0.19, stage: "正在重放签名作品详情接口" })
      try {
        const replayed = await replaySignedDetailURL(webView, allDetailURLs)
        if (replayed) {
          data.apiDetailJSON = replayed
          localBitRateCount = getArray(getNestedRecord(extractInlineDetailRoot(data) || {}, "video")?.bit_rate).length
          hasRichDetail = localBitRateCount > 0
          log?.("签名作品详情接口重放命中。")
          if (!data.title) {
            const root = extractInlineDetailRoot(data)
            if (root) {
              data.title = getString(root.desc) || getString(root.caption) || data.title
            }
          }
        } else {
          log?.("签名作品详情接口重放未命中，继续使用页面内嵌数据。")
        }
      } catch (error) {
        log?.(`签名作品详情接口重放跳过：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // 5) 兑底：无签名 fetch 作品详情接口（依赖预置 cookie，成功率较低）。
    const shouldFetchDetail = galleryLike
      || (!hasRichDetail && (hasInlineRoot || (!data.videoSrc && preliminaryImages.length === 0)))
    const fallbackAwemeId = shouldFetchDetail
      ? (extractAwemeIdFromURL(data.canonical) || extractAwemeIdFromURL(data.pageURL) || awemeId)
      : null
    if (fallbackAwemeId && !hasRichDetail) {
      report?.({ fraction: 0.2, stage: "正在尝试读取作品详情接口" })
      try {
        const apiDetailJSON = await fetchAwemeDetailInWebView(webView, fallbackAwemeId)
        if (apiDetailJSON) {
          data.apiDetailJSON = apiDetailJSON
          localBitRateCount = getArray(getNestedRecord(extractInlineDetailRoot(data) || {}, "video")?.bit_rate).length
          hasRichDetail = localBitRateCount > 0
          log?.("作品详情接口已命中。")
        } else {
          log?.("作品详情接口未命中，继续使用页面内嵌数据。")
        }
      } catch (error) {
        log?.(`作品详情接口跳过：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    log?.(`本地格式证据：detail=${data.apiDetailJSON ? "有" : "无"}，bitRate=${localBitRateCount}，登录会话=${options?.webView ? "有" : "无"}`)
    log?.(`videoSrc=${data.videoSrc ? "已提取" : "未提取"}，apiDetail=${data.apiDetailJSON ? "有" : "无"}，routerData=${data.routerDataJSON ? "有" : "无"}，videoInfoRes=${data.videoInfoResJSON ? "有" : "无"}`)
    data.thumbnailURL = extractThumbnailURL(data)
    const structuredImageCount = extractImageURLs({ ...data, imageURLs: [] }).length
    data.imageURLs = extractImageURLs(data)
    log?.(`thumbnail=${data.thumbnailURL ? "已提取" : "未提取"}`)
    log?.(`imageURLs=${data.imageURLs.length}，structuredImages=${structuredImageCount}`)
    log?.(`performanceMedia=${data.performanceMedia.length}，resourceHints=${data.resourceHints.length}`)

    return data
  } finally {
    if (ownsWebView) webView.dispose()
  }
}

async function resolveShortLink(url: string): Promise<string> {
  try {
    const response = await fetch(url, { method: "GET", timeout: 20, debugLabel: "douyin-resolve-shortlink" })
    return response.url || url
  } catch {
    return url
  }
}

function generateDouyinWebId(): string {
  return (Date.now().toString() + String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")).slice(-19)
}

async function replaySignedDetailURL(webView: WebViewController, urls: string[]): Promise<string | null> {
  const targets = JSON.stringify(urls.slice(0, 3))
  return webView.evaluateJavaScript<string | null>(`
    (async () => {
      const urls = ${targets}
      for (const url of urls) {
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 5000)
          const response = await fetch(url, {
            credentials: 'include',
            signal: controller.signal,
            headers: { accept: 'application/json, text/plain, */*' },
          })
          clearTimeout(timer)
          if (!response.ok) continue
          const text = await response.text()
          try {
            const json = JSON.parse(text)
            if (json && typeof json === 'object' && json.aweme_detail !== undefined) return text
          } catch (e) {}
        } catch (e) {}
      }
      return null
    })()
  `)
}

async function fetchAwemeDetailInWebView(webView: WebViewController, awemeId: string): Promise<string | null> {
  const escapedAwemeId = JSON.stringify(awemeId)
  return webView.evaluateJavaScript<string | null>(`
    (async () => {
      const awemeId = ${escapedAwemeId}
      const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve(null), ms))
      const fetchDetail = async () => {
        const baseParams = {
          device_platform: 'webapp',
          channel: 'channel_pc_web',
          update_version_code: '170400',
          pc_client_type: '1',
          pc_libra_divert: 'Windows',
          version_code: '290100',
          version_name: '29.1.0',
          cookie_enabled: 'true',
          screen_width: String(window.screen?.width || 390),
          screen_height: String(window.screen?.height || 844),
          browser_language: navigator.language || 'zh-CN',
          browser_platform: navigator.platform || 'iPhone',
          browser_name: 'Safari',
          browser_version: '18.0',
          browser_online: String(navigator.onLine),
          engine_name: 'WebKit',
          engine_version: '605.1.15',
          os_name: 'iOS',
          os_version: '18',
          cpu_core_num: String(navigator.hardwareConcurrency || 8),
          device_memory: '8',
          platform: 'PC',
          downlink: '10',
          effective_type: '4g',
          round_trip_time: '200',
          support_h265: '1',
          support_dash: '1',
          uifid: '',
          aweme_id: awemeId,
        }
        const endpoints = [
          '/aweme/v1/web/aweme/detail/',
          'https://www.douyin.com/aweme/v1/web/aweme/detail/',
          'https://www.iesdouyin.com/aweme/v1/web/aweme/detail/',
        ]
        for (const aid of ['6383', '1128']) {
          const params = new URLSearchParams({ ...baseParams, aid })
          for (const endpoint of endpoints) {
            try {
              const controller = new AbortController()
              const timer = setTimeout(() => controller.abort(), 1800)
              const response = await fetch(endpoint + '?' + params.toString(), {
                credentials: 'include',
                signal: controller.signal,
                headers: { accept: 'application/json, text/plain, */*' },
              })
              clearTimeout(timer)
              if (!response.ok) continue
              const json = await response.json()
              if (json?.aweme_detail) return JSON.stringify(json)
            } catch (e) {}
          }
        }
        return null
      }
      return await Promise.race([fetchDetail(), timeout(4500)])
    })()
  `)
}

export async function downloadVideo(
  sourceURL: string,
  options?: {
    preferNoWatermark?: boolean
    onProgress?: DownloadProgressFn
    onLog?: DownloadLogFn
  }
): Promise<DownloadSuccess> {
  const reportProgress = (fraction: number, stage: string) => {
    options?.onProgress?.({ fraction, stage })
  }
  const log = (message: string) => {
    options?.onLog?.(message)
    void logEvent({ level: "info", event: "douyin.log", details: { message: message.slice(0, 500) } })
  }

  reportProgress(0.03, "正在分析分享页面")
  log("开始解析分享链接页面…")

  const extracted = await extractFromWebView(sourceURL, {
    onLog: log,
    onProgress: options?.onProgress,
  })

  const inlineRoot = extractInlineDetailRoot(extracted)
  log(`页面 aweme 内嵌数据：${inlineRoot ? "已命中" : "未命中"}`)

  const imageURLs = extractImageURLs(extracted)
  const galleryLike = isGalleryURL(sourceURL) || isGalleryURL(extracted.canonical) || isGalleryURL(extracted.pageURL)

  if (!extracted.videoSrc && !inlineRoot && !imageURLs.length) {
    throw new Error("未能从页面中提取到视频地址、图片地址或 aweme 内嵌数据")
  }

  await ensureDownloadDirectories()
  log("已确认下载目录可用：Yoinks/Downloads")

  const candidates = buildDownloadCandidates(
    extracted,
    options?.preferNoWatermark ?? true
  )
  let lastError = "未生成可用下载候选地址"

  if (galleryLike && imageURLs.length) {
    log("已识别为图文链接，优先批量下载图片，跳过视频候选。")
    return downloadImageBatch({
      sourceURL,
      extracted,
      imageURLs,
      onProgress: reportProgress,
      onLog: log,
    })
  }

  if (galleryLike && !imageURLs.length) {
    throw new Error("已识别为图文链接，但未能提取到图片地址")
  }

  if (!candidates.length && imageURLs.length) {
    return downloadImageBatch({
      sourceURL,
      extracted,
      imageURLs,
      onProgress: reportProgress,
      onLog: log,
    })
  }

  if (!candidates.length) {
    throw new Error(lastError)
  }

  log(`共生成 ${candidates.length} 个下载候选，开始逐个尝试。`)
  log(`候选顺序：${candidates.map((item) => item.label).join(", ")}`)
  reportProgress(0.22, `已生成 ${candidates.length} 个候选地址`)

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]
    const attemptBase = 0.22 + (index / candidates.length) * 0.5
    reportProgress(attemptBase, `正在尝试候选 ${index + 1}/${candidates.length}：${candidate.label}`)
    log(`尝试候选 ${index + 1}/${candidates.length}：${candidate.label}`)

    try {
      const response = await fetch(candidate.url, {
        method: "GET",
        timeout: 180,
        debugLabel: `douyin-downloader-${candidate.label}`,
        headers: candidate.headers,
      })

      if (!response.ok) {
        const preview = await response.text().catch(() => "")
        lastError = `${candidate.label}: ${response.status} ${response.statusText} ${preview.slice(0, 120)}`
        log(`候选失败：${candidate.label} -> ${response.status} ${response.statusText}`)
        continue
      }

      if (!isLikelyMediaResponse(response.url, response.mimeType)) {
        const preview = await response.text().catch(() => "")
        lastError = `${candidate.label}: 响应不是视频资源 ${response.mimeType || "unknown"} ${preview.slice(0, 120)}`
        log(`候选跳过：${candidate.label} 响应不是视频资源，mime=${response.mimeType || "unknown"}`)
        continue
      }

      const fileName = `${sanitizeFileName(extracted.title)}.mp4`
      const filePath = Path.join(DOWNLOAD_DIR, fileName)

      log(`候选命中：${candidate.label}，开始流式下载视频数据…`)
      const downloadStart = Math.min(0.78, attemptBase + 0.04)
      const downloadEnd = Math.min(0.94, attemptBase + (0.5 / candidates.length))
      reportProgress(downloadStart, `候选命中：${candidate.label}，正在下载视频数据`)
      await cancelResponseBody(response)
      await downloadURLToFileWithProgress({
        url: response.url,
        destination: filePath,
        headers: candidate.headers,
        start: downloadStart,
        end: downloadEnd,
        stage: "正在下载视频",
        onProgress: options?.onProgress,
      })
      const bytesWritten = FileManager.statSync(filePath).size
      if (bytesWritten === 0) {
        lastError = `${candidate.label}: 视频响应为空`
        log(`候选跳过：${lastError}`)
        continue
      }

      log(`文件写入完成：${fileName}`)
      reportProgress(1, `下载完成：${fileName}`)

      return {
        id: createTaskId(),
        sourceURL,
        filePath,
        fileName,
        files: [{
          filePath,
          fileName,
          finalURL: response.url,
          bytesWritten,
          mediaType: "video",
        }],
        mediaType: "video",
        extracted,
        finalURL: response.url,
        bytesWritten,
        createdAt: new Date().toISOString(),
        matchedCandidateLabel: candidate.label,
      }
    } catch (error) {
      lastError = `${candidate.label}: ${error instanceof Error ? error.message : String(error)}`
      log(`候选异常：${lastError}`)
    }
  }

  if (imageURLs.length) {
    log(`视频候选均失败，回退到图文图片下载。最后视频错误：${lastError}`)
    return downloadImageBatch({
      sourceURL,
      extracted,
      imageURLs,
      onProgress: reportProgress,
      onLog: log,
    })
  }

  throw new Error(`所有下载候选均失败：${lastError}`)
}
