# 通用免播放取链探测框架设计（方案 B）

**日期**: 2026-08-20  
**状态**: 已确认，待实施  
**影响范围**: App 侧 (`services/media.ts`) + 插件侧 (`browser.tsx.src`)

---

## 一、目标

统一 "无需真实播放取链" 的核心能力，将分散在各处的主动探测逻辑收编进注册表驱动的分发器，实现：

1. **App 侧**: `probeMediaCore` 从 ~3000 行瘦身，新增站点只需注册策略
2. **插件侧**: `collectCandidates()` 结构化，新增提取器只需注册策略
3. **代码复用**: 公共工具库（URL 解析、HTML 解混淆、Referer 增强 fetch）在两端共享

---

## 二、现状梳理

### App 侧 (`services/media.ts`)

当前 `probeMediaCore` 里的硬编码 if 链：

```typescript
// probeMediaCore (media.ts)
if (detectMediaPlatform(sourceURL) === "douyin") return probeDouyinDirect(...)
if (detectMediaPlatform(probeURL) === "bilibili") {
  const bilibiliProbe = await probeBilibiliDirect(probeURL)
  if (bilibiliProbe) return bilibiliProbe
}
if (detectMediaPlatform(probeURL) === "youtube") {
  const youtubeProbe = await probeYouTubeDirect(probeURL)
  if (youtubeProbe && youtubeProbe.choices.length) return youtubeProbe
}
if (isStreamTapePageURL(probeURL)) {
  const streamTapeProbe = await probeStreamTapeDirect(probeURL)
  if (streamTapeProbe) return streamTapeProbe
}
if (/\.m3u8/i.test(sourceURL)) { /* HLS 快路径 */ }
if (referer && isTrailingSlashDirectMediaURL(sourceURL)) { /* redirect 快路径 */ }
/* yt-dlp 主链兜底 */
const tryPublicPlayerFallback = async () => {
  if (options.skipPublicPlayerFallback) return null
  return probePublicPlayerSource(sourceURL, taskId, deadline)
}
```

**问题**: 每加一个新站点就要加一段 if + logEvent + early return，函数越滚越长。

### 插件侧 (`browser.tsx.src`)

当前 `collectCandidates()` 里所有 `xxxMediaURLs()` 都是独立函数：

```typescript
async function collectCandidates(): Promise<Candidate[]> {
  const pending: Array<{ value: string; source: string }> = []
  
  // DOM 扫描
  document.querySelectorAll("video, audio").forEach(...)
  document.querySelectorAll("video source, audio source").forEach(...)
  
  // 播放器配置
  if (document.querySelector("video, audio, .fp-player, ...")) {
    for (const value of playerScriptSourceURLs()) pending.push(...)
  }
  for (const value of maccmsPlayerConfigURLs()) pending.push(...)
  for (const value of sameOriginFrameScriptSourceURLs()) pending.push(...)
  for (const value of sameOriginFrameMediaURLs()) pending.push(...)
  for (const value of iframeQueryMediaURLs()) pending.push(...)
  for (const value of vueComponentMediaURLs()) pending.push(...)
  
  // 端点 fetch
  const endpointResults = await Promise.all(playerMediaEndpointURLs().map(...))
  
  // supjav 专用
  for (const value of await resolveSupjavServerLinks()) pending.push(...)
  
  // performance/metadata 等...
  
  return sortCandidates(candidates)
}
```

**问题**: 每个函数独立运行，没有统一的超时控制/错误处理/日志标记来源。

---

## 三、架构设计

### 3.1 分层结构

```
┌──────────────────────────────────────────────────────────────┐
│  公共工具库 (shared-utils)                                    │
│  ├── URL 解析/归一化 (normalizeURL, classify)                  │
│  ├── DOM 提取基类 (extractFromScript, extractFromIframe...)   │
│  ├── HTML 解混淆 (botlink 还原、JS 片段拼接)                   │
│  └── Referer 增强 fetch (GM.xmlHttpRequest + AbortController)│
└───────────────────────┬──────────────────────────────────────┘
                        ▼
        ┌─────────────────────────────┐     ┌─────────────────────────────┐
        │ App 侧: services/player-probe.ts │     │ 插件侧: browser-player-probe.ts │
        │                             │     │                             │
        │ probePlayerDirect(url,ctx)  │     │ collectViaStrategies()      │
        │  └─ 按注册表顺序试           │     │  └─ 按注册表顺序试          │
        │    test → probe             │     │    test → extract           │
        │                             │     │                             │
        │ 策略注册表 (静态数组)         │     │ 策略注册表 (静态数组)       │
        │  - bilibili-native           │     │  - maccms-config            │
        │  - youtube-native            │     │  - vue-component            │
        │  - streamtape-native         │     │  - same-origin-frame        │
        │  - hls-fast-path             │     │  - iframe-query             │
        │  - public-player-fallback    │     │  - player-endpoint          │
        │  - redirect-fast-path        │     │  - supjav-server-links      │
        └─────────────────────┬─────────┘     └─────────────────────┬─────┘
                              │                                     │
                              ▼                                     ▼
        ┌─────────────────────────────────────┐   ┌─────────────────────────────────────┐
        │ App 最终产出：MediaProbe              │   │ 插件最终产出：Candidate[]           │
        │  { title, webpageURL, choices }       │   │  [{ url, kind, source, pageURL }]   │
        └─────────────────────────────────────┘   └─────────────────────────────────────┘
```

### 3.2 核心类型定义

#### App 侧 (`services/player-probe.ts`)

```typescript
export type PlayerProbeContext = {
  taskId: string
  referer?: string
  userAgent?: string
  deadline?: number
  logEvent: (event: string, details: Record<string, unknown>) => Promise<void>
}

export type PlayerProbeStrategy = {
  name: string                                        // 日志 origin，如 "bilibili-native"
  test: (url: string, ctx: PlayerProbeContext) => boolean
  probe: (url: string, ctx: PlayerProbeContext) => Promise<MediaProbe | null>
}

/** 统一调度器：按注册表顺序试，首个非 null 返回 */
export async function probePlayerDirect(
  url: string,
  ctx: PlayerProbeContext
): Promise<MediaProbe | null>
```

#### 插件侧 (`browser-player-probe.ts`)

```typescript
export type PlayerExtractionStrategy = {
  name: string                                        // 日志来源，如 "maccms-config"
  test: () => boolean                                 // 页面级检测
  extract: () => Promise<string[]> | string[]        // 返回候选 URL 列表
}

/** 统一采集器：按注册表顺序试 */
export async function collectViaStrategies(): Promise<Array<{ value: string; source: string }>>
```

---

## 四、策略映射

### 4.1 App 侧策略注册表

| 策略名 | name | test | probe（包裹现有函数） |
|---|---|---|---|
| bilibili | `bilibili-native` | `isBilibiliHost` | 内部先做短链解析+normalize，再 `probeBilibiliDirect` |
| youtube | `youtube-native` | `detectMediaPlatform==="youtube"` | 内部含 itag 排序 + url-check，再 `probeYouTubeDirect` |
| streamtape | `streamtape-native` | `isStreamTapePageURL` | `probeStreamTapeDirect` |
| hls | `hls-native` | `\.m3u8` | sniff → `hlsEndpointChoices` |
| redirect | `direct-redirect` | referer + 尾部斜杠 | `resolveRedirectedDirectMedia` |
| public-player | `public-player` | `() => true`（兜底） | `probePublicPlayerSource` |

**执行顺序**: 专用站点在前（命中快、结果准），格式级居中，通用兜底最后。

### 4.2 插件侧策略注册表

| 策略名 | name | test | extract（引用现有函数） |
|---|---|---|---|
| maccms-config | `maccms-config` | `/player_|macplayer/i` | `maccmsPlayerConfigURLs` |
| vue-component | `vue-component` | `#app.__vue__` | `vueComponentMediaURLs` |
| same-origin-frame | `same-origin-frame` | `iframe.length > 0` | `sameOriginFrameMediaURLs` |
| iframe-query | `iframe-query` | `() => true`（轻量） | `iframeQueryMediaURLs` |
| player-endpoint | `player-endpoint` | `/\/media\/hls\?s=/i` | `playerMediaEndpointURLs` |
| supjav-server-links | `supjav-server-links` | `/supjav\.com/i` | `resolveSupjavServerLinks` |

**执行顺序**: 轻量 DOM 扫描在前，重网络在后。

---

## 五、边界与约束

### 5.1 不改动部分

- ❌ **Douyin WebView 链**: 保留 `probeMediaCore` 开头特判（依赖 WebView 会话）
- ❌ **yt-dlp 主链**: 全部策略落空后仍走现有 yt-dlp 流程（重试 + SSL 降级）
- ❌ **DOM 扫描兜底**: 插件侧 `collectCandidates()` 的 `<video>` 原生元素扫描保留
- ❌ **运行时监听**: 插件侧 `installRuntimeProxies()` + frame report 链路保留

### 5.2 环境差异

| 能力 | App 侧 | 插件侧 |
|---|---|---|
| 网络请求 | `fetch` + `AbortController` | `GM.xmlHttpRequest` 优先 + `fetch` 兜底 |
| 日志系统 | `logEvent` (structured JSONL) | `console.warn` / GM.log |
| 类型输出 | `MediaProbe` | `Candidate[]` |
| 超时控制 | `deadline` (全局 45s) | 单策略 2s，总采集 8s |

### 5.3 代码复用方式

- ✅ **纯函数工具**: URL 解析、正则匹配、字符串处理、HTML 解混淆逻辑 → 手动复制两份
- ❌ **不可共享**: 网络请求实现、类型定义、日志接口 → 各自独立

---

## 六、实施计划

### Phase 1: 公共工具库 (预计 2h)

1. **App 侧**: `services/shared-utils.ts`
   - `normalizeURL(value, baseURL?)`
   - `classify(url)` (复用 media.ts 的 classify)
   - `extractBotlinkToken(html)` (StreamTape botlink 解混淆)
   - `enhancedFetch(url, options)` (Referer + UA + timeout)

2. **插件侧**: `browser-shared-utils.ts`
   - 最小集：URL 归一化、分类、botlink 解混淆
   - GM.xmlHttpRequest 封装

### Phase 2: 重构插件侧 (预计 3h)

1. 新建 `browser-player-probe.ts`
2. 迁移现有 `xxxMediaURLs` 函数到策略注册表
3. 替换 `browser.tsx.src` 中的 `collectCandidates()` 调用
4. TS 诊断无新增错误

### Phase 3: 重构 App 侧 (预计 4h)

1. 新建 `services/player-probe.ts`
2. 将 `probeMediaCore` 里的 if 链收编进注册表
3. 保持 yt-dlp 兜底不变
4. TS 诊断无新增错误

### Phase 4: 验证与测试 (预计 2h)

1. TypeScript 诊断全过
2. 启动回归通过 (`scripting-ts project "YoinksRemote"`)
3. 真机验证（B 站/YouTube/streamtape/supjav）

**总计**: ~11h

---

## 七、验收标准

### 7.1 功能验收

- [ ] B 站 b23 短链 → 原生 API 直链（无 yt-dlp）
- [ ] YouTube → IOS innertube 签名直链（无 yt-dlp）
- [ ] StreamTape → botlink 解混淆 → tapecontent 直链
- [ ] supjav → ST/FST 解析 → upstream 页
- [ ] HLS 直链 → 秒级变体解析（<3s）
- [ ] 插件侧 MacCMS/Vue/iframe 提取成功率 ≥ 现有水平

### 7.2 性能验收

- [ ] 新增站点探测耗时 ≤ 现有水平
- [ ] 插件侧总采集时间 ≤ 8s（95% 分位）
- [ ] App 侧 probe 超时预算不变（45s）

### 7.3 代码质量

- [ ] TypeScript 诊断无新增错误
- [ ] 启动回归通过
- [ ] 无新增外部依赖
- [ ] 代码行数净减少（~3000 行 → ~2500 行）

---

## 八、风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| 策略 test/probe 编写 bug | 中 | 低 | 每个策略写独立 verify 脚本（assert 自检） |
| 公共工具库复制不一致 | 高 | 中 | 用 diff 对比两端文件，确保逻辑一致 |
| 插件侧 GM.xmlHttpRequest 兼容性问题 | 低 | 高 | fallback 到 fetch，保基本功能 |
| 真机环境特殊站点漏网 | 中 | 中 | 保留 yt-dlp 兜底，覆盖长尾 |

---

## 九、后续扩展

- **远程解析集成**: 未来可把 `remote-resolver` 也收编进注册表
- **站点专属插件**: 允许用户自定义策略（JSON config）
- **性能监控**: 记录每个策略的命中次数/耗时，指导优化优先级

---

**批准人**: 用户确认  
**下次行动**: Phase 1 实施（公共工具库）