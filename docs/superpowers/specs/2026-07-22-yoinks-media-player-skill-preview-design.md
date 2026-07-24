# Yoinks 在线预览迁移至 Media Player Skill 设计

**日期：** 2026-07-22  
**状态：** 待用户审阅  
**范围：** Yoinks 在线预览；`media-player-skill` 的请求配置能力

## 1. 背景与目标

Yoinks 当前把在线预览的播放器 HTML、`WebViewController` 生命周期、事件桥接、12 秒超时、网页登录重试和“下载后播放”兜底都放在 `index.tsx`。这让页面承担了播放器实现细节，也与新建的 `media-player-skill` 形成两套播放器实现。

本次目标是：

1. Yoinks 在线预览改用本地 `media-player-skill` 的 `HLSPlayerService`。
2. 先补齐 skill 中 `headers`、`referer`、`origin`、`baseUrl` 的实际请求配置能力；不能只接受配置而不生效。
3. Yoinks 移除在线预览专用的网页登录、Cookie 检查、登录后重试和“下载后播放”兜底。
4. 保留 Yoinks 的自动播放偏好、结构化日志、下载流程及已下载文件的 Quick Look 播放。

## 2. 非目标

以下不属于本轮工作：

- 改造 yt-dlp 的探测、下载、保存、合并或认证下载流程。
- 为 Yoinks 加入外部播放器选择器或外部播放器启动入口。
- 为预览增加新的账号登录能力；在线预览不再尝试登录。
- 保证所有受反盗链、Cookie 或 DRM 保护的站点都可播放。
- 绕过浏览器/WKWebView 对 `Referer`、`Origin`、`User-Agent` 和原生媒体请求头的限制。

## 3. 当前状态

### 3.1 Yoinks

`index.tsx` 当前含有：

- `playerHTML()`：生成 `<video>` WebView 页面；
- `presentHTML5Player()`：创建/复用 WebView、监听事件、处理 12 秒超时、呈现和清理；
- `previewSelectedChoice()`：首次失败后提示登录，创建 `GenericPreviewSession` 并重试；
- `services/generic-preview-session.ts`：暂存网页登录后的 ephemeral WebView Cookie 会话。

### 3.2 Media Player Skill

`media-player-skill/scripts/player/hls-player-service.ts` 当前提供：

- `HLSPlayerService`；
- WebView + hls.js / 原生 HLS 回退；
- hls.js 网络/媒体错误恢复；
- 质量切换事件和基础控制方法；
- `PlayerConfig` 中已有 `headers`、`referer`、`origin`、`userAgent`、`baseUrl` 字段。

但当前 skill 的播放器 HTML 尚未把 `headers`、`referer` 等完整映射到 hls.js 的请求管线；因此本轮必须先补齐该实现和验证。

## 4. 目标架构

```text
Yoinks/index.tsx
  └─ services/online-preview.ts
       ├─ 解析/合并预览请求上下文
       ├─ 调用 media-player-skill HLSPlayerService
       ├─ 订阅 skill 播放事件并写 Yoinks 脱敏日志
       ├─ 全屏呈现 WebView
       └─ 页面关闭后销毁播放器

media-player-skill
  └─ HLSPlayerService
       ├─ 用 baseUrl 加载播放器 HTML
       ├─ 在 hls.js XHR/fetch 请求注入允许的自定义 headers
       ├─ 使用浏览器上下文处理 Referer / Origin
       ├─ hls.js HLS/AES-128/质量切换/错误恢复
       └─ 原生 HLS 回退（明确请求头限制）
```

边界原则：

- **Yoinks**：负责业务输入、用户可见状态、偏好映射、隐私日志和播放器会话呈现。
- **skill**：负责播放页面、媒体加载、hls.js 请求配置、播放控制和资源释放。
- **页面层不再直接管理 WebViewController**，除非 skill 的公开服务接口暴露控制器供 `<WebView>` 呈现。

## 5. Skill 请求配置设计

### 5.1 配置语义

保留并明确 `PlayerConfig`：

```ts
interface PlayerConfig {
  baseUrl?: string
  referer?: string
  origin?: string
  headers?: Record<string, string>
  userAgent?: string
  autoPlay?: boolean
  muted?: boolean
  playsInline?: boolean
  // 既有 HLS 缓冲及恢复配置
}
```

- `baseUrl`：传给 `WebViewController.loadHTML(html, baseUrl)`；默认使用预览页面 URL 的 origin。
- `referer`：记录预期来源页面；用于为页面选择 base URL 和向 hls.js 的自定义加载器提供允许的非受限 header 策略。
- `origin`：记录预期源站；默认从 `baseUrl` 推导。
- `headers`：仅用于允许在 JavaScript XHR/fetch 设置的自定义请求头。
- `userAgent`：如果 Scripting WebView API 无法对单个 WebView 设置 UA，必须标记为受限；不得伪称已应用。

### 5.2 Header 过滤和浏览器受限字段

skill **接受所有 Header 配置**，完成格式校验后分流处理：

| 字段类别 | 处理方式 | 备注 |
|---|---|---|
| 受限字段：`referer`、`origin`、`host`、`connection`、`content-length`、`user-agent`、`cookie`、`sec-*` | 记录为“已接收但由 WebView 决定，未通过 JS 强制注入” | `referer`/`origin` 用于推导 `baseUrl` 并建立页面上下文 |
| 允许自定义字段（`authorization`、`x-token`、`x-user-id` 等） | hls.js 的 `xhrSetup` / `fetchSetup` 实际注入 | 仅作用于 hls.js 可控请求 |
| 其他未知字段 | 若名称合法则透传给 hls.js | 非法/空名称丢弃 |

安全原则：

- `cookie` 不通过 JS 注入；Cookie 由 WebView Cookie Store 管理。
- `authorization` 或 token 的值仅驻留在播放器内存/HTML 配置中，**不进入日志**。
- 禁止控制字符和空 header 名称；大小/数量设置合理上限，避免把大对象注入 HTML。
- 技能不伪称浏览器受限字段已在 JS 层生效，避免产生“配置已生效”的误导。

### 5.3 hls.js 请求路径

skill 在 HTML 内配置 hls.js 的 `xhrSetup`，若当前 hls.js 版本需要，补充等效 `fetchSetup`。这些配置必须覆盖：

- master manifest；
- variant manifest；
- media segment；
- init segment；
- AES-128 key；
- subtitle/track 请求。

注入的 `requestHeaders` 为 **已剥离受限字段后的允许自定义 Header**。

伪代码：

```js
const requestHeaders = /* 已过滤允许字段，JSON 序列化注入 */
const hls = new Hls({
  ...hlsConfig,
  xhrSetup(xhr) {
    Object.entries(requestHeaders).forEach(([name, value]) => {
      xhr.setRequestHeader(name, value)
    })
  },
  // 若 hls.js 版本支持
  fetchSetup(controller, context) {
    requestHeaders && controller.headers.set(...)
  },
})
```

实现必须保持既有 hls.js 配置合并逻辑：调用者提供的 HLS 配置与默认配置不能因新增请求设置而丢失。

### 5.4 Referer / Origin 与原生回退的能力报告

`Referer` / `Origin` 属于浏览器受控请求头，不把它们当作普通 `headers` 注入。

- 使用 `loadHTML(html, baseUrl)` 建立页面 source context。
- `baseUrl` 优先取 `referer` 的 origin；当 `referer` 不可用时取媒体 URL origin。
- `origin` 只用于配置诊断和上下文推导，不主动伪造 header。
- 原生 `<video src>` HLS 回退：**不能可靠添加任意自定义 header**；skill 在回退路径必须返回/记录 `requestMode: "native-fallback"` 与 `customHeadersApplied: false`。
- hls.js 路径：返回/记录 `requestMode: "hls.js"` 与 `customHeadersApplied: true`（若有允许注入的自定义 Header）。

这意味着需要自定义 Authorization Header 的媒体应优先走 hls.js；若设备只能走 native fallback，Yoinks 需要以“当前播放器模式不支持该鉴权头”作为实际失败原因，而不是误报为自定义 Header 已生效。

## 6. Yoinks 预览适配层

新建：`Yoinks/services/online-preview.ts`。

### 6.1 数据模型

```ts
export type PreviewAutoplayMode = "muted" | "audible"

export type PreviewRequest = {
  url: string
  title: string
  autoplayMode: PreviewAutoplayMode
  webpageURL?: string
  previewReferer?: string
  previewHeaders?: Record<string, string>
}

export type OnlinePreviewResult =
  | { status: "presented" }
  | { status: "invalid-url"; message: string }
  | { status: "failed"; message: string }
```

`PreviewRequest` 中的 `webpageURL` 是 yt-dlp 探测后的页面地址，供请求上下文回退使用。

### 6.2 请求上下文优先级

```text
previewReferer（格式级）
  > webpageURL（探测结果）
  > 用户输入且已规范化的源地址
  > 预览媒体 URL 的 origin
```

`previewHeaders` 为格式级信息；没有时传空对象。不得从下载用 cookie 文件或持久认证会话复制 Cookie 到浏览器请求头。

适配层推导：

```ts
const player = createPlayer({
  baseUrl: originOf(effectiveReferer || previewURL),
  referer: effectiveReferer,
  origin: originOf(effectiveReferer || previewURL),
  headers: previewHeaders,
  autoPlay: true,
  muted: autoplayMode === "muted",
  playsInline: true,
})
```

### 6.3 会话生命周期

1. 校验 URL 是 HTTP/HTTPS。
2. 创建 skill player。
3. `initialize()`，获取 `player.getController()`。
4. 触发 `player.play(url)`。
5. 全屏 `present()` 播放器 WebView。
6. WebView 关闭时，无论播放是否成功，执行一次 `player.destroy()`。
7. 对打开、初始化或呈现异常，执行同样的 cleanup，并返回 `failed`。

实现应避免旧实现的两个问题：

- 不在播放器仍展示时提前 destroy；
- 多个异常/关闭回调只能触发一次释放。

### 6.4 事件和用户行为

| 事件/结果 | Yoinks 行为 |
|---|---|
| 无 `previewURL` | 保持“当前格式没有可用的预览链接”提示 |
| 非 HTTP/HTTPS URL | 显示“预览链接无效” |
| player 初始化/呈现失败 | 显示“在线预览无法打开” |
| skill `playing` | 写日志；不额外打断用户 |
| skill `error` | 写日志；播放器页面显示 skill 的播放错误 |
| 自动播放被阻止 | 留在播放器页面，用户可点击原生 controls 播放 |
| 用户关闭播放器 | 释放 player，记录关闭日志 |

明确删除：

- `beginGenericPreviewLogin()`；
- `disposeGenericPreviewSession()`；
- 登录提示、Cookie 域匹配、登录后重试；
- `preview.fallback-download` 与“下载完后播放”对话框；
- 12 秒超时作为业务回退的判断。

## 7. MediaChoice 与探测数据

扩展 `MediaChoice`：

```ts
export type MediaChoice = {
  // 既有字段
  previewURL?: string
  previewReferer?: string
  previewHeaders?: Record<string, string>
}
```

相应扩展 `RawFormat` 和 `probeMedia()` 的 JSON 映射。

`ytdlp_probe.py` 只有在 yt-dlp/抽取器明确提供格式级 HTTP header 或 Referer 信息时输出这些字段；不存在时不猜测、不杜撰。默认页面级 Referer 仍由 Yoinks 适配层推导。

## 8. 日志与隐私

预览日志通过 Yoinks `logEvent()` 写入，继续使用现有脱敏流程。

建议事件：

- `preview.started`：`isMuted`、`hasReferer`、`headerCount`、`requestMode`。
- `preview.presented`：播放器成功显示。
- `preview.player-event`：仅允许事件名、错误码、模式和重试标记；本轮不再有 retry。
- `preview.player-error`：错误类型、错误码、模式。
- `preview.closed`：已关闭并释放。
- `preview.failed`：初始化或呈现失败，message 必须经过 `safeText()` 处理。

日志限制：

- 不记录完整 `previewURL`；
- 不记录 query token、Cookie、Authorization、Header 值；
- header 名称中疑似敏感的键不原样写入，统一记为 `sensitive-header`；
- 普通错误文本也必须经 URL 脱敏处理。

## 9. 文件变更

### Media Player Skill

| 文件 | 变更 |
|---|---|
| `scripts/types.ts` | 明确请求配置字段和可观测请求模式类型（如需要） |
| `scripts/player/hls-player-service.ts` | 过滤 headers、将其注入 hls.js XHR/fetch、传递 autoplay/muted/playsInline、报告原生回退限制 |
| `scripts/index.ts` | 如新增公开类型/辅助函数则导出 |
| `SKILL.md` | 更新实际 headers/referer 支持范围和原生回退限制 |
| `verify_request_config.ts` | 新建：验证配置序列化、过滤和 HTML 生成，不发起真实鉴权请求 |

### Yoinks

| 文件 | 变更 |
|---|---|
| `services/online-preview.ts` | 新建 skill 适配层 |
| `services/media.ts` | 扩展 preview URL、Referer、headers 的探测映射 |
| `ytdlp_probe.py` | 在可用时输出格式级预览请求元数据 |
| `index.tsx` | 使用适配层；删除内置播放器/登录重试/下载兜底代码和无用导入 |
| `services/generic-preview-session.ts` | 删除 |
| `verify_generic_preview_session.ts` | 删除 |
| `verify_online_preview.ts` | 新建：验证优先级、偏好映射、错误分类和一次性资源释放 |

## 10. 测试与验收

### 10.1 TDD/服务级检查

先写并执行预期失败的验证：

1. skill 请求配置：
   - 普通自定义 header 出现在 hls.js 请求设置中；
   - `referer` / `origin` / `cookie` / `user-agent` 等受限头不通过 XHR 注入；
   - base URL 从有效 Referer/origin 正确推导；
   - HTML 中没有不必要的敏感 Header 诊断输出；
   - native fallback 明确标记自定义 headers 不保证应用。
2. Yoinks 适配层：
   - 只接受 HTTP/HTTPS preview URL；
   - 格式级 Referer 优先于页面 URL；
   - 页面 URL 优先于源媒体 URL origin；
   - `muted` / `audible` 正确映射；
   - 打开失败与关闭路径只释放一次；
   - 不存在登录重试或下载兜底分支。

### 10.2 自动验证命令

```bash
# Skill
scripting-ts run scripts/verify_request_config.ts
scripting-ts run scripts/index.ts --check

# Yoinks
scripting-ts run verify_online_preview.ts
scripting-ts run verify_shell_quote.ts
scripting-ts run verify_log_tail.ts
scripting-ts run verify_log_redaction.ts
scripting-ts project "Yoinks"
```

具体 `verify_request_config.ts` 位置会以 skill 的实际验证目录为准；实现时保持可通过 `scripting-ts` 独立执行。

### 10.3 真机验收

1. 普通 MP4 临时 URL 可显示并播放。
2. 普通 HLS/m3u8 可显示并播放。
3. 静音自动播放模式可启动，用户可取消静音。
4. 有声自动播放若受系统拦截，播放器仍保留且可手动播放。
5. 需要 Referer 的 HLS 在真实请求上下文下验证。
6. 需要自定义鉴权 Header 的 HLS 走 hls.js 模式验证。
7. 关闭播放器后重复打开，确认无残留音频、黑屏或已释放控制器复用。
8. 使用失效 URL，确认不出现登录页、不进入登录重试、不显示下载兜底。
9. 审查日志，确认签名 URL 查询参数、Header 值和 Cookie 没有泄露。

## 11. 风险与回滚

### 风险

- HLS 自定义 header 支持仅对 hls.js 可控请求可靠；原生 HLS fallback 不保证。
- 一些平台的下载成功不代表浏览器 WebView 可播放，尤其是需要 Cookie、DRM 或严格反盗链的平台。
- skill 的当前实现已经通过 TypeScript 诊断，但本次请求配置变更必须以真机 HLS/MP4 测试为准。

### 回滚

本次删除 Yoinks 内置预览和登录重试前，应在项目备份中保存完整旧实现。若 skill 在真机无法稳定工作，可从备份恢复 `index.tsx` 和 `services/generic-preview-session.ts`，并撤销新增适配层。下载功能不受此迁移影响。
