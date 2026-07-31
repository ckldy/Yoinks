---
title: Yoinks 通用公开播放器源抽取（A+B）
date: 2026-07-31
status: 已完成并通过真机验收
scope: 第6项
---

# 目标

当用户主动提交链接，或用户已主动触发发现页并选择入队的单个公开页面，现有匿名 `yt-dlp` 探测没有返回可下载格式、或该单页匿名探测达到总超时时间时，Yoinks 在受限范围内从公开 HTML 中寻找静态嵌入的媒体源。成功后复用现有格式选择、预览、下载、文件命名与批量队列。

本功能是通用 A+B 抽取框架，不绑定 Javtiful；Javtiful 仅作为第一批真机验收样例之一。

# 非目标与安全边界

本功能不：

- 读取、导入、注入或持久化 Safari Cookie、`Authorization` 或其他凭据；
- 绕过 DRM、license、付费墙、登录墙、验证码、地区限制或机器人验证；
- 监听网络流量、读取 Safari `performance` 资源记录、进行全局抓包；
- 读取第三方 iframe、递归 iframe，或在无候选时继续猜测 URL；
- 在后台批量扫描页面；每次只处理用户流程中的一个页面。

只接受 `http:` / `https:` 的公开候选。拒绝 `blob:`、`data:`、`file:` 等协议，以及媒体分片（`.ts`、`.m4s`）。不会解析、保存或使用 `drm`、`license`、`widevine`、`fairplay`、`authorization`、`cookie` 等受保护配置。

# 范围与同主域定义

## A：当前页面 HTML

匿名获取原始页面的公开 HTML，提取静态 HTML 属性、meta、内嵌 JSON 或脚本字符串中可安全解码的固定媒体 URL。

## B：同主域 iframe HTML

仅当 A 没有有效候选时，从当前页面静态 HTML 中读取 iframe `src`，最多访问 3 个 iframe。

iframe 的注册主域须与原页面相同。允许不同子域，例如：

- `www.example.com` → `player.example.com`；
- `video.example.co.uk` → `www.example.co.uk`。

拒绝不同注册主域、无法可靠确定注册主域、非 HTTP(S) URL、重复 URL 和嵌套 iframe。iframe 最大深度为 1。

为避免用简陋字符串后缀误判，注册主域判断应采用本地、保守的 public-suffix 规则子集；无法分类的主机仅允许完全相同主机，不将其视为同主域。

# 受控数据流

```text
用户主动提交/已选择入队的公开页面 URL
  → 既有匿名 yt-dlp 探测
  → 有格式：保持既有流程
  → “无可下载格式”失败或单页匿名探测总超时：公开播放器源抽取
      → A：当前页 HTML（最多 1 请求）
      → 有候选：构造已有 MediaProbe
      → 无候选：B：最多 3 个同主域 iframe（各最多 1 请求）
      → 有候选：构造已有 MediaProbe
      → 无候选：返回既有无格式失败，不入队
```

抽取器不用于认证失败、Cookie 过期、DRM、TLS、风控、用户取消或其他非“无格式”且非“单页匿名探测总超时”的错误，以避免把失败扩展成额外网络请求。

# 候选规则与产物

## 静态候选来源

可识别下列静态载体中的 URL：

- `<video>`、`<audio>`、`<source>` 的 `src`；
- `link[rel=preload][as=video|audio]` 的 `href`；
- `og:video`、`twitter:player:stream` 等公开 meta；
- 已知 JSON/脚本字面量中的 URL 值。

HTML entity 和 JSON string escape 可被解码；URL 相对路径按其所在页面或 iframe 的 URL 解析。候选规范化时保留查询参数、去除 fragment，并按最终 URL 去重。

## 合法媒体类别

- 渐进直链：常见视频/音频扩展名；
- HLS：`.m3u8`；
- DASH：`.mpd`；
- 明确媒体 query 参数（如 `manifest`、`playlist`、`m3u8`、`mpd`）仅可作为低优先级推断候选，仍要经过 URL/关键词安全校验。

候选按 HLS master、DASH、视频、音频、推断媒体的既有偏好排序，最多保留小上限，避免大 HTML 中生成无界列表。

## MediaProbe 构造

抽取成功后由专门服务返回无敏感的候选对象，调用方将其转为现有 `MediaProbe` / `MediaChoice`。直链与清单 URL 的 `previewReferer` 设为候选所在页面（原页面或允许 iframe 页面），沿用现有播放与下载头传递机制。

标题优先来自原页面的公开标题；iframe 标题只能作为原页面标题为空时的后备，避免输出文件名退化为播放器 iframe 标题。抽取器不得保存短期媒体 URL 到历史记录以外的新存储。

# 网络、日志与错误处理

- 总请求最多 4 个：原页面 1 个 + 同主域 iframe 最多 3 个；顺序执行，A 命中后不请求 iframe。
- 请求匿名发起，不附加 Cookie/Authorization；Referer 仅在最终媒体预览/下载链路中使用对应公开来源页面。
- 对页面响应设置尺寸和超时上限；非 HTML 响应、重定向到非 HTTP(S) 或跨主域 iframe 目标均拒绝。
- 日志只写抽取阶段、是否命中、候选类型数量、iframe 已检查数量和安全拒绝类别；不得记录页面 HTML、完整媒体 URL 或查询参数。
- 抽取器无候选或页面读取失败时，回到原有“未找到可下载格式”语义；不将失败条目加入队列。
- 直链短时失效仍由既有预览/下载错误处理报告；本阶段不在下载时自动重抓页面。

# 实现边界

建议新增独立的 `services/public-player-source.ts`：纯函数负责 URL、主域、HTML 候选和敏感字段过滤；异步协调器负责受限获取当前页和 iframe。`services/media.ts` 只在既有匿名探测判定为“无格式”时调用该协调器，并复用既有 `MediaProbe` / `MediaChoice` 构造。发现页调用现有预解析入口，无须复制抽取逻辑。

预期变更：

- 新增 `services/public-player-source.ts`；
- `services/media.ts`：受控回退与 `MediaProbe` 适配；
- 发现/队列调用点仅在确有需要时调整错误分类或标题传递；
- 新增独立验证脚本，不改 Safari 用户脚本，不改 Cookie/认证服务。

# 验收与验证

自动验证至少覆盖：

1. 当前 HTML 的 MP4、HLS、DASH 候选与 URL 去重；
2. HTML entity / JSON escape 解码、相对 URL 解析；
3. 同注册主域子域 iframe 允许；跨域、未知注册主域、非 HTTP(S)、重复与嵌套 iframe 拒绝；
4. iframe 数量上限为 3；A 命中时不请求 iframe；
5. `blob:`/`data:`/分片及 DRM、license、authorization、cookie 相关字段拒绝；
6. `MediaProbe` 的 Referer 和原页面标题优先级；
7. 日志字段不含完整候选 URL、查询参数、HTML 或凭据；
8. 现有直链选择、发现预解析、Safari 候选相关回归保持通过。

真机验收：

1. 一个当前页面静态含候选的公开页面；
2. 一个候选只存在于同主域 iframe 的公开页面；
3. Javtiful 发现 → 预解析 → 入队 → 下载闭环；
4. 跨主域 iframe 与无静态候选页面：不访问第三方 iframe、不入队、UI 正常恢复；
5. 无后缀 MP4 的预览、下载与文件命名保持正确。
