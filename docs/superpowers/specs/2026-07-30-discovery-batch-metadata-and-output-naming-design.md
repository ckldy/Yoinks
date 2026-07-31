# 发现批量元数据复用与统一输出命名设计

**日期：** 2026-07-30  
**状态：** 已完成并通过真机验收

## 目标

1. 发现页已经解析出的媒体条目加入批量队列后，批量任务必须复用该条目的解析元数据，而不是无条件退化为只拿页面 URL 再次探测。
2. 所有下载结果按可读标题命名，优先媒体探测标题，依次回退到发现页条目标题、页面标题和安全兜底名。
3. 同名文件绝不覆盖，依序使用 ` (1)`、` (2)` 后缀。

## 批量队列数据

扩展批量条目以保存最小发现元数据：

```ts
type BatchItem = {
  // existing fields
  sourceTitle?: string
  sourceKind?: "discover" | "manual"
  // future-compatible, only when discovery has verified reusable media metadata
  resolved?: {
    url: string
    title?: string
    // no cookies, authorization, arbitrary headers, DRM/key/license
  }
}
```

发现页回调不得只传 URL 数组。应传递 `{ url, title }` 条目；成功入队的条目保留发现标题。

批量执行规则：

1. 如果队列条目已有可用 `resolved` 媒体数据，优先复用它进入既有格式选择/下载流程。
2. 如果仅有页面 URL，走现有 `probeMedia()`；探测成功后保存本次 probe 的 `title` 供后续下载命名。
3. 若页面 URL 重新探测失败，保留发现条目的标题和失败详情；不得将“发现阶段已成功列出条目”误判为无效链接。
4. 本轮不从 Safari、Cookie 或网络抓包向发现队列复制认证上下文。

## 输出命名

为所有最终发布文件统一使用：

```text
probe.title
→ batch/source title
→ page title
→ current safe fallback
```

文件名规则：

- 规范化控制字符及 `/ : * ? " < > |`；合并连续空白；去除首尾点和空格；限制合理长度。
- 保留经验证的媒体扩展名，如 `.mp4`、`.mkv`、`.mp3`。
- 目标目录已有同名文件时自动递增：`标题.mp4`、`标题 (1).mp4`、`标题 (2).mp4`。
- 不覆盖现有文件。
- 命名同时适用于直链、HLS、yt-dlp 单流、音视频合并、音频转换和批量任务。
- 发布后的文件名用于下载记录、相册保存和文件导出。

## 不变边界

- 不更改用户已选格式、下载策略、登录流程、Safari 引用页 Referer 语义或媒体校验。
- 不保存 Cookie、Authorization、任意请求头、DRM/key/license。
- 不删除已有下载文件或历史记录。

## 验证

新增或扩展服务级回归，覆盖：

1. 发现条目标题从 DiscoverTab 到 BatchItem 的传递；
2. 批量探测使用条目 URL，并将探测 title 传给下载命名；
3. 探测 title、发现标题、兜底名的优先级；
4. 非法文件名清理；
5. 相同扩展名的 ` (1)`、` (2)` 无覆盖递增；
6. 直接 MP4、HLS 和批量下载使用最终可读文件名。

完成后运行现有候选、Safari、直接媒体及项目启动回归，并做真机发现页→批量下载→相册命名验收。
