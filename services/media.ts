import { Path, Script } from "scripting"
import { createTaskId, logEvent } from "./logs"
import type { AuthPlatform } from "./platform-auth"

export type SaveMode = "ask" | "photos" | "files"
export type ConcurrentDownloads = 1 | 2 | 4 | 8
export type MediaKind = "video" | "audio"

export type ToolStatus = {
  ytDlpVersion: string | null
}

export type DownloadProgress = {
  fraction: number
  stage: string
  downloadedBytes?: number
  totalBytes?: number
  speed?: number
  eta?: number
  part?: number
  totalParts?: number
}

export type MediaChoice = {
  id: string
  label: string
  kind: MediaKind
  formatExpression: string
  height?: number
  estimatedBytes?: number
  mergeAudioFormat?: string
  mergeExtension?: "mp4" | "mkv"
  previewURL?: string
}

export type MediaProbe = {
  title: string
  uploader?: string
  duration?: number
  thumbnail?: string
  webpageURL: string
  choices: MediaChoice[]
}

export type DownloadResult = {
  filePath: string
  fileName: string
  sourceURL: string
  choice: MediaChoice
  taskId: string
  fileSizeBytes: number
}

type RawFormat = {
  formatId: string
  ext?: string
  vcodec?: string
  acodec?: string
  height?: number
  width?: number
  fps?: number
  abr?: number
  tbr?: number
  filesize?: number
  previewURL?: string
}

const ROOT_DIR = Path.join(FileManager.documentsDirectory, "Yoinks")
const DOWNLOAD_DIR = Path.join(ROOT_DIR, "Downloads")
const TEMP_DIR = Path.join(ROOT_DIR, "tmp")
const RUNNER_PATH = Path.join(Script.directory, "ytdlp_runner.py")
const PROBE_PATH = Path.join(Script.directory, "ytdlp_probe.py")
const MEDIA_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".mkv", ".webm", ".m4a", ".aac", ".opus", ".mp3"])

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function compactMessage(value: string): string {
  const errors = value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("ERROR:"))
  if (errors.length) return errors[errors.length - 1].replace(/^ERROR:\s*/, "").slice(0, 800)
  return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(-800)
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))]
}

function extensionOf(path: string): string {
  const clean = path.startsWith("/") ? path : path.split(/[?#]/)[0]
  const index = clean.lastIndexOf(".")
  return index >= 0 ? clean.slice(index).toLowerCase() : ""
}

function formatBytes(value?: number): string {
  if (!value || value <= 0) return ""
  const units = ["B", "KB", "MB", "GB"]
  let size = value
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`
}

function isAllowedURL(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

export type MediaPlatform = "douyin" | "xiaohongshu" | "generic"

const XIAOHONGSHU_URL_PATTERNS = [
  /https?:\/\/(?:www\.)?(?:xiaohongshu|rednote)\.com\/(?:explore|discovery\/item|search_result|user\/profile\/[a-z0-9]+)\/[a-z0-9]+(?:\?[^\s"'<>，。！？；：、]*)?/i,
  /https?:\/\/xhslink\.com\/[^\s"'<>，。！？；：、]+/i,
]
const DOUYIN_URL_PATTERNS = [
  /https?:\/\/v\.douyin\.com\/[a-zA-Z0-9_-]+/i,
  /https?:\/\/(?:www\.)?douyin\.com\/video\/[0-9]+/i,
  /https?:\/\/(?:www\.)?iesdouyin\.com\/[^\s"'<>，。！？；：、]*/i,
]

function sanitizeExtractedURL(value: string): string {
  return value
    .replace(/[^\x00-\x7F]+$/, "")
    .replace(/[，,。.!！？?；;：:、\)）\(（]+$/, "")
}

export function detectMediaPlatform(value: string | null | undefined): MediaPlatform {
  if (!value) return "generic"
  if (DOUYIN_URL_PATTERNS.some((pattern) => pattern.test(value))) return "douyin"
  if (XIAOHONGSHU_URL_PATTERNS.some((pattern) => pattern.test(value))) return "xiaohongshu"
  return "generic"
}

export function mediaPlatformLabel(value: string | null | undefined): string | null {
  switch (detectMediaPlatform(value)) {
    case "douyin": return "抖音"
    case "xiaohongshu": return "小红书"
    default: return null
  }
}

export function extractFirstURL(value: string | null | undefined): string | null {
  if (!value) return null
  for (const pattern of [...XIAOHONGSHU_URL_PATTERNS, ...DOUYIN_URL_PATTERNS]) {
    const match = value.match(pattern)
    if (match) {
      const candidate = sanitizeExtractedURL(match[0])
      if (isAllowedURL(candidate)) return candidate
    }
  }
  const candidate = sanitizeExtractedURL(value.match(/https?:\/\/[^\s<>"']+/i)?.[0] || value.trim())
  return isAllowedURL(candidate) ? candidate : null
}

async function ensureDirectories() {
  if (!(await FileManager.exists(DOWNLOAD_DIR))) await FileManager.createDirectory(DOWNLOAD_DIR, true)
  if (!(await FileManager.exists(TEMP_DIR))) await FileManager.createDirectory(TEMP_DIR, true)
}

async function runCommand(command: string, timeout: number) {
  return Shell.run(command, { cwd: Script.directory, timeout })
}

function parseLastJSON(output: string): Record<string, unknown> {
  try {
    const whole = JSON.parse(output) as unknown
    if (typeof whole === "object" && whole != null && !Array.isArray(whole)) return whole as Record<string, unknown>
  } catch {}
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line) as unknown
      if (typeof value === "object" && value != null && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {}
  }

  // Scripting's ffprobe emits diagnostics around its multi-line JSON payload.
  // Extract balanced object candidates instead of assuming the whole output is JSON.
  for (let start = output.indexOf("{"); start >= 0; start = output.indexOf("{", start + 1)) {
    let depth = 0
    let quoted = false
    let escaped = false
    for (let end = start; end < output.length; end += 1) {
      const character = output[end]
      if (quoted) {
        if (escaped) escaped = false
        else if (character === "\\") escaped = true
        else if (character === '"') quoted = false
        continue
      }
      if (character === '"') {
        quoted = true
        continue
      }
      if (character === "{") depth += 1
      if (character === "}") depth -= 1
      if (depth !== 0) continue
      try {
        const value = JSON.parse(output.slice(start, end + 1)) as unknown
        if (typeof value === "object" && value != null && !Array.isArray(value)) return value as Record<string, unknown>
      } catch {}
      break
    }
  }
  throw new Error("下载工具未返回可识别的媒体信息")
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function formatScore(item: RawFormat): number {
  let score = item.tbr || 0
  if (item.ext === "mp4") score += 10_000
  if (item.vcodec?.startsWith("avc")) score += 5_000
  if (item.acodec && item.acodec !== "none") score += 1_000
  return score
}

function isMuxedVideo(item: RawFormat): boolean {
  if (!item.formatId || !item.height) return false
  if (item.vcodec && item.vcodec !== "none" && item.acodec && item.acodec !== "none") return true
  // Some extractors omit codec metadata for progressive HTTP MP4 files.
  return item.formatId.startsWith("http-") && item.ext === "mp4" && Boolean(item.filesize)
}

function buildChoices(formats: RawFormat[]): MediaChoice[] {
  const audioFormats = formats
    .filter((item) => item.formatId && item.acodec && item.acodec !== "none" && (!item.vcodec || item.vcodec === "none"))
    .sort((a, b) => {
      const aPreference = (a.ext === "m4a" ? 100_000 : 0) + (a.abr || a.tbr || 0)
      const bPreference = (b.ext === "m4a" ? 100_000 : 0) + (b.abr || b.tbr || 0)
      return bPreference - aPreference || formatScore(b) - formatScore(a)
    })
  const muxedVideos = formats
    .filter(isMuxedVideo)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || formatScore(b) - formatScore(a))
  const videoOnly = formats
    .filter((item) => item.formatId && item.vcodec && item.vcodec !== "none" && (!item.acodec || item.acodec === "none") && item.height)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || formatScore(b) - formatScore(a))

  const choices: MediaChoice[] = muxedVideos.map((item) => ({
    id: `video-${item.height}-${item.formatId}`,
    label: `${item.height}p 视频${item.ext ? ` · ${item.ext.toUpperCase()}` : ""}${item.fps ? ` · ${Math.round(item.fps)} fps` : ""}${item.filesize ? ` · 约 ${formatBytes(item.filesize)}` : ""}`,
    kind: "video",
    formatExpression: item.formatId,
    height: item.height,
    estimatedBytes: item.filesize,
    previewURL: item.previewURL,
  }))

  for (const item of videoOnly) {
    const audio = audioFormats.find((candidate) => item.ext === "mp4" ? candidate.ext === "m4a" : candidate.ext === "webm") || audioFormats[0]
    const canMerge = Boolean(audio)
    const mergeExtension = item.ext === "mp4" && audio?.ext === "m4a" ? "mp4" : "mkv"
    choices.push({
      id: `video-${item.height}-${item.formatId}${audio ? `-with-${audio.formatId}` : "-silent"}`,
      label: `${item.height}p ${canMerge ? "视频 · 合并音频" : "无音轨视频"}${item.ext ? ` · ${item.ext.toUpperCase()}` : ""}${item.fps ? ` · ${Math.round(item.fps)} fps` : ""}${(item.filesize || audio?.filesize) ? ` · 约 ${formatBytes((item.filesize || 0) + (audio?.filesize || 0))}` : ""}`,
      kind: "video",
      formatExpression: item.formatId,
      height: item.height,
      estimatedBytes: (item.filesize || 0) + (audio?.filesize || 0) || undefined,
      mergeAudioFormat: audio?.formatId,
      mergeExtension: canMerge ? mergeExtension : undefined,
      previewURL: item.previewURL,
    })
  }

  choices.push(...audioFormats.map<MediaChoice>((item) => ({
    id: `audio-${item.formatId}`,
    label: `仅音频${item.ext ? ` · ${item.ext.toUpperCase()}` : ""}${item.abr || item.tbr ? ` · ${Math.round(item.abr || item.tbr || 0)} kbps` : ""}${item.filesize ? ` · 约 ${formatBytes(item.filesize)}` : ""}`,
    kind: "audio",
    formatExpression: item.formatId,
    estimatedBytes: item.filesize,
    previewURL: item.previewURL,
  })))

  return choices
}

export async function getToolStatus(): Promise<ToolStatus> {
  const ytDlp = await runCommand("python3 -m yt_dlp --version", 20)
  const status: ToolStatus = {
    ytDlpVersion: ytDlp.exitCode === 0 ? ytDlp.output.trim().split(/\s+/)[0] || null : null,
  }
  await logEvent({ level: status.ytDlpVersion ? "info" : "warn", event: "tools.checked", details: { ytDlpVersion: status.ytDlpVersion, ytDlpExitCode: ytDlp.exitCode } })
  return status
}

export async function installYtDlp(): Promise<string> {
  await logEvent({ level: "info", event: "tools.install.started", details: { tool: "yt-dlp" } })
  const result = await runCommand("python3 -m pip install --upgrade yt-dlp", 900)
  if (result.exitCode !== 0) {
    await logEvent({ level: "error", event: "tools.install.failed", details: { tool: "yt-dlp", exitCode: result.exitCode, output: result.output } })
    throw new Error(compactMessage(result.output || "yt-dlp installation failed"))
  }
  const version = await runCommand("python3 -m yt_dlp --version", 20)
  if (version.exitCode !== 0) throw new Error("yt-dlp 安装完成但版本校验失败")
  const installedVersion = version.output.trim().split(/\s+/)[0]
  await logEvent({ level: "info", event: "tools.install.completed", details: { tool: "yt-dlp", version: installedVersion } })
  return installedVersion
}

export type ProbeOptions = {
  cookieFile?: string
  authorizedPlatform?: AuthPlatform
}

export async function probeMedia(url: string, options: ProbeOptions = {}): Promise<MediaProbe> {
  const sourceURL = extractFirstURL(url)
  if (!sourceURL) throw new Error("请输入有效的公开 http 或 https 链接。")
  const taskId = createTaskId()
  await logEvent({ level: "info", event: "probe.started", taskId, details: { sourceURL, authorizedPlatform: options.authorizedPlatform || null, cookieAuthorized: Boolean(options.cookieFile) } })
  const cookieArgument = options.cookieFile ? ` ${quote(options.cookieFile)}` : ""
  const result = await runCommand(`python3 ${quote(PROBE_PATH)} ${quote(sourceURL)}${cookieArgument}`, 120)
  await logEvent({ level: result.exitCode === 0 ? "info" : "error", event: "probe.command.completed", taskId, details: { exitCode: result.exitCode, output: result.exitCode === 0 ? "媒体信息已返回" : result.output } })
  if (result.exitCode !== 0) throw new Error(compactMessage(result.output || "媒体探测失败"))
  const payload = parseLastJSON(result.output)
  if (payload.ok !== true) throw new Error(compactMessage(stringValue(payload.error) || "媒体探测失败"))
  const rawFormats = Array.isArray(payload.formats) ? payload.formats : []
  const formats: RawFormat[] = rawFormats.map((value) => {
    const item = value as Record<string, unknown>
    return {
      formatId: stringValue(item.formatId) || "",
      ext: stringValue(item.ext),
      vcodec: stringValue(item.vcodec),
      acodec: stringValue(item.acodec),
      height: numberValue(item.height),
      width: numberValue(item.width),
      fps: numberValue(item.fps),
      abr: numberValue(item.abr),
      tbr: numberValue(item.tbr),
      filesize: numberValue(item.filesize),
      previewURL: stringValue(item.previewURL),
    }
  }).filter((item) => Boolean(item.formatId))
  const choices = buildChoices(formats)
  const probe: MediaProbe = {
    title: stringValue(payload.title) || "未命名媒体",
    uploader: stringValue(payload.uploader),
    duration: numberValue(payload.duration),
    thumbnail: stringValue(payload.thumbnail),
    webpageURL: stringValue(payload.webpageUrl) || sourceURL,
    choices,
  }
  await logEvent({ level: "info", event: "probe.completed", taskId, details: { title: probe.title, choiceCount: choices.length, formatCount: formats.length } })
  return probe
}

function readProgress(path: string): DownloadProgress | null {
  try {
    if (!FileManager.existsSync(path)) return null
    const value = JSON.parse(FileManager.readAsStringSync(path)) as { percent?: number; downloadedBytes?: number; totalBytes?: number; speed?: number; eta?: number; fragmentIndex?: number; fragmentCount?: number }
    const percent = typeof value.percent === "number" ? Math.max(0, Math.min(100, value.percent)) : null
    const fraction = percent == null ? 0.05 : Math.max(0.05, Math.min(0.95, percent / 100))
    return {
      fraction,
      stage: percent == null ? "正在传输" : `${percent.toFixed(1)}%`,
      downloadedBytes: numberValue(value.downloadedBytes),
      totalBytes: numberValue(value.totalBytes),
      speed: numberValue(value.speed),
      eta: numberValue(value.eta),
      part: numberValue(value.fragmentIndex),
      totalParts: numberValue(value.fragmentCount),
    }
  } catch {
    return null
  }
}

function parseOutputPaths(output: string): string[] {
  return uniquePaths(output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("/") && MEDIA_EXTENSIONS.has(extensionOf(line))))
}

function extractProbeStreamTypes(output: string): string[] {
  const types = new Set<string>()
  const summaryPattern = /^\s*Stream #.*:\s+(Video|Audio):/gim
  for (const match of output.matchAll(summaryPattern)) types.add(match[1].toLowerCase())
  if (types.size > 0) return [...types]

  // This ffprobe build writes the selected values after its diagnostic output.
  for (const line of output.split(/\r?\n/)) {
    const type = line.trim().toLowerCase()
    if (type === "video" || type === "audio") types.add(type)
  }
  return [...types]
}

async function verifyMediaFile(filePath: string, choice: MediaChoice, taskId: string) {
  const result = await runCommand(`ffprobe -v error -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 ${quote(filePath)}`, 60)
  await logEvent({ level: result.exitCode === 0 ? "info" : "error", event: "verify.command.completed", taskId, details: { exitCode: result.exitCode, output: result.output, filePath } })
  if (result.exitCode !== 0) throw new Error("下载文件验证失败：ffprobe 无法读取输出")
  const types = extractProbeStreamTypes(result.output)
  const expected = choice.kind === "audio" ? "audio" : "video"
  if (!types.includes(expected)) throw new Error(`下载文件验证失败：缺少${expected === "audio" ? "音频" : "视频"}流`)
  if (choice.mergeAudioFormat && !types.includes("audio")) throw new Error("下载文件验证失败：合并结果缺少音频流")
  await logEvent({ level: "info", event: "verify.completed", taskId, details: { filePath, streamTypes: types, expected } })
}

async function fileSizeBytes(filePath: string): Promise<number> {
  const stat = await FileManager.stat(filePath)
  return typeof stat.size === "number" && stat.size >= 0 ? stat.size : 0
}

export async function cancelDownload(cancelPath: string) {
  await logEvent({ level: "info", event: "download.cancel.requested", details: { cancelPath } })
  await FileManager.writeAsString(cancelPath, String(Date.now()))
}

export async function downloadMedia(options: {
  url: string
  choice: MediaChoice
  concurrentFragments: ConcurrentDownloads
  insecureTLS?: boolean
  cookieFile?: string
  authorizedPlatform?: AuthPlatform
  onProgress: (value: DownloadProgress) => void
  onCancelPath: (path: string) => void
}): Promise<DownloadResult> {
  const sourceURL = extractFirstURL(options.url)
  if (!sourceURL) throw new Error("请输入有效的公开 http 或 https 链接。")
  await ensureDirectories()

  const taskId = createTaskId()
  const configPath = Path.join(TEMP_DIR, `${taskId}.json`)
  const progressPath = Path.join(TEMP_DIR, `${taskId}.progress.json`)
  const cancelPath = Path.join(TEMP_DIR, `${taskId}.cancel`)
  const taskDirectory = Path.join(TEMP_DIR, taskId)
  const mergeAudioFormat = options.choice.mergeAudioFormat
  const config = {
    url: sourceURL,
    format: options.choice.formatExpression,
    format_sort: ["res", "fps", "vcodec:h264", "acodec:aac"],
    output: "%(title).120B [%(id)s].%(ext)s",
    paths: DOWNLOAD_DIR,
    progress_path: progressPath,
    cancel_flag: cancelPath,
    concurrent_fragments: options.concurrentFragments,
    no_check_certificates: Boolean(options.insecureTLS),
    cookiefile: options.cookieFile || undefined,
    extract_audio: false,
  }
  await FileManager.writeAsString(configPath, JSON.stringify(config))
  await logEvent({ level: "info", event: "download.started", taskId, details: { sourceURL, choiceId: options.choice.id, choiceLabel: options.choice.label, formatExpression: options.choice.formatExpression, concurrentFragments: options.concurrentFragments, tlsInsecure: Boolean(options.insecureTLS), authorizedPlatform: options.authorizedPlatform || null, cookieAuthorized: Boolean(options.cookieFile), outputDirectory: DOWNLOAD_DIR } })
  options.onCancelPath(cancelPath)

  let polling = true
  let timer: ReturnType<typeof setTimeout> | null = null
  const pollProgress = () => {
    if (!polling) return
    const progress = readProgress(progressPath)
    if (progress) options.onProgress(progress)
    timer = setTimeout(pollProgress, 350)
  }
  timer = setTimeout(pollProgress, 350)

  try {
    if (mergeAudioFormat) {
      await FileManager.createDirectory(taskDirectory, true)
      const videoConfigPath = Path.join(TEMP_DIR, `${taskId}.video.json`)
      const audioConfigPath = Path.join(TEMP_DIR, `${taskId}.audio.json`)
      const videoConfig = { ...config, output: "%(title).120B [%(id)s].video.%(ext)s", paths: taskDirectory }
      const audioConfig = { ...config, format: mergeAudioFormat, output: "%(title).120B [%(id)s].audio.%(ext)s", paths: taskDirectory }
      await FileManager.writeAsString(videoConfigPath, JSON.stringify(videoConfig))
      await FileManager.writeAsString(audioConfigPath, JSON.stringify(audioConfig))

      options.onProgress({ fraction: 0.02, stage: "正在下载视频流" })
      const videoResult = await runCommand(`python3 ${quote(RUNNER_PATH)} ${quote(videoConfigPath)}`, 7200)
      await logEvent({ level: videoResult.exitCode === 0 ? "info" : "error", event: "download.video.command.completed", taskId, details: { exitCode: videoResult.exitCode, output: videoResult.output } })
      if (videoResult.exitCode === 130) throw new Error("下载已取消")
      if (videoResult.exitCode !== 0) throw new Error(compactMessage(videoResult.output || "视频流下载失败"))
      const videoPath = [...parseOutputPaths(videoResult.output)].reverse().find((path) => FileManager.existsSync(path))
      if (!videoPath) throw new Error("视频流下载完成但未找到输出文件")

      options.onProgress({ fraction: 0.55, stage: "正在下载音频流" })
      const audioResult = await runCommand(`python3 ${quote(RUNNER_PATH)} ${quote(audioConfigPath)}`, 7200)
      await logEvent({ level: audioResult.exitCode === 0 ? "info" : "error", event: "download.audio.command.completed", taskId, details: { exitCode: audioResult.exitCode, output: audioResult.output } })
      if (audioResult.exitCode === 130) throw new Error("下载已取消")
      if (audioResult.exitCode !== 0) throw new Error(compactMessage(audioResult.output || "音频流下载失败"))
      const audioPath = [...parseOutputPaths(audioResult.output)].reverse().find((path) => FileManager.existsSync(path))
      if (!audioPath) throw new Error("音频流下载完成但未找到输出文件")

      const extension = options.choice.mergeExtension || "mkv"
      const fileName = `${Path.basename(videoPath).replace(/\.video\.[^.]+$/, "")}.${extension}`
      const filePath = Path.join(DOWNLOAD_DIR, fileName)
      const fastStart = extension === "mp4" ? " -movflags +faststart" : ""
      options.onProgress({ fraction: 0.93, stage: "正在使用内置 FFmpeg 合并" })
      const mergeResult = await runCommand(`ffmpeg -y -i ${quote(videoPath)} -i ${quote(audioPath)} -map 0:v:0 -map 1:a:0 -c copy${fastStart} ${quote(filePath)}`, 900)
      await logEvent({ level: mergeResult.exitCode === 0 ? "info" : "error", event: "merge.ffmpeg.completed", taskId, details: { exitCode: mergeResult.exitCode, output: mergeResult.output, videoPath, audioPath, filePath } })
      if (mergeResult.exitCode !== 0) throw new Error(compactMessage(mergeResult.output || "FFmpeg 合并失败"))
      await verifyMediaFile(filePath, options.choice, taskId)
      options.onProgress({ fraction: 1, stage: "下载、合并并验证完成" })
      await logEvent({ level: "info", event: "download.completed", taskId, details: { filePath, choiceId: options.choice.id, mergedWithFFmpeg: true } })
      return { filePath, fileName, sourceURL, choice: options.choice, taskId, fileSizeBytes: await fileSizeBytes(filePath) }
    }

    options.onProgress({ fraction: 0.02, stage: "正在下载" })
    const result = await runCommand(`python3 ${quote(RUNNER_PATH)} ${quote(configPath)}`, 7200)
    await logEvent({ level: result.exitCode === 0 ? "info" : "error", event: "download.command.completed", taskId, details: { exitCode: result.exitCode, output: result.output } })
    if (result.exitCode === 130) throw new Error("下载已取消")
    if (result.exitCode !== 0) throw new Error(compactMessage(result.output || "yt-dlp 下载失败"))
    const paths = parseOutputPaths(result.output)
    const filePath = [...paths].reverse().find((path) => FileManager.existsSync(path))
    if (!filePath) throw new Error("下载完成但未找到输出文件")
    await verifyMediaFile(filePath, options.choice, taskId)
    options.onProgress({ fraction: 1, stage: "下载并验证完成" })
    await logEvent({ level: "info", event: "download.completed", taskId, details: { filePath, choiceId: options.choice.id } })
    return { filePath, fileName: Path.basename(filePath), sourceURL, choice: options.choice, taskId, fileSizeBytes: await fileSizeBytes(filePath) }
  } catch (error) {
    await logEvent({ level: "error", event: "download.failed", taskId, details: { message: error instanceof Error ? error.message : String(error) } })
    throw error
  } finally {
    polling = false
    if (timer) clearTimeout(timer)
    for (const path of [configPath, Path.join(TEMP_DIR, `${taskId}.video.json`), Path.join(TEMP_DIR, `${taskId}.audio.json`), progressPath, cancelPath]) {
      try {
        if (FileManager.existsSync(path)) FileManager.removeSync(path)
      } catch {}
    }
    try {
      if (FileManager.existsSync(taskDirectory)) FileManager.removeSync(taskDirectory)
    } catch {}
  }
}

export async function saveResult(filePath: string, fileName: string, mode: SaveMode, taskId?: string): Promise<string> {
  if (mode === "photos") {
    if ([".mp3", ".m4a", ".aac", ".opus"].includes(extensionOf(filePath))) {
      await logEvent({ level: "warn", event: "save.photos.unsupported", taskId, details: { filePath, fileName } })
      throw new Error("音频文件请导出到文件或通过分享面板保存。")
    }
    const isVideo = [".mp4", ".m4v", ".mov", ".mkv", ".webm"].includes(extensionOf(filePath))
    const saved = isVideo
      ? await Photos.saveVideo(filePath, { fileName, shouldMoveFile: false })
      : await Photos.savePhoto(filePath, { fileName, shouldMoveFile: false })
    if (!saved) {
      await logEvent({ level: "error", event: "save.photos.failed", taskId, details: { filePath, fileName } })
      throw new Error("保存到相册失败")
    }
    await logEvent({ level: "info", event: "save.photos.completed", taskId, details: { filePath, fileName } })
    return "已保存到相册。"
  }
  if (mode === "files") {
    const data = Data.fromFile(filePath)
    if (!data) throw new Error("无法读取下载文件")
    const paths = await DocumentPicker.exportFiles({ files: [{ data, name: fileName }] })
    if (!paths.length) {
      await logEvent({ level: "warn", event: "save.files.cancelled", taskId, details: { fileName } })
      throw new Error("已取消导出")
    }
    await logEvent({ level: "info", event: "save.files.completed", taskId, details: { fileName, exportedPaths: paths } })
    return "已导出到文件。"
  }
  const choice = await Dialog.actionSheet({
    title: "下载完成",
    message: fileName,
    actions: [{ label: "播放" }, { label: "保存到相册" }, { label: "导出到文件" }, { label: "分享文件" }, { label: "暂不处理" }],
    cancelButton: true,
  })
  if (choice === 0) {
    await QuickLook.previewURLs([filePath], true)
    await logEvent({ level: "info", event: "save.play.presented", taskId, details: { fileName } })
    return "已关闭系统播放器。"
  }
  if (choice === 1) return saveResult(filePath, fileName, "photos", taskId)
  if (choice === 2) return saveResult(filePath, fileName, "files", taskId)
  if (choice === 3) {
    await ShareSheet.present([filePath])
    await logEvent({ level: "info", event: "save.share.presented", taskId, details: { filePath, fileName } })
    return "已打开分享面板。"
  }
  await logEvent({ level: "info", event: "save.deferred", taskId, details: { filePath, fileName } })
  return "文件已保留在 Yoinks 下载目录。"
}
