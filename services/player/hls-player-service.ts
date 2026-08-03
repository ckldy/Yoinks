// Core HLS Player Service
// Manages WebView + hls.js lifecycle, quality switching, error recovery

import type {
  PlayerConfig,
  PlayerEvent,
  PlayerErrorEvent,
  QualityOption,
  HlsConfig
} from "./types"
import {
  BILIBILI_DESKTOP_UA,
  rewriteBilibiliCdnUrl,
} from "./bilibili-cdn"
import { logEvent } from "../logs"

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
  // This JSON is embedded in an inline <script>; escape HTML/script delimiters too.
  return JSON.stringify(filterAllowedHeaders(headers))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
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
.ctrl-wrap{position:absolute;top:10px;right:10px;display:flex;gap:6px;z-index:20;pointer-events:none}
.ctrl-host{position:relative;pointer-events:auto}
.pill{background:rgba(0,0,0,0.55);color:#fff;border:none;border-radius:14px;padding:5px 12px;font:600 12px -apple-system;cursor:pointer;-webkit-tap-highlight-color:transparent}
.pill:active{background:rgba(0,0,0,0.75)}
.menu{position:absolute;top:34px;right:0;background:rgba(0,0,0,0.7);border-radius:8px;padding:4px 0;min-width:68px;display:none;z-index:21}
.menu.open{display:block}
.menu-item{color:#fff;font:13px -apple-system;padding:8px 14px;cursor:pointer;-webkit-tap-highlight-color:transparent;white-space:nowrap;text-align:center}
.menu-item:active{background:rgba(255,255,255,0.15)}
.menu-item.active{color:#4ad6ff}
.tap-layer{position:absolute;top:0;left:0;right:0;bottom:0;z-index:5;display:none}
.bar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:10px;padding:12px 14px 20px;background:linear-gradient(transparent,rgba(0,0,0,0.75));z-index:15;opacity:0;transition:opacity .25s;pointer-events:none}
.bar.show{opacity:1;pointer-events:auto}
.bar-btn{background:rgba(255,255,255,0.18);color:#fff;border:none;border-radius:50%;width:40px;height:40px;font:700 15px -apple-system;cursor:pointer;-webkit-tap-highlight-color:transparent;flex:none}
.bar-btn:active{background:rgba(255,255,255,0.3)}
.bar-track{flex:1;height:32px;display:flex;align-items:center;cursor:pointer;touch-action:none}
.bar-rail{width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,0.3);position:relative}
.bar-fill{position:absolute;left:0;top:0;bottom:0;width:0;background:#4ad6ff;border-radius:2px}
.bar-time{color:#fff;font:12px -apple-system;min-width:96px;text-align:right;flex:none}
</style>
</head>
<body>
<div class="loading" id="loading">加载中...</div>
<video id="video" controls {{PLAYS_INLINE}} {{MUTED}} {{AUTOPLAY}} preload="{{PRELOAD}}"></video>
<audio id="audio" preload="auto"></audio>
<div class="error" id="error" style="display:none"></div>
<div class="tap-layer" id="tapLayer"></div>
<div class="bar" id="bar">
  <button class="bar-btn" id="playBtn">▶</button>
  <div class="bar-track" id="track"><div class="bar-rail"><div class="bar-fill" id="fill"></div></div></div>
  <span class="bar-time" id="timeText">0:00 / 0:00</span>
</div>
<div class="ctrl-wrap">
  <div class="ctrl-host" id="qualityHost" style="display:none">
    <button class="pill" id="qualityBtn">画质</button>
    <div class="menu" id="qualityMenu"></div>
  </div>
  <div class="ctrl-host" id="speedHost">
    <button class="pill" id="speedBtn">1.0x</button>
    <div class="menu" id="speedMenu"></div>
  </div>
</div>

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
var latestLoadedFragment = null;
var seekPollTimer = null;
var seekPollLastTime = null;
var seekPollStartedAt = 0;
var seekPollSamples = 0;
var seekPollTargetTime = null;

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

function finiteSeconds(value) {
  var number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10) / 10 : null;
}

function bufferedRangeCount() {
  try { return video && video.buffered ? video.buffered.length : 0; } catch (e) { return 0; }
}

function bufferedRangesSnapshot() {
  var ranges = [];
  try {
    for (var i = 0; video && video.buffered && i < video.buffered.length && i < 2; i++) {
      ranges.push({ start: finiteSeconds(video.buffered.start(i)), end: finiteSeconds(video.buffered.end(i)) });
    }
  } catch (e) {}
  return ranges;
}

function reportSeekDiagnostic(label, extra) {
  try {
    window.webkit?.messageHandlers?.seekDiagnostic?.postMessage(Object.assign({
      label: String(label),
      currentTime: finiteSeconds(video.currentTime),
      duration: finiteSeconds(video.duration),
      readyState: Number(video.readyState) || 0,
      networkState: Number(video.networkState) || 0,
      paused: !!video.paused,
      bufferedRanges: bufferedRangeCount()
    }, extra || {}));
  } catch (e) {
    console.log('[Player] Failed to report seek diagnostic:', e);
  }
}

function stopSeekPolling(reason) {
  if (!seekPollTimer) return;
  clearInterval(seekPollTimer);
  seekPollTimer = null;
  reportSeekDiagnostic('seek.poll.finished', { reason: String(reason), samples: seekPollSamples, targetTime: seekPollTargetTime });
}

function startSeekPolling(targetTime) {
  stopSeekPolling('replaced');
  seekPollStartedAt = Date.now();
  seekPollSamples = 0;
  seekPollTargetTime = finiteSeconds(targetTime);
  reportSeekDiagnostic('seek.poll.started', { targetTime: seekPollTargetTime });
  seekPollTimer = setInterval(function() {
    seekPollSamples += 1;
    reportSeekDiagnostic('seek.poll.sample', {
      elapsedMs: Date.now() - seekPollStartedAt,
      samples: seekPollSamples,
      targetTime: seekPollTargetTime,
      buffered: bufferedRangesSnapshot(),
      fragment: latestLoadedFragment
    });
    if (seekPollSamples >= 20) stopSeekPolling('completed');
  }, 500);
}

function observeSeekByTimeJump() {
  var current = finiteSeconds(video.currentTime);
  if (current == null) return;
  if (seekPollLastTime != null && Math.abs(current - seekPollLastTime) >= 5) startSeekPolling(current);
  seekPollLastTime = current;
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

function bindMediaEvents(enableSeekDiagnostics) {
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
  video.onseeking = function() {
    if (enableSeekDiagnostics) {
      reportSeekDiagnostic('seek.start');
      startSeekPolling(video.currentTime);
    }
    syncAudioFromVideo();
  };
  video.onseeked = function() {
    if (enableSeekDiagnostics) reportSeekDiagnostic('seek.completed');
    syncAudioFromVideo();
    if (!video.paused && currentAudioSrc) playAudioWithVideo();
  };
  video.onwaiting = function() { if (enableSeekDiagnostics) reportSeekDiagnostic('seek.waiting'); };
  video.onstalled = function() { if (enableSeekDiagnostics) reportSeekDiagnostic('seek.stalled'); };
  video.ontimeupdate = function() {
    if (enableSeekDiagnostics) observeSeekByTimeJump();
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
  bindMediaEvents(false);
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
  latestLoadedFragment = null;
  seekPollLastTime = null;
  stopSeekPolling('new-play');
  if (blackScreenTimer) { clearTimeout(blackScreenTimer); blackScreenTimer = null; }
  loading.style.display = 'block';
  hideError();
  bindMediaEvents(false);

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
  } else if (Object.keys(customHeaders).length === 0 && video.canPlayType('application/vnd.apple.mpegurl')) {
    // Native WebKit/AVFoundation HLS gives iOS reliable random seeking for public streams.
    reportMode('native-fallback', false);
    bindDirectMediaEvents();
    video.src = src;
    video.load();
  } else if (window.Hls && Hls.isSupported()) {
    reportMode('hls.js', Object.keys(customHeaders).length > 0);

    bindMediaEvents(true);
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
    // MSE 播放：用自绘控制条替代 iOS 原生 controls（原生对 MSE 流会闪烁/调不出）。
    enableCustomControls();

    hls.on(Hls.Events.MANIFEST_PARSED, function() {
      loading.style.display = 'none';
      startNativePlayback();
    });

    hls.on(Hls.Events.ERROR, function(event, data) {
      reportSeekDiagnostic('hls.error', { hlsType: String(data.type || ''), hlsDetails: String(data.details || ''), fatal: !!data.fatal });
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

    hls.on(Hls.Events.FRAG_LOADED, function(event, data) {
      var fragment = data && data.frag ? data.frag : {};
      latestLoadedFragment = { start: finiteSeconds(fragment.start), end: finiteSeconds(fragment.start + fragment.duration), sn: Number.isFinite(Number(fragment.sn)) ? Number(fragment.sn) : null };
      reportSeekDiagnostic('hls.fragment.loaded', latestLoadedFragment);
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
      qualityLevels = levels;
      if (levels.length >= 2) {
        qualityHost.style.display = '';
        if (manualLevel === -1) qualityBtn.textContent = '自动';
        buildQualityMenu();
      } else {
        qualityHost.style.display = 'none';
      }
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
  stopSeekPolling('destroyed');
  seekPollLastTime = null;
  latestLoadedFragment = null;
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

// --- 倍速 + 画质控件 ---
var SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
var speedMenu = document.getElementById('speedMenu');
var speedBtn = document.getElementById('speedBtn');
var qualityHost = document.getElementById('qualityHost');
var qualityBtn = document.getElementById('qualityBtn');
var qualityMenu = document.getElementById('qualityMenu');
var currentRate = 1.0;
var manualLevel = -1;
var qualityLevels = [];

function speedLabel(r) { return (r % 1 === 0 ? r.toFixed(1) : String(r)) + 'x'; }

function buildSpeedMenu() {
  speedMenu.innerHTML = '';
  SPEEDS.forEach(function(r) {
    var item = document.createElement('div');
    item.className = 'menu-item' + (r === currentRate ? ' active' : '');
    item.textContent = speedLabel(r);
    item.addEventListener('click', function(e) {
      e.stopPropagation();
      applySpeed(r);
      speedMenu.classList.remove('open');
    });
    speedMenu.appendChild(item);
  });
}

function applySpeed(rate) {
  currentRate = rate;
  try { video.playbackRate = rate; } catch(e) {}
  if (currentAudioSrc && audio) { try { audio.playbackRate = rate; } catch(e) {} }
  speedBtn.textContent = speedLabel(rate);
  buildSpeedMenu();
}

function labelForLevel(id) {
  var l = qualityLevels[id];
  return l ? l.label : ('档位' + id);
}

function buildQualityMenu() {
  qualityMenu.innerHTML = '';
  var auto = document.createElement('div');
  auto.className = 'menu-item' + (manualLevel === -1 ? ' active' : '');
  auto.textContent = '自动';
  auto.addEventListener('click', function(e) {
    e.stopPropagation();
    selectQuality(-1);
    qualityMenu.classList.remove('open');
  });
  qualityMenu.appendChild(auto);
  qualityLevels.forEach(function(l) {
    var item = document.createElement('div');
    item.className = 'menu-item' + (manualLevel === l.id ? ' active' : '');
    item.textContent = l.label;
    item.addEventListener('click', function(e) {
      e.stopPropagation();
      selectQuality(l.id);
      qualityMenu.classList.remove('open');
    });
    qualityMenu.appendChild(item);
  });
}

function selectQuality(level) {
  manualLevel = level;
  setQuality(level);
  qualityBtn.textContent = (level === -1) ? '自动' : labelForLevel(level);
  buildQualityMenu();
}

speedBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  speedMenu.classList.toggle('open');
  qualityMenu.classList.remove('open');
});
qualityBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  qualityMenu.classList.toggle('open');
  speedMenu.classList.remove('open');
});
// Keep touch events within custom controls away from native video tap-to-play.
var controls = document.querySelector('.ctrl-wrap');
['pointerdown', 'touchstart', 'click'].forEach(function(type) {
  controls.addEventListener(type, function(e) { e.stopPropagation(); });
});
document.addEventListener('click', function(e) {
  if (e.target && e.target.closest && e.target.closest('.ctrl-wrap')) return;
  speedMenu.classList.remove('open');
  qualityMenu.classList.remove('open');
});

// --- 自绘控制条（MSE 播放时替代 iOS 原生 controls——原生 controls 对 MSE 流会闪烁/调不出） ---
var customControlsEnabled = false;
var tapLayer = document.getElementById('tapLayer');
var bar = document.getElementById('bar');
var playBtn = document.getElementById('playBtn');
var track = document.getElementById('track');
var fill = document.getElementById('fill');
var timeText = document.getElementById('timeText');
var barHideTimer = null;
var seeking = false;

function formatTime(t) {
  t = Math.max(0, isNaN(t) ? 0 : Math.floor(t));
  var m = Math.floor(t / 60);
  var s = t % 60;
  return m + ':' + (s < 10 ? '0' + s : String(s));
}
function updateBar() {
  var dur = video.duration || 0;
  var cur = video.currentTime || 0;
  playBtn.textContent = video.paused ? '▶' : '❚❚';
  fill.style.width = (dur > 0 ? Math.min(100, (cur / dur) * 100) : 0) + '%';
  timeText.textContent = formatTime(cur) + ' / ' + formatTime(dur);
}
function showBar() {
  bar.classList.add('show');
  updateBar();
  if (barHideTimer) clearTimeout(barHideTimer);
  barHideTimer = setTimeout(function() { bar.classList.remove('show'); }, 3000);
}
function hideBar() {
  if (barHideTimer) clearTimeout(barHideTimer);
  barHideTimer = null;
  bar.classList.remove('show');
}
function enableCustomControls() {
  if (customControlsEnabled) return;
  customControlsEnabled = true;
  try { video.removeAttribute('controls'); } catch (e) {}
  tapLayer.style.display = 'block';
  tapLayer.addEventListener('click', function() {
    if (bar.classList.contains('show')) {
      // 已唤出控制条：再次点击切换播放/暂停（贴近原生点按习惯）。
      if (video.paused) { video.play().catch(function() {}); } else { video.pause(); }
      showBar();
    } else {
      showBar();
    }
  });
  playBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (video.paused) { video.play().catch(function() {}); } else { video.pause(); }
    showBar();
  });
  track.addEventListener('pointerdown', function(e) {
    e.stopPropagation();
    seeking = true;
    seekFromEvent(e);
  });
  track.addEventListener('pointermove', function(e) {
    if (seeking) seekFromEvent(e);
  });
  ['pointerup', 'pointercancel'].forEach(function(type) {
    track.addEventListener(type, function() { seeking = false; });
  });
  function seekFromEvent(e) {
    var rect = track.getBoundingClientRect();
    var ratio = rect.width > 0 ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0;
    var t = ratio * (video.duration || 0);
    try { video.currentTime = t; } catch (err) {}
    updateBar();
  }
  video.addEventListener('timeupdate', updateBar);
  video.addEventListener('play', updateBar);
  video.addEventListener('pause', updateBar);
  video.addEventListener('durationchange', updateBar);
  video.addEventListener('ended', function() { updateBar(); showBar(); });
  updateBar();
}

buildSpeedMenu();
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
    // Bilibili CDN mirrors enforce UA checks; use a desktop Chrome UA by default.
    try {
      this.controller.setCustomUserAgent(this.config.userAgent || BILIBILI_DESKTOP_UA)
    } catch { /* UA setting is best-effort */ }
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

    await this.controller.addScriptMessageHandler("seekDiagnostic", (message: any) => {
      const label = typeof message?.label === "string" ? message.label.slice(0, 80) : "unknown"
      const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null
      logEvent({
        level: label === "hls.error" ? "warn" : "info",
        event: `preview.hls.${label}`,
        details: {
          currentTime: number(message?.currentTime),
          duration: number(message?.duration),
          readyState: number(message?.readyState),
          networkState: number(message?.networkState),
          paused: message?.paused === true,
          bufferedRanges: number(message?.bufferedRanges),
          elapsedMs: number(message?.elapsedMs),
          samples: number(message?.samples),
          targetTime: number(message?.targetTime),
          reason: typeof message?.reason === "string" ? message.reason.slice(0, 40) : undefined,
          buffered: Array.isArray(message?.buffered) ? message.buffered.slice(0, 2).map((range: any) => ({ start: number(range?.start), end: number(range?.end) })) : undefined,
          fragment: message?.fragment && typeof message.fragment === "object" ? { start: number(message.fragment.start), end: number(message.fragment.end), sn: number(message.fragment.sn) } : undefined,
          start: number(message?.start),
          end: number(message?.end),
          sn: number(message?.sn),
          hlsType: typeof message?.hlsType === "string" ? message.hlsType.slice(0, 80) : undefined,
          hlsDetails: typeof message?.hlsDetails === "string" ? message.hlsDetails.slice(0, 120) : undefined,
          fatal: message?.fatal === true,
        },
      }).catch(() => {})
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
    // Rewrite Bilibili CDN hosts to the CORS-free mirror when possible.
    const playbackUrl = rewriteBilibiliCdnUrl(url)
    const pairedAudio = rewriteBilibiliCdnUrl(audioUrl || this.config.audioUrl || "")
    this.currentUrl = playbackUrl

    if (!this.controller) await this.initialize()

    await new Promise<void>(resolve => {
      const id = setTimeout(() => resolve(), 300)
      return () => clearTimeout(id)
    })

    const js = `play(${JSON.stringify(playbackUrl)}, ${JSON.stringify(pairedAudio)})`
    await this.controller.evaluateJavaScript(js)

    // Unconfirmed intent only — waitForPlayback requires confirmed: true from WebView.
    this.emit({ type: "play", timestamp: Date.now(), data: { url: playbackUrl } })
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
    if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) throw new Error("Invalid playback rate")
    await this.controller.evaluateJavaScript(`applySpeed(${rate})`)
    this.emit({ type: "ratechange", timestamp: Date.now(), data: { rate } })
  }

  async setVolume(volume: number): Promise<void> {
    if (!this.controller) return
    await this.controller.evaluateJavaScript(`video.volume = ${Math.max(0, Math.min(1, volume))}`)
    this.emit({ type: "volumechange", timestamp: Date.now(), data: { volume } })
  }

  async setQuality(levelId: string | number): Promise<void> {
    if (!this.controller) return
    const level = Number(levelId)
    if (!Number.isInteger(level) || level < -1) throw new Error("Invalid quality level")
    await this.controller.evaluateJavaScript(`setQuality(${level})`)
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

    const controller = this.controller
    this.controller = null
    if (controller) {
      try {
        await controller.evaluateJavaScript("destroy()")
      } catch {
        // The sheet may already have dismissed the WebView.
      } finally {
        controller.dispose()
      }
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