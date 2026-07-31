# Safari 跨 iframe 主动媒体采集设计

**日期：** 2026-07-31  
**状态：** 待用户审阅后实施

## 背景与根因

在 `https://123av.com/en/v/mida-727` 的真机抓包中，顶层页只加载了一个 `javplayer.cc` 跨域 iframe。该 iframe 的 `/stream` JSON 接口返回了公开 HLS 清单，且抓包确认实际访问了该 `.m3u8`。现有 `browser.tsx` 只扫描当前文档的 DOM 与 Resource Timing，因此顶层页得到 0 条候选，无法读取 iframe 内的视频请求。

## 目标

在用户主动触发采集时，允许同一 Safari userscript 的顶层文档与可注入的 iframe 文档协作，将各 frame 中公开可见的 HLS、DASH 或常见媒体直链汇总到既有 Yoinks Safari 候选槽位。

预期本次页面的 iframe 可报告其公开 HLS 候选，Yoinks 随后沿用当前的候选导入、分析、预览与下载流程。

## 非目标与安全边界

- 不启用后台监听、自动采集、全局抓包或自动下载。
- 不读取、复制、保存或注入 Cookie、Authorization、Referer、用户代理、DRM/license 数据。
- 不处理 `blob:`、`data:`、DRM/付费墙/登录受限流。
- 只采集 HTTP(S) URL，继续拒绝 `.ts` 和 `.m4s` 分片。
- 不实现 `javplayer.cc` 或任何单站点的接口解析规则。
- 不递归操纵、读取或直接访问跨域 frame DOM；每个 frame 只读自己的文档内容。

## 方案比较

### A. 跨 frame 协作汇总（采用）

每个已注入的 userscript 实例只扫描自身 document；顶层实例创建一次采集会话，iframe 实例通过共享 GM 存储提交其本地候选；顶层等待一个受限窗口并汇总写入现有候选槽位。

**优点：** 通用，不依赖站点接口；不需要跨域 DOM 权限或认证材料；覆盖此次播放器链路。  
**代价：** 需要定义短期会话和 GM 存储协调，并受 Safari 对 userscript iframe 注入策略限制。

### B. 在顶层特判播放器 JSON 接口

解析当前站点的 `javplayer.cc/stream` 一类接口。

**不采用：** 容易扩展为站点特例，维护成本和范围均不符合需求。

### C. 改用网络层抓包

把 VPN/MITM 抓包能力接入插件。

**不采用：** 权限与隐私边界过大，且会涉及请求头、认证信息和后台网络观察，不符合本特性约束。

## 设计

### 1. 主动会话

- 仅点击 Safari 浮动按钮或扩展菜单后，由顶层文档创建一个新的随机会话标识。
- 会话包含创建时间、顶层页面 URL 的无 fragment 形式和有限有效期。
- 顶层在短暂汇总窗口内等待；窗口结束后只汇总属于该会话的 frame 报告。
- 新一次主动采集覆盖旧一次会话和候选，避免陈旧 iframe 结果混入。

### 2. Frame 本地扫描与报告

- userscript 保持 `@match http://*/*` 与 `@match https://*/*`；若 Safari 允许该脚本在 frame 注入，则 frame 仅执行现有的本地 DOM、metadata 和 Resource Timing 扫描。
- frame 不创建页面浮动按钮、不注册对用户可见的菜单入口，也不直接写主候选结果。
- frame 发现顶层创建的有效会话后，在有限等待内提交：frame 自己的规范化候选、frame URL（仅用于候选 `pageURL` / Referer 语义）和非敏感计数摘要。
- 仅使用现有 URL 分类：HLS、DASH、常见视频/音频直链及既有保守 inferred 规则。

### 3. 顶层汇总与兼容

- 顶层也扫描自己的文档，将自己的候选和 frame 报告按完整 URL 去重。
- 继续使用当前优先级：HLS master/playlist 优先，其次其它 HLS、DASH、视频、音频、inferred。
- 最多保留 50 条；写入结构仍兼容 `yoinks-media-candidates-v1`，因此 App 侧导入 UI 不需要破坏性迁移。
- 候选来自 iframe 时，`pageURL` 设为该 frame URL，使后续分析能保留正确页面来源；顶层标题仍可作为用户展示标题的回退。

### 4. 诊断与错误反馈

- `yoinks-media-candidates-diagnostic-v1` 扩展为非敏感摘要：顶层候选数、已报告 frame 数、frame 候选总数、会话阶段、等待时长，以及按类别的失败原因。
- 不保存候选 URL、Cookie、请求头、响应正文或 iframe 域名列表到诊断槽位。
- 顶层写入成功后保留 `GM.log`；发生会话/写入异常时将错误类别写入诊断，并在浮动按钮显示“采集失败”。
- Yoinks App 导入空候选时，应把允许字段的诊断摘要写入既有运行日志，便于从 App 日志判断“顶层为空、无 frame 报告”与“frame 有报告但无候选”的区别；日志继续走既有脱敏层。

### 5. 失败与降级

- 如果 Safari 不在 iframe 中注入 userscript，则顶层仍按当前逻辑采集，不影响已支持站点。
- 如果 frame 比顶层晚加载或未在窗口内上报，该 frame 不进入本次结果；用户可在播放/加载稳定后重新主动采集。
- 任何 GM 存储读写失败只使该次采集失败，不应修改 Yoinks 下载历史或自动触发下载。

## 实施范围

- `browser.tsx`：会话协调、顶层/iframe 角色区分、frame 报告汇总、诊断字段和版本号。
- `services/safari-media-candidates.ts`：兼容读取扩展诊断，并为 App 空导入事件提供安全日志摘要。
- `index.tsx`：仅在现有 Safari 导入为空路径记录安全诊断事件。
- `verify_safari_media_candidates.ts`：新增跨 frame 会话、去重、上限、陈旧会话忽略、无 frame 降级与诊断脱敏检查。

## 验收与验证

### 静态检查

1. 构造顶层 0 条、iframe 1 条 `.m3u8` 的报告，汇总结果必须为 1 条 HLS 候选。
2. 相同 URL 在多个 frame 或顶层重复时，结果仅保留一条。
3. `.ts`、`.m4s`、`blob:`、`data:`、无效会话和过期报告必须被拒绝。
4. 候选总数最多 50 条，排序保持既有 HLS master 优先规则。
5. 诊断与 App 运行日志不得包含查询参数、Cookie、Authorization 或媒体 URL。
6. 全项目 TypeScript diagnostics 为 0，原 Safari 候选和日志脱敏验证继续通过。

### 真机检查

1. 打开本次 123av 页面，等待播放器加载或播放后点击浮动采集按钮。
2. 预期 Safari 提示至少捕获 1 条候选；Yoinks 导入后能进入分析。
3. 检查 Safari 诊断：有 frame 报告和非零 frame 候选计数；检查 Yoinks 运行日志仅有脱敏摘要。
4. 在已支持的顶层直链/HLS 页面重复采集，确认没有回归。
5. 若 Safari 未向 iframe 注入脚本，记录限制与实际诊断，不把静态检查误报为真机闭环。
