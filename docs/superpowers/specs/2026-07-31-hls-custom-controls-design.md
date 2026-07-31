# HLS 自绘控制条设计（A1）

## 问题与依据

Yoinks 的 HLS 预览由 hls.js 管理 `<video>`，但 iOS WKWebView 的原生 `controls` 进度拖动不会可靠地同步回页面 `video.currentTime` 与 hls.js。对同一 XChina HLS 的真机复现中，自动播放正常，拖到 47 分钟后不能继续；`seeking` 事件与轮询时间跳变均未观察到，说明故障边界在原生系统控制条与页面媒体元素之间。

此前对启动阶段的非致命 `bufferSeekOverHole` 自动恢复曾破坏自动播放，已回滚，不能作为本设计的依据或机制。

## 决策与范围

采用 A1：HLS/hls.js 预览统一使用页面内自绘控制条，完全不依赖原生 HLS 进度拖动。

仅影响 `services/player/hls-player-service.ts` 的 HLS 路径：

- 自绘播放/暂停、进度拖动、当前时间/总时长；
- 保留现有右上角画质、倍速控件；
- HLS 以外的直链 MP4、progressive AV 与 DASH 保留原生 `controls` 和现有行为；
- 不改 HLS URL、请求头、Cookie、认证、AES key、加载策略、缓冲参数或下载功能。

## UI

HLS 激活时视频元素不带 `controls`，显示底部半透明控制栏：

1. 44pt 命中区域的播放/暂停按钮；
2. `input type=range` 进度条，最小值 0、最大值为媒体有效 duration、步长 0.1 秒；
3. `当前时间 / 总时长`，使用 `m:ss` 或 `h:mm:ss`；
4. 不改变既有画质与倍速菜单位置。

非 HLS 时自绘底栏隐藏，视频保留原生 controls。

## 交互与状态流

- `MANIFEST_PARSED` 与 `durationchange` 更新总时长与 range 上限。
- `timeupdate` 在非拖动状态下更新 range、时间文字及播放/暂停图标。
- 点按播放按钮：若暂停则调用既有 `startNativePlayback()`，否则 `video.pause()`；双流场景仍由既有事件同步音频。
- 拖动开始：设置 `isScrubbing=true`，仅用 range 当前值更新预览时间，不写 `video.currentTime`。
- 拖动结束（`change`、pointer/touch 结束的统一提交）：校验 duration 有效并 clamp 至 `[0, duration]`；仅调用一次 `video.currentTime=target`；若拖动前正在播放，保留播放意图，等待既有 hls.js/media 管线继续取目标分片。暂停状态不被改变。
- `seeking` / `seeked` 继续触发现有脱敏诊断及双流音频同步。自绘提交会使这些事件对页面可见，可作为后续验证证据。
- 切换媒体、销毁页面或切到非 HLS 时复位拖动状态、隐藏控制条，不保留旧时间。

## 错误与可用性

- duration 不可用或非有限时，range 禁用并显示 `0:00 / --:--`；不执行 seek。
- 不引入自动 `recoverMediaError()`、`startLoad()`、`loadSource()` 或 `video.play()` 的后台兜底。
- 所有已有 hls.js 错误提示与加载 UI 保持。
- 使用按钮与 range 原生语义，提供 `aria-label`；控件不遮挡画质/倍速菜单。

## 验证

### 静态

新增定向验证，断言：

- HLS 路径切换至自绘控制且非 HLS 保留原生 controls；
- 自绘进度提交只写一次 `video.currentTime`，且不自动改变暂停/播放意图；
- `timeupdate`、`durationchange`、拖动状态和时间格式均存在；
- 不包含 URL、Header、Cookie、Authorization 或 key 采集；
- 既有日志脱敏、在线预览与 TypeScript 回归通过。

### 真机

1. 使用同一 XChina HLS，确认自动播放正常；
2. 通过自绘条拖到 47 分钟；
3. 确认画面跳转并在目标附近继续播放；
4. 验证暂停后拖动仍保持暂停；
5. 验证画质、倍速正常；
6. 任选一个 MP4/DASH 预览，确认仍展示原生控制条。

## 回滚

本改动集中于 HLS HTML 模板与定向验证；若出现自动播放或 UI 回归，可从实施前项目备份恢复。