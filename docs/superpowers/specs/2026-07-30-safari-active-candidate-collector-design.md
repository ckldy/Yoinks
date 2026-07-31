# Safari 主动媒体候选采集器：恢复与扩展设计

**日期：** 2026-07-30  
**范围：** Yoinks 的 Safari 用户主动媒体候选采集。

## 目标

恢复项目内可维护的 Safari userscript 源文件，并扩展用户主动触发时的公开媒体候选发现。Safari 候选继续通过既有 GM 存储槽位传给 Yoinks，由用户选择并确认后复用 `analyzeMedia()`；该入口不触发启动剪贴板自动下载。

## 范围

### 恢复的项目资产

- 根目录 `browser.tsx`：带 userscript metadata 的 Safari 采集器。
- `verify_safari_media_candidates.ts`：纯逻辑回归验证。

### 用户主动候选来源

菜单命令触发时采集：

1. `video[src]`、`audio[src]`、`source[src]` 及其 `srcset`。
2. `link[rel=preload][as=video|audio]`。
3. `og:video`、`og:video:url`、`twitter:player:stream` 元数据。
4. `performance.getEntriesByType("resource")` 的当下资源快照。

候选只接受 HTTP(S) 的 HLS、DASH、常见视频/音频资源。无显式媒体扩展名但 query 包含 `manifest`、`playlist`、`m3u8` 或 `mpd` 的性能资源，会标记为低优先级推断候选。

## 数据与边界

- 写入既有 `yoinks-media-candidates-v1` GM 槽位，覆盖旧的采集快照。
- 写入字段仅为 URL、页面 URL、标题、候选类型、采集时间和来源标签。
- URL 保留 query、移除 fragment；签名 URL 的 query 由现有 App 端日志/历史脱敏机制处理。
- 拒绝 `blob:`、`data:`、`file:`、`javascript:` 和无效 URL。
- 不将 `.ts`、`.m4s`、密钥或许可证端点作为候选。
- 完整 URL 去重、上限 50。
- 排序：master/playlist HLS、其他 HLS、DASH、直链视频、音频、推断候选。

本实现不包含从 Safari 读取或持久化 Cookie、Authorization、Bearer token、任意认证头、DRM key 或 license 内容的功能。受保护媒体可由既有 Yoinks 用户主动登录与 cookies.txt 导入机制处理；DRM 仅允许只读诊断。

## 交互

用户在 Safari 扩展菜单选择“导入本页媒体候选到 Yoinks”，或点击页面右下角的 Yoinks 浮动入口。脚本读取当前页面的公开 DOM、元数据和资源时序快照，写入候选包，并在浮动入口旁短暂显示候选数量。Safari 的 GM 设置 `yoinks-floating-entry-always-visible-v1` 默认开启；菜单命令可切换该设置。开启时浮动入口始终显示；关闭时，长按约 0.7 秒可只隐藏当前文档的入口，刷新或重新打开页面后恢复。Yoinks 下载页点击“从 Safari 导入媒体候选”，选择一个候选并二次确认，之后仅分析；用户再选择格式并下载。

## 验证

`verify_safari_media_candidates.ts` 覆盖：

- HTTP(S) allowlist 和危险协议拒绝；
- HLS/DASH/视频/音频/推断候选分类；
- fragment 移除、query 保留；
- 去重与 50 条上限；
- master HLS 优先、分片排除、推断候选后置；
- envelope 字段不含 Cookie、Authorization、headers、DRM/key/license。

完成后执行 TypeScript diagnostics、验证脚本和项目启动回归；Safari 真机复测用户主动采集、候选排序、导入后仅分析以及已存在的 Referer/UA 下载闭环。
