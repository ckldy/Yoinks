# Safari 1.5 秒延迟媒体采集设计

## 目标

降低 Safari 页面播放器异步写入媒体地址时，Yoinks 用户脚本过早扫描导致遗漏候选的概率，同时不改变浮动入口的长按隐藏交互。

## 范围

- 短按浮动入口后，先等待 1.5 秒，再执行现有候选扫描和 GM Storage 写入。
- Safari 菜单“导入本页媒体候选到 Yoinks”使用同一延迟采集流程。
- 长按隐藏入口维持现有语义：一旦触发长按，不能写入候选。
- 延迟期间入口保持禁用，提示“正在等待媒体地址…”。

## 非目标与安全边界

- 不调用 `play()`、不修改媒体元素、也不尝试模拟播放。
- 不读取、导出、保存或转移 Cookie、Authorization、Cloudflare 挑战数据、AES 密钥或其他认证材料。
- 不改变候选分类、排序、URL 清洗和存储格式。
- 不保证解决 Python/yt-dlp 与 CDN 的 TLS/连接指纹差异；它只处理页面异步初始化造成的过早扫描。

## 实现

仅修改 `browser.tsx`：

1. 增加 `CAPTURE_DELAY_MS = 1500` 常量与可测试的 `waitForCaptureDelay()` Promise helper。
2. 增加 `captureAfterDelay()`，先等待 1.5 秒，再调用现有 `captureCurrentPage()`。
3. 短按事件和菜单命令改用该 helper；短按在等待时显示反馈并禁用入口。
4. 长按检测与隐藏代码保持原样，且点击事件在 `longPressTriggered` 为真时立即返回，因此不会进入延迟采集。

## 验证

- 新增小型静态验证脚本，检查 1.5 秒常量、延迟 helper、浮动短按和菜单入口都使用延迟采集，并保留长按取消守卫。
- 全项目 TypeScript diagnostics。
- `scripting-ts project "Yoinks" --check`。
- Safari 候选安全验证回归。
- 真机：未播放页面短按浮动入口，确认约 1.5 秒后提示候选数量；长按仍隐藏入口；菜单入口同样延迟采集。
