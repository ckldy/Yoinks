---
title: B站单视频发现 412 移动页回退设计
date: 2026-07-31
status: 已完成（静态、网络与真机验收通过）
---

# 目标

当 B 站桌面单视频页面在公开匿名发现中返回 HTTP 412 时，自动且仅一次改用同 BV/AV 的 `m.bilibili.com` 页面重新调用现有 yt-dlp 发现流程。

# 范围

1. 仅作用于 `playlist`/`author` 入口中的 B 站**单视频**页面。
2. 仅当原地址是桌面 B 站视频 URL，且第一次 `discoverPlaylist` 错误文本匹配 HTTP 412 时触发。
3. 仅将 host 从 `www.bilibili.com`/`bilibili.com` 替换为 `m.bilibili.com`，保留 pathname 和 query；不改变 b23 短链先解析的现有逻辑。
4. 回退继续使用现有 `insecure`、非 flat 单视频发现、超时和重试设置；不注入 Cookie、不伪造 Authorization、不增加全局请求头。
5. 成功写入专用 info 日志；回退失败时保留原 412 与回退错误，便于诊断。
6. 修正 CDN 回归测试：普通 `mirror` host 可改写至 HW mirror；mcdn edge URL 与 COS 签名 URL 必须原样保留（含非标准端口和 query），避免签名失效 403。

# 非目标

- 不对作者主页/WBI API 添加移动页回退。
- 不将所有 B 站桌面链接预先改写为 m 站。
- 不将 412 视作登录问题或加入 Cookie 流程。
- 不改动媒体 CDN 实际播放/下载策略。

# 验证

- 纯函数测试：识别桌面单视频、构造 m 站 URL、只对 412 判定回退。
- CDN 测试覆盖 mirror 改写、mcdn/COS 保持原样。
- 运行既有 `verify_discover_bili_behavior.ts`；该网络验证若受 B站瞬态风控影响，报告实际结果，不将其等同于静态回归失败。
- 全项目 TypeScript diagnostics 和 `scripting-ts project "Yoinks" --check`。
- 真机：在桌面单视频触发 412 的网络环境，发现页应自动回退并列出条目；正常桌面请求不应额外请求 m 站。
