// DASH Player Service for Bilibili-style .m4s DASH segments
// Uses dash.js + a self-generated MPD to play video-only + audio .m4s streams.

import type { PlayerConfig, PlayerEvent, PlayerErrorEvent } from "./types"
import { filterAllowedHeaders, serializeHeadersForJS } from "./hls-player-service"
import { BILIBILI_DESKTOP_UA, rewriteBilibiliCdnUrl } from "./bilibili-cdn"
import { logEvent } from "../logs"

export type { PlayerConfig }

// Default dash.js CDN. Using jsdelivr; fallback to unpkg if needed.
const DEFAULT_DASH_JS_URL =
  "https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js"

// Browser-restricted headers already filtered in hls-player-service; just re-export for clarity.
export { filterAllowedHeaders, serializeHeadersForJS }

const DASH_HTML_TEMPLATE = `
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<!-- Send full Referer to same-security cross-origin CDN (e.g. bilibili.com -> bilivideo.com). -->
<meta name="referrer" content="no-referrer-when-downgrade">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;width:100%;background:#000;overflow:hidden}
video{width:100%;height:100%;object-fit:contain;display:block}
.loading{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font:14px -apple-system;text-align:center;z-index:10}
.error{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#ff4444;font:14px -apple-system;text-align:center;padding:20px;z-index:10;max-width:90%;display:none}
</style>
</head>
<body>
<div class="loading" id="loading">加载中...</div>
<video id="video" controls {{PLAYS_INLINE}} {{MUTED}} {{AUTOPLAY}} preload="auto"></video>
<div class="error" id="error"></div>

<script src="{{DASH_JS_URL}}"></script>
<script>
var video = document.getElementById('video');
var loading = document.getElementById('loading');
var errorDiv = document.getElementById('error');
var player = null;
var requestMode = 'dash.js';
var headersApplied = false;

var config = {{DASH_CONFIG}};

function reportError(message, fatal) {
  try {
    window.webkit?.messageHandlers?.error?.postMessage({ error: String(message), fatal: !!fatal });
  } catch (e) {}
}
function reportPlayback(type) {
  try {
    window.webkit?.messageHandlers?.playback?.postMessage({ type: type });
  } catch (e) {}
}
function reportMode(mode, applied) {
  requestMode = mode;
  headersApplied = !!applied;
  try {
    window.webkit?.messageHandlers?.requestMode?.postMessage({ mode: mode, customHeadersApplied: !!applied });
  } catch (e) {}
}
function reportDiagnostic(label, data) {
  try {
    window.webkit?.messageHandlers?.diagnostic?.postMessage({ label: String(label), data: data == null ? null : data });
  } catch (e) {}
}
function showError(msg, fatal) {
  loading.style.display = 'none';
  errorDiv.textContent = msg + (fatal ? ' (无法恢复)' : '');
  errorDiv.style.display = 'block';
  reportError(msg, fatal);
}

// Parse top-level MP4 boxes from an ArrayBuffer. Returns array of {type, offset, size}.
function parseMp4Boxes(buffer) {
  var boxes = [];
  var data = new DataView(buffer);
  var offset = 0;
  while (offset + 8 <= buffer.byteLength) {
    var size = data.getUint32(offset, false);
    var type = '';
    for (var i = 4; i < 8; i++) {
      type += String.fromCharCode(data.getUint8(offset + i));
    }
    if (size === 0) {
      size = buffer.byteLength - offset;
    } else if (size === 1) {
      if (offset + 16 > buffer.byteLength) break;
      var hi = data.getUint32(offset + 8, false);
      var lo = data.getUint32(offset + 12, false);
      size = hi * 4294967296 + lo;
    }
    if (size < 8 || offset + size > buffer.byteLength) break;
    boxes.push({ type: type, offset: offset, size: size });
    offset += size;
  }
  return boxes;
}

// Find init (ftyp+moov) end and sidx range from the first buffer of a .m4s file.
function findInitAndIndexRanges(buffer) {
  var boxes = parseMp4Boxes(buffer);
  var moovEnd = -1;
  var sidxStart = -1;
  var sidxEnd = -1;
  for (var i = 0; i < boxes.length; i++) {
    var b = boxes[i];
    if (b.type === 'moov') {
      moovEnd = b.offset + b.size;
    } else if (b.type === 'sidx') {
      sidxStart = b.offset;
      sidxEnd = b.offset + b.size;
    }
  }
  if (moovEnd < 0) return null;
  // init ends right before sidx if present, otherwise after moov.
  var initEnd = sidxStart > 0 ? sidxStart : moovEnd;
  return {
    initEnd: initEnd,
    sidxStart: sidxStart,
    sidxEnd: sidxEnd
  };
}

function fetchArrayBuffer(url, headers) {
  return new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    // 2 MB is enough for large YouTube moov/sidx boxes while still being a small probe.
    xhr.setRequestHeader('Range', 'bytes=0-2097151');
    Object.entries(headers || {}).forEach(function(entry) {
      try { xhr.setRequestHeader(entry[0], entry[1]); } catch (e) {}
    });
    xhr.onload = function() {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response);
      } else {
        reject(new Error('HTTP ' + xhr.status));
      }
    };
    xhr.onerror = function() { reject(new Error('Network error')); };
    xhr.send();
  });
}
function isForbiddenStatus(err) {
  var msg = String(err && err.message ? err.message : err);
  return /\b403\b/.test(msg);
}

function buildMpd(videoUrl, videoRanges, audioUrl, audioRanges, duration, videoCodec, audioCodec) {
  function segBase(ranges, url) {
    var sb = '<SegmentBase indexRangeExact="false"';
    if (ranges.sidxStart >= 0 && ranges.sidxEnd > ranges.sidxStart) {
      sb += ' indexRange="' + ranges.sidxStart + '-' + (ranges.sidxEnd - 1) + '"';
    }
    sb += '>';
    sb += '<Initialization sourceURL="' + escapeXml(url) + '" range="0-' + (ranges.initEnd - 1) + '"/>';
    if (ranges.sidxStart >= 0 && ranges.sidxEnd > ranges.sidxStart) {
      sb += '<RepresentationIndex sourceURL="' + escapeXml(url) + '" range="' + ranges.sidxStart + '-' + (ranges.sidxEnd - 1) + '"/>';
    }
    sb += '</SegmentBase>';
    return sb;
  }
  function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function pts(seconds) {
    return 'PT' + seconds + 'S';
  }
  var mpd = '<?xml version="1.0" encoding="UTF-8"?>';
  mpd += '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="' + pts(duration) + '" minBufferTime="PT2S">';
  mpd += '<Period duration="' + pts(duration) + '">';
  // Video adaptation set
  var videoCodecAttr = videoCodec ? ' codecs="' + escapeXml(videoCodec) + '"' : '';
  mpd += '<AdaptationSet mimeType="video/mp4" contentType="video" segmentAlignment="true" subsegmentAlignment="true" startWithSAP="1">';
  mpd += '<Representation id="v1" bandwidth="1000000"' + videoCodecAttr + '>';
  mpd += '<BaseURL>' + escapeXml(videoUrl) + '</BaseURL>';
  mpd += segBase(videoRanges, videoUrl);
  mpd += '</Representation></AdaptationSet>';
  // Audio adaptation set
  var audioCodecAttr = audioCodec ? ' codecs="' + escapeXml(audioCodec) + '"' : '';
  mpd += '<AdaptationSet mimeType="audio/mp4" contentType="audio" segmentAlignment="true" subsegmentAlignment="true" startWithSAP="1">';
  mpd += '<Representation id="a1" bandwidth="128000"' + audioCodecAttr + '>';
  mpd += '<BaseURL>' + escapeXml(audioUrl) + '</BaseURL>';
  mpd += segBase(audioRanges, audioUrl);
  mpd += '</Representation></AdaptationSet>';
  mpd += '</Period></MPD>';
  return 'data:application/dash+xml;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent(mpd)));
}

async function probeRangesForUrl(url, fallbackUrl, headers) {
  try {
    var buf = await fetchArrayBuffer(url, headers);
    var ranges = findInitAndIndexRanges(buf);
    if (!ranges) throw new Error('无法解析 .m4s 初始化段');
    return { ranges: ranges, usedFallback: false };
  } catch (err) {
    if (fallbackUrl && fallbackUrl !== url && isForbiddenStatus(err)) {
      reportDiagnostic('dash.init.fallback', { reason: String(err.message || err), original: url, fallback: fallbackUrl });
      var buf2 = await fetchArrayBuffer(fallbackUrl, headers);
      var ranges2 = findInitAndIndexRanges(buf2);
      if (!ranges2) throw new Error('无法解析 .m4s 初始化段');
      return { ranges: ranges2, usedFallback: true };
    }
    throw err;
  }
}

function startDashPlayback() {
  if (!config.videoUrl || !config.audioUrl) {
    showError('DASH 播放器缺少视频或音频地址', true);
    return;
  }
  if (!window.dashjs || !window.dashjs.MediaPlayer) {
    showError('DASH 播放器加载失败', true);
    return;
  }
  if (typeof window.MediaSource === 'undefined' && typeof window.WebKitMediaSource === 'undefined') {
    showError('当前系统/浏览器不支持 MSE，无法播放 DASH 分段', true);
    return;
  }
  player = window.dashjs.MediaPlayer().create();

  // Inject custom headers into dash.js XHR requests
  var allowedHeaders = config.customHeaders || {};
  if (Object.keys(allowedHeaders).length > 0) {
    player.updateSettings({
      streaming: {
        requestModifier: {
          modifyRequestHeader: function(xhr) {
            Object.entries(allowedHeaders).forEach(function(entry) {
              try { xhr.setRequestHeader(entry[0], entry[1]); } catch (e) {}
            });
            return xhr;
          },
          modifyRequestURL: function(url) { return url; }
        }
      }
    });
    headersApplied = true;
  }

  player.on('playbackStarted', function() {
    loading.style.display = 'none';
    reportPlayback('playing');
  });
  player.on('canPlay', function() {
    loading.style.display = 'none';
    reportPlayback('canplay');
  });
  player.on('error', function(e) {
    var msg = (e && e.error && e.error.message) ? e.error.message : 'DASH 播放失败';
    showError(msg, true);
  });

  reportMode('dash.js', headersApplied);

  reportDiagnostic('dash.init.urls', {
    videoUrl: config.videoUrl,
    videoFallback: config.videoFallbackUrl,
    audioUrl: config.audioUrl,
    audioFallback: config.audioFallbackUrl,
    headerKeys: Object.keys(allowedHeaders || {}),
    baseUrl: document.baseURI || null
  });
  Promise.all([
    probeRangesForUrl(config.videoUrl, config.videoFallbackUrl, allowedHeaders),
    probeRangesForUrl(config.audioUrl, config.audioFallbackUrl, allowedHeaders)
  ]).then(function(results) {
    var videoResult = results[0];
    var audioResult = results[1];
    var videoPlayUrl = videoResult.usedFallback && config.videoFallbackUrl ? config.videoFallbackUrl : config.videoUrl;
    var audioPlayUrl = audioResult.usedFallback && config.audioFallbackUrl ? config.audioFallbackUrl : config.audioUrl;
    reportDiagnostic('dash.init.success', { videoUsedFallback: videoResult.usedFallback, audioUsedFallback: audioResult.usedFallback });
    var mpd = buildMpd(videoPlayUrl, videoResult.ranges, audioPlayUrl, audioResult.ranges, config.duration || 0, config.videoCodec, config.audioCodec);
    player.initialize(video, mpd, config.autoPlay);
    if (config.muted) {
      video.muted = true;
    }
  }).catch(function(err) {
    showError('DASH 初始化失败: ' + (err.message || err), true);
  });
}

window.startDashPlayback = startDashPlayback;
window.destroyDashPlayer = function() {
  try {
    if (player) { player.reset(); player = null; }
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch (e) {}
};

startDashPlayback();
</script>
</body>
</html>
`

export class DashPlayerService {
  private controller: any = null
  private config: Required<Pick<PlayerConfig, "autoPlay" | "muted" | "playsInline" | "baseUrl">> & PlayerConfig
  private dashJsUrl: string
  private customHeaders: Record<string, string>
  private eventListeners: Map<string, Set<(event: PlayerEvent) => void>> = new Map()
  private currentUrl: string = ""
  private currentOriginalUrl: string = ""
  private currentAudioUrl: string = ""
  private currentOriginalAudioUrl: string = ""
  private duration: number = 0
  private isDestroyed: boolean = false
  private requestMode: "dash.js" | "unknown" = "unknown"
  private headersApplied: boolean = false

  constructor(config: PlayerConfig = {}) {
    this.config = {
      autoPlay: true,
      muted: false,
      playsInline: true,
      baseUrl: "https://example.com",
      ...config,
    } as any
    this.dashJsUrl = this.config.dashJsUrl || DEFAULT_DASH_JS_URL
    this.customHeaders = filterAllowedHeaders(this.config.headers || {})
  }

  async initialize(): Promise<any> {
    if (this.controller) return this.controller

    const html = this.buildHtml()
    this.controller = new WebViewController()
    // Bilibili CDN mirrors enforce UA checks; use a desktop Chrome UA by default.
    try {
      this.controller.setCustomUserAgent(this.config.userAgent || BILIBILI_DESKTOP_UA)
    } catch { /* UA setting is best-effort */ }
    await this.controller.loadHTML(html, this.config.baseUrl)
    await this.setupMessageHandlers()
    return this.controller
  }

  private buildHtml(): string {
    const dashConfig = {
      videoUrl: this.currentUrl,
      videoFallbackUrl: this.currentOriginalUrl,
      audioUrl: this.currentAudioUrl,
      audioFallbackUrl: this.currentOriginalAudioUrl,
      duration: this.duration,
      customHeaders: this.customHeaders,
      autoPlay: this.config.autoPlay,
      muted: this.config.muted,
      videoCodec: this.config.videoCodec,
      audioCodec: this.config.audioCodec,
    }
    return DASH_HTML_TEMPLATE
      .replace("{{DASH_JS_URL}}", this.dashJsUrl)
      .replace("{{DASH_CONFIG}}", JSON.stringify(dashConfig).replace(/</g, "\\u003c"))
      .replace("{{PLAYS_INLINE}}", this.config.playsInline ? "playsinline" : "")
      .replace("{{MUTED}}", this.config.muted ? "muted" : "")
      .replace("{{AUTOPLAY}}", this.config.autoPlay ? "autoplay" : "")
  }

  private async setupMessageHandlers(): Promise<void> {
    if (!this.controller) return

    await this.controller.addScriptMessageHandler("playback", (message: any) => {
      if (message?.type === "canplay") {
        this.emit({ type: "canplay", timestamp: Date.now() })
      }
      if (message?.type === "playing") {
        this.emit({ type: "play", timestamp: Date.now(), data: { url: this.currentUrl, confirmed: true } })
      }
    })

    await this.controller.addScriptMessageHandler("error", (message: any) => {
      this.emit({
        type: "error",
        timestamp: Date.now(),
        data: {
          code: -1,
          message: message.error,
          recoverable: !message.fatal,
          fatal: message.fatal,
        },
      } as PlayerErrorEvent)
    })

    await this.controller.addScriptMessageHandler("requestMode", (message: any) => {
      this.requestMode = message.mode
      this.headersApplied = message.customHeadersApplied === true
      this.emit({
        type: "requestmode",
        timestamp: Date.now(),
        data: { mode: message.mode, customHeadersApplied: message.customHeadersApplied },
      })
    })

    await this.controller.addScriptMessageHandler("diagnostic", (message: any) => {
      try {
        // eslint-disable-next-line no-console
        console.log(`[DashPlayer] ${message?.label || "diagnostic"}`, message?.data)
      } catch {}
      logEvent({
        level: "info",
        event: "dash.diagnostic",
        details: {
          label: message?.label,
          data: message?.data,
        },
      }).catch(() => {})
    })
  }

  async play(url: string, audioUrl?: string): Promise<void> {
    if (this.isDestroyed) throw new Error("Player destroyed")
    this.currentUrl = url
    this.currentAudioUrl = audioUrl || this.config.audioUrl || ""
    if (!this.controller) await this.initialize()
    // The HTML is already playing on load; no further JS call needed because we bake URLs into HTML.
    this.emit({ type: "play", timestamp: Date.now(), data: { url } })
  }

  async destroy(): Promise<void> {
    if (this.isDestroyed) return
    this.isDestroyed = true
    if (this.controller) {
      try {
        await this.controller.evaluateJavaScript("destroyDashPlayer()")
      } catch {}
      this.controller.dispose()
      this.controller = null
    }
    this.currentUrl = ""
    this.currentAudioUrl = ""
    this.eventListeners.clear()
    this.emit({ type: "ended", timestamp: Date.now() })
  }

  on(event: string, listener: (event: PlayerEvent) => void): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set())
    }
    this.eventListeners.get(event)!.add(listener)
    return () => {
      this.eventListeners.get(event)?.delete(listener)
    }
  }

  private emit(event: PlayerEvent): void {
    const listeners = this.eventListeners.get(event.type)
    if (!listeners) return
    listeners.forEach((listener) => {
      try {
        listener(event)
      } catch {}
    })
  }

  getCurrentUrl(): string {
    return this.currentUrl
  }

  getRequestMode(): "direct" | "hls.js" | "dash.js" | "native-fallback" | "unknown" {
    return this.requestMode
  }

  getHeadersApplied(): boolean {
    return this.headersApplied
  }

  setDuration(seconds: number): void {
    this.duration = seconds
  }

  prepare(url: string, audioUrl: string, duration: number): void {
    // Rewrite Bilibili CDN hosts to the CORS-free mirror so dash.js XHR/MSE works.
    // Keep original URLs as fallback in case the mirror rejects signed URLs (403).
    this.currentOriginalUrl = url
    this.currentOriginalAudioUrl = audioUrl
    this.currentUrl = rewriteBilibiliCdnUrl(url)
    this.currentAudioUrl = rewriteBilibiliCdnUrl(audioUrl)
    this.duration = duration
    logEvent({
      level: "info",
      event: "dash.prepare.urls",
      details: {
        videoOriginal: url,
        videoRewritten: this.currentUrl,
        audioOriginal: audioUrl,
        audioRewritten: this.currentAudioUrl,
        sameVideo: url === this.currentUrl,
        sameAudio: audioUrl === this.currentAudioUrl,
      },
    }).catch(() => {})
  }
}

export function createDashPlayer(config: PlayerConfig = {}): DashPlayerService {
  return new DashPlayerService(config)
}
