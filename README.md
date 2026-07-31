# Yoinks

面向 [Scripting](https://scripting.fun) 的 iOS 媒体下载脚本。粘贴或分享公开媒体链接，探测可选格式后下载，并可保存到相册或文件。

当前版本：**1.6.2**

作者：**vcncv**

> 本项目受 [Pablo Stanley / Yoinks](https://github.com/pablostanley/yoinks) 启发，在 Scripting 运行时中重新实现核心下载体验，并针对 iOS 与 Scripting 宿主能力做了适配。

---

## 功能

- **链接输入与批量队列**：剪贴板粘贴、手动输入、Share Sheet / Intent 分享链接；支持批量添加并顺序下载。
- **格式探测与下载**：`yt-dlp` 探测标题、时长、清晰度及音视频流；仅有一种视频格式时会自动载入，存在多种视频格式时保留手动选择；H.264 优先 MP4；HEVC / AV1 / VP9 使用 MKV 流拷贝（外部播放器）；支持仅音频 MP3 与一键最佳质量。
- **在线预览与保存**：支持 DASH 双流、H.264 优先及静音/有声自动播放；无自定义请求头的 HLS 优先交给 iOS 原生播放器，以改善随机定位；Safari 导入的 HLS 支持原生分片下载（curl 分批并行 + 本地合成，避免 CDN 拒绝 ffmpeg 连接）；可保存到相册、Files 或自定义目录。
- **最近候选库**：Safari 用户主动采集、发现页入队、手动与剪贴板链接统一保留 24 小时；可查看来源、类型、质量与容器提示，并按推荐/HLS/DASH/视频/音频/页面筛选。默认仅显示最近 3 条，较早候选可按需展开。
- **Safari 候选采集**：Safari 用户脚本 **1.1.1** 仅在用户主动操作时从当前页采集公开媒体候选；短按浮动入口或菜单会等待约 1.5 秒，减少播放器异步初始化的遗漏；单候选直接进入分析，多候选点选后直接分析；采集直链优先保留，页面探测失败时可携带 Referer 回退；采集结果给出三种反馈（已捕获 / 需要解析 / 未捕获），顶层无候选时保存公开播放器 iframe 线索。
- **公开播放器静态源回退**：用户主动选择的公开页面在匿名探测无格式或超时时，受限读取当前页及最多 3 个同注册主域 iframe 的静态 HTML，识别公开媒体源。
- **公开播放器链路解析**：当 Safari 页面只有公开播放器 iframe 线索时，Yoinks 匿名读取 iframe 页面、一个同源脚本与一个公开 JSON，提取公开媒体链接；不执行脚本、不携带 Cookie/授权，全链路 12 秒超时；解析期间锁定页面操作并可用“停止分析”终止。
- **站点与可靠性**：抖音走匿名 WebView 详情候选路径；小红书、YouTube、B站等以 `yt-dlp` 为主；支持必要的用户授权登录/Cookie 重试与 TLS 兼容重试。
- **记录与设置**：下载历史、最近链接、容量清理、运行日志、输出目录、默认保存方式与 `yt-dlp` 更新。

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
├── browser.tsx                    # Safari 用户主动媒体候选采集器
├── intent.tsx                     # 快捷指令 / Share Sheet
├── assistant_tool.tsx             # Assistant 只读日志工具
├── ytdlp_probe.py / ytdlp_runner.py
├── services/
│   ├── media.ts                   # 探测/下载/合并/验证主链
│   ├── media-candidates.ts        # 最近候选库持久化与筛选
│   ├── safari-media-candidates.ts # Safari 候选导入与安全清洗
│   ├── public-player-source.ts    # 受限公开播放器静态源抽取
│   ├── discovery.ts               # 发现页服务
│   ├── logs.ts                    # 运行日志与脱敏
│   └── player/                    # 播放服务
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
