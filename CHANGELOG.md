# 更新日志

本项目使用语义化版本号 `主版本.次版本.修订版本`：

- 主版本：不兼容的重大调整。
- 次版本：向后兼容的新功能。
- 修订版本：向后兼容的问题修复与小幅优化。

## 未发布

### 修复

- **发现页实验开关类型错误**：`index.tsx` 已读写 `experimentalDiscoveryEnabled`，但 `YoinksPreferences`、默认偏好和本地偏好规范化未定义该字段，导致 3 项 TypeScript 报错。现补齐布尔字段，默认关闭，并兼容已有本地偏好值。

### 验证

- 修复后 `index.tsx` 中 `experimentalDiscoveryEnabled` 的 3 项类型错误已消失；项目诊断从 16 项降为 13 项。剩余诊断为 1.4.9 快照既有的发现页 `services/discovery.ts` 缺失和 `verify_x_preview_audio.ts` 可空检查问题。

## 1.4.9 - 2026-07-28

### 修复

- **X（Twitter）多视频帖分析不出格式**：裸 `x.com/.../status/<id>` 多视频推文被 yt-dlp 以 `_type=playlist` 返回，顶层 `formats` 为空，探测显示标题但 `choiceCount/formatCount=0`。探测时展开 `entries` 取第一段视频格式，并把 `webpageUrl` 固定为 `/video/1`；`probeMedia`/`downloadMedia` 同步 pin 到 `/video/N`；runner 增加 `playlist_items=1` 防止裸状态链接误下第二段时 format 不匹配。

### 验证

- 复现链接 `https://x.com/i/status/2081601740965593356`：修复前 `formats=[]`，修复后 `formatCount=9` 且 `webpageUrl` 带 `/video/1`。
- TypeScript 诊断 0 错误；`verify_x_multivideo_probe.ts` 7/7；`verify_x_preview_audio.ts` 通过；`python3 -m py_compile ytdlp_probe.py ytdlp_runner.py` 通过；`scripting-ts project "Yoinks" --check` 通过。
- 仍需真机：粘贴该多视频 X 链接应列出格式并可下载第一段。

## 1.4.8 - 2026-07-27

### 修复

- **发现功能平台识别**：`services/discovery-engines/playlist.ts` 不再硬编码返回 B站，改为按 URL host 自动识别 YouTube、TikTok、抖音、X、小红书、B站等平台。
- **发现页「换一批」**：只有在明确还有更多内容（`totalAvailable > items.length` 或当前页已满）时才显示，避免单页/无结果时仍出现翻页按钮。
- **相关推荐平台选择**：仅列出 B站/YouTube；切换发现类型时若当前平台不被支持则自动重置为 B站。
- **B站 Web 搜索**：`bilibili_web_discover.py` 的时长解析支持整数秒与 `HH:MM:SS`，并对 `numResults`/`numPages` 兜底避免总页数为 0。
- **`ytdlp_discover.py` 输出简化**：`sourceURL` 统一使用原始输入。

### 验证

- TypeScript 诊断 0 错误；`verify_discovery_service.ts`、`verify_bilibili_space.ts`、`verify_discover_bili_behavior.ts` 均通过；`python3 -m py_compile` 通过；`scripting-ts project "Yoinks" --check` 通过。
- 真机验证：平台字段正确性、相关推荐平台选择受限、翻页按钮按需显示、B 站搜索时长显示均正常。

## 1.4.7 - 2026-07-26

### 修复

- **X（Twitter）视频在线预览无声音**：X 的 HLS 流分为 video-only 和 audio-only playlist，默认选中的 HLS video-only 在播放器中没有音轨。现在当目标是 HLS video-only 时，优先选择同高度的 muxed progressive MP4 作为预览源，并正确识别 X 的 `hls-audio-*` 音频格式用于下载合并。

### 验证

- TypeScript 诊断 0 错误；`verify_x_preview_audio.ts` 回归通过；`verify_online_preview.ts`、`verify_hard_codec_choice.ts` 保持通过。
- 真机验证：X 视频在线预览可正常播放并有声音。

## 1.4.6 - 2026-07-26

### 修复

- **YouTube 在线预览无画面**：yt-dlp 返回的 YouTube video-only 流为 DASH movie-fragment MP4，现在识别 `googlevideo.com` 域名并统一走 `DashPlayerService` 播放。
- **YouTube VP9 预览失败**：VP9 格式音频轨道为 webm/opus，`DashPlayerService` 仅支持 MP4 DASH init/index；预览时自动将 webm 音频回退到同链接的 m4a AAC，实际以 H.264 视频 + AAC 音频完成预览。
- DASH init/index 探测 Range 从 512KB 放宽到 2MB，覆盖更大的 `moov+sidx`。

### 验证

- TypeScript 诊断 0 错误；`verify_online_preview.ts` 6 组测试通过。
- 真机验证：YouTube H.264 / VP9 / AV1、B 站 `.m4s` DASH 在线预览均正常播放。

## 1.4.5 - 2026-07-26

### 变更

- **HEVC / AV1 / VP9**：下载后仅 `ffmpeg -c copy` 合成 **MKV**，不再强制 VideoToolbox 转码为 H.264。
- 格式列表硬编码项标注「外部播放器 · 容器·MKV」；请用 Infuse / VLC / nPlayer 等打开。
- H.264 + AAC 仍合并为 MP4；仅 H.264 流拷贝失败时才可选兼容转码。
- 本机 LGPL `ffprobe` 对硬编码不可靠时，按文件大小软验证放行（`verify.soft.completed`），避免误杀可播放 MKV。

## 1.4.4 - 2026-07-26

### 修复

- 下载分片 SSL/握手超时（如 `_ssl.c handshake timed out`）：自动重试一次视频/音频/单文件下载，并记录 `download.tls-timeout.retry`。
- 失败文案优先识别粘连在进度行上的 `ERROR:` / `Got error`，展示「网络 TLS/握手超时」而非 traceback 碎片。

## 1.4.3 - 2026-07-26

### 修复

- 合并下载视频流 exit 0 却报「未找到输出文件」：stdout 路径解析支持 Destination/already downloaded/Merger 行与 `.m4s` 等中间扩展名；stdout 无路径时扫描 work 目录回退。
- `ytdlp_runner` 静默进度输出、缩小 Shell 缓冲占用；无磁盘有效路径时改为非 0 退出，避免假成功。
- runtime 主链纳入 `download.video/audio/command.completed` 与 `download.output.fallback`，失败可带 work 文件列表。

## 1.4.2 - 2026-07-26

### 优化

- 批量队列内「从剪贴板添加」：直接解析并入队，不再弹确认。
- 队列条目支持左滑删除（进行中条目除外）；点按仍可播放/分享等。
- 设置新增「批量下载」分组，配置默认统一格式（与自动下载策略共用，空闲队列会同步）。

## 1.4.1 - 2026-07-26

### 优化

- 批量队列列表按状态排序（进行中 → 等待 → 失败 → 取消 → 完成），标题/副标题用短链与格式标签。
- 已完成条目可播放、分享；「重试失败/取消」「清理已结束」按钮显示数量。
- 入队确认展示短链与空位截断说明；进度区在批量时标题为「批量下载中」。

## 1.4.0 - 2026-07-26

### 变更

- 下载页「链接」区增加“加入批量队列”入口，可在探测完格式后直接入队；支持单一格式与仅音频。
- 批量任务顺序执行、同一任务保留原有分片并发；当前任务可取消，队列可暂停/继续/清空。
- 下载前可统一选格式；下载完成后写入记录，并继续下一项。
- 设置中「自动下载」默认格式重命名为「批量下载统一格式」。

### 验证

- `verify_batch_queue.ts` 静态覆盖队列状态机、格式选择、默认策略与取消行为。
- 仍需真机验证连续下载、暂停/继续、取消、失败后继续与清理已结束。

## 1.3.3 - 2026-07-25

### 修复

- 下载页格式列表把视频编码（H.264 / HEVC / AV1 / VP9 等）放在分辨率后并始终显示；同一高度的不同编码并列展示，便于避开设备不支持的 AV1/HEVC。

### 验证

- `verify_hard_codec_choice.ts` 13/13 通过。

## 1.3.2 - 2026-07-25

### 修复

- 下载 AV1/HEVC/VP9 完成后 iOS 播放器黑屏：明确标记不兼容编码，若用户强制选择会转码成 H.264；无法转码时中止并提示使用兼容格式。

## 1.3.1 - 2026-07-25

### 修复

- `Shell.run` 下载任务偶发被宿主日志文本替换为 `Write scripts settings successfully` 等噪音时，自动重试一次，避免真实下载未执行却直接报错。

## 1.3.0 - 2026-07-24

### 变更

- 抖音链接优先使用匿名 WebView 打开详情页并抽取媒体 URL，不再依赖 yt-dlp；支持图集图片、视频流和短链跳转。
- 抖音下载保持匿名，不发送账号 Cookie；其它平台仍可用登录重试。

### 验证

- 抖音短链和图集需在真机验证。

## 1.2.3 - 2026-07-24

### 修复

- TikTok 等短链探测出现 WebView 系统噪音或超时时，自动重试一次并显示友好错误，而不是“没有可下载格式”。

## 1.2.2 - 2026-07-24

### 修复

- 在线预览播放出现有声无画时，双流音频延迟到视频出现真实帧后启动；优先选择 H.264，视频错误时停止音频。

## 1.2.1 - 2026-07-24

### 修复

- 探测完成后 WebView 可能在释放时把宿主诊断文字混入 stdout：探测端识别后自动重试；平台 Cookie 改为重新登录后 fresh cookies 立即重探。

## 1.2.0 - 2026-07-24

### 变更

- 分段下载进度按视频、音频、合并映射为单调进度；下载中提供可见取消入口；支持 m3u8 下载。
