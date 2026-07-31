# 无自定义请求头 HLS 原生播放优先设计

## 背景

同一 XChina AES-128 HLS 在 hls.js WebView 中可自动播放，但随机定位到 47 分钟后无法恢复。已逐层验证：原生控件事件、HTML range 事件、普通触摸轨道、视频命中区域和 seek 后 `play()` 时序均不能解决该场景。最后确认普通触摸轨道能够跟手，但写入目标时间后即使再次播放也无法在目标位置解码。

这表明故障位于 hls.js/MSE 在此 WKWebView 场景的随机定位能力，而非控制层。继续修改 hls.js 恢复策略已发生过自动播放回归，停止该方向。

## 决策

移除当前未解决问题的 A1 自绘 HLS 控件及相关轨道/续播逻辑，并优先使用 WebKit/iOS 原生 HLS 路径播放无需自定义可注入 Header 的 HLS。

条件：

- URL 是 HLS `.m3u8`；
- 过滤后的 `customHeaders` 为空。

符合条件时，使用既有原生 `<video src>` 流程并上报 `requestMode: native-fallback`、`headersApplied: false`。该路径交由 WebKit/AVFoundation 处理 HLS 清单、AES-128 key、分片和随机定位。

若存在允许的自定义 Header，保留 hls.js 路径，因为原生 `<video>` 无法可靠附加这些 Header。

## 范围

- 移除 A1 自绘 UI、触摸轨道、HLS 自定义 seek/续播逻辑和仅为它们添加的定向断言；
- 保留此前通用的 HLS 播放器、原生 fallback、质量/倍速的现有代码，且不为原生路径强加 hls.js 质量菜单；
- 保留通用、脱敏的 HLS 诊断和已有日志安全边界；
- 不改 URL、Referer、Cookie、Authorization、AES key、下载或 Safari 插件。

## 行为

1. 无 Header HLS：进入原生 HLS 路径，显示系统媒体控制，不显示 hls.js 的画质菜单；随机定位由系统播放器负责。
2. 有 Header HLS：维持 hls.js 播放及既有 hls.js 控件能力；不适用当前 XChina 验收结论。
3. MP4、progressive AV、DASH：行为不变。

## 验证

- 静态：空 Header HLS 在 hls.js 初始化之前选择 native fallback；有 Header HLS 仍选择 hls.js；A1 自绘控件/触摸轨道/续播实现不再存在；请求模式日志正确；日志不记录敏感网络字段。
- TypeScript、日志脱敏和在线预览回归。
- 真机 XChina：自动播放后拖到 47 分钟，确认系统控制条可定位且目标位置能继续播放；复测一个有 Header 的 HLS（若有可用样本）仍走 hls.js。

## 风险与回滚

原生 HLS 对自定义 Header 不可靠，因此仅在 Header 为空时选择。若原生路径对某公开源不能播放，可通过实施前备份恢复或在后续依据日志调整限定条件；本轮不自动回退到 hls.js，以免混淆定位证据。
