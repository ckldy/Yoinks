import { logEvent, safeText } from "./logs"
import type { PreviewAutoplayMode } from "./preferences"
import { createPlayer, type PlayerConfig, type HLSPlayerService } from "./player/hls-player-service"
import { createDashPlayer, type DashPlayerService } from "./player/dash-player-service"

export type OnlinePreviewOptions = {
  url: string
  title: string
  autoplayMode: PreviewAutoplayMode
  referer?: string
  headers?: Record<string, string>
  webpageURL?: string
  previewReferer?: string
  previewHeaders?: Record<string, string>
  /** Separate audio for DASH video-only preview (Bilibili/YouTube). */
  audioUrl?: string
  /** Media duration in seconds; required for DASH MPD generation. */
  duration?: number
  /** Actual video codec string for DASH MPD (e.g. avc1.640033). */
  videoCodec?: string
  /** Actual audio codec string for DASH MPD (e.g. mp4a.40.2). */
  audioCodec?: string
}

export type OnlinePreviewResult =
  | { status: "presented"; player: HLSPlayerService | DashPlayerService | null; played: boolean }
  | { status: "invalid-url"; message: string }
  | { status: "failed"; message: string }

function isDashSegment(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    return pathname.endsWith(".m4s") || pathname.includes(".m4s")
  } catch {
    return /\.m4s(?:[?#]|$)/i.test(url)
  }
}

/**
 * YouTube video-only streams are served from googlevideo.com as complete
 * DASH movie-fragment ISO BMFF files (ftyp → moov → sidx → moof → mdat).
 * Safari/WKWebView cannot decode these with a plain <video> element, so they
 * must go through DashPlayerService like Bilibili .m4s segments.
 * Muxed YouTube formats (itag 18/22) have no separate audioUrl and will keep
 * using the direct progressive path.
 */
export function isGoogleVideoDashUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return hostname.includes("googlevideo.com")
  } catch {
    return false
  }
}

export const PREVIEW_PLAYBACK_TIMEOUT_MS = 12_000

type PlaybackConfirmation =
  | { status: "playing" }
  | { status: "failed"; message: string }
  | { status: "dismissed" }

type PlaybackWait = {
  promise: Promise<PlaybackConfirmation>
  dispose: (reason?: "dismissed" | "cancel") => void
}

function waitForPlayback(player: HLSPlayerService | DashPlayerService): PlaybackWait {
  let settled = false
  let timeout: ReturnType<typeof setTimeout> | null = null
  let offPlay: (() => void) | null = null
  let offError: (() => void) | null = null
  let resolvePromise: ((result: PlaybackConfirmation) => void) | null = null

  const clearHooks = () => {
    if (timeout) clearTimeout(timeout)
    timeout = null
    offPlay?.()
    offError?.()
    offPlay = null
    offError = null
  }

  const finish = (result: PlaybackConfirmation) => {
    if (settled) return
    settled = true
    clearHooks()
    resolvePromise?.(result)
  }

  const promise = new Promise<PlaybackConfirmation>(resolve => {
    resolvePromise = resolve
    // Only confirmed WebView "playing" counts — not the synthetic emit from play().
    offPlay = player.on("play", event => {
      if (event.data?.confirmed === true) finish({ status: "playing" })
    })
    offError = player.on("error", event => {
      if (event.data?.fatal === true) {
        finish({ status: "failed", message: safeText(String(event.data?.message || "媒体播放失败")) })
      }
    })
    timeout = setTimeout(
      () => finish({ status: "failed", message: "12 秒内未能开始播放" }),
      PREVIEW_PLAYBACK_TIMEOUT_MS,
    )
  })

  return {
    promise,
    dispose: (reason = "cancel") => {
      if (settled) {
        clearHooks()
        return
      }
      if (reason === "dismissed") {
        // User closed the sheet — not a hard media failure.
        finish({ status: "dismissed" })
        return
      }
      clearHooks()
      settled = true
      resolvePromise?.({ status: "failed", message: "预览已取消" })
    },
  }
}

function isBilibiliStreamUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return hostname.includes("bilibili") || hostname.includes("bilivideo")
  } catch {
    return false
  }
}

function resolveEffectiveReferer(options: OnlinePreviewOptions): string {
  const candidate = options.previewReferer ?? options.webpageURL ?? options.referer ?? options.url
  // Never use the .m4s/stream URL itself as the document base for Bilibili;
  // that would make Referer point to the CDN and cause 403.
  if (isBilibiliStreamUrl(candidate) && candidate === options.url) {
    return options.webpageURL ?? options.referer ?? "https://www.bilibili.com/"
  }
  return candidate
}

function resolveEffectiveHeaders(options: OnlinePreviewOptions): Record<string, string> {
  return options.previewHeaders ?? options.headers ?? {}
}

async function safeDestroy(player: HLSPlayerService | DashPlayerService | null | undefined): Promise<void> {
  if (!player) return
  try {
    await player.destroy()
  } catch {
    // Best-effort cleanup after dismiss.
  }
}

export async function openOnlinePreview(
  options: OnlinePreviewOptions,
): Promise<OnlinePreviewResult> {
  const { url, title, autoplayMode } = options

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { status: "invalid-url", message: "预览链接无效" }
    }
  } catch {
    return { status: "invalid-url", message: "预览链接无效" }
  }

  const effectiveReferer = resolveEffectiveReferer(options)
  // Prefer full referer as document base (Bilibili CDN checks Referer context); origin as fallback.
  let baseUrl: string
  try {
    baseUrl = effectiveReferer && /^https?:\/\//i.test(effectiveReferer) ? effectiveReferer : new URL(effectiveReferer).origin
  } catch {
    try {
      baseUrl = new URL(url).origin
    } catch {
      baseUrl = "https://www.bilibili.com"
    }
  }
  let origin: string
  try {
    origin = new URL(baseUrl).origin
  } catch {
    origin = baseUrl
  }

  const playerConfig: PlayerConfig = {
    baseUrl,
    referer: effectiveReferer,
    origin,
    headers: resolveEffectiveHeaders(options),
    autoPlay: true,
    muted: autoplayMode === "muted",
    playsInline: true,
    hlsJsUrl: "https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js",
    audioUrl: options.audioUrl,
    videoCodec: options.videoCodec,
    audioCodec: options.audioCodec,
  }

  const useDash = (isDashSegment(url) || isGoogleVideoDashUrl(url)) && Boolean(options.audioUrl)
  const player = useDash
    ? createDashPlayer({ ...playerConfig, audioUrl: options.audioUrl })
    : createPlayer(playerConfig)
  if (useDash) {
    ;(player as DashPlayerService).prepare(url, options.audioUrl || "", options.duration || 0)
  }
  let wait: PlaybackWait | null = null
  let played = false
  let mediaFailed: string | null = null

  try {
    const controller = await player.initialize()
    if (!controller) {
      return { status: "failed", message: "在线预览无法打开" }
    }

    wait = waitForPlayback(player)

    // Present first so the sheet always appears; play runs concurrently with confirmation.
    // When present resolves (user dismissed), do NOT treat timeout as hard failure if user watched.
    const presentTask = controller.present({ fullscreen: true, navigationTitle: "播放" })
    const playTask = player.play(url, options.audioUrl).catch((error: unknown) => error)
    const confirmationTask = wait.promise.then(result => {
      if (result.status === "playing") played = true
      if (result.status === "failed") mediaFailed = result.message
      return result
    })

    try {
      await presentTask
    } finally {
      wait.dispose("dismissed")
      try { await playTask } catch { /* ignore */ }
      try { await confirmationTask } catch { /* ignore */ }
      await safeDestroy(player as any)
    }

    // Hard fail only for fatal media errors. Timeout while sheet was open must not
    // pop "在线预览失败" after the user already watched (bridge/slow confirm).
    if (mediaFailed && !played) {
      const softTimeout = /12\s*秒|未能开始播放|超时|加载超时/i.test(mediaFailed)
      if (softTimeout) {
        await logEvent({
          level: "warn",
          event: "preview.failed",
          details: {
            title,
            message: mediaFailed,
            soft: true,
            requestMode: player.getRequestMode(),
            headersApplied: player.getHeadersApplied(),
            hasAudio: Boolean(options.audioUrl),
          },
        })
        return { status: "presented", player: null, played: false }
      }
      await logEvent({
        level: "error",
        event: "preview.failed",
        details: {
          title,
          message: mediaFailed,
          requestMode: player.getRequestMode(),
          headersApplied: player.getHeadersApplied(),
          hasAudio: Boolean(options.audioUrl),
        },
      })
      return { status: "failed", message: mediaFailed }
    }

    await logEvent({
      level: "info",
      event: "preview.playing",
      details: {
        title,
        isMuted: autoplayMode === "muted",
        requestMode: player.getRequestMode(),
        headersApplied: player.getHeadersApplied(),
        hasAudio: Boolean(options.audioUrl),
        played,
      },
    })

    return { status: "presented", player: null, played }
  } catch (error) {
    wait?.dispose("cancel")
    await safeDestroy(player as any)
    const message = error instanceof Error ? error.message : String(error)
    await logEvent({
      level: "error",
      event: "preview.failed",
      details: { title, message: safeText(message) },
    })
    return { status: "failed", message: safeText(message) || "在线预览无法打开" }
  }
}
