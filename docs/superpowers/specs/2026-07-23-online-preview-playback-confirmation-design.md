# 在线预览播放确认与失败反馈设计

## 目标

修复 Yoinks 在线预览打开后黑屏或无限“加载中”的问题。系统 WebView 已呈现不再被当作播放成功；必须由媒体元素确认实际进入可播放状态。

## 范围

- 保留系统 `<video controls>`，不改造控制层。
- WebView 通过脚本消息回传 `ready`、`playing` 和 `error`。
- 在线预览服务订阅事件：首次 `playing` 后记录 `preview.playing`；致命错误或 12 秒内未播放则记录 `preview.failed`。
- 超时或致命失败时更新播放器内的错误提示，销毁播放器并让调用方弹出失败提示。
- 修复验证脚本退出，增加静态契约和纯逻辑的超时/失败检查。

## 非目标

- 不尝试让原生 `<video>` 直链携带任意 HTTP 请求头；WebKit 平台不支持该能力。
- 不更换 hls.js CDN，不改变下载、登录、格式探测或 UI 布局。
- 不对真实远程媒体做宿主自动测试；该部分需真机验证。

## 数据流

1. `play(url)` 在 WebView 中重置加载状态并启动直链或 HLS。
2. `loadedmetadata` / `MANIFEST_PARSED` 触发浏览器播放请求；`canplay` 和 `playing` 通过 message handler 上报。
3. `openOnlinePreview()` 注册播放器事件，并在呈现后等待首次 `playing`（12 秒）。
4. 若收到致命 `error` 或超时，显示明确错误、写脱敏结构化日志、释放播放器并返回失败。
5. 若开始播放，写 `preview.playing`，返回持有的播放器实例，交由现有页面生命周期释放。

## 错误处理与日志

- 自动播放被浏览器拒绝只显示提示，不立即视为媒体加载失败；用户可通过系统控件手动播放。
- 真实 video/HLS 致命错误、evaluate/present 失败、12 秒未播放会记录 `preview.failed`。
- 日志不写媒体 URL 或请求头，只记录标题、请求模式、是否应用可用 headers、错误文本和超时原因。

## 验证

- TypeScript 全项目诊断。
- `verify_online_preview.ts`：字段/URL 校验、事件名称与超时常量的静态契约，且通过 `Script.exit` 正常结束。
- `scripting-ts project "Yoinks" --check` 与启动回归。
- 真机：一个普通 MP4 和一个 HLS 链接均能显示系统控件并开始播放；不可播放链接在 12 秒内显示错误而非无限加载；检查日志有 `preview.playing` 或 `preview.failed`。
