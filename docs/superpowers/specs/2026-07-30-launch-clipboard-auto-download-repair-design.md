# 启动剪贴板自动下载修复设计

## 背景

当前 `analyzeMedia(url, true)` 已在探测成功后按已保存的统一格式策略启动下载，但应用启动阶段没有读取剪贴板并调用该入口；同时手动“粘贴链接”错误传入 `true`，导致其也可能触发自动下载。

## 已确认行为

- 每次 Yoinks 启动时，仅在下载页首次出现期间检查一次剪贴板。
- 有效的公开 HTTP(S) URL 自动进入媒体分析。
- 仅这条“启动剪贴板”路径可在 `automaticDownloadEnabled` 开启时自动下载。
- 自动下载关闭时，启动剪贴板链接仍自动分析，但保留在格式选择页。
- 手动粘贴、手动输入、历史重分析、Safari 候选导入均只分析，不自动下载。
- 用户清除/关闭当前链接后，会记录该 URL；下次启动遇到同一剪贴板 URL 时跳过一次，防止立即重跑。
- 剪贴板为空、不是 URL 或访问被拒绝时，保持页面初始状态，不弹错误。

## 实现

### 启动检查

在 `index.tsx` 的启动 effect 中，在工具、历史和会话刷新后调用一次异步检查：

1. 使用 `launchClipboardCheckedRef` 确保每次脚本启动仅运行一次。
2. 若用户已抑制启动检查、已有 URL、正在分析、正在下载或批量任务运行，则跳过。
3. 用 `Pasteboard.getString()` 读取文本；自动路径捕获异常并仅记录脱敏事件。
4. 用既有 `extractFirstURL()` 规范化链接；无链接不改变 UI。
5. 使用 `consumeSkippedClipboardURL()` 对比上次关闭/清除所记录的 URL；命中则跳过。
6. 清理 Safari 候选来源状态、设置 URL/状态，调用 `analyzeMedia(valid, true)`。

### 手动入口

`pasteURL()` 改为调用 `analyzeMedia(valid)`，保持手动操作必须由用户明确选择格式和开始下载的行为。

### 日志

补齐不含原始无效剪贴板文本的事件：

- `clipboard-launch.checked`
- `clipboard-launch.empty`
- `clipboard-launch.invalid`
- `clipboard-launch.accepted`（规范化 URL、平台）
- `clipboard-launch.skipped`（原因）
- `clipboard-launch.read-failed`（错误摘要）

既有 `auto-download.selected` 与 `auto-download.skipped` 保持不变。

## 风险与边界

- 只使用项目已有 `Pasteboard.getString()` API，不新增权限或依赖。
- 不读取或存储 Cookie、请求头等敏感数据。
- 启动检查不得与用户主动输入、Safari 导入、下载或批量任务竞争。
- 真机需验证剪贴板访问授权和真实下载；CLI 只能验证逻辑与类型。

## 验证

- 为启动决策抽出纯函数或添加聚焦验证，覆盖：仅一次、空文本、无 URL、跳过记录、活动任务、自动下载开关开/关、手动入口不请求自动下载。
- 运行 TypeScript diagnostics 和现有相关策略验证。
- 真机：冷启动有效剪贴板 + 开关关/开；手动粘贴不自动下载；拒绝剪贴板访问无错误 UI；关闭后同 URL 再启动不重跑。
