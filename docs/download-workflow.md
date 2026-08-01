# Yoinks 下载功能工作模式梳理

> 最后更新：2026-08-01（对应本地 1.6.3 + 未发版 HLS 原生下载改动）
> 范围：`services/media.ts` 的 `downloadMedia` 及其支撑服务（`background-download.ts`、`ytdlp_runner.py`、`batch-queue.ts`、`services/douyin.ts`、`services/cache.ts`）。

## 1. 下载入口

| 入口 | 触发 | 流程 |
| --- | --- | --- |
| 单链下载 | 粘贴/分享链接 → 分析 → 选格式 → 开始 | `startDownload()` → `downloadMedia()` → `saveResult()` |
| 批量下载 | 批量队列（记录页）→ 开始批量 | `startBatchDownload()` 串行逐项：复用预探测或重新 probe → `downloadMedia()` → 自动保存策略 |
| Safari 候选导入 | Safari 浮动入口采集 → 导入分析 | `analyzeSafariCandidate()` → 复用 `analyzeMedia()` → 单链下载 |
| 发现页入队 | 发现页候选 → 入队 | 入队前预探测（`probe` 缓存）→ 批量下载时直接复用 |
| 剪贴板自动下载 | 冷启动首个剪贴板链接（开关开启） | 自动 `analyzeMedia` → 自动选格式 → 单链下载 |
| 抖音 | 抖音链接 → 匿名 WebView 探测 → 候选 | `downloadDouyinDirect()`（独立管线，不走 yt-dlp） |

## 2. 下载管线（按 `MediaChoice.formatExpression` 分派）

`downloadMedia()` 内的分派顺序：

```
douyin → downloadDouyinDirect()
formatExpression === "direct" → 原生直链下载（BackgroundURLSession）
isM3U8URL / formatExpression === "m3u8" → HLS 管线
其余 → yt-dlp 管线（单文件或 视频+音频 分离合并）
```

### 2.1 原生直链（direct）

- 用 `BackgroundURLSession.startDownload`（Scripting 原生 NSURLSession 栈）下载，支持进度与取消。
- 请求头：`User-Agent`（Safari 导入时用移动 Safari UA）、可选 `Referer`。
- 下载后 `verifyMediaFile` → 发布到 `Downloads`。

### 2.2 HLS / m3u8 管线

核心目标：**优先原生分片下载，ffmpeg 只作最后兜底**（本设备 ffmpeg 网络 TLS 常被 CDN 拒绝、进程无法被 JS kill、取消只能等超时）。

```
有 referer（Safari 导入）或直接 m3u8 直链
  └─ downloadHlsSegmentsNative()
       ├─ 拉取 master 清单（fetch + Safari UA）
       ├─ 选最高清晰度 variant（selectHighestHlsVariant）
       ├─ 校验：仅支持 VOD（#EXT-X-ENDLIST）、无真实加密（METHOD=NONE 不算）、无 fMP4（#EXT-X-MAP）
       ├─ 不支持 → 返回 undefined → 落到 ffmpeg 分支
       └─ 支持：
            HLS_NATIVE_MODE === "fetch"（默认）
              ├─ downloadHlsSegmentsFetch：Scripting fetch（HTTP/2 复用，4 并发）
              │    ├─ 测速门槛：前 min(24,count) 片 >16s → 判定连接未复用 → { slow:true }
              │    └─ 每片 3 次重试 + 30s 超时
              ├─ slow / 失败 → downloadHlsSegmentsCurlBatches 兜底（复用已写 seg_* 文件）
              └─ 全部完成后 ffmpeg -f concat 本地合成 MP4（-c copy，无网络 TLS）
            HLS_NATIVE_MODE === "curl"（调试直连）
              └─ downloadHlsSegmentsCurlBatches：curl -Z 分批（30/批、8 并行、--max-time 30）
ffmpeg 分支（native 不支持 / 无 referer 时旧逻辑）
  ├─ ffmpeg 直连（-rw_timeout 30s、-c copy、+faststart）→ 成功发布
  ├─ 失败 → downloadHlsSegmentsNative 原生分片兜底 → 成功发布
  └─ 再失败 → BackgroundURLSession 下载原始 .ts → ffmpeg 封装 → 发布（仅非 m3u8 的伪 HLS）
```

- 完整性校验：`hlsPublishFailure` 用清单 `durationSeconds` vs 输出时长（≥90% 或差 ≤5s），防止单分片伪成功。
- 取消：fetch 路径逐片检查 cancel 文件（即时）；curl 批次无法批内中断（平台限制），批间检查并显示「正在停止（等待当前批次结束）…」。

### 2.3 yt-dlp 单文件

- 写 `download.json` → `python3 ytdlp_runner.py download.json`（yt-dlp，`noplaylist`、`playlist_items=1`、`android_vr` player client）。
- 进度：runner 写 `progress.json`，JS 侧 500ms 轮询映射到分段窗口（0.02→0.95）。
- 重试：宿主噪音（host noise）、TLS 超时、音频远端断连各自动重试一次。
- 完成后 `verifyMediaFile` → 发布。

### 2.4 yt-dlp 视频+音频分离合并

- video（0.02→0.5）→ audio（0.5→0.9）→ ffmpeg 合并（0.9→0.99）。
- H.264：`-c copy` MP4（+faststart）；失败回退 `h264_videotoolbox` 转码 MP4。
- 硬编码（HEVC/AV1/VP9）：`-c copy` → MKV（不转码，提示外部播放器）。
- 取消：`exit 130` 识别 + cancel 文件轮询。

### 2.5 抖音匿名下载

- 独立于 `downloadMedia`：匿名 WebView → 候选 → 流式/图文下载（`services/douyin.ts`）。
- 无用户登录、不接第三方解析 API；cancel 文件为 `tmp/<taskId>.cancel`。

### 2.6 批量队列

- `batch-queue.ts` 纯状态机；`index.tsx` `startBatchDownload` 串行执行。
- 每项：复用缓存 probe（发现页）或重新探测 → 自动选格式（策略：推荐/最高画质/首选容器）→ `downloadMedia`。
- 保存：仅 `photos` 模式自动存相册；`files`/询问模式保留原文件供「记录」页导出。
- 停止：`stopRequested` 整批停止；单条取消只停当前项。

## 3. 关键机制

| 机制 | 说明 |
| --- | --- |
| 取消 | 标记文件 `tmp/<taskId>/cancel`（抖音为 `tmp/<taskId>.cancel`）；下载侧轮询检测。yt-dlp/curl 无法被杀进程，只能批间/片间响应 |
| 进度 | `createProgressTracker`：单调 fraction + 分段窗口映射；HLS 分片 0.15→0.94、合成 0.94→0.99 |
| 完整性 | HLS 清单时长 vs 输出时长；`verifyMediaFile` ffprobe 流类型检查；硬编码软验证 |
| 发布 | `publishMediaFile`：安全文件名（`safeOutputStem`）→ `Downloads` 下重命名，冲突加 ` (1)`/` (2)` |
| 清理 | `downloadMedia` finally 删除 `tmp/<taskId>`；`cache.ts` 手动清理 tmp 残留（跳过运行中/近 10 分钟写入） |
| 会话 | 平台登录 Cookie 写入任务目录 `cookies.txt`，仅本次下载使用；临时会话结束后销毁 |

## 4. 已知限制（平台约束）

- **ffmpeg / curl / python 无法被 JS kill**：`Shell.run` 无 abort；取消只能靠缩小批次/收短超时（curl 批 30 片、ffmpeg 分支仍最多等 900s 超时）。
- **curl 无 HTTP/2**：ios_system 内置 curl 8.x 未编译 HTTP/2，-Z 每片独立连接（~2.8s/片握手）——这是 fetch-first 的动机。
- **ffmpeg 网络 TLS 不稳定**：部分 CDN 拒绝 ffmpeg 的 OpenSSL 握手；原生分片路径用 fetch（NSURLSession）规避。
- **设备内存**：fetch 分片并发 4 为实测稳定档；过高会耗尽内存。
- **lgpl ffprobe 对硬编码不可靠**：HEVC/AV1/VP9 走软验证（文件大小 > 0 即放行）。

## 5. 优化记录

### 2026-08-01 本轮

- **A. curl 兜底只补缺失分片**：fetch-slow/部分失败后，curl 主批次跳过已存在 `seg_*`，只补缺失分片；无缺失时跳过空批次直接合成。修复「fetch 已写分片被 curl 全量重下」的浪费。
- **B. 无 referer 的 m3u8 直链也 native-first**：统一 HLS 管线，直接粘贴的 m3u8 也先走 fetch HTTP/2 分片下载（可取消、快），失败/不支持再落 ffmpeg；原生请求默认携带移动 Safari UA。Safari 导入（有 referer）原生失败仍直接报错；无 referer 直链原生失败则记录 warning 并回退 ffmpeg（旧行为）。
- **B2. 修复原生返回 undefined 时误删 taskDirectory 的潜在 bug**：原生路径 finally 此前无条件删除 `tmp/<taskId>`，当清单类型不支持（加密/fMP4/live）回退 ffmpeg 分支时，输出目录已被删除导致 ffmpeg 写不进文件；现仅在原生真正完成（成功或报错抛出）时清理，回退 ffmpeg 时保留 taskDirectory。
- **D. HLS curl 路径显示速度与字节**：`downloadHlsSegmentsCurlBatches` 进度附加已下字节与实时速度，与 fetch 路径一致。

### 后续建议（已实施 2026-08-01）

- **拆分 HLS 下载代码到独立模块 `services/hls.ts`**：`isM3U8URL`、清单/变体解析（`parseHlsManifestSummary`/`listHlsVariants`/`selectHighestHlsVariant`）、完整性校验（`hlsCompletenessFailure`/`hlsPublishFailure`）、`readHlsManifestSummary` 与三个分片下载器（curl 分批 / fetch / native）全部搬出；新建 `services/shell-utils.ts`（quote/runCommand/formatBytes）供 media 与 hls 共用，避免循环依赖；media.ts 保留 re-export 兼容既有 import。media.ts 由 2774 行降至约 2330 行。
- **下载前重复检测**：手动下载前查询历史记录，相同 URL 已成功下载且文件可用时弹窗确认「该链接已下载过」；自动下载与批量队列不打断。
- **ffmpeg 分支取消反馈与超时收短**：取消时进度显示「正在停止（等待 FFmpeg 结束）…」；进入 ffmpeg 前复查取消标志避免无谓启动；runCommand 超时 900→600s（进程无法 kill，只能缩短等待）。
