# YouTube IOS Client 原生探测最小优化设计

日期：2026-08-03

## 背景与证据

Yoinks 当前优先通过 Innertube IOS client 获取 YouTube 签名直链，再以 16 MiB Range 检查首条视频 URL；首条失败时会丢弃整套 IOS 结果并回退 yt-dlp/android_vr。

真机抓包会话 `E8B646AB-3214-4A83-8873-3ED8FE92B75E` 证明：

- 被健康检查选中的是 IOS `itag=248`（VP9/WebM），GET Range 返回 403；
- 同一视频随后由 android_vr 获取的 `itag=137` 视频与 `itag=140` 音频连续返回 206，并完成下载、合并、验证和相册保存；
- 因此“一条 VP9 URL 403”不足以证明整套 IOS client URL 均不可用。

## 目标

1. 健康检查优先代表用户最常用、iOS 兼容性最好的 H.264/MP4 路径，而不是格式列表首项。
2. 不因一个格式失败而过早丢弃所有 IOS choices。
3. H.264/MP4 视频优先搭配 M4A 音频，保证 MP4 流复制兼容性。
4. progressive 与 adaptive 格式不重复生成 choice。
5. 日志区分 HTTP 状态、超时和网络异常，且不记录完整签名 URL。
6. 保留现有 yt-dlp/android_vr 与 UMP 回退，不引入新依赖、PoToken 或多客户端注册表。

## 设计

### 1. 正确分类格式

- `streamingData.formats` 仅生成 progressive/muxed choices。
- `streamingData.adaptiveFormats` 单独拆分 video-only 与 audio-only。
- 不再从两组拼接后的 `allFormats` 生成 DASH，避免 progressive 重复出现。

### 2. 容器兼容音频

- 从 adaptive audio-only 中计算：
  - `bestMp4Audio`：`audio/mp4` 内按 bitrate 最高；
  - `bestAudio`：所有音频按 bitrate 最高。
- H.264/MP4 DASH choice 使用 `bestMp4Audio || bestAudio`。
- MKV choice 使用 `bestAudio || bestMp4Audio`。
- `youtubeAudioItag`、`previewAudioURL` 和 codec 元数据必须与实际选中的音频一致。

### 3. 候选健康检查

健康检查最多执行三次，按代表性而不是原列表顺序：

1. 视频首选：`youtubeVideoItag === 137`；否则最高分辨率 H.264 DASH；否则 H.264 muxed/video。
2. 视频备选：另一条 H.264 视频 URL（若与首选不同）。
3. 音频：首个被保留 DASH choice 的 `previewAudioURL`，优先对应 `itag=140`。

单条检查返回结构化结果：

```ts
{
  usable: boolean
  status?: number
  reason: "ok" | "http" | "timeout" | "network"
}
```

每次检查记录 `probe.youtube.direct.url-check`：stream、itag、codec、host、status、reason；不保存 query 或完整 URL。

### 4. 保留与回退规则

- 任一代表性 H.264 视频检查成功：保留 IOS 原生 probe。
- 对需要音频的 DASH choices：只有代表音频检查成功才保留；音频失败时仍保留 muxed choices。
- 首个视频失败、备选成功：过滤明确失败的那个 choice，保留其余 IOS choices。
- 无可组成完整下载的可用 choice：记录 `probe.youtube.direct.url-blocked`，回退 yt-dlp/android_vr。
- 超时或网络异常按不可用处理，但日志不得误写成“403”。

## 非目标

- 不自动在线更新 IOS client 版本。
- 不实现原生 android_vr client。
- 不引入 PoToken、BotGuard 或 signatureTimestamp 动态提取。
- 不改 UMP/SABR 协议实现。
- 不遍历检查所有格式，避免探测耗时和额外流量失控。

## 验证

新增一个轻量静态回归脚本，至少检查：

1. progressive 只来自 `formats`；adaptive video/audio 只来自 `adaptiveFormats`。
2. H.264 choice 优先 `audio/mp4`。
3. 健康检查优先 itag 137/H.264，而不是首个视频 choice。
4. 健康检查返回 status/reason，不再只有 boolean。
5. 最多两条视频加一条音频检查。
6. 日志包含 itag/stream/status/reason/host，不包含完整 URL。
7. 无完整可用 choice 时仍回退 yt-dlp。

然后运行：

- 新增专项回归脚本；
- 现有 `verify_youtube_recovery_order.py`；
- 现有 `verify_ump_cancellation.py`；
- `scripting-ts project "Yoinks"`；
- TypeScript 诊断（需注明既有 iCloud 陈旧模块视图污染）。

## 真机验收

使用 `Pxq4hBIyyL4`：

- 日志中的首个 video URL check 应为 itag 137 或 H.264，而不是 itag 248；
- 若 IOS 137/140 返回 206，probe origin 应为 `youtube-native`，下载走 direct 原生链；
- 若 IOS H.264 仍失败，应准确记录实际状态并无感回退 android_vr；
- 播放、下载、FFmpeg 合并、音视频验证和相册保存均不回归。
