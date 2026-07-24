// Core HLS Player Service
// Manages WebView + hls.js lifecycle, quality switching, error recovery

import type {
  PlayerConfig,
  PlayerEvent,
  PlayerErrorEvent,
  QualityOption,
  HlsConfig
} from "./types"

export type { PlayerConfig }

// Default HLS.js config optimized for mobile
export const DEFAULT_HLS_CONFIG: HlsConfig = {
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
  maxBufferSize: 60 * 1000 * 1000,
  maxMaxBufferSize: 120 * 1000 * 1000,
  enableWorker: true,
  lowLatencyMode: false,
  manifestLoadingTimeOut: 10000,
  manifestLoadingMaxRetry: 3,
  manifestLoadingRetryDelay: 1000,
  levelLoadingTimeOut: 10000,
  levelLoadingMaxRetry: 4,
  levelLoadingRetryDelay: 1000,
  fragLoadingTimeOut: 20000,
  fragLoadingMaxRetry: 6,
  fragLoadingRetryDelay: 1000,
  startLevel: -1,
  capLevelToPlayerSize: true,
  capLevelOnFPSDrop: true,
  fpsDroppedMonitoringPeriod: 5000,
  fpsDroppedMonitoringThreshold: 0.2,
  appendErrorMaxRetry: 3,
  enableSoftwareAES: true,
  enableCEA708Captions: true,
  stretchShortVideoTrack: true,
  forceKeyFrameOnDiscontinuity: true,
  abrEwmaFastLive: 3.0,
  abrEwmaSlowLive: 9.0,
  abrEwmaFastVoD: 3.0,
  abrEwmaSlowVoD: 9.0,
  abrEwmaDefaultEstimate: true,
  abrBandWidthFactor: 0.95,
  abrBandWidthUpFactor: 0.7,
  maxStarvationDelay: 4,
  maxLoadingDelay: 4,
  minAutoBitrate: 0,
  emeEnabled: false,
  requestMediaKeySystemAccessFunc: null
}

// Browser-restricted headers that cannot be set via XHR/fetch
export const RESTRICTED_HEADERS = new Set([
  "referer",
  "origin",
  "host",
  "connection",
  "content-length",
  "user-agent",
  "cookie",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "upgrade-insecure-requests",
])

// Filter out browser-restricted headers from custom headers for XHR injection
export function filterAllowedHeaders(headers: Record<string, string>): Record<string, string> {
  const allowed: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase()
    if (!RESTRICTED_HEADERS.has(normalized) && value && typeof value === "string") {
      // Sanitize header name and value
      const sanitizedName = key.replace(/[^a-zA-Z0-9\-]/g, "")
      const sanitizedValue = value.replace(/[\r\n]/g, " ")
      if (sanitizedName && sanitizedName.length <= 128 && sanitizedValue.length <= 8192) {
        allowed[sanitizedName] = sanitizedValue
      }
    }
  }
  return allowed
}

// Serialize headers for safe JSON injection into HTML
export function serializeHeadersForJS(headers: Record<string, string>): string {
  return JSON.stringify(filterAllowedHeaders(headers))
}

// HTML template with embedded hls.js and header injection support
const PLAYER_HTML_TEMPLATE = `
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="referrer" content="no-referrer-when-downgrade">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;width:100%;background:#000;overflow:hidden}
video{width:100%;height:100%;object-fit:contain;display:block}
audio{display:none}
.loading{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font:14px -apple-system;text-align:center;z-index:10}
.error{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#ff4444;font:14px -apple-system;text-align:center;padding:20px;z-index:10;max-width:90%}
</style>
</head>
<body>
<div class="loading" id="loading">加载中...</div>
<video id="video" controls {{PLAYS_INLINE}} {{MUTED}} {{AUTOPLAY}} preload="{{PRELOAD}}"></video>
<audio id="audio" preload="auto"></audio>
<div class="error" id="error" style="display:none"></div>

<script src="{{HLS_JS_URL}}"></script>
<script>
var video = document.getElementById('video');
var audio = document.getElementById('audio');
var loading = document.getElementById('loading');
var errorDiv = document.getElementById('error');
var hls = null;
var currentSrc = '';
var currentAudioSrc = '';
var hlsConfig = {{HLS_CONFIG}};
var customHeaders = {{CUSTOM_HEADERS}};
var preferMuted = {{PREFER_MUTED}};
var requestMode = 'unknown';
var startedReported = false;
var blackScreenTimer = null;

function reportError(message, fatal) {
  try {
    window.webkit?.messageHandlers?.error?.postMessage({ error: message, fatal: !!fatal });
  } catch (e) {
    console.log('[Player] Failed to report error:', e);
  }
}

function showError(msg, fatal) {
  loading.style.display = 'none';
  errorDiv.textContent = msg + (fatal ? ' (无法恢复)' : '');
  errorDiv.style.display = 'block';
  reportError(msg, fatal);
  console.log('[Player] Error:', msg, fatal ? 'FATAL' : 'RECOVERABLE');
}

function isHlsSource(src) {
  try {
    return new URL(src).pathname.toLowerCase().endsWith('.m3u8');
  } catch (e) {
    return /\.m3u8(?:[?#]|$)/i.test(src);
  }
}

function reportPlaybackEvent(type) {
  try {
    window.webkit?.messageHandlers?.playback?.postMessage({ type: type });
  } catch (e) {
    console.log('[Player] Failed to report playback event:', e);
  }
}

function stopOrphanAudio() {
  try {
    if (!audio) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  } catch (e) {}
}

function hasVisibleVideoFrame() {
  // AV1/HEVC often "plays" with 0x0 videoWidth while <audio> still works → 有声无画.
  return video && video.videoWidth > 0 && video.readyState >= 2;
}

function syncAudioFromVideo() {
  if (!currentAudioSrc || !audio) return;
  try {
    if (Math.abs(audio.currentTime - video.currentTime) > 0.35) audio.currentTime = video.currentTime;
  } catch (e) {}
}

function playAudioWithVideo() {
  if (!currentAudioSrc || !audio) return;
  // Never start paired audio until video has a real frame (prevents black-screen-with-sound).
  if (!hasVisibleVideoFrame()) return;
  if (!audio.getAttribute('src')) {
    audio.src = currentAudioSrc;
    try { audio.load(); } catch (e) {}
  }
  try { audio.currentTime = video.currentTime || 0; } catch (e) {}
  audio.play().catch(function() {});
}

function startNativePlayback() {
  video.play().catch(function(e) {
    console.log('[Player] Autoplay prevented:', e);
  });
  // Dual-stream: wait for video frame via onplaying/ontimeupdate; do not start audio here.
  if (!currentAudioSrc) return;
  playAudioWithVideo();
}

function markPlaying() {
  if (startedReported) return;
  // For progressive-av, require a visible frame so soft-timeout is honest and audio is gated.
  if (currentAudioSrc && !hasVisibleVideoFrame()) return;
  startedReported = true;
  if (blackScreenTimer) { clearTimeout(blackScreenTimer); blackScreenTimer = null; }
  loading.style.display = 'none';
  reportPlaybackEvent('playing');
}

function bindMediaEvents() {
  video.oncanplay = function() {
    loading.style.display = 'none';
    reportPlaybackEvent('canplay');
  };
  video.onplaying = function() {
    if (currentAudioSrc && !hasVisibleVideoFrame()) {
      // Decode may still be pending; do not start orphan audio.
      return;
    }
    if (currentAudioSrc && audio && audio.paused) playAudioWithVideo();
    markPlaying();
  };
  video.onpause = function() {
    if (currentAudioSrc && audio && !audio.paused) audio.pause();
  };
  video.onseeking = function() { syncAudioFromVideo(); };
  video.onseeked = function() {
    syncAudioFromVideo();
    if (!video.paused && currentAudioSrc) playAudioWithVideo();
  };
  video.ontimeupdate = function() {
    if (currentAudioSrc && !hasVisibleVideoFrame()) {
      // Advancing time without frames: stop any premature audio.
      try { if (audio && !audio.paused) audio.pause(); } catch (e) {}
      return;
    }
    if (video.currentTime > 0.05) {
      if (currentAudioSrc && audio && audio.paused) playAudioWithVideo();
      markPlaying();
    }
    if (currentAudioSrc && audio && !audio.paused && Math.abs(audio.currentTime - video.currentTime) > 0.5) syncAudioFromVideo();
  };
  video.onerror = function() {
    stopOrphanAudio();
    if (blackScreenTimer) { clearTimeout(blackScreenTimer); blackScreenTimer = null; }
    var code = video.error && video.error.code;
    var hint = currentAudioSrc
      ? (code === 4 ? '视频编码可能不受支持（请选 H.264/AVC 清晰度）' : '视频轨加载失败（防盗链或直链失效）')
      : '原生播放器无法播放此媒体';
    showError(hint, true);
  };
}

function bindDirectMediaEvents() {
  bindMediaEvents();
  video.onloadedmetadata = function() {
    loading.style.display = 'none';
    startNativePlayback();
  };
}

function hideError() {
  errorDiv.style.display = 'none';
}

function reportMode(mode, headersApplied) {
  requestMode = mode;
  try {
    window.webkit?.messageHandlers?.requestMode?.postMessage({
      mode: mode,
      customHeadersApplied: headersApplied
    });
  } catch (e) {
    console.log('[Player] Failed to report request mode:', e);
  }
}

function play(src, audioSrc) {
  currentSrc = src;
  currentAudioSrc = audioSrc || '';
  startedReported = false;
  if (blackScreenTimer) { clearTimeout(blackScreenTimer); blackScreenTimer = null; }
  loading.style.display = 'block';
  hideError();
  bindMediaEvents();

  if (hls) {
    hls.destroy();
    hls = null;
  }

  // DASH video-only + separate audio: video element muted; sound from <audio> (respect preferMuted).
  // Only load audio after video has frames (playAudioWithVideo); keep src empty until then to avoid orphan sound.
  if (currentAudioSrc) {
    video.muted = true;
    audio.muted = !!preferMuted;
    try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (e) {}
    // Arm once: if no frame in 8s, stop and tip (do not leave silent black with no feedback).
    blackScreenTimer = setTimeout(function() {
      blackScreenTimer = null;
      if (startedReported || hasVisibleVideoFrame()) return;
      stopOrphanAudio();
      showError('视频无画面（可能是 AV1/防盗链）。请改选 H.264 清晰度或直接下载。', true);
    }, 8000);
  } else {
    audio.removeAttribute('src');
    try { audio.load(); } catch (e) {}
  }

  if (!isHlsSource(src)) {
    reportMode(currentAudioSrc ? 'progressive-av' : 'direct', false);
    bindDirectMediaEvents();
    video.src = src;
    video.load();
  } else if (window.Hls && Hls.isSupported()) {
    reportMode('hls.js', Object.keys(customHeaders).length > 0);

    hls = new Hls(hlsConfig);
    // Inject custom headers for all hls.js controlled requests
    if (Object.keys(customHeaders).length > 0) {
      hls.on(Hls.Events.XHR_SETUP, function(event, data) {
        Object.entries(customHeaders).forEach(function([name, value]) {
          try { data.xhr.setRequestHeader(name, value); } catch (e) {}
        });
      });
      // For newer hls.js versions that support fetch
      if (Hls.Events.FETCH_SETUP) {
        hls.on(Hls.Events.FETCH_SETUP, function(event, data) {
          Object.entries(customHeaders).forEach(function([name, value]) {
            try { data.headers.set(name, value); } catch (e) {}
          });
        });
      }
    }

    hls.loadSource(src);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, function() {
      loading.style.display = 'none';
      startNativePlayback();
    });

    hls.on(Hls.Events.ERROR, function(event, data) {
      console.log('[Player] HLS Error:', data.type, data.details, data.fatal);
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            showError('网络错误，尝试重连...', false);
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            showError('媒体错误，尝试恢复...', false);
            hls.recoverMediaError();
            break;
          default:
            showError('播放失败: ' + data.details, true);
            hls.destroy();
            hls = null;
            break;
        }
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        // Non-fatal media errors - hls.js handles internally
      }
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, function(event, data) {
      console.log('[Player] Quality switched to:', data.level);
      window.webkit?.messageHandlers?.qualityChange?.postMessage({ level: data.level });
    });

    hls.on(Hls.Events.LEVELS_UPDATED, function(event, data) {
      var levels = data.levels.map(function(l, i) {
        return { id: i, label: l.height + 'p', bitrate: l.bitrate, width: l.width, height: l.height };
      });
      window.webkit?.messageHandlers?.levelsUpdated?.postMessage({ levels: levels });
    });

  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Native HLS fallback - cannot inject custom headers
    reportMode('native-fallback', false);
    bindDirectMediaEvents();
    video.src = src;
    video.load();
  } else {
    showError('不支持HLS播放', true);
  }
}

function setQuality(level) {
  if (hls) {
    hls.currentLevel = level;
  }
}

function destroy() {
  if (blackScreenTimer) { clearTimeout(blackScreenTimer); blackScreenTimer = null; }
  if (hls) {
    hls.destroy();
    hls = null;
  }
  try { video.pause(); } catch (e) {}
  video.src = '';
  video.load();
  try {
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
  } catch (e) {}
  currentAudioSrc = '';
  startedReported = false;
}

window.play = play;
window.setQuality = setQuality;
window.destroy = destroy;
</script>
</body>
</html>
`

export class HLSPlayerService {
  private controller: any = null
  private config: PlayerConfig
  private eventListeners: Map<string, Set<(event: PlayerEvent) => void>> = new Map()
  private currentUrl: string = ""
  private isDestroyed: boolean = false
  private hlsJsUrl: string
  private baseUrl: string
  private customHeaders: Record<string, string>
  private requestMode: "unknown" | "direct" | "hls.js" | "native-fallback" | "progressive-av" = "unknown"
  private headersApplied: boolean = false

  constructor(config: PlayerConfig = {}) {
    this.config = {
      autoPlay: true,
      muted: false,
      playsInline: true,
      preload: "metadata",
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      enableWorker: true,
      lowLatencyMode: false,
      hlsJsUrl: "https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js",
      baseUrl: "https://example.com",
      ...config
    }
    this.hlsJsUrl = this.config.hlsJsUrl!
    this.baseUrl = this.config.baseUrl!
    this.customHeaders = filterAllowedHeaders(this.config.headers || {})
  }

  async initialize(): Promise<any> {
    if (this.controller) return this.controller

    const html = this.buildHtml()
    this.controller = new WebViewController()
    await this.controller.loadHTML(html, this.baseUrl)

    await this.setupMessageHandlers()

    return this.controller
  }

  private buildHtml(): string {
    const hlsConfig = {
      ...DEFAULT_HLS_CONFIG,
      maxBufferLength: this.config.maxBufferLength,
      maxMaxBufferLength: this.config.maxMaxBufferLength,
      enableWorker: this.config.enableWorker,
      lowLatencyMode: this.config.lowLatencyMode
    }

    return PLAYER_HTML_TEMPLATE
      .replace("{{HLS_JS_URL}}", this.hlsJsUrl)
      .replace("{{HLS_CONFIG}}", JSON.stringify(hlsConfig))
      .replace("{{CUSTOM_HEADERS}}", serializeHeadersForJS(this.config.headers || {}))
      .replace("{{PLAYS_INLINE}}", this.config.playsInline ? "playsinline" : "")
      .replace("{{MUTED}}", this.config.muted ? "muted" : "")
      .replace("{{PREFER_MUTED}}", this.config.muted ? "true" : "false")
      .replace("{{AUTOPLAY}}", this.config.autoPlay ? "autoplay" : "")
      .replace("{{PRELOAD}}", this.config.preload || "metadata")
  }

  private async setupMessageHandlers(): Promise<void> {
    if (!this.controller) return

    await this.controller.addScriptMessageHandler("qualityChange", (message: any) => {
      this.emit({ type: "qualitychange", timestamp: Date.now(), data: message })
    })

    await this.controller.addScriptMessageHandler("levelsUpdated", (message: any) => {
      const options: QualityOption[] = message.levels.map((l: any) => ({
        id: String(l.id),
        label: l.label,
        bitrate: l.bitrate,
        width: l.width,
        height: l.height,
        selected: false
      }))
      this.emit({ type: "qualitychange", timestamp: Date.now(), data: { options } })
    })

    await this.controller.addScriptMessageHandler("error", (message: any) => {
      this.emit({
        type: "error",
        timestamp: Date.now(),
        data: {
          code: -1,
          message: message.error,
          recoverable: !message.fatal,
          fatal: message.fatal
        }
      } as PlayerErrorEvent)
    })

    await this.controller.addScriptMessageHandler("playback", (message: any) => {
      if (message?.type === "canplay") {
        this.emit({ type: "canplay", timestamp: Date.now() })
      }
      if (message?.type === "playing") {
        this.emit({ type: "play", timestamp: Date.now(), data: { url: this.currentUrl, confirmed: true } })
      }
    })

    await this.controller.addScriptMessageHandler("requestMode", (message: any) => {
      this.requestMode = message.mode
      this.headersApplied = message.customHeadersApplied === true
      this.emit({
        type: "requestmode",
        timestamp: Date.now(),
        data: {
          mode: message.mode,
          customHeadersApplied: message.customHeadersApplied
        }
      })
    })
  }

  async play(url: string, audioUrl?: string): Promise<void> {
    if (this.isDestroyed) throw new Error("Player destroyed")
    this.currentUrl = url

    if (!this.controller) await this.initialize()

    await new Promise<void>(resolve => {
      const id = setTimeout(() => resolve(), 300)
      return () => clearTimeout(id)
    })

    const pairedAudio = audioUrl || this.config.audioUrl || ""
    const js = `play(${JSON.stringify(url)}, ${JSON.stringify(pairedAudio)})`
    await this.controller.evaluateJavaScript(js)

    // Unconfirmed intent only — waitForPlayback requires confirmed: true from WebView.
    this.emit({ type: "play", timestamp: Date.now(), data: { url } })
  }

  async pause(): Promise<void> {
    if (!this.controller) return
    await this.controller.evaluateJavaScript("video.pause()")
    this.emit({ type: "pause", timestamp: Date.now() })
  }

  async resume(): Promise<void> {
    if (!this.controller) return
    await this.controller.evaluateJavaScript("video.play()")
    this.emit({ type: "play", timestamp: Date.now() })
  }

  async seek(seconds: number): Promise<void> {
    if (!this.controller) return
    await this.controller.evaluateJavaScript(`video.currentTime = ${seconds}`)
    this.emit({ type: "seeked", timestamp: Date.now(), data: { position: seconds } })
  }

  async setPlaybackRate(rate: number): Promise<void> {
    if (!this.controller) return
    await this.controller.evaluateJavaScript(`video.playbackRate = ${rate}`)
    this.emit({ type: "ratechange", timestamp: Date.now(), data: { rate } })
  }

  async setVolume(volume: number): Promise<void> {
    if (!this.controller) return
    await this.controller.evaluateJavaScript(`video.volume = ${Math.max(0, Math.min(1, volume))}`)
    this.emit({ type: "volumechange", timestamp: Date.now(), data: { volume } })
  }

  async setQuality(levelId: string | number): Promise<void> {
    if (!this.controller) return
    await this.controller.evaluateJavaScript(`setQuality(${levelId})`)
  }

  async getCurrentTime(): Promise<number> {
    if (!this.controller) return 0
    const result = await this.controller.evaluateJavaScript("video.currentTime")
    return Number(result) || 0
  }

  async getDuration(): Promise<number> {
    if (!this.controller) return 0
    const result = await this.controller.evaluateJavaScript("video.duration")
    return Number(result) || 0
  }

  async getBuffered(): Promise<Array<{ start: number; end: number }>> {
    if (!this.controller) return []
    const result = await this.controller.evaluateJavaScript(`
      (function() {
        var buffered = video.buffered;
        var ranges = [];
        for (var i = 0; i < buffered.length; i++) {
          ranges.push({ start: buffered.start(i), end: buffered.end(i) });
        }
        return ranges;
      })()
    `)
    return result || []
  }

  async isPlaying(): Promise<boolean> {
    if (!this.controller) return false
    const result = await this.controller.evaluateJavaScript("!video.paused && !video.ended")
    return Boolean(result)
  }

  async setFullscreen(fullscreen: boolean): Promise<void> {
    if (!this.controller) return
    await this.controller.evaluateJavaScript(
      fullscreen
        ? "video.webkitEnterFullscreen?.()"
        : "video.webkitExitFullscreen?.()"
    )
  }

  async destroy(): Promise<void> {
    if (this.isDestroyed) return
    this.isDestroyed = true

    if (this.controller) {
      await this.controller.evaluateJavaScript("destroy()")
      this.controller.dispose()
      this.controller = null
    }

    this.currentUrl = ""
    this.eventListeners.clear()
    this.emit({ type: "ended", timestamp: Date.now() })
  }

  getController(): any {
    return this.controller
  }

  getCurrentUrl(): string {
    return this.currentUrl
  }

  getRequestMode(): "unknown" | "direct" | "hls.js" | "native-fallback" | "progressive-av" {
    return this.requestMode as "unknown" | "direct" | "hls.js" | "native-fallback" | "progressive-av"
  }

  getHeadersApplied(): boolean {
    return this.headersApplied
  }

  getHtmlForTesting(): string {
    return this.buildHtml()
  }

  updateConfig(config: Partial<PlayerConfig>): void {
    this.config = { ...this.config, ...config }
    if (config.headers) {
      this.customHeaders = filterAllowedHeaders(config.headers)
    }
  }

  on(eventType: string, listener: (event: PlayerEvent) => void): () => void {
    if (!this.eventListeners.has(eventType)) {
      this.eventListeners.set(eventType, new Set())
    }
    this.eventListeners.get(eventType)!.add(listener)

    return () => this.off(eventType, listener)
  }

  off(eventType: string, listener: (event: PlayerEvent) => void): void {
    this.eventListeners.get(eventType)?.delete(listener)
  }

  private emit(event: PlayerEvent): void {
    this.eventListeners.get(event.type)?.forEach(fn => {
      try { fn(event) } catch (e) { console.error("Player event listener error:", e) }
    })

    this.eventListeners.get("*")?.forEach(fn => {
      try { fn(event) } catch (e) { console.error("Player wildcard listener error:", e) }
    })
  }

  once(eventType: string): Promise<PlayerEvent> {
    return new Promise(resolve => {
      const off = this.on(eventType, event => {
        off()
        resolve(event)
      })
    })
  }

  async waitFor(eventType: string, timeoutMs = 10000): Promise<PlayerEvent> {
    return Promise.race([
      this.once(eventType),
      new Promise<PlayerEvent>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout waiting for ${eventType}`)), timeoutMs)
      )
    ])
  }
}

export function createPlayer(config: PlayerConfig = {}): HLSPlayerService {
  return new HLSPlayerService(config)
}

export const PlayerPresets = {
  default: (baseUrl: string) => ({
    baseUrl,
    hlsJsUrl: "https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js",
    autoPlay: true,
    playsInline: true,
    maxBufferLength: 30,
    maxMaxBufferLength: 60
  }),

  lowLatency: (baseUrl: string) => ({
    ...PlayerPresets.default(baseUrl),
    lowLatencyMode: true,
    maxBufferLength: 10,
    maxMaxBufferLength: 20
  }),

  highQuality: (baseUrl: string) => ({
    ...PlayerPresets.default(baseUrl),
    maxBufferLength: 60,
    maxMaxBufferLength: 120
  }),

  haijiao: () => PlayerPresets.default("https://haijiao.com"),

  tangxin: () => PlayerPresets.default("https://tth.txh069.com")
}