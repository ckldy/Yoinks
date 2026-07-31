# 统一媒体候选列表设计

**日期：** 2026-07-30  
**状态：** 已完成并通过真机验收

## 目标

在 Yoinks 的下载页顶部建立独立于下载历史的「最近候选」列表。Safari 主动采集、发现页点击与手动/剪贴板链接都使用统一的 `MediaCandidate` 记录，用户可在 24 小时内跨 App 重启重新选择并分析候选。

## 非目标

- 不改变已有的格式探测、在线预览、下载、登录、保存或下载记录主链。
- 不把候选库作为下载历史、收藏夹或下载队列。
- 不导入、保存或展示 Cookie、Authorization、任意请求头、DRM key 或 license。
- 不自动下载候选。

## 数据模型与存储

新增 `services/media-candidates.ts`，使用独立 Storage 键保存版本化 envelope：

```ts
type MediaCandidateSource = "safari" | "discover" | "manual"
type MediaCandidateKind = "hls" | "dash" | "video" | "audio" | "page"

type MediaCandidate = {
  id: string
  source: MediaCandidateSource
  url: string
  pageURL?: string
  title?: string
  kind?: MediaCandidateKind
  createdAt: number
  expiresAt: number
}
```

- 上限 50 条，TTL 固定 24 小时。
- 每次读写均清除过期和无效条目。
- 使用规范化完整 URL 去重；重复写入会合并非空元数据、刷新时间和过期时间，并置顶。
- 超出 50 条时移除最旧候选。
- URL 必须是 HTTP(S)，删除 fragment，保留 query，以兼容临时签名的公开媒体 URL。
- 缓存候选与 `services/history.ts`、`services/link-history.ts` 完全独立；清空候选不影响下载文件、下载记录或最近成功链接。
- 数据损坏、版本不符或字段非法时安全返回空列表。

## 来源接入

### Safari

用户在 Safari 导入列表中确认一个候选后，先写入 `source: "safari"` 候选，再复用当前 `analyzeMedia()` 和页面优先/直链回退策略。

### 手动和剪贴板

仅当一个有效 URL 被手动确认或启动剪贴板接受时，写入 `source: "manual"` 候选，然后调用既有分析。

### 发现页

用户点击发现页结果的现有分析/下载入口时，先写入 `source: "discover"` 候选，再进入原有流程。发现页本轮若没有统一调用点，先保留服务接口和手动/Safari接入，发现页接入作为同一实现中的受影响调用点补齐。

## 下载页界面

在下载页链接输入区域下方、分析/格式区域前显示「最近候选」分组：

- 仅在列表非空时展示。
- 右上角「清空」按钮，二次确认后仅清空候选库。
- 条目显示来源、候选种类、标题或脱敏域名、剩余有效时间。
- 不展示完整签名 query。
- 点击条目会填充 URL、恢复 Safari 候选的页面 Referer（若有），并调用既有 `analyzeMedia()`；不会自动下载。
- Safari 候选的页面 URL 保留为本次分析/下载 Referer，且不会作为 HTTP 认证上下文存储。

## 可观测性与隐私

- 复用既有 `redactURL` 日志脱敏规则。
- 候选库内容不写入下载历史。
- 可选结构化日志只记录 source、kind、候选数量和脱敏 URL 字段。

## 错误处理

- 读写失败：不阻断当前分析，界面保持可用，并记录脱敏警告日志。
- 过期候选：读取时静默移除，不再可点选。
- Safari 短期签名 URL 失效：继续显示既有探测失败反馈，用户可重新 Safari 采集。

## 验证

新增 `verify_media_candidates.ts`，至少覆盖：

1. 规范化与 HTTP(S) 边界；
2. 过期清理；
3. 去重置顶与元数据更新；
4. 50 条容量淘汰；
5. 损坏数据安全回退；
6. 清空候选不影响独立下载历史存储。

实现后运行：

- `scripting-ts run verify_media_candidates.ts`
- 现有 Safari 与直接媒体回归脚本
- 全项目 TypeScript diagnostics
- `scripting-ts project "Yoinks"`

真机验收：Safari 候选与手动链接可跨 App 重启显示；点选候选可重新分析；清空只影响候选；过期候选自动消失。
