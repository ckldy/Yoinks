# 更新日志

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
