# 更新日志

## 1.6.13 — 2026-08-04

> UI 全面美化（参照 Pornhub / BMW Companion 的 SwiftUI 原生组件设计语言）+ UMP 组件自愈链（丢失自动恢复）+ UMP 插件迁移到项目目录（yt-dlp `--plugin-dir` 加载，彻底脱离 AppGroup 容器），全部真机验收通过。

### 新功能

- **UI 全面美化**：新增主题系统（`components/theme.ts`，品牌绿 + 动态深浅色）与 8 个共享组件（`components/ui.tsx`：HeroCard / MetricCard / StatTile / StatusPill / ActionPill / IconBadge / EmptyState）；记录页 2×2 统计网格 + 空态；下载页大百分比进度卡、批量队列卡（统计胶囊 + 双操作按钮 + 左滑删除）、链接 HeroCard（无条件显示“从 Safari 导入”入口）、候选库卡片、格式/任务区 ActionPill 化；设置页工具引擎状态卡片化（IconBadge + 就绪/安装胶囊）、Safari 插件状态胶囊、本地存储 3 列统计；日志页胶囊筛选器 + 等级徽章；删除了死代码 `statusIcon`。全部用 SwiftUI 原生组件实现。
- **UMP 组件自愈链**（组件丢失自动恢复，不再需要手动重复安装）：① 启动/状态检查检测到“组件在但补丁缺”时静默自动重打补丁（幂等、离线、秒级）；② 安装成功后把组件固化到项目 `python/ump-vendor/`（iCloud 持久）+ AppGroup 独立目录双备份，组件丢失时自动从备份恢复；③ 备份也不可用时仅启动时允许联网 pip 补装（60s 缓存 + 并发锁，失败静默回退普通 yt-dlp）。诊断日志输出 `site`/`evidence`（各部件存在性），下次丢失可精确定位被清的是哪部分。
- **UMP 插件迁移到项目目录**（彻底脱离 AppGroup 容器）：yt-dlp 通过 `--plugin-dir` 从项目 `python/ump-vendor/` 直接加载 yt_dlp_plugins 与 protobug 依赖（一个参数同时解决插件与依赖），App 更新/重装、iOS 清理都不再影响 UMP 组件；插件与补丁随仓库分发，安装版开箱即用；探测/下载命令全部注入插件目录，并清理 ios_system 常驻进程模块缓存（改插件无需重启 App）。

### 验证

- UI：`scripting-ts project "Yoinks"` 启动回归、TS 基线 49 无新增；真机验收通过（含功能回归：全选按钮、历史链接入口恢复）。
- 自愈：`verify_ump_selfheal`（ensure/backup/双 vendor/restore/复检）全过；`verify_ump_selfheal_restore` 破坏性测试（组件丢失 → 自动恢复 `restored`）通过。
- 迁移：usersite 清空 UMP 组件后端到端真实下载成功（`MEDIA_DOWNLOADER_PROTOCOL ump`）；sys.path 验证 ytse/protobug 均从项目目录加载；**真机验收通过**（播放 dash.js 有声 + 下载双流 `protocol:["ump"]` 182.98MiB/30s + 合并/相册全成功）。

## 1.6.12 — 2026-08-04

> 下载可靠性三件套：B站分段下载取消与计数修复 + 下载后台保活（BackgroundKeeper）+ 下载完成通知（仅后台发送、点击通知切回原界面），全部真机验收通过。

### 修复

- **B站/直链分段下载取消延迟（日志驱动，25s → 毫秒级）**：`downloadDirectSegmented` 读循环每块数据前检查取消标记（原实现需等整段读完，表现为「取消停止不下来」）；取消错误不再静默重试、立即抛出；分段下载为纯 JS fetch，无后台进程残留。
- **分段下载进度计数虚增**：段失败重试时从总计数扣除本段已写入字节（原实现 `downloaded` 只增不减，重试重复下载后 UI 显示「已下载 > 总大小」）。

### 新功能

- **下载后台保活**：`BackgroundKeeper.keepAlive()` 包裹单链/批量下载（引用计数并发安全，仅主 App 环境），App 切后台后分段 fetch / HLS / ffmpeg 合并等 JS 侧下载继续运行不被系统挂起；下载完成/取消/失败自动释放保活。
- **下载完成通知**：App 处于后台时下载完成/失败发送本地通知（单链成功/失败 + 批量完成一条汇总，不逐条轰炸）；前台不打扰（界面已有状态显示）；**点击通知仅将 App 带回前台显示原实例**（`tapAction: "none"`，不重新运行脚本）；设置页「下载偏好」新增「后台下载完成通知」开关（默认开）。

### 验证

- 新增：`verify_segmented_cancel_fix`（9 项）、`verify_background_keepalive`（9 项）、`verify_download_notify`（14 项）。
- 回归：`verify_download_cancel` 41 项、`scripting-ts project "Yoinks"` 启动通过。
- **真机验收通过**：B站大文件下载中途取消 1s 内停止、进度不再增长、显示不再超总大小；切后台下载继续（完成后保活释放）；后台完成收到通知、点击通知切回原界面（无重复实例）。

## 1.6.11 — 2026-08-03

> UMP 组件（yt-dlp-ytse + protobug + 兼容补丁）检测与一键安装：从 GitHub 安装的发布版不再因缺组件而功能不完整。

### 新功能

- **UMP 组件检测与一键安装**（对齐 yt-dlp 模式）：设置页「工具与登录」新增 UMP 组件状态行——`未安装` / `补丁缺失` / `0.4.3 · 就绪`；未就绪时提供「安装」/「修复补丁」按钮（pip 安装 yt-dlp-ytse==0.4.3 + protobug==1.0.0 并自动应用 6 处兼容补丁，`--trusted-host` 对齐 yt-dlp）；「检查下载引擎」同时刷新两项。
- **补丁工具 `python/patch_ytse.py`**（随仓库分发）：`check` 输出结构化 JSON（版本/6 项补丁标记/缺失列表）；`patch` 幂等补丁（PO_TOKEN 别名、`_list_formats` 5→4 值、`-ump` 稳定后缀、`__all__` 导出、sabr/ump 的 traverse_obj import），形态与 0.4.3 预期不符时保守失败不写文件。
- 「YouTube UMP 优先下载」开关下新增提示：组件未就绪时明确告知优先下载不会生效，直接走 yt-dlp。

### 验证

- patch_ytse.py 测试全过（原始 0.4.3 → 6 项补丁应用 → 复检全绿 → 幂等零改动 → 语法有效 → 真实环境 patched=true）。
- `verify_ump_tool_status` 真实环境通过（ytseVersion 0.4.3 / ytsePatched true）；项目启动回归通过。
- 待真机：设置页状态行、安装/修复按钮点验。

## 1.6.10 — 2026-08-03

> 本版为 **YouTube UMP 官方通道下载闭环**（yt-dlp-ytse 插件方案 A）+ **DASH 播放器稳定性两轮优化**（含 MSE 自绘控制条），全部静态/端到端验证与真机验收通过。

### 新功能

- **YouTube UMP 官方通道优先下载（yt-dlp-ytse 插件）**：接入 yt-dlp-ytse（UMP-wrapped GET 协议），下载优先走 UMP（`extractor_args youtube.formats=ump` + `format_sort proto:ump`），规避 googlevideo GET 403；`toUMPFormatExpression` 给数字 itag 自动加 `-ump` 后缀（如 `137+140 → 137-ump+140-ump`）；**每流失败（非取消）自动回退普通 yt-dlp 重跑一次**（60s 预算 + 设置开关，清残留后重试）；UMP 副本 format_id 稳定后缀修复（yt-dlp 去重后缀 `-0/-1` 顺序不稳定会匹配到 https 版）；**日志协议标记**：下载完成后输出 `MEDIA_DOWNLOADER_PROTOCOL ump|https`，`command.completed` 的 `details.protocol` 直接可见实际协议。
- **预览 UMP 本地片段兜底**：在线预览失败（YouTube 可恢复类错误）→ 自动刷新播放地址重试一次 → 仍失败则走 UMP 官方通道下载前 45s 片段本地播放；运行期可取消（新操作写入 cancel 文件，~1s 内退出）。
- **YouTube 冷启动 PoToken（08-02 晚）**：纯 Python（bgutils）生成 PoToken，避免冷启动 GET 全 403（ion44 出口 IP 实测 GET 全 403 而 UMP POST 全 200）；POST 下载 60s 超时 + 异常续传 + SSL 级联降级。
- **YouTube IOS 原生探测优化**：itag 137/H.264 优先健康检查、progressive/adaptive 分离、H.264 优先 M4A、结构化状态日志。

### 改进与修复

- **UMP 取消确保进程退出**：驱动加检查点（fetch_media 每轮查 cancel）+ 短 socket 超时（5s/8s）+ ffmpeg_run SIGKILL 包装；取消/关闭预览不再残留后台进程。
- **UMP --insecure TLS 绕开**：参照 yt-dlp，仅对 SSL 错误自动降级重试；`ytdlp_runner.py` 顶部清除 `yt_dlp*` sys.modules 缓存强制重扫插件（改插件无需重启 App）。
- **DASH 播放器稳定性（第一轮，日志驱动）**：修复模板字符串 `\b` 退格转义 bug（`/\b403\b/` 编译成退格字符正则，403 判定从未生效，B站 mirror fallback 逻辑是死的）；初始化探测 2MB 截断时自动扩大 16MB 重试（4K moov 超限不再报「无法解析 .m4s 初始化段」）；视频/音频独立探测，音频失败（403/超时）降级**仅视频静音播放**（不再全盘失败）；403 纳入 0/300/900ms 重试链；dash.js CDN 失败自动切 unpkg 兑底 + 4s 无反应主动切换；未知时长 MPD 1h 兑底。
- **DASH/HLS 播放界面：MSE 自绘控制条（第二轮，真机反馈）**：iOS WKWebView 对 MSE（hls.js/dash.js）流的原生 `<video controls>` 会闪烁/调不出（平台已知行为）；MSE 模式改自绘控制条（点击画面唤出/播放暂停、底部播放按钮、可拖动进度条、时间显示、3s 自动隐藏），native-fallback / 直链模式保留原生 controls。
- 顺手修复：`mergeYouTubeUMPTracks` 旧参数名 bug（`isCancelFlagSet`）。

### 验证

- 全项目 TypeScript 诊断通过（模板字符串内嵌 JS 由 verify 做语法检查）。
- 新增：`verify_dash_player_stability` 24 项（模板 JS 语法 + 探测扩大/403 重试/音频降级/CDN 兑底/时长兑底/自绘控制条断言）、`verify_ump_first` 8 项、`verify_ump_cancel_fast` 8 项、`verify_ump_cancellation`、`verify_ump_insecure`。
- 回归全过：`verify_online_preview`、`verify_player_controls` 15、`verify_mpd` 18、`verify_mpd_e2e` 6、`verify_ump_cancel_fast` 8、`verify_ump_first` 8。
- **真机验收通过**：UMP 下载闭环（13:37 `proto=["ump"]` 日志实锤：720p 136-ump+140-ump 48.34MiB 24s ≈2.0MiB/s + 音频 8.75MiB 8s，无回退，合并→验证→相册全通）；DASH 播放器稳定性 + 自绘控制条（14:07 用户确认符合预期）。

## 1.6.9 — 2026-08-02

> 本版为「cat-catch 审计优化」P0+P1 全量落地（加密 HLS 下载管线与 DASH 桥接、采集器运行时代理与清单兑底）+ chinaxmovie/MacCMS 采集修复 + m3u8 分析原生快路径，全部静态/端到端验证与真机验收通过。

### 新功能

- **AES-128 加密 HLS 原生下载**（`services/hls-crypto.ts` 新增）：纯 JS 查表法 AES-CBC 解密（无 WebCrypto 依赖，NIST SP 800-38A 向量验证）；解析 `#EXT-X-KEY`（AES-128/NONE/其它 METHOD）与显式 IV，缺省 IV 按分片序号生成；只走 native fetch（curl 无法解密），并发 2，解密后按 TS(0x47) / fMP4(moof) 分片级校验，KEY/IV 错误立即重试；SAMPLE-AES 等仍回落 yt-dlp。
- **EXT-X-MAP（CMAF/fMP4）init 段支持与字节级拼接**：init 段先下载后与分片序列直接拼接成合法 MP4（cat-catch 同款，规避 ffmpeg concat 对 fMP4 的 MPEG-TS 误判卡死）；TS 流保持 ffmpeg concat。
- **DASH MPD → m3u8 桥接**（`services/mpd.ts` 新增）：轻量解析 MPD（SegmentTemplate `$Number$`/`$RepresentationID$`/补零、SegmentList；on-demand/SegmentBase 不支持回落 yt-dlp），视频轨与音频轨分别合成 m3u8 复用 HLS 分片管线，独立音频轨时 ffmpeg 合并（`-c copy`）；`isMPDURL` / `fetchMPDText`（`urn:mpeg:dash:schema:mpd` 特征校验）接入下载分支（Safari 导入失败直接报错，无 referer 回落 ffmpeg 原生读 MPD）。
- **byteRange 分片下载**：解析 `#EXT-X-BYTERANGE`（含 offset 缺省续接）与 EXT-X-MAP 的 BYTERANGE 属性；fetch / curl / 加密三个下载器均支持 Range 请求与长度校验。
- **错误分片集中重下**：fetch 与加密下载器第一轮全部跑完后，对失败分片集中重下一轮，仍失败才报错（不再单次重试即整单失败）。
- **采集器运行时代理（browser 1.2.9 → 1.3.0）**：捕获会话期间包装页面 fetch/XHR（页面主世界），新出现的媒体 URL 直接入候选（`source: "runtime"`）；m3u8 响应文本（`#EXTM3U` ≤512KB、最多 3 条）缓存为 `manifestCache`；会话结束卸载并清空；DASH 识别增强（`.mpd` 中间路径、query `type=dash` 等）；候选收集上限 200 防超长页面爆内存。
- **清单缓存兑底**：Envelope 新增 `manifestCache`（sanitize 白名单：URL + `#EXTM3U` 开头 + 大小/条数限制）；`downloadHlsSegmentsNative` / `downloadMedia` 新增 `manifestFallbackText`，清单端点 403/404 时用采集器已捕获的清单文本兜底；导入时存 ref、下载时按 URL 匹配传递。
- **采集器 1.3.1（MacCMS/第三方播放器 iframe 捕获）**：新增 MacCMS `player_aaaa` 配置对象 `url` 键提取（PLAYER_CONFIG_DECL/URL_KEY，兼容 JSON 转义 `\/` 与无分号结尾）、iframe src query 媒体参数提取（`iframeQueryMediaURLs`，覆盖 155jx 等第三方播放器 `url=` 传参模式）与 `maccmsPlayerConfigURLs` 无条件提取（不依赖 video/player 容器门控）；采集已有正片级 HLS/DASH 候选时跳过 30 秒播放监听（修复 chinaxmovie 首次采集卡 30s、需二次采集的问题，一次点击 ~2.6s 出候选）。

### 改进与修复

- 重构：从 `downloadHlsSegmentsNative` 抽出 `downloadHlsMediaPlaylistText` 供 MPD 桥接复用同一分片下载/解密/合成管线；`parseHlsMediaPlaylist` 的 `HlsMediaPlaylistPlan.segments` 改为 `HlsSegment { url, byteRange? }`。
- **m3u8 分析原生快路径**：`.m3u8` 直链探测不再先跑 yt-dlp generic（Python 冷启动 + extractor 多轮网络 + 失败重试常耗 6-10s+，抓包下 SSL 重试更慢），直接原生 fetch master（Referer + Safari UA，8s 上限）解析变体出格式（实测 2.2s）；master 带 RESOLUTION 时清晰度直接可见，enrich 不再下载 TS 分片重复探测；`sniffHlsManifest` 支持无 Referer（手动粘贴 m3u8 也可原生嗅探）。
- `verify_browser_publish` 断言随符号更新（PLAYER_CONFIG_DECL/URL_KEY、iframeQueryMediaURLs、maccmsPlayerConfigURLs、监听跳过条件）。

### 验证

- 全项目 TypeScript 0 错误；`scripting-ts project "Yoinks"` 启动回归通过。
- 新增 e2e / 单测：`verify_hls_byterange_e2e` 6 项、`verify_mpd` 18 项、`verify_mpd_e2e` 6 项、`verify_manifest_fallback` 9 项。
- 回归全过：`verify_hls_crypto` 20、`verify_hls_aes128_e2e` 6、`verify_hls_fmp4_e2e` 6、`verify_hls_highest_variant` 9、`verify_hls_variant_choices` 21、`verify_download_cancel` 41、`verify_browser_publish` 24。
- **真机验收通过**：采集器 1.3.1 已发布到 Safari 用户脚本（`userscripts/Yoinks.user.js`，部署产物与源码一致）；chinaxmovie 一次点击 ~2.6s 出候选（不再二次采集）；m3u8 直链分析原生快路径出格式速度符合预期。

## 1.6.8 — 2026-08-02

### 改进与修复

- **修复「最近候选库」残留旧 Safari 数据**：之前仅在点击「从 Safari 导入媒体候选」时才清除 Safari 来源的历史候选；若用户在插件里又捕获了新数据但尚未导入，直接打开 App 时「最近候选库」仍显示上一次页面的旧链接。现改为 App 启动时同步 Safari 最新捕获时间戳——新捕获晚于候选库最新 Safari 候选时，自动清除旧 Safari 来源候选（保留发现/手动来源）。
- 回归确认采集器 1.2.9 清除逻辑正确：点击浮动入口捕获前最优先清空旧候选（click handler + captureCurrentPage 双重兜底），部署产物与源码版本一致，无残留通道。

### 验证

- 已通过 TypeScript 项目诊断、verify_safari_player_script_capture 26 项、verify_browser_publish 19 项、verify_download_cancel 40 项、verify_hls_variant_choices 21 项、verify_hls_highest_variant 9 项、新增 verify_media_candidates_sync 7 项（候选库同步语义：新捕获清除旧 Safari 候选 / 保留发现手动 / 旧 envelope 不误清）。

## 1.6.7 — 2026-08-02

### 新功能

- Safari 候选采集器更新至 **1.2.9**（1.2.5 → 1.2.9）：
  - **avtoday 同源 iframe 直读**：正片 m3u8 藏在同源 iframe 的脚本变量中，采集器直接遍历同源 iframe 文档提取真实播放地址，不再依赖被 Cloudflare 断连的跨 frame 探测。
  - **jvlook Vue 镜像源提取**：读取页面 Vue 组件树中的 `videoDetail.videoUrlOne/Two/Three` 镜像源字段，与 Twitter 原始源一并入库，避免只抓到 403 原始源而漏掉可用镜像。
  - **捕获前清除旧数据**：点击浮动入口捕获时，最优先清空上一次捕获的候选数据（先清除 → 再触发播放 → 再捕获），防止旧页面链接残留；`captureCurrentPage` 内部同样兜底清空。

### 改进与修复

- 公开播放器 frame 解析带 Safari UA + 重试，规避 Cloudflare 断连；`normalizePublicURL` 修剪尾部 `'"` 引号残留；运行日志上限 128K → 512K。
- 候选分析失败时自动回退尝试镜像源（回退链 `safari-candidate.fallback-next`），Twitter 原始源 403 不再整条失败。
- 导入 Safari 候选时先清除「最近候选库」中 Safari 来源的历史记录（保留手动/发现来源），避免旧链接累积。

### 验证

- 已通过 TypeScript 项目诊断、verify_safari_player_script_capture 26 项、verify_browser_publish 19 项、`scripting-ts project "Yoinks"` 启动回归。
- 真机验收通过：avtoday / jvlook 捕获出真实链接并可分析；点击浮动入口旧数据被清除后再捕获；jvlook 镜像源解析成功。

## 1.6.6 — 2026-08-01

### 新功能

- Safari 候选采集器更新至 **1.2.5**（1.1.9 → 1.2.5）：
  - **PH 系站点正片捕获**（redtube / YouPorn / Pornhub / Tube8 等）：主动识别播放器配置 `mediaDefinition` 中的签名清单端点（`/media/hls?s=...`、`/media/mp4?s=...`；YouPorn 为 `/media/hls/?s=...` 尾部斜杠形态）并 fetch 解析出各档 HLS master.m3u8 与 MP4 直链，无需等待播放即可拿到真实链接。
  - porntrex 等站点 kt_player **flashvars 直链捕获**（`video_url` / 别名键），并过滤全广告 iframe（`go.gsrv.dev` 等），避免把广告当播放器线索。
  - **非媒体资源噪音过滤**：播放器脚本中的头像/图标（如 `default-userAvatar.svg`）等不再误入候选列表。
  - **捕获性能优化**：PH 端点已解析出真实媒体时直接返回、跳过 30 秒播放监听循环；多个签名端点改为并发 fetch；端点超时收短——实测捕获耗时从约 37 秒降至 2-5 秒。
- **通用清晰度补全**：直链媒体（MP4 等）从页面元数据与文件本体（moov 头）解析分辨率；m3u8 单清单从 TS 分片 H.264 SPS 解析分辨率（ffprobe 兑底），格式标签更准确。
- 下载页「最近候选库」可在设置中关闭（默认显示）：设置页「下载偏好」新增开关，关闭后下载页不再展示候选库区域，减少占用。

### 改进与修复

- 修复同步管线（browser.tsx.src → Yoinks.user.js 转换器）把“首个变量带类型标注但无初始化器”的多变量 `let` 声明吞成单变量（丢失 `bestScore` 声明），导致 Safari 采集在含 iframe 页面偶发 `ReferenceError` 采集失败的问题；新增回归检查，部署产物校验更严格。
- PH 系签名端点 fetch 优先走 GM.xmlHttpRequest（扩展特权请求），失败回退页面 fetch，兼容无 CSP 与受限环境。

### 验证

- 已通过 TypeScript 项目诊断、`scripting-ts project "Yoinks"` 启动回归及 Safari/PH/redtube/YouPorn/porntrex/浏览器发布回归（19+19+19+15+21 项）。
- 真机验收通过：redtube / YouPorn 捕获出真实直链（多档 HLS/MP4）、捕获提速（约 37 秒 → 2-5 秒）、最近候选库开关、Safari 页面刷新后新版采集器生效。

## 1.6.5 — 2026-08-01

### 新功能

- Safari 候选采集器更新至 **1.1.9**：支持捕获**重定向型媒体端点 `.vid`**——sxyprn 等站点的正片通过 `sxyprn.com/cdn8/<obfuscated>.vid`（302）→ `c8/c10.trafficdeposit.com/widi/<...>.vid`（渐进式 MP4，最高数百 MB）提供，`.vid` 已纳入采集媒体名单与候选分类。
- `.vid` 导入**直接解析出直链**：重定向解析（`Range: bytes=0-1` + 来源页 Referer + Safari UA 跟随 302）拿到最终 CDN 直链，并从来源页提取分辨率（如 `resolution:HD 720` → 720p）回填格式标签；解析失败时保留 `.vid` 源直链兜底，下载/预览由 NSURLSession/AVPlayer 自行跟随 302（与页面播放器一致）。
- Safari 候选**预览噪音过滤**：相关视频预览片段（CDN77 `*.bkcdn.net/library/*.mp4`、trafficdeposit `/pivi/` 视频缩略图 `vidthumb.mp4` 等）不再进入候选列表，正片 CDN（`widi/*.vid`）不受影响。
- 主播放器 src 由 JS 延迟设置的页面（如 sxyprn `getvsrc()`），即使已有预览候选也会进入监听循环，等正片地址出现后自动补捕获，避免把预览片段当正片。

### 改进与修复

- `.vid` 探测跳过 HLS sniff（无 Range 的 sniff 会触发数百 MB body 下载并拖垮后续重定向解析），直接跟随 302 解析最终直链。
- 修复 Safari 导入 `.vid` 偶发“分析不出来”：CDN 慢/限流（如 trafficdeposit 503）时自动走直链兜底，不再整条失败。
- `.vid` 候选直接走直链分析（candidate-direct），跳过 yt-dlp 对站点的 Piracy/不支持必然失败。

### 验证

- 已通过 TypeScript 项目诊断、`scripting-ts project "Yoinks"` 启动回归及 Safari/直链/公开播放器/HLS 回归（15+16+21+20+26+21 项）。
- 真机验收通过：sxyprn 页面捕获只出正片 `.vid`、导入出 720p 直链、下载正常；相关视频预览与广告缩略图不再进入候选列表。

## 1.6.4 — 2026-08-01

### 新功能

- HLS / m3u8 下载全面升级为**原生 HTTP/2 分片优先**（Scripting fetch / NSURLSession，与在线预览同栈）：默认并行下载分片并本地合成，速度显著提升且可即时取消；连接未复用（如抓包 MITM）时自动回退 curl 分批补下，并复用已写分片。
- HLS master 清单**自动选择最高清晰度**，并支持**多清晰度列出选择**下载（240p–2160p 等）。
- 直接粘贴的 m3u8 直链也走原生分片下载（无需 Referer），不再落入缓慢且不可取消的 ffmpeg 直连。
- 下载前**重复检测**：同一链接已成功下载且文件仍可用时，弹窗确认后再下载（自动下载与批量队列不打断）。
- 设置页新增**清理下载缓存**：一键清理 `tmp` 下失败/中断任务残留（跳过运行中任务）。
- 下载引擎可用性防御：HLS / 原生直链 / 抖音不再因 yt-dlp 缺失而禁用「开始下载」；设置页安装/更新 yt-dlp 兼容 SSL 证书异常环境。
- Safari 候选采集器更新至 **1.1.6**。

### 改进与修复

- Safari 采集：支持**无扩展名 HLS 端点**（如 `play.php`）通过 `#EXTM3U` 嗅探捕获并下载；正片藏在跨域 iframe 时记录播放器 frame 线索并在失败后走公开播放器 iframe 解析；beeg 类“点击播放后才请求 m3u8”的站点在采集时主动触发播放并自动补捕获，避免漏掉真实链接。
- HLS 下载取消：curl 分批批次缩小（30/批）、每片与整体超时收短，取消时立即显示「正在停止（等待当前批次结束）…」；ffmpeg 兑底分支显示「正在停止（等待 FFmpeg 结束）…」并收短超时（600s）。
- 修复 `#EXT-X-KEY:METHOD=NONE`（显式无加密）被误判为加密、从而落入无法取消且常失败的 ffmpeg 分支的问题。
- 修复原生分片返回 undefined（加密/fMP4/live 清单不支持）时误删任务目录、导致 ffmpeg 兑底写不进文件的问题。
- HLS curl 兑底只补缺失分片，不再全量重下已存在分片；下载进度显示已下字节与实时速度。
- 代码结构：HLS 分片下载逻辑拆分到独立模块 `services/hls.ts`（含共享工具 `services/shell-utils.ts`），`media.ts` 体积下降约 400 行，行为不变。

### 验证

- 已通过 TypeScript 项目诊断、`scripting-ts project "Yoinks"` 启动回归及 40 项下载/HLS/取消回归。
- 真机验收通过：HLS 原生分片下载（beeg/EPORNER）、取消/续下、多清晰度选择、重复下载提示、缓存清理、yt-dlp 缺失防御与按钮恢复。

## 1.6.3 — 2026-08-01

### 新功能

- Safari 浮动入口支持**按住拖动放置**：按住绿色圆形图标即可拖动到屏幕任意位置，松手后水平吸附到最近的左/右边缘并保持垂直位置，不再固定于右下角遮挡网页内容。
- 浮动入口位置自动记忆：拖动后的位置保存到本地，刷新页面或重新打开后仍停留在上次放置的地方。
- Safari 候选采集器更新至 **1.1.2**。

### 改进与修复

- 拖动位移超过阈值（8px）时进入拖动模式并取消长按计时；快速点按仍为采集媒体候选，长按 700ms 移除入口的交互保持不变。
- 拖动范围限制在视口内（含刘海安全区），旋转屏幕或切换设备后自动将保存位置修正到可见区域。
- 浮动入口移动到屏幕左侧后，采集反馈气泡自动显示在按钮右侧，避免被挤出屏幕。
- 拖动时按钮放大并加深阴影提示拖动状态，拖动结束不误触发采集。

### 验证

- 已通过 TypeScript 项目诊断与 `scripting-ts project "Yoinks"` 启动回归。
- 待真机验证：拖动放置、位置记忆、点击/长按/拖动三种交互互不干扰、边缘吸附与安全区边界。

## 1.6.2 — 2026-08-01

### 新功能

- 新增 **Safari 公开播放器链路解析**：Safari 页面没有可直接采集的媒体候选、但存在公开播放器 iframe 时，Yoinks 会匿名解析 iframe 页面、同源脚本与公开 JSON，提取公开媒体链接后复用既有候选与分析流程；仅访问公开静态内容，不执行脚本、不携带 Cookie/授权。
- Safari 候选采集器更新至 **1.1.1**：页面采集结果增加三种反馈（已捕获 N 个候选 / 已获取链接信息、需要解析 / 未捕获到媒体链接）；顶层无候选时保存公开播放器 iframe 线索供 Yoinks 解析。
- Safari 导入的 HLS 增加**原生分片下载**：默认使用 curl 分批并行下载分片并本地合成（无需 ffmpeg 网络连接），避免部分 CDN 拒绝 ffmpeg TLS 握手；显示分片数、进度与速度，分片失败自动补下；fetch 流式 4 并发保留为备选。

### 改进与修复

- 点击“从 Safari 导入媒体候选”且需要解析公开播放器链路时，解析期间锁定页面操作（禁止重复点击/新操作），显示 12 秒超时说明与“停止分析”终止按钮；停止或超时后页面立即恢复可操作，不再陷入解析循环。
- 公开播放器 HTML 回退纳入 45 秒总探测预算，避免 yt-dlp 超时后再叠加页面+iframe 解析造成无界等待。
- Safari HLS 探测：空格式仍按 HLS 清单处理；Cloudflare 反爬或远端清单断连时保留公开 m3u8 直连回退。
- 公开播放器解析增加阶段跟踪（frame-html / script / endpoint / json / media），便于日志定位失败环节。

### 隐私与安全

- 公开播放器链路解析保持匿名受限：仅请求公开 HTML/JS/JSON，不执行脚本、不导入 Cookie、Authorization 或请求头，无站点特例，全链路 12 秒 deadline 与 1.5 MB 总字节预算。

### 验证

- 已通过 TypeScript 项目诊断、公开播放器来源（26/26）、Safari 候选（18/18）、延迟采集（9/9）、解析超时预算（4/4）等回归。
- Safari 公开播放器链路、原生分片 HLS 下载（2351 分片合成并保存相册）、插件采集反馈三态，以及导入解析锁与停止/超时均已完成真机验证并符合预期。

## 1.6.1 — 2026-07-31

### 改进与修复

- Safari 导入仅有一条媒体候选时，跳过候选菜单和二次确认，直接开始分析。
- Safari 导入有多条候选时，保留一次候选选择；点选后直接开始分析，不再询问是否导入。
- 单链接分析完成后，若仅有一种视频格式，会自动载入该格式；存在多种视频格式时仍由用户选择。
- 一种视频格式与多个音频格式同时存在时，默认载入视频；音频格式仍可在格式菜单中手动切换。
- Safari 浮动入口与菜单采集前等待约 1.5 秒，减少页面播放器异步写入媒体地址造成的候选遗漏；长按隐藏入口的交互保持不变。
- 无自定义请求头的 HLS 预览优先使用 iOS 原生播放器和系统控制条，改善公开 HLS 的随机定位；需要允许自定义请求头的 HLS 继续使用 hls.js。
- HLS seek 诊断仅在 hls.js 路径启用；关闭预览时立即停止诊断轮询，避免原生 HLS 日志混入和关闭后的无效记录。

### 验证

- 已通过 TypeScript 项目诊断、唯一视频格式逻辑验证（4/4）、Safari 候选安全回归（14/14）、Safari 延迟采集（6/6）、HLS 播放/诊断（11/11）、在线预览与日志脱敏回归。
- Safari 延迟采集、单候选直入、多候选一次选择后直入、唯一视频格式自动载入、HLS 原生播放与随机定位等本版功能，均已完成真机验证并符合预期。

## 1.6.0 — 2026-07-31

### 新功能

- 新增统一的**最近候选库**：Safari 用户主动采集、发现页入队以及手动/剪贴板链接可在 24 小时内重新选择分析。
- 候选库支持来源、类型、质量与容器提示，以及按推荐、HLS、DASH、视频、音频和页面筛选。
- 候选库默认只展示最近 3 条；较早项目可按需展开，避免下载页持续变长。
- Safari 候选采集器更新至 **1.0.9**，支持用户主动从当前页面采集公开媒体候选。
- 新增受限的通用公开播放器源回退：当用户主动选择的公开页面匿名探测无格式或超时时，可从当前页面及最多 3 个同注册主域 iframe 的静态 HTML 中识别公开媒体源。

### 改进与修复

- Safari 已主动采集的媒体直链优先于页面静态回退；页面探测失败时保留实际候选 URL 与 Referer 的下载路径。
- 对公开页面中重复的渐进 MP4 链接按推断清晰度收敛，避免同一低清版本重复展示。
- TLS 兼容重试在后续 JSON 输出重试时继续沿用 `--insecure` 状态。
- 改善发现页入队、批量元数据和输出命名可靠性；补充 Bilibili 发现页 412 的受限移动页回退。
- 强化运行日志脱敏与候选数据校验。

### 隐私与安全

- Safari 采集仅在用户主动操作时读取公开媒体候选；不采集、不导入、不保存 Cookie、Authorization 或其他请求凭据。
- 公开播放器源回退使用匿名请求，仅接受 `http(s)` 静态公开内容；有 12 秒超时、1.5 MB 页面大小、同注册主域 iframe（最多 3 个）和无递归限制。
- 不绕过 DRM、license、付费墙、登录墙、验证码、地区限制或网络请求保护；不进行全局抓包、后台扫描或动态资源枚举。

### 验证

- 所有本次功能均已通过用户真机测试闭环。
- 发布前静态回归覆盖候选库、Safari 候选、公开播放器源、直链选择、日志脱敏、批量队列、Bilibili 回退、输出命名与启动检查。
