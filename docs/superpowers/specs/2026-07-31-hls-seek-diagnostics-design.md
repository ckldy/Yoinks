# HLS 拖动冻结临时诊断设计

## 背景

真机已稳定复现：Yoinks 的单 HLS/hls.js 预览在拖到约 47 分钟后，画面停留在拖动前帧，停留 20 秒不恢复。运行日志仅记录 `preview.playing`；现有 HLS 模板的 `seeking`/`seeked` 仅用于双流音频同步，未向宿主回传单 HLS 的 seek 状态。抓包未出现可与本次操作可靠对齐的预览分片请求，因此根因尚未确定。

## 目标

增加一次性、脱敏的 HLS seek 观测，不改变播放、缓冲、重试或认证行为。通过一次真机复现区分时间轴/加载、网络分片失败与渲染冻结。

## 采集事件

HLS/hls.js 模板通过现有 WebView message handler 上报以下结构化事件：

- `seek.start`：拖动发起时的 `currentTime`、`duration`、`readyState`、是否暂停、缓冲区时间范围数量；
- `seek.completed`：`seeked` 时的实际时间、`readyState`、是否暂停、缓冲区范围数量；
- `seek.waiting`、`seek.stalled`：拖动后等待数据时的时间、`readyState` 与缓冲区数量；
- `hls.error`：hls.js 的 `type`、`details`、`fatal` 布尔值；
- `hls.fragment`：仅 `start`、`end`、`sn`（若存在）和加载结果，不记录 URL。

时间值为秒数；所有数值有限性校验并取整/小数截断。不得记录候选 URL、分片 URL、请求头、Cookie、Authorization、AES 密钥或响应内容。

## 数据流

1. `hls-player-service.ts` 的内嵌 WebView 脚本收集最小事件字段，发送至新增的 `seekDiagnostic` message handler。
2. 宿主播放器服务将该事件写入已有 `runtime.jsonl`，以 `preview.hls.seek.*` 或 `preview.hls.fragment.*` 标识；使用现有日志脱敏入口。
3. 诊断仅在 HLS/hls.js 预览实例存在时发生；不影响原生 HLS、DASH、下载或 Safari 插件采集。

## 非目标

- 本轮不修改 `currentTime`、不强制重新加载、不中止/恢复 hls.js、不调整缓冲参数。
- 不尝试绕过站点访问控制或提取认证材料。
- 不以单次日志为由直接修复；先用证据决定下一步。

## 验证

- 静态验证：模板包含 seek/wait/stalled/hls error/fragment 上报，且日志字段不包含 URL/headers/cookie/key 等敏感字段。
- TypeScript diagnostics 与现有在线预览/日志脱敏回归。
- 真机：播放约 10 秒，拖到 47 分钟并停留 20 秒；读取 `runtime.jsonl` 和抓包，确认至少有 seek 开始事件与后续 seek/hls 结果，随后定位根因。
