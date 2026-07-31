# Safari 公开播放器链路解析设计

**日期：** 2026-07-31  
**状态：** 用户已确认设计边界，待实施

## 问题证据

目标页面顶层 Safari 用户脚本已运行并识别到一个跨域 iframe，但 Safari 未将脚本注入 iframe，故 `frameReportCount` 始终为 0。抓包同时确认 iframe 内公开 `/stream` JSON 返回 HLS 地址，且随后实际请求该清单。跨 frame 协作无法在此平台能力下成立。

## 目标

在用户主动 Safari 采集后，顶层脚本保存最多一个公开 iframe URL；若没有顶层媒体候选，Yoinks App 匿名、受限地解析这个公开播放器链路，找出公开 HLS/DASH/常见媒体直链并复用既有 Safari 候选导入与分析流程。

## 安全边界

- 仅用户主动执行 Safari 采集并在 Yoinks 导入时触发；无后台扫描、无自动下载。
- Safari 仅读取顶层 DOM 的 iframe `src`，不读取跨域 iframe DOM。
- 最多保留一个 HTTP(S) iframe URL；不保存 Cookie、Authorization、请求头、DRM/license 或响应正文。
- App 匿名读取 iframe HTML，并最多读取一个同源外部 JavaScript 模块；总预算 12 秒、1.5 MB。
- 不携带 Cookie、Authorization、浏览器 Referer 或用户代理；不绕过 Cloudflare、登录、地区、付费或 DRM 限制。
- 只从静态公开文本或 JSON 中接受字段名 `stream`、`url`、`src`、`file` 所对应的 HTTP(S) `.m3u8`、`.mpd` 或既有常见媒体直链；拒绝 `blob:`、`data:`、`.ts`、`.m4s`。
- 不按域名写特例；任何公开 JSON 接口均须从 iframe HTML 或其同源脚本文本中显式发现。

## 数据流

1. 顶层 `browser.tsx` 主动扫描时，除现有候选外，收集第一个规范化 HTTP(S) iframe `src` 并写入候选 envelope 的可选 `playerFrameURL`。
2. Yoinks 导入读取候选：若普通媒体候选为空但 `playerFrameURL` 存在，显示“正在解析公开播放器链路”。
3. 新的服务读取 iframe HTML，提取静态媒体 URL、同源 script URL 和文本中可见的同源 JSON 端点线索。
4. 只读取一个同源 script；从 HTML/脚本文本发现公开 JSON URL 后读取该 JSON，递归提取允许字段值中的媒体 URL。
5. 将发现地址构造为现有 Safari 候选：其 `pageURL` 为 iframe URL，便于后续媒体探测采用正确公开页面来源。
6. 若仍无候选，保留现有空状态；运行日志只记录阶段和数量，不写 URL 或 query。

## 降级

- 无 iframe、iframe 不可读、超时、挑战页、非 JSON 响应或无媒体字段：安全失败，不尝试认证或更多网络请求。
- 原有顶层 DOM/Resource Timing 候选路径保持优先，不受影响。
- 跨 frame GM 会话逻辑可保留为对将来支持 iframe 注入的平台的降级补充，但不作为本链路成功前提。

## 验收

1. 模拟顶部无候选、一个 iframe、HTML/同源脚本中发现 JSON endpoint、JSON `{media:{stream:"...m3u8"}}` 时，输出一条 HLS 候选。
2. 证明只有允许字段名和允许 URL 类型会被导入；敏感字段、分片、非 HTTP(S) URL 均拒绝。
3. 验证最多一个 iframe、一个同源脚本、总大小/超时预算；跨域脚本不得读取。
4. `verify_safari_media_candidates`、新增公开播放器链路验证、日志脱敏、全项目 TypeScript 检查通过。
5. 真机在目标页面点击采集后，Yoinks 导入应得到 HLS 候选；若匿名读取被挑战页拒绝，日志应仅显示脱敏阶段/数量。
