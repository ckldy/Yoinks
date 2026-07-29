# Yoinks 发现页设计 —— 从视频链接自主探测相关视频

**Date:** 2026-07-27  
**Status:** P0 implemented; TypeScript + launch regression passed; device QA pending for playlist/author discovery  
**Baseline:** Yoinks 1.4.x（已具备批量下载队列）  
**Purpose:** 研究学习。仅用于本地验证媒体下载/发现链路，不传播、不商业。

## 1. Goal

在现有「记录 / 下载 / 设置」三标签之外新增 **「发现」** 页，让用户输入一个种子链接（或关键词）后，自动探测更多相关视频，并以列表形式供用户勾选、确认，再批量加入下载队列。

发现页本身**不执行下载**，只产生候选 URL；真正的下载仍复用现有批量队列与 `downloadMedia`。

## 2. Scope

### Included (v1)

- 新增第 4 个 Tab：`记录 | 发现 | 下载 | 设置`
- 发现类型：
  - **播放列表 / 合集 / 频道（A）** —— 稳定功能
  - **同一作者全部视频（D）** —— 与 A 合并实现（作者主页即 playlist）
  - **关键词搜索（C）** —— 实验功能，默认隐藏
  - **视频页相关推荐（B）** —— 实验功能，默认隐藏
- 发现结果列表：标题、作者、时长、复选框
- 用户确认后批量加入下载页队列
- 设置页增加「实验性发现功能」开关

### Excluded (v1)

- 自动下载（必须用户手动点开始批量下载）
- 发现历史持久化
- 缩略图预加载（减少网络/失败）
- 后台发现
- 多站点同时发现

## 3. Research-use constraints

- 仅访问公开页面，不自动登录。
- 不主动绕过付费 / DRM；如研究需要验证特定能力，可在受控、非传播前提下进行手动测试并记录验证目的。
- 发现结果不保存、不分享、不自动下载。
- 单次发现上限 50 条，批量队列上限仍保持 30 条。
- 日志中对 URL 脱敏。

## 4. Module split

| 文件 | 职责 |
|---|---|
| `services/discovery.ts` | 类型定义 + `discover()` 统一入口 + 引擎分发 |
| `services/discovery-engines/playlist.ts` | A/D：yt-dlp `--flat-playlist` 展开 playlist/channel/author |
| `services/discovery-engines/search.ts` | C：yt-dlp search extractor（实验） |
| `services/discovery-engines/related.ts` | B：WebView 抓取相关推荐（实验，v1 可留壳） |
| `components/DiscoverTab.tsx` | 发现页 UI |
| `ytdlp_discover.py` | Python 侧统一输出发现结果 JSON |

`services/batch-queue.ts` 与 `services/media.ts` 核心逻辑不变；发现页只负责产生 URL 列表，然后调用 `enqueueURLs`。

## 5. Data types

```ts
type DiscoveryKind = "playlist" | "author" | "search" | "related"

type DiscoveryItem = {
  id: string
  url: string
  title: string
  uploader?: string
  duration?: number
  thumbnail?: string
  index: number
}

type DiscoveryResult = {
  kind: DiscoveryKind
  sourceURL: string
  query?: string
  items: DiscoveryItem[]
  totalAvailable?: number
}
```

## 6. Discovery engines

### 6.1 Playlist / Author（A/D，稳定）

- 输入：种子 URL（playlist、series、channel、author homepage）
- 调用：`python3 ytdlp_discover.py --flat-playlist --max N <url>`
- yt-dlp 使用 `--dump-single-json` 输出 entries
- Python 端提取：`id`, `title`, `uploader`, `duration`, `webpage_url`, `thumbnails`
- 失败时复用 `compactMessage` 同风格错误提示

### 6.2 Search（C，实验）

- 输入：关键词 + 站点/通用
- 调用：`python3 ytdlp_discover.py --search "ytsearch10:关键词"`
- 不同站点支持度不同，失败提示：「该站点暂不支持搜索发现」
- 仅当设置中开启「实验性发现功能」才显示

### 6.3 Related（B，实验）

- 输入：单个视频 URL
- 用 Scripting `WebView` 加载页面并注入 JS 抓取推荐区链接
- 站点相关、容易失效，v1 可先提供壳子，明确标注「实验功能，可能无法解析」
- 仅当设置中开启「实验性发现功能」才显示

## 7. UI flow

### Tab 顺序

```text
记录 | 发现 | 下载 | 设置
```

### 发现页输入区

| 控件 | 说明 |
|---|---|
| 发现类型 | 按钮，弹出 ActionSheet：播放列表/合集、作者主页、关键词搜索、相关推荐（后两项需实验开关开启） |
| 种子输入 | 显示当前链接/关键词；支持「从剪贴板粘贴」和「手动输入」；非搜索类型会自动识别第一个有效 http/https 链接 |
| 数量上限 | 按钮，选项 10/20/30/40/50，默认 20 |
| 开始发现 | 主按钮 |

### 发现结果区

- Section header：`共 N 条 · 已选 M · 全选/取消全选`
- 每行：标题（一行截断）、副标题 `作者 · 时长`、右侧 checkmark
- 若结果超过上限，header 提示：`仅展示前 20 条`

### 底部操作区

- **加入批量队列（M）** —— 主按钮
- **复制选中链接**
- **清空结果**

### 加入队列后

1. 选中 URL 去重
2. 调用 `enqueueURLs` 更新批量队列
3. 父组件切到 `DOWNLOAD_TAB`
4. 用户手动点「开始批量下载」才会真正下载

## 8. Error handling

| 场景 | 处理 |
|---|---|
| 输入不是有效 http(s) | 提示：请输入有效的公开链接 |
| 站点不支持该发现类型 | 提示：该站点暂不支持此类型的发现 |
| 网络超时 / SSL | 复用 `isTransientProbeFailure` / `isCertificateVerifyFailure` 自动重试一次 |
| 发现成功但 0 条 | 提示：未找到可展开的视频 |
| 实验功能未开启 | 「搜索」「相关推荐」选项隐藏 |
| 选中数超过批量队列剩余容量 | 提示：批量队列最多 30 条，当前还可加入 X 条 |

## 9. Settings

在设置页新增：

> **实验性发现功能**（默认关闭）  
> 开启后，发现页才显示「关键词搜索」和「相关推荐」。

A/D 始终可用。

## 10. Implementation phases

### P0：发现页 + A/D 稳定能力

- 新增 Tab 并调整常量
- 新增 `services/discovery.ts`、playlist 引擎、`ytdlp_discover.py`
- 新增 `components/DiscoverTab.tsx`
- 设置页加「实验性发现功能」开关
- 连接 `enqueueURLs` 与 tab 切换
- 验证：TypeScript 0 错误、`scripting-ts project` 启动、playlist/作者页真机点验

### P1：搜索能力（实验）

- 实现 search 引擎
- 发现页显示关键词输入框
- 真机验证 YouTube / B 站搜索

### P2：相关推荐（实验）

- WebView 抓取相关视频
- 站点特定 JS selector
- 明确标注「易失效」

## 11. Testing

### Automated / scriptable

- `ytdlp_discover.py` 对已知 playlist URL 输出合法 JSON
- `services/discovery.ts` 分发到正确引擎
- `DiscoverTab` 选中状态与 URL 去重

### Project

- TypeScript diagnostics clean
- `scripting-ts project "Yoinks"` launches

### Device

1. 输入 YouTube/B 站 playlist URL → 列出条目 → 勾选 → 加入批量队列 → 下载页可见
2. 输入作者主页 URL → 列出视频 → 加入队列
3. 开启实验开关后，关键词搜索可用（若站点支持）
4. 关闭实验开关时，搜索/相关推荐选项不显示
5. 批量队列达到 30 条后，发现页提示不可再加入
