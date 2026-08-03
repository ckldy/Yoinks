# Yoinks

面向 [Scripting](https://scripting.fun) 的 iOS 媒体下载脚本。粘贴或分享公开媒体链接，探测可选格式后下载，并可保存到相册或文件。

当前版本：**1.6.12**

作者：**vcncv**

> 本项目受 [Pablo Stanley / Yoinks](https://github.com/pablostanley/yoinks) 启发，在 Scripting 运行时中重新实现核心下载体验，并针对 iOS 与 Scripting 宿主能力做了适配。

---

## 功能

- **链接输入与批量队列**：剪贴板粘贴、手动输入、Share Sheet / Intent 分享链接；支持批量添加并顺序下载。
- **格式探测与下载**：`yt-dlp` 探测标题、时长、清晰度及音视频流；仅有一种视频格式时会自动载入，存在多种视频格式时保留手动选择；H.264 优先 MP4；HEVC / AV1 / VP9 使用 MKV 流拷贝（外部播放器）；支持仅音频 MP3 与一键最佳质量；直链与 HLS 缺失清晰度时自动从页面元数据 / 文件本体（moov）/ TS 分片 SPS 补全分辨率标签；**m3u8 直链分析走原生快路径**（跳过 yt-dlp，fetch master 直接解析变体与清晰度，实测 2.2s 出格式）。
- **YouTube UMP 官方通道优先**：接入 yt-dlp-ytse 插件，下载优先走 UMP 官方 POST 通道（`格式表达式自动加 -ump 后缀` + `proto:ump` 排序，规避 GET 403）；**每流失败自动回退普通 yt-dlp 重试一次**（60 秒预算，可设置开关）；实际协议（ump / https）写入日志 `details.protocol`，可随时确认走的是哪条通道；真机已确认 UMP 下载闭环（720p 48MB 24s ≈2MiB/s，无回退）；UMP 下载取消/关闭预览确保进程退出（检查点 + 短 socket 超时 + ffmpeg SIGKILL）；仅 SSL 错误时自动 `--insecure` 降级重试；Python 常驻进程缓存自动清除（改插件无需重启 App）。
- **在线预览与保存**：支持 DASH 双流、H.264 优先及静音/有声自动播放；无自定义请求头的 HLS 优先交给 iOS 原生播放器，以改善随机定位；HLS / m3u8 默认**原生 HTTP/2 分片下载**（与预览同栈），自动选择最高清晰度并支持多档选择，连接未复用（如抓包）时自动回退 curl 分批补下；**支持 AES-128 加密 HLS 原生解密下载**（纯 JS AES-CBC，解密后分片级校验）、**EXT-X-MAP / CMAF(fMP4) init 段**（字节级拼接）、**#EXT-X-BYTERANGE 分片**（Range 请求）与错误分片集中重下；**DASH MPD 原生下载**（MPD→m3u8 桥接：视频/音频轨分别走分片管线后合并，on-demand 回落 yt-dlp）；**DASH 播放器稳定性增强**：初始化探测 2MB→16MB 自动扩大（4K moov 超限不再报错）、视频/音频独立探测（音频 403 时降级仅视频静音播放）、403 瞬时重试、dash.js CDN 失败自动切 unpkg 兜底、未知时长 MPD 兑底；**MSE 播放（hls.js/dash.js）使用自绘控制条**（播放/暂停、可拖动进度条、时间显示），修复 iOS 原生控制栏在 MSE 流上闪烁/调不出的问题，原生/直链播放仍用系统控制栏；可保存到相册、Files 或自定义目录。
- **最近候选库**：Safari 用户主动采集、发现页入队、手动与剪贴板链接统一保留 24 小时；可查看来源、类型、质量与容器提示，并按推荐/HLS/DASH/视频/音频/页面筛选。默认仅显示最近 3 条，较早候选可按需展开；也可在设置中关闭该区域以减少下载页占用。
- **Safari 候选采集**：Safari 用户脚本 **1.3.1** 仅在用户主动操作时从当前页采集公开媒体候选；浮动入口可**按住拖动放置**到屏幕任意边缘（松手自动吸附左/右边缘并记忆位置，不再固定右下角遮挡网页内容），短按入口或菜单会等待约 1.5 秒，减少播放器异步初始化的遗漏；长按入口可移除（关闭“始终显示浮动入口”时）；单候选直接进入分析，多候选点选后直接分析；采集直链优先保留，页面探测失败时可携带 Referer 回退；支持无扩展名 HLS 端点、跨域 iframe 正片、“点击播放后才请求”的站点，以及 sxyprn 等站点经 `cdn8/*.vid` 302 到 CDN 的正片；**PH 系站点（redtube / YouPorn / Pornhub / Tube8 等）主动识别签名清单端点（`/media/hls?s=`、`/media/mp4?s=`）并 fetch 解析出多档 HLS / MP4 直链**；相关视频预览、广告缩略图与播放器脚本中的非媒体资源（头像/图标 svg 等）自动过滤；主播放器 src 延迟设置的页面会在正片地址出现后自动补捕获；**捕获已解析出真实媒体时立即返回（跳过 30 秒播放监听）、多个端点并发请求**，捕获耗时约 2-5 秒；**MacCMS（苹果 CMS）播放站支持**：提取 `player_aaaa` 配置对象 `url` 键（兼容 JSON 转义 `\/` 与无分号结尾）与 155jx 等第三方播放器 iframe 的 `url=` 传参；采集已拿到正片级 HLS/DASH 时跳过 30 秒监听，一次点击 ~2.6s 出候选；**运行时代理**：捕获会话期间包装页面 fetch/XHR，新出现的媒体 URL 直接入候选，m3u8 响应文本缓存为 `manifestCache`，下载时清单端点 403/404 自动兑底；DASH 识别支持 `.mpd` 中间路径与 `type=dash` 等查询参数；采集结果给出三种反馈（已捕获 / 需要解析 / 未捕获），顶层无候选时保存公开播放器 iframe 线索。
- **公开播放器静态源回退**：用户主动选择的公开页面在匿名探测无格式或超时时，受限读取当前页及最多 3 个同注册主域 iframe 的静态 HTML，识别公开媒体源。
- **公开播放器链路解析**：当 Safari 页面只有公开播放器 iframe 线索时，Yoinks 匿名读取 iframe 页面、一个同源脚本与一个公开 JSON，提取公开媒体链接；不执行脚本、不携带 Cookie/授权，全链路 12 秒超时；解析期间锁定页面操作并可用“停止分析”终止。
- **站点与可靠性**：抖音走匿名 WebView 详情候选路径；小红书、YouTube、B站等以 `yt-dlp` 为主；支持必要的用户授权登录/Cookie 重试与 TLS 兼容重试；HLS / 原生直链 / 抖音不依赖 yt-dlp 也可下载；下载前重复检测避免误重复；设置页可一键清理下载缓存。
- **记录与设置**：下载历史、最近链接、容量清理、下载缓存清理、运行日志、输出目录、默认保存方式与 `yt-dlp` 更新。

---

## 安装

### 一键安装（推荐）

在 iOS Safari 打开：

```text
https://scripting.fun/import_scripts?urls=%5B%22https:%5C/%5C/github.com%5C/ckldy%5C/Yoinks%22%5D
```

或访问：

- GitHub：https://github.com/ckldy/Yoinks
- Releases：https://github.com/ckldy/Yoinks/releases

### 手动安装

1. 安装 [Scripting](https://scripting.fun)
2. 将本仓库克隆或下载到 Scripting 的 `scripts/Yoinks` 目录
3. 在 Scripting 中打开 **Yoinks** 运行

---

## 使用

1. 打开 **下载** 页，粘贴或从剪贴板导入公开媒体链接。
2. 等待探测完成：仅有一种视频格式会自动载入；有多种视频格式时选择格式，或使用「最佳质量 / 仅 MP3」快捷入口。
3. 开始下载；进度显示已下载大小、速度与阶段。
4. 完成后保存到相册或文件；在 **记录** 中管理历史文件。

支持从其它 App 分享 **URL / 文本** 到 Yoinks；抖音、小红书等分享文案会优先提取其中的短链或页面链接。

---

## 界面结构

| 标签 | 说明 |
|------|------|
| 记录 | 历史下载、预览/分享/删除、滚动加载更多 |
| 下载 | 当前链接、最近候选库、格式列表、批量队列、任务进度与结果操作 |
| 设置 | 偏好、工具状态、日志、关于与更新说明 |

---

## 项目结构

```text
Yoinks/
├── script.json                    # 脚本元数据与版本
├── index.tsx                      # 主 UI 与业务编排
├── browser.tsx.src               # Safari 用户主动媒体候选采集器（TSX 源码，发布为 Yoinks.user.js 由 Scripting 管理）
├── intent.tsx                     # 快捷指令 / Share Sheet
├── assistant_tool.tsx             # Assistant 只读日志工具
├── ytdlp_probe.py / ytdlp_runner.py
├── services/
│   ├── media.ts                   # 探测/下载/合并/验证主链
│   ├── hls.ts                     # HLS 分片下载（原生 HTTP/2 优先 + curl 兑底）
│   ├── shell-utils.ts             # quote/runCommand/formatBytes 共享工具
│   ├── cache.ts                   # 下载缓存清理
│   ├── media-candidates.ts        # 最近候选库持久化与筛选
│   ├── safari-media-candidates.ts # Safari 候选导入与安全清洗
│   ├── public-player-source.ts    # 受限公开播放器静态源抽取
│   ├── discovery.ts               # 发现页服务
│   ├── logs.ts                    # 运行日志与脱敏
│   └── player/                    # 播放服务
├── docs/
│   └── download-workflow.md       # 下载工作模式梳理与优化记录
├── CHANGELOG.md
└── verify_*.ts / *.py             # 本地回归脚本
```

运行时目录（不入库）：`logs/` 与应用 Documents 下的 `Yoinks/Downloads`。

---

## 隐私、安全与限制

- 仅用于你**有权保存**的公开内容与个人备份；请遵守目标网站服务条款与当地法律法规。
- Safari 候选采集仅在用户主动操作时读取公开媒体候选；不采集、不导入、不保存 Cookie、Authorization 或其他请求凭据。
- 公开播放器源回退与链路解析仅使用匿名 `http(s)` 请求；静态回退限制为当前页面和最多 3 个同注册主域 iframe，链路解析读取 iframe 页面、一个同源脚本与一个公开 JSON；12 秒超时、1.5 MB 页面大小、无递归、不执行脚本。
- 不提供破解或绕过 DRM、license、付费墙、登录墙、验证码、地区限制、未授权抓取的支持；不进行全局抓包、后台扫描或动态资源枚举。
- 站点规则与提取器会变化。部分内容可能需要用户自行提供已授权的登录 Cookie，或因网络/TLS 失败。
- 部分硬编码在 iOS 上可能「有声无画」；格式列表优先 H.264。HEVC / AV1 / VP9 使用 MKV 流拷贝，必要时请使用外部播放器。

---

## 开发与验证

```bash
scripting-ts project "Yoinks" --check
```

仓库包含 `verify_*.ts` / `verify_*.py` 回归脚本，覆盖候选库、Safari 候选、安全脱敏、公开播放器源、格式选择、批量队列、发现页、输出路径与预览等行为。

---

## 版本与更新

详见 [CHANGELOG.md](./CHANGELOG.md)。

| 版本 | 要点 |
|------|------|
| **1.6.12** | **下载可靠性三件套**：B站/直链分段下载取消延迟修复（读循环取消检查点，25s→毫秒级，取消错误不再静默重试）+ 进度计数虚增修复（段重试扣除已写入字节，显示不再超总大小）；**下载后台保活**（BackgroundKeeper 包裹单链/批量下载，切后台继续分段 fetch/HLS/ffmpeg，引用计数并发安全）；**下载完成通知**（仅 App 后台时发送：单链成功/失败 + 批量汇总一条；点击通知切回原界面不重开实例；设置页开关默认开）；真机验收通过 |
| **1.6.11** | UMP 组件（yt-dlp-ytse + protobug + 兼容补丁）检测与一键安装：设置页状态行/「安装」/「修复补丁」按钮；`python/patch_ytse.py` 幂等补丁工具（check/patch，形态不符保守失败）；组件未就绪时明确提示 UMP 优先不会生效 | **YouTube UMP 官方通道下载**（yt-dlp-ytse 插件：UMP 优先 + 失败每流自动回退普通 yt-dlp + 60s 预算开关 + `-ump` 稳定后缀 + 日志协议标记，真机确认 UMP 闭环）；UMP 取消确保进程退出 + 仅 SSL 错误 `--insecure` 降级 + 插件缓存自动重扫；YouTube 冷启动 PoToken 与预览 UMP 本地片段兑底；**DASH 播放器稳定性**（403 判定 bug、2MB→16MB 探测、音频 403 降级静音、403 重试、CDN 兑底、时长兑底）+ **MSE 自绘控制条**（修复控制栏闪烁/调不出，播放/暂停/进度条）；YouTube IOS 原生探测优化（137/H.264 优先）；真机验收通过 |
| **1.6.9** | HLS 下载管线增强：AES-128 原生解密、EXT-X-MAP/CMAF init 段字节拼接、#EXT-X-BYTERANGE 分片、错误分片集中重下、DASH MPD→m3u8 桥接（视频/音频轨分别下载后合并）；采集器 1.3.1：运行时代理（fetch/XHR）+ m3u8 清单缓存兑底 + DASH 识别增强 + MacCMS `player_aaaa` 配置/155jx iframe 传参捕获 + 已有正片级 HLS/DASH 跳过 30s 监听；m3u8 直链分析原生快路径（跳过 yt-dlp）；会话级候选上限；已完成真机验收 |
| **1.6.8** | 修复「最近候选库」残留旧 Safari 数据：启动时同步 Safari 最新捕获时间戳，新捕获晚于候选库最新 Safari 候选时自动清除旧 Safari 来源候选（保留发现/手动来源）；采集器 1.2.9 清除逻辑回归确认 |
| **1.6.7** | Safari 采集器 1.2.9：同源 iframe 直读 m3u8（avtoday）+ 公开播放器解析 UA/重试；Vue 组件树提取镜像源 videoUrlOne/Two/Three + 候选分析回退链（jvlook）；点击浮动入口捕获前最优先清除旧候选数据；已完成真机验收 |
| **1.6.6** | Safari 采集器 1.2.5：PH 系站点（redtube / YouPorn 等）签名清单端点捕获（/media/hls?s=、/media/mp4?s=）、porntrex flashvars 直链、非媒体资源噪音过滤、捕获性能优化（37 秒 → 2-5 秒）；通用清晰度补全（moov / TS SPS / ffprobe）；最近候选库可关闭；转换器同步管线修复；已完成真机验收 |
| **1.6.5** | Safari 采集器 1.1.9：捕获 `.vid` 重定向型正片端点（sxyprn 等，302 解析出最终 CDN 直链并回填 720p 清晰度）；预览噪音过滤（bkcdn library / trafficdeposit pivi / vidthumb.mp4）；主媒体延迟设置时自动补捕获；`.vid` 导入直链分析 + 失败兜底；已完成真机验收 |
| **1.6.4** | HLS 原生 HTTP/2 分片优先下载（自动最高清晰度/多档选择/可即时取消）；无 referer m3u8 直链也原生分片；Safari 采集器 1.1.6（无扩展名 HLS、跨域 iframe、播放触发捕获）；重复下载检测、缓存清理、yt-dlp 缺失防御；下载逻辑拆分 HLS 模块；已完成真机验收 |
| **1.6.3** | Safari 浮动入口支持按住拖动放置、位置记忆与边缘吸附；插件采集器更新至 1.1.2；已完成真机验收 |
| **1.6.2** | Safari 公开播放器链路匿名解析；HLS 原生分片下载（curl 并行 + 本地合成）；导入解析锁与停止/超时；插件采集反馈三态；已完成真机验收 |
| **1.6.1** | Safari 延迟采集、单候选直入与点选免确认；唯一视频格式自动载入；无 Header HLS 优先 iOS 原生播放；已完成真机验收 |
| 1.6.0 | 统一最近候选库与 Safari 主动候选采集；默认折叠较早候选；受限公开播放器静态源回退；发现/批量可靠性、输出命名与日志脱敏增强 |
| 1.5.1 | 下载稳定性修复：YouTube 匿名/登录会话一致性、剪贴板自动下载、TLS 证书兼容重试、B站 DASH 音频断连重试 |
| 1.5.0 | HLS / DASH 倍速控制、HLS 画质选择、在线预览可靠性增强；YouTube 按需登录与发现页能力 |

---

## 致谢

- **vcncv** — Scripting 适配、维护与发布
- [Pablo Stanley / Yoinks](https://github.com/pablostanley/yoinks) — 上游产品与交互灵感
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — 媒体提取
- [Scripting](https://scripting.fun) — iOS 脚本运行时

## 许可证

若未另行声明，以仓库根目录许可证文件为准。上游 Yoinks 与 `yt-dlp` 等依赖请遵循其各自许可。
