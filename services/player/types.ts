// Core types for the Media Player Skill
// Used by all providers, components, and utilities

// ============================================
// Authentication
// ============================================

export interface AuthTokens {
  token: string
  userId: string
  expiry?: number // Unix timestamp ms
  [key: string]: any
}

export interface AuthProvider {
  getAuth(): Promise<AuthTokens | null>
  isExpiredError(error: any): boolean
  refreshAuth(): Promise<AuthTokens>
  clearAuth(): Promise<void>
}

// ============================================
// Media Metadata (unified from different sources)
// ============================================

export interface MediaMeta {
  id: string
  title: string
  coverUrl?: string
  description?: string
  duration?: number // seconds

  // Payment/access
  isPaid: boolean
  hasPurchased: boolean
  payType?: "coin" | "vip" | "diamond" | "subscription"
  price?: string

  // Streaming info (populated after unlock)
  playUrl?: string
  backupUrl?: string
  lines?: StreamLine[]

  // Source tracking
  source: string // "haijiao" | "tangxin" | "custom"
  rawData?: any // Original API response
}

export interface StreamLine {
  id: string
  name: string
  url: string
  isVip?: boolean
  quality?: string // "1080p", "720p", etc.
}

// ============================================
// Unlock Provider (for paid/VIP content)
// ============================================

export interface UnlockResult {
  meta: MediaMeta
  success: boolean
  error?: string
}

export interface UnlockProvider {
  canUnlock(meta: MediaMeta): boolean
  unlock(mediaId: string, meta: MediaMeta): Promise<UnlockResult | null>
}

// ============================================
// Download
// ============================================

export interface DownloadOptions {
  url: string
  outputPath: string
  headers?: Record<string, string>
  userAgent?: string
  referer?: string
  onProgress?: (progress: DownloadProgress) => void
}

export interface DownloadProgress {
  downloaded: number
  total: number
  percentage: number // 0-1
  speed: number // bytes/sec
  eta: number // seconds
  status: "starting" | "downloading" | "merging" | "completed" | "failed"
}

export interface DownloadResult {
  success: boolean
  path: string
  size: number
  duration: number
  error?: string
}

export interface DownloadTask {
  id: string
  options: DownloadOptions
  status: "pending" | "running" | "completed" | "failed" | "cancelled"
  progress: DownloadProgress
  process?: any // Shell process reference
  startTime: number
  endTime?: number
}

// ============================================
// Player Configuration
// ============================================

export interface PlayerConfig {
  // HLS.js configuration
  hlsConfig?: Partial<HlsConfig>

  // Referer/Origin for requests
  referer?: string
  origin?: string

  // Custom headers
  headers?: Record<string, string>

  // User agent
  userAgent?: string

  // Auto-play
  autoPlay?: boolean

  // Muted start (for autoplay policy)
  muted?: boolean

  // Playsinline
  playsInline?: boolean

  // Preload
  preload?: "none" | "metadata" | "auto"

  // Buffer settings
  maxBufferLength?: number
  maxMaxBufferLength?: number

  // Error recovery
  enableWorker?: boolean
  lowLatencyMode?: boolean

  // External player
  externalPlayerScheme?: string
  externalPlayerEncode?: boolean

  // hls.js URL (optional, for local bundle)
  hlsJsUrl?: string

  // Base URL for WebView
  baseUrl?: string

  /** Separate audio stream for DASH video-only preview (Bilibili/YouTube). */
  audioUrl?: string
}

export interface HlsConfig {
  maxBufferLength: number
  maxMaxBufferLength: number
  maxBufferSize: number
  maxMaxBufferSize: number
  enableWorker: boolean
  lowLatencyMode: boolean
  manifestLoadingTimeOut: number
  manifestLoadingMaxRetry: number
  manifestLoadingRetryDelay: number
  levelLoadingTimeOut: number
  levelLoadingMaxRetry: number
  levelLoadingRetryDelay: number
  fragLoadingTimeOut: number
  fragLoadingMaxRetry: number
  fragLoadingRetryDelay: number
  startLevel: number
  capLevelToPlayerSize: boolean
  capLevelOnFPSDrop: boolean
  fpsDroppedMonitoringPeriod: number
  fpsDroppedMonitoringThreshold: number
  appendErrorMaxRetry: number
  enableSoftwareAES: boolean
  enableCEA708Captions: boolean
  stretchShortVideoTrack: boolean
  forceKeyFrameOnDiscontinuity: boolean
  abrEwmaFastLive: number
  abrEwmaSlowLive: number
  abrEwmaFastVoD: number
  abrEwmaSlowVoD: number
  abrEwmaDefaultEstimate: boolean
  abrBandWidthFactor: number
  abrBandWidthUpFactor: number
  maxStarvationDelay: number
  maxLoadingDelay: number
  minAutoBitrate: number
  emeEnabled: boolean
  requestMediaKeySystemAccessFunc: any
}

// ============================================
// Events
// ============================================

export type PlayerEventType =
  | "ready"
  | "play"
  | "pause"
  | "ended"
  | "error"
  | "waiting"
  | "canplay"
  | "timeupdate"
  | "progress"
  | "seeking"
  | "seeked"
  | "volumechange"
  | "ratechange"
  | "fullscreenchange"
  | "qualitychange"
  | "requestmode"

export interface PlayerEvent<T = any> {
  type: PlayerEventType
  timestamp: number
  data?: T
}

export interface PlayerErrorEvent extends PlayerEvent {
  type: "error"
  data: {
    code: number
    message: string
    recoverable: boolean
    hlsErrorType?: string
    hlsErrorDetails?: string
    fatal?: boolean
  }
}

// ============================================
// Request Mode Reporting
// ============================================

export type RequestMode = "direct" | "hls.js" | "native-fallback" | "unknown"

export interface RequestModeEvent extends PlayerEvent {
  type: "requestmode"
  data: {
    mode: RequestMode
    customHeadersApplied: boolean
  }
}

// ============================================
// Quality Selection
// ============================================

export interface QualityOption {
  id: string
  label: string
  bitrate?: number
  width?: number
  height?: number
  selected: boolean
}

// ============================================
// Subtitle/Caption
// ============================================

export interface SubtitleTrack {
  id: string
  label: string
  language: string
  url: string
  kind: "subtitles" | "captions" | "descriptions" | "chapters" | "metadata"
  default: boolean
}

// ============================================
// Chapter
// ============================================

export interface Chapter {
  id: string
  startTime: number
  endTime: number
  title: string
  thumbnail?: string
}