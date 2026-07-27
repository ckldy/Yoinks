# 更新日志

本项目使用语义化版本号 `主版本.次版本.修订版本`：

- 主版本：不兼容的重大调整。
- 次版本：向后兼容的新功能。
- 修订版本：向后兼容的问题修复与小幅优化。

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

### 新增

- **批量下载**：添加菜单增加「批量添加…」（剪贴板全部链接 / 多行输入），确认后入队。
- 下载页在队列非空时显示 **批量队列**：统一格式策略、开始/停止整批、重试失败、清空、条目操作。
- 顺序执行：探测 → 自动选格式 → 下载 → 写历史；进度前缀 `批量 i/N`；失败不中断整批。
- 规格见 `docs/superpowers/specs/2026-07-26-yoinks-batch-download-design.md`。

### 说明

- 普通粘贴仍只取第一条链接；播放列表展开与多视频并行不在本版范围。
- 批量中不弹每次保存询问；相册模式自动入库，其余模式文件保留在记录中。
- 需登录的站点在批量中标记失败，请先在单链或设置中完成登录。

## 1.3.3 - 2026-07-25

### 优化

- 选择格式标签改为「分辨率 · 编码 · 类型 · 容器·XXX」：编码（H.264/AV1/VP9/HEVC）提前且必显，缺省写「编码未知」。
- 同一清晰度按编码并列展示（如 1080p H.264 与 1080p AV1 同时可选），不再只保留一条。
- 容器统一写成「容器·MP4」等，减少把容器误当成编码的误解。

## 1.3.2 - 2026-07-25

### 修复

- 下载 AV1/VP9/HEVC 后 iOS 播放「有声无画」：格式列表优先 H.264，硬编码项标注「iOS可能无画面」。
- 合并/单文件下载若源为硬编码，发布前尝试 VideoToolbox 转 H.264；转码失败则明确提示改选 H.264，避免发布黑屏文件。
- **说明（1.4.5）**：上述强制转码策略已改为 **MKV 流拷贝 + 外部播放器**；列表仍可优先 H.264。

## 1.3.1 - 2026-07-25

### 修复

- 下载阶段若 `Shell.run` 仅捕获到宿主诊断文案（如 `Write scripts settings successfully`），自动重试一次，避免误报下载失败。
- 将该类宿主噪音纳入统一判定；失败提示改为「操作被宿主中断或日志干扰，请重试」。

## 1.1.1 - 2026-07-21

### 优化

- 当前链接操作改为独立列表行，降低历史链接、重新分析和清除链接之间的误触风险。
- 重新分析期间明确显示“分析中……”，完成后恢复“重新分析链接”。

### 修复

- 文件名包含英文单引号等 Shell 特殊字符时，ffprobe 媒体验证能正确接收完整路径，避免下载已完成却被误判失败。
- 在线预览的自动播放失败不再被立即视为播放失败；登录重试会复用临时会话，并在播放结束后释放。
- 最小运行日志改为串行写入并按 UTF-8 完整 JSONL 行裁剪，避免并发覆写和多字节截断。

## 1.1.0 - 2026-07-21

### 新增

- 提供在线预览自动播放设置，可在静音自动播放和有声自动播放之间选择；默认静音自动播放。
- 下载任务中显示已下载大小、文件总大小、当前下载速度和可用时的预计剩余时间。
- 关于页面显示当前版本，并可在应用内查看本次更新内容。

### 优化

- 保留视频播放控制条；有声自动播放受 iOS 策略限制时可手动播放。
- 总大小或速度暂不可用时显示明确的等待状态。

### 修复

- 媒体探测命令成功但未返回可解析 JSON 时自动重试一次，改善临时探测输出异常的恢复能力。

## 1.0.0 - 2026-07-20

### 首个可用版本

- 支持公开媒体链接探测、格式选择、下载、音视频合并和保存到相册或文件。
- 支持下载记录、本地文件管理、登录/Cookie 重试、TLS 兼容重试与结构化运行日志。
