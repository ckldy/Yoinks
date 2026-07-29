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
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;width:100%;background:#000;overflow:hidden}
video{width:100%;height:100%;object-fit:contain;display:block}
.loading{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font:14px -apple-system;text-align:center;z-index:10}
.error{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#ff4444;font:14px -apple-system;text-align:center;padding:20px;z-index:10;max-width:90%}
</style>
</head>
<body>
<div class="loading" id="loading">加载中...</div>
<video id="video" controls playsinline></video>
<div class="error" id="error" style="display:none"></div>

<script src="{{HLS_JS_URL}}"></script>
<script>
var video = document.getElementById('video');
var loading = document.getElementById('loading');
var errorDiv = document.getElementById('error');
var hls = null;
var currentSrc = '';
var hlsConfig = {{HLS_CONFIG}};
var customHeaders = {{CUSTOM_HEADERS}};
var requestMode = 'unknown';

function showError(msg, fatal) {
  loading.style.display = 'none';
  errorDiv.textContent = msg + (fatal ? ' (无法恢复)' : '');
  errorDiv.style.display = 'block';
  console.log('[Player] Error:', msg, fatal ? 'FATAL' : 'RECOVERABLE');
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

function play(src) {
  currentSrc = src;
  loading.style.display = 'block';
  hideError();

  if (hls) {
    hls.destroy();
    hls = null;
  }

  if (window.Hls && Hls.isSupported()) {
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
      video.play().catch(function(e) {
        console.log('[Player] Autoplay prevented:', e);
      });
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
    video.src = src;
    video.addEventListener('loadedmetadata', function() {
      loading.style.display = 'none';
      video.play().catch(function(e) {
        console.log('[Player] Native autoplay prevented:', e);
      });
    });
    video.addEventListener('error', function() {
      showError('原生播放器无法播放此视频', true);
    });
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
  if (hls) {
    hls.destroy();
    hls = null;
  }
  video.src = '';
  video.load();
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
  private requestMode: "unknown" | "hls.js" | "native-fallback" = "unknown"
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

    this.setupMessageHandlers()

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
  }

  private setupMessageHandlers(): void {
    if (!this.controller) return

    this.controller.addScriptMessageHandler("qualityChange", (message: any) => {
      this.emit({ type: "qualitychange", timestamp: Date.now(), data: message })
    })

    this.controller.addScriptMessageHandler("levelsUpdated", (message: any) => {
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

    this.controller.addScriptMessageHandler("error", (message: any) => {
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

    this.controller.addScriptMessageHandler("requestMode", (message: any) => {
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

  async play(url: string): Promise<void> {
    if (this.isDestroyed) throw new Error("Player destroyed")
    this.currentUrl = url

    if (!this.controller) await this.initialize()

    await new Promise<void>(resolve => {
      const id = setTimeout(() => resolve(), 300)
      return () => clearTimeout(id)
    })

    const js = `play(${JSON.stringify(url)})`
    await this.controller.evaluateJavaScript(js)

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

  getRequestMode(): "unknown" | "hls.js" | "native-fallback" {
    return this.requestMode
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