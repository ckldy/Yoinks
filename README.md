# Yoinks

面向 [Scripting](https://scripting.fun) 的 iOS 媒体下载脚本。粘贴或分享公开媒体链接，探测可选格式后下载，并可保存到相册或文件。

当前版本：**1.4.9**

> 本项目受 [Pablo Stanley / Yoinks](https://github.com/pablostanley/yoinks) 启发，在 Scripting 运行时中重新实现核心下载体验。Scripting 的模拟 Node.js 环境无法完整运行原版 `node` / `npm` 工作流，因此这里保留名称与使用路径，并针对 iOS 与宿主能力做了适配。

---

## 功能

- **链接输入**：剪贴板粘贴、手动输入、Share Sheet / Intent 分享链接；**批量添加**多条链接入队后顺序下载；队列内可直贴剪贴板、左滑删除
- **格式探测**：`yt-dlp` 探测标题、时长、清晰度与音视频流；格式标签显示分辨率、编码、类型与容器
- **下载**：单文件 / 分离音视频后用内置 `ffmpeg` 合并；H.264 优先 MP4；**HEVC / AV1 / VP9 流拷贝合成 MKV**（外部播放器）；支持仅音频（MP3）、一键最佳质量
- **站点分流**
  - 抖音：匿名 WebView 抓取详情候选后流式/图文下载（不登录、不接第三方解析 API）
  - 小红书、YouTube、B 站等：以 `yt-dlp` 为主；必要时 Cookie / 登录重试、TLS 兼容重试
- **在线预览**：探测后可预览；DASH 双流、H.264 优先；支持静音/有声自动播放策略
- **保存**：相册、Files / 自定义输出目录；可选保留 Yoinks 本地原文件
- **记录**：下载历史、最近链接复用、可用性检查与限额清理
- **日志**：运行日志（主链 + warn/error）；调试时可开临时详细日志
- **设置**：默认保存方式、批量统一格式默认、原文件保留与限额、输出目录、yt-dlp 更新、关于页与更新说明

---

## 安装

### 一键安装（推荐）

在 iOS Safari 打开：

```text
https://scripting.fun/import_scripts?urls=%5B%22https:%5C/%5C/github.com%5C/ckldy%5C/Yoinks%22%5D
```

或从仓库安装：

- GitHub：https://github.com/ckldy/Yoinks
- 标签：https://github.com/ckldy/Yoinks/releases/tag/v1.4.9

### 手动安装

1. 安装 [Scripting](https://scripting.fun)
2. 将本仓库克隆或下载到 Scripting 的 `scripts/Yoinks` 目录
3. 在 Scripting 中打开 **Yoinks** 运行

---

## 使用

1. 打开 **下载** 页，粘贴或从剪贴板导入公开媒体链接  
2. 等待探测完成，选择格式（或使用「最佳质量 / 仅 MP3」快捷入口）  
3. 开始下载；进度会显示已下大小、速度与分段状态  
4. 完成后保存到相册或文件；也可在 **记录** 中管理历史文件  

**设置** 中可调整保存方式、是否保留原文件、输出目录、预览自动播放与日志级别。

### 分享入口

- 支持从其它 App 分享 **URL / 文本** 到 Yoinks（`intentInputTypes`: `URLs`, `Text`）
- 抖音、小红书等分享文案会优先提取其中的短链或页面链接

---

## 界面结构

| 标签 | 说明 |
|------|------|
| 记录 | 历史下载、预览/分享/删除、滚动加载更多 |
| 下载 | 当前链接、格式列表、批量队列（非空时）、任务进度与结果操作 |
| 设置 | 偏好、工具状态、日志、关于与更新说明 |

---

## 项目结构

```text
Yoinks/
├── script.json              # 脚本元数据与版本
├── index.tsx                # 主 UI 与业务编排
├── intent.tsx               # 快捷指令 / Share Sheet
├── assistant_tool.tsx       # Assistant 只读日志工具
├── ytdlp_probe.py           # yt-dlp 探测
├── ytdlp_runner.py          # yt-dlp 下载
├── services/
│   ├── media.ts             # 探测/下载/合并/验证主链
│   ├── douyin.ts            # 抖音匿名 WebView 路径
│   ├── online-preview.ts    # 在线预览
│   ├── history.ts           # 下载记录与清理
│   ├── link-history.ts      # 最近成功链接
│   ├── preferences.ts       # 用户偏好
│   ├── platform-auth.ts     # 非抖音站登录/Cookie
│   ├── logs.ts              # 运行日志
│   ├── background-download.ts
│   └── player/              # 播放相关服务
├── CHANGELOG.md
└── verify_*.ts / *.py       # 本地回归脚本
```

运行时目录（不入库）：

- `logs/`：运行日志
- 应用 Documents 下的 `Yoinks/Downloads`：默认下载原文件

---

## 技术说明

| 组件 | 用途 |
|------|------|
| yt-dlp | 探测与下载（多数站点） |
| Scripting 内置 ffmpeg / ffprobe | 合并、转码与媒体流验证 |
| WebView | 抖音匿名详情抓取 |
| Scripting UI | 三标签页与原生交互 |

注意：

- 设备上的 `ffprobe` 诊断输出可能夹杂非 JSON 内容；验证逻辑以流摘要行为准，不依赖纯 JSON 解析。
- 高分辨率常为分离音视频轨，下载后由 ffmpeg 合并。
- 部分硬编码（如 AV1）在 iOS 上可能「有声无画」；格式列表优先 H.264，必要时尝试转码或提示改选。

---

## 开发与验证

在 Scripting 环境中：

```bash
# 类型检查（项目级）
# 使用宿主 TypeScript 诊断 / scripting-ts 能力

# 启动脚本
scripting-ts project "Yoinks"
```

仓库内带有若干 `verify_*.ts` / `verify_*.py`，用于日志裁剪、探测韧性、编码选择、Shell 引号等回归。

Git 工作流可使用 Scripting 的 [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) skill（`.git` 存放在 App Group，避免 iCloud 膨胀）。

---

## 版本与更新

详见 [CHANGELOG.md](./CHANGELOG.md)。

近期版本摘要：

| 版本 | 要点 |
|------|------|
| 1.4.9 | X 多视频帖：裸 status 探测展开 entries 并 pin `/video/1` |
| 1.4.8 | 发现页平台识别、换一批、B 站搜索时长 |
| 1.4.7 | X 视频预览：默认使用带音频的 progressive MP4 |
| 1.4.6 | YouTube 预览走 DashPlayerService；VP9 音频回退到 AAC |
| 1.4.5 | 硬编码下载改为 MKV 流拷贝 + 外部播放器 |
| 1.3.3 | 格式标签显示编码；同高多编码并列 |
| 1.3.2 | 下载硬编码黑屏：H.264 优先与转码/提示 |
| 1.3.1 | 宿主诊断噪音导致误报下载失败时自动重试 |
| 1.3.0 | 抖音匿名 WebView 下载主链 |
| 1.1.x | 在线预览、进度详情、日志与路径修复 |
| 1.0.0 | 首个可用版本：探测、下载、保存与记录 |

---

## 免责声明

- 仅用于你**有权保存**的公开内容与个人备份场景。
- 请遵守目标网站服务条款与当地法律法规。
- 不提供破解、绕过付费墙或未授权抓取的支持。
- 站点规则与提取器会变化；部分链接可能需要登录 Cookie 或因网络/TLS 失败。

---

## 致谢

- [Pablo Stanley / Yoinks](https://github.com/pablostanley/yoinks) — 上游产品与交互灵感  
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — 媒体提取  
- [Scripting](https://scripting.fun) — iOS 脚本运行时  

---

## 许可证

若未另行声明，以仓库根目录许可证文件为准。上游 Yoinks 与 yt-dlp 等依赖请遵循其各自许可。
