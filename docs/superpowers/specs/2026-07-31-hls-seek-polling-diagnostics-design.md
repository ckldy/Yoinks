# HLS 拖动轮询诊断设计

## 背景与已排除项

同一 XChina HLS 在 Yoinks WebView/hls.js 中可自动播放，却在系统视频控制条拖动到目标位置后停在旧画面、无法继续。此前基于 `mediaError/bufferSeekOverHole` 的自动 `recoverMediaError()` 实验破坏了自动播放，已完整回滚；该错误稳定出现在约 0.1 秒的启动阶段，不能作为拖动故障根因。

已有 `seeking`/`seeked`/`waiting` 事件诊断未可靠记录系统控件拖动后的状态，且 HTTPS 抓包未见 Yoinks WebView 对应的分片请求。因此不能再基于事件缺失直接修改 HLS 恢复行为。

## 目标

以短周期、只读的媒体状态快照确认系统控件拖动后真实发生了什么，不改变自动播放、当前时间、hls.js 加载、缓冲、错误恢复、URL 或请求头。

## 设计

### 状态采样

- HLS/hls.js 预览启动后，建立轻量轮询，每 500ms 比较 `video.currentTime` 与前一快照。
- 仅在检测到时间发生明显跳变（差值至少 5 秒）时，视为候选 seek；这可覆盖系统控件未派发 `seeking` 的情况。
- 候选 seek 后最多采集 10 秒、20 个样本，随后自动停止；若另一次明显跳变，重启新的诊断窗口。
- 不轮询、保存或回传 URL、请求头、Cookie、Authorization、AES key、响应内容。

### 每个样本的最小字段

- 采样序号与距 seek 起始的毫秒数；
- `currentTime`、相对目标时间的增量、`duration`；
- `paused`、`readyState`、`networkState`；
- `video.buffered` 的时间范围：最多前两个范围的 `start/end`，均四舍五入到 0.1 秒；
- hls.js 最近一次 `FRAG_LOADED` 的 `start/end/sn`（仅时间和序号，不含 URL）。

### 日志与边界

- 事件名为 `preview.hls.seek.poll.started`、`preview.hls.seek.poll.sample`、`preview.hls.seek.poll.finished`。
- 样本上报仍使用既有 `seekDiagnostic` message handler 和 `logEvent`，通过现有日志脱敏路径。
- 正常播放不写轮询样本；仅候选 seek 的 10 秒窗口写入有限日志。
- 不触发 `video.play()`、不写 `video.currentTime`、不调用 `hls.startLoad()`、`hls.recoverMediaError()`、`hls.loadSource()` 或 `hls.destroy()`。

## 预期判定

1. `currentTime` 不跳至目标：系统控件与页面媒体状态不同步；
2. 跳至目标后、最近分片时间未更新且缓冲范围不覆盖目标：hls.js 加载/时间线问题；
3. 分片和缓冲范围覆盖目标但 `currentTime` 不推进：WebKit 解码/渲染停滞；
4. `networkState` 或 `readyState` 降级：再结合 hls.js error 定位媒体或网络层。

## 验证

- 静态检查轮询只在 HLS 路径使用，且明确禁止控制 API；
- 静态检查不记录任何 URL/headers/cookie/auth/key 字段；
- TypeScript、日志脱敏及在线预览回归通过；
- 真机同一视频：播放约 10 秒，拖到 47 分钟，保留页面 10 秒；读取日志分析而不再立即修改播放行为。
