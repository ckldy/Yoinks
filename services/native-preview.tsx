// native-preview.tsx — 抖音 muxed 直链原生预览（AVPlayer/AVFoundation）
//
// 背景（2026-08-18 真机实锤）：
// 抖音桌面 detail 的 bit_rate/play_addr 均为 muxed MP4，音轨是 **HE-AACv2（AAC+PS
// 参数立体声）**。iOS WKWebView 的 <video> 元素无法解码 HE-AACv2 音轨 → 有画面无声；
// 原生 AVPlayer（AVFoundation）完整支持 HE-AACv2 解码（实测 duration 50.43s 正常播放）。
// 因此抖音直链预览改走原生播放器。
//
// 2026-08-18 真机两坑：
// 1. SharedAudioSession.setCategory("playback", ["defaultToSpeaker"]) 报 OSStatus -50 →
//    音频会话未激活 → AVPlayer 卡 waiting 无声；必须传空选项 []。
// 2. 原生失败后若自动回退 WebView 播放器，两个播放页面叠加；失败时须先 dismiss 原生页。
import { logEvent } from "./logs"
import type { PreviewAutoplayMode } from "./preferences"

// 页面组件所需（Navigation/AVPlayerView 等为全局/从 scripting import）
import { AVPlayerView, Button, Navigation, NavigationStack, useEffect, useObservable, VStack, type PIPStatus } from "scripting"

export type NativePreviewOptions = {
  url: string
  audioURL?: string
  title: string
  autoplayMode: PreviewAutoplayMode
  headers?: Record<string, string>
  duration?: number
}

export type NativePreviewResult =
  | { status: "presented"; played: boolean }
  | { status: "invalid-url"; message: string }
  | { status: "failed"; message: string }

/** 抖音 CDN 直链（muxed MP4）走原生播放器；其它平台仍走 WebView 播放器。 */
export function isNativePreviewCandidate(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return hostname.includes("douyinvod.com") || hostname.endsWith(".douyin.com") || hostname === "www.douyin.com"
  } catch {
    return false
  }
}

/** 承载 AVPlayerView 的页面。player 生命周期由外层管理，页面只负责展示与关闭。 */
export function NativePreviewScreen({ player, title, onClose }: {
  player: AVPlayer
  title: string
  onClose: () => void
}) {
  // AVPlayerViewProps.pipStatus 为必填 observable（PiP 生命周期只读状态）
  const pipStatus = useObservable<PIPStatus>()
  // 供外层（openNativePreview 超时/失败时）主动关闭页面，避免与后续操作叠加成双页面
  const dismiss = Navigation.useDismiss()
  useExposeDismiss(dismiss)
  return (
    <NavigationStack>
      <VStack
        navigationTitle={title}
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          cancellationAction: <Button title="关闭" action={() => { onClose(); dismiss() }} />,
        }}
      >
        <AVPlayerView
          player={player}
          pipStatus={pipStatus}
          entersFullScreenWhenPlaybackBegins={false}
          updatesNowPlayingInfoCenter={false}
        />
      </VStack>
    </NavigationStack>
  )
}

// 模块级保存 dismiss 句柄：openNativePreview 失败/超时后主动关页，避免“两个播放页面”叠加
let pendingDismiss: (() => void) | null = null
function useExposeDismiss(dismiss: () => void) {
  useEffect(() => {
    pendingDismiss = dismiss
    return () => { if (pendingDismiss === dismiss) pendingDismiss = null }
  }, [dismiss])
}
function dismissNativePreviewPage() {
  try { pendingDismiss?.() } catch {}
  pendingDismiss = null
}

/**
 * 用原生 AVPlayer 播放抖音 muxed 直链（HE-AACv2 音轨由 AVFoundation 原生解码）。
 * 返回 played 表示确认开始播放；失败返回错误信息。
 */
export async function openNativePreview(options: NativePreviewOptions): Promise<NativePreviewResult> {
  const { url, title, audioURL } = options

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { status: "invalid-url", message: "预览链接无效" }
    }
  } catch {
    return { status: "invalid-url", message: "预览链接无效" }
  }

  // 激活音频会话（playback）。2026-08-18 真机实锤：传 ["defaultToSpeaker"] 会报
  // OSStatus -50 导致会话未激活 → AVPlayer 卡 waiting 无声；空选项实测成功。
  try {
    await SharedAudioSession.setCategory("playback", [])
    await SharedAudioSession.setActive(true)
  } catch (error) {
    await logEvent({
      level: "warn",
      event: "preview.native.audio-session",
      details: { message: error instanceof Error ? error.message : String(error) },
    }).catch(() => {})
  }

  let played = false
  let errorMessage: string | null = null
  let readyReported = false

  const player = new AVPlayer()
  const audioPlayer = audioURL ? new AVPlayer() : null
  // 抖音 bit_rate 可能在不同 CDN/清晰度下返回带音轨文件；只要存在独立音频，
  // 视频播放器必须静音，否则会把内置音轨与 audioPlayer 叠加输出。
  player.volume = audioPlayer ? 0 : 1
  if (audioPlayer) audioPlayer.volume = 1
  let audioReady = !audioPlayer
  let videoReady = false
  let audioStarted = false
  const syncAudioToVideo = () => {
    if (!audioPlayer) return
    try {
      if (Math.abs(audioPlayer.currentTime - player.currentTime) > 0.25) {
        audioPlayer.currentTime = player.currentTime
      }
    } catch {}
  }
  const startPlayersIfReady = () => {
    if (!videoReady || !audioReady) return
    try {
      syncAudioToVideo()
      player.play()
      if (audioPlayer && !audioStarted) {
        audioStarted = true
        audioPlayer.play()
      }
    } catch (error) {
      void logEvent({ level: "warn", event: "preview.native.play-error", details: { message: error instanceof Error ? error.message : String(error) } }).catch(() => {})
    }
  }
  player.onReadyToPlay = () => {
    readyReported = true
    videoReady = true
    void logEvent({ level: "info", event: "preview.native.ready", details: { title, hasSeparateAudio: Boolean(audioURL) } }).catch(() => {})
    startPlayersIfReady()
  }
  if (audioPlayer) {
    audioPlayer.onReadyToPlay = () => {
      audioReady = true
      startPlayersIfReady()
    }
  }
  player.onTimeControlStatusChanged = (status) => {
    // 2026-08-18 实锤：TimeControlStatus 是数字枚举（paused=0/waiting=1/playing=2），
    // String(status) 得不到 "playing"，必须数字比较。
    if (status === TimeControlStatus.playing) {
      played = true
      syncAudioToVideo()
      if (audioPlayer && audioReady && !audioStarted) {
        audioStarted = true
        audioPlayer.play()
      }
    } else if (status === TimeControlStatus.paused) {
      audioPlayer?.pause()
      audioStarted = false
    }
  }
  player.onError = (message) => {
    errorMessage = message
  }

  let sourceOK = false
  try {
    const hasHeaders = options.headers && Object.keys(options.headers).length > 0
    sourceOK = player.setSource(url, hasHeaders ? { headers: options.headers } : undefined)
    if (audioPlayer) sourceOK = audioPlayer.setSource(audioURL!, hasHeaders ? { headers: options.headers } : undefined) && sourceOK
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error)
  }
  if (!sourceOK && !errorMessage) errorMessage = "无法加载媒体源"

  // player.setSource 同步失败时不呈现空播放器；其余加载/缓冲由 AVPlayer 在已打开页面中处理。
  if (!sourceOK) {
    try { player.dispose() } catch { /* best-effort */ }
    try { audioPlayer?.dispose() } catch { /* best-effort */ }
    return { status: "failed", message: errorMessage || "无法加载媒体源" }
  }

  // 用户从格式列表主动进入预览页后，页面必须保持打开，由 AVPlayer 自行缓冲并在
  // onReadyToPlay 中自动开始播放。不能等待固定时限后 dismiss，否则慢 CDN 会被误判失败。
  const presentTask = Navigation.present({
    element: (
      <NativePreviewScreen
        player={player}
        title={title}
        onClose={() => { try { player.pause(); audioPlayer?.pause() } catch {} }}
      />
    ),
  })
  void presentTask.then(() => {
    // Navigation.present 仅在用户关闭页面后 resolve；此时再释放，避免播放页提前失效。
    try { player.pause() } catch {}
    try { player.dispose() } catch { /* best-effort */ }
    try { audioPlayer?.pause(); audioPlayer?.dispose() } catch { /* best-effort */ }
  }).catch(() => {})

  await logEvent({
    level: "info",
    event: "preview.native.presented",
    details: {
      title,
      isMuted: options.autoplayMode === "muted",
      requestMode: "native-avplayer",
      headersApplied: Boolean(options.headers && Object.keys(options.headers).length > 0),
      hasAudio: true,
      ready: readyReported,
    },
  }).catch(() => {})

  return { status: "presented", played: true }
}
