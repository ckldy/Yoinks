# 播放器倍速 + 画质控件设计（方案 A）

## 背景

审计 Plyr（sampotts/plyr）后对照 Yoinks 现有预览播放器发现：底层引擎（hls.js / dash.js / 双流同步 / 错误恢复）已比 Plyr 更贴合本项目，但 Plyr 式的"用户可见控件"缺失——倍速与画质切换的 API 早已实现却从未接入 UI。

- `HLSPlayerService.setPlaybackRate()` / `DashPlayerService.setPlaybackRate()`：仅设 `video.playbackRate`
- `HLSPlayerService.setQuality()` + hls.js `LEVELS_UPDATED` 已回传画质列表：无 UI 菜单
- `HLSPlayerService.setQuality()` 调用 JS `setQuality(level)`：已存在

本设计在不引入 Plyr / 不改编排 / 不碰双流同步核心的前提下，为两个播放器 HTML 模板补齐倍速与画质控件。

## 目标

1. 倍速控件（两个模板都有）：右上角常驻半透明药丸按钮，点击弹出菜单 `0.5 / 0.75 / 1.0 / 1.25 / 1.5 / 2.0`，应用后同时作用于 `<video>` 和 `<audio>`（双流同步关键）。
2. 画质控件（仅 HLS 模板）：右上角倍速旁的 `画质` 药丸，仅当 hls.js 上报 ≥2 个 level 时才渲染；点击弹出菜单 `自动` + 各清晰度，复用现有 `setQuality(level)`（-1 = ABR 自动）。

## 非目标

- 不替换原生 `<video controls>`（播放/暂停/进度/音量/全屏仍用原生）
- 不做 PiP、字幕、预览缩略图
- 不改下载 / 探测 / 双流同步核心逻辑
- 不改 `online-preview.ts` 编排
- 不引入任何新 CDN 依赖

## 架构

零原生改动：不新增 SwiftUI 控件、不新增 message handler、不改 `online-preview.ts`。所有逻辑加在两个 HTML 模板字符串内：

- `PLAYER_HTML_TEMPLATE`（`services/player/hls-player-service.ts`）→ 倍速 + 画质
- `DASH_HTML_TEMPLATE`（`services/player/dash-player-service.ts`）→ 倍速

## 组件细节

### 1. 倍速控件（两个模板共有）

**DOM**：右上角常驻药丸按钮 `#speedBtn`，显示当前倍率（默认 `1.0x`）。点击展开下方竖排菜单 `#speedMenu`。

**行为**：
- 选择倍率后执行：
  ```js
  video.playbackRate = rate;
  if (currentAudioSrc && audio) audio.playbackRate = rate; // 双流同步
  ```
- DASH 模板无 `<audio>` 元素，仅设 `video.playbackRate`
- 更新按钮文本；高亮当前选中项
- 点空白处关闭菜单

### 2. 画质控件（仅 HLS 模板）

**DOM**：倍速按钮左侧的 `画质` 药丸 `#qualityBtn`，初始 `display:none`。

**行为**：
- 在 hls.js `LEVELS_UPDATED` 回调里：若 levels.length >= 2，构建菜单（`自动` + 各 `height p`），显示按钮；否则隐藏
- 选择后调用现有 `setQuality(level)`（-1 = 自动 ABR，0..n = 固定）
- 复用现有 `LEVEL_SWITCHED` 事件做高亮反馈
- direct / progressive-av / native-fallback 模式下永远隐藏

### 3. CSS

- 药丸：`rgba(0,0,0,0.55)` 背景、白字、`12px -apple-system`、圆角、右上角固定、`z-index:20`
- 菜单：药丸下方竖排，同样半透明背景，选项带 hover/active 反馈
- 始终可见，不自动隐藏

## 关键技术约束

1. **双流倍速必须同步**：HLS 模板 B站/YouTube video-only 预览用 `<video>` + 独立 `<audio>` 手工同步。若只设 `video.playbackRate`，音频仍 1x → 立刻失同步。控件必须两者都设。
2. **画质仅 HLS 有效**：DASH 模板 dash.js + 单 representation MPD（无多清晰度）；direct/progressive-av 单流。仅 hls.js 通过 `LEVELS_UPDATED` 上报多清晰度。
3. **控件只在 WebView 内**：直接调 JS，无需新增 message handler，不碰 `online-preview.ts` 编排，改动面完全隔离在两个 HTML 模板字符串里。

## 涉及文件

| 文件 | 改动 |
|---|---|
| `services/player/hls-player-service.ts` | `PLAYER_HTML_TEMPLATE` 增加倍速 + 画质 CSS/DOM/JS |
| `services/player/dash-player-service.ts` | `DASH_HTML_TEMPLATE` 增加倍速 CSS/DOM/JS |
| `script.json` | version `1.4.9 → 1.5.0` |
| `verify_player_controls.ts` | 新增静态验证脚本 |

## 验证

1. TypeScript 诊断 0 错误
2. `scripting-ts project "Yoinks"` 启动回归
3. 新增 `verify_player_controls.ts`：构建两个模板 HTML，断言：
   - 倍速 6 档齐全
   - 双流下 `audio.playbackRate` 被设
   - 画质菜单受 levels 数量门控（<2 隐藏）
   - 画质含 `自动` 选项（level -1）
   - 无模板占位符泄漏
4. 真机：B站 HLS 链（画质菜单出现）、YouTube/X progressive 链（倍速生效）、确认双流同步未坏

## 版本

`1.4.9 → 1.5.0`（新功能）
