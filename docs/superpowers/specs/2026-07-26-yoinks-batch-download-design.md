# Yoinks Batch Download Design

**Date:** 2026-07-26  
**Status:** Approved 2026-07-26; implemented P0–P2 in 1.4.0 (device QA pending)  
**Baseline:** Yoinks 1.3.3 (single-link probe → format → download)

## Goal

Add an explicit **batch download** path for multiple independent public media URLs, without changing the default single-link workflow. Entry is a menu item on the existing add-link flow (Scheme 1). Queue UI appears only when the queue is non-empty. Execution is strictly sequential and reuses `probeMedia` / `resolveAutomaticChoice` / `downloadMedia` / history.

## Problem

Today every entry path uses `extractFirstURL` and a single `progress` / `result` / `cancelPath` task model:

- Nav bar `+` / 「添加媒体链接」→ clipboard or manual → one URL → `analyzeMedia`
- Recent links, history re-download, Share/Intent → one URL
- `ytdlp_probe.py` uses `noplaylist: True`
- Settings 「并发」is yt-dlp **fragment** concurrency, not multi-video batch

There is **no** batch UI entry and no multi-item queue.

## Scope

### Included (v1)

- Extend add-link action sheet with **批量添加…**
- Batch sources: clipboard all URLs; multi-line paste/manual input
- Confirm sheet before enqueue (count, preview, cap)
- In-memory session queue; Section on Download tab only when `queue.length > 0`
- Unified automatic format strategy for the batch
- Sequential runner: probe → auto choice → download → history
- Cancel current item; stop whole batch; retry failed; clear completed / clear queue
- `extractAllURLs` + `services/batch-queue.ts`
- Runtime log events for batch lifecycle
- Phased implementation P0 → P1 → P2

### Excluded (v1)

- Playlist / series / multi-P expansion (`noplaylist` stays true)
- Parallel multi-video downloads
- Per-item manual format picker in batch
- Login WebView during batch (items needing login fail with guidance)
- Disk-persisted queue / resume after kill
- Fourth tab 「队列」
- Multi-select on History tab
- Share/Intent auto-batch (remains single-link)
- Changing fragment concurrency semantics

## Decisions (locked)

| Topic | Decision |
|-------|----------|
| UI entry | Scheme 1: third item on add-link menu |
| Empty queue UI | No permanent batch section |
| Single paste | Still `extractFirstURL` only |
| Concurrency | One media at a time |
| Format | Batch-wide `AutomaticDownloadFormatStrategy` (default from settings) |
| Save `ask` | No per-item dialogs during batch; keep managed originals |
| Save `files` | No DocumentPicker storm; keep originals; export from History |
| Save `photos` | Auto-save video/image when mode is photos |
| Login | Fail item if fresh cookies required and no usable session |
| Caps | 20 URLs per add; 30 items per session queue |
| Lifetime | Memory only for current script session |

---

## 1. Entry and navigation

### Primary entry

Shared by nav `+` and 「添加媒体链接」via `chooseLinkSource()`:

```text
添加媒体链接
  1. 从剪贴板粘贴      // single, unchanged
  2. 手动输入          // single, unchanged
  3. 批量添加…         // new
```

### Batch source submenu

```text
批量添加
  1. 从剪贴板提取全部链接
  2. 多行粘贴 / 手动输入
```

### Confirm before enqueue

When ≥1 URL parsed:

- Title: `识别到 N 条链接`
- Body: first 3–5 URLs + `…其余 M 条` if needed; note truncation if over per-add cap
- Actions: **加入队列** / 取消

Zero URLs → status `未找到有效的公开链接。`

### Unchanged paths

| Path | Behavior |
|------|----------|
| Normal paste / manual | First URL only |
| Launch clipboard auto-analyze | Single |
| Share / Intent | Single (v1) |
| Tabs | Still 记录 / 下载 / 设置 |
| Settings concurrency | Fragment threads only |

### When batch is running

`chooseLinkSource` offers **only** 「批量添加…」so single-link analyze cannot race the runner Shell/WebView.

---

## 2. Queue model

### Types (session memory)

```ts
type BatchItemStatus =
  | "pending"
  | "probing"
  | "downloading"
  | "completed"
  | "failed"
  | "cancelled"

type BatchItem = {
  id: string
  sourceURL: string
  status: BatchItemStatus
  title?: string
  errorMessage?: string
  choiceLabel?: string
  result?: DownloadResult
  addedAt: number
}

type BatchQueueState = {
  items: BatchItem[]
  formatStrategy: AutomaticDownloadFormatStrategy
  preferredContainer: PreferredContainer
  running: boolean
  stopRequested: boolean
  activeItemId: string | null
}
```

Closing Yoinks discards the in-memory queue. Successful downloads remain in `history` / `link-history`.

### `extractAllURLs`

- Same site priority patterns as `extractFirstURL` (Xiaohongshu, Douyin, then generic `https?://`)
- Scan full text; `sanitizeExtractedURL`; allow only http(s)
- Dedupe preserving first-seen order (string identity after sanitize; do not strip query)
- Caller applies per-add cap of 20

### Enqueue rules

| Case | Behavior |
|------|----------|
| New URL | Append `pending` |
| Same as pending/failed/cancelled | Skip; may status「已在队列」 |
| Same as probing/downloading | Skip |
| Same as completed | Allow new item (simple re-download) |
| Add while running | Allowed; new `pending` picked up in order |
| Session at 30 | Reject further adds with clear status |

### Module split

| Module | Role |
|--------|------|
| `services/media.ts` | `extractAllURLs` (and existing single download APIs) |
| `services/batch-queue.ts` | Pure queue: add, dedupe, counts, next pending, retry, clear — **no UI** |
| `index.tsx` | Menus, confirm, queue Section, runner loop |

---

## 3. Execution

### Strict sequential runner

For each `pending` item while `running && !stopRequested`:

1. `status = probing`
2. `probeMedia` (Douyin anonymous WebView path unchanged; other sites use existing cookie **if session already present**)
3. `resolveAutomaticChoice(probe, formatStrategy, preferredContainer)`  
   - No choice → `failed`, continue
4. `status = downloading`
5. `downloadMedia` with existing progress → top bar; stage prefix `批量 i/N · …`
6. Success:
   - `completed`, store result fields
   - `addHistoryRecord` + `rememberRecentLink` + prune limits (same as single)
   - Save: see Decisions table
7. Failure: `failed` + message; **do not stop batch**
8. If `stopRequested`: cancel current if needed; leave remaining as `pending`; `running = false`

**Start batch** only processes `pending`. Failed items need explicit retry (item sheet or 「重试全部失败」) to become `pending` again.

### Login policy

- If probe/download needs fresh login and no usable persistent/temporary session: mark item `failed` with message to login via settings or single-link flow.
- **Do not** present login WebView inside the batch runner.

### Cancel

| Action | Behavior |
|--------|----------|
| FAB / confirm cancel current | `cancelDownload`; item → `cancelled`; if not stop-all, continue next pending |
| 停止整批 | `stopRequested = true` + cancel current; leftover stays `pending` |
| 清空队列 | Only when `!running`; clear all items |
| 清空已完成 | Remove `completed` (and optionally leave cancelled) |

### Mutual exclusion

| State | Single start | Batch start | Single analyze |
|-------|--------------|-------------|----------------|
| Idle | ✓ | if pending ✓ | ✓ |
| Single analyzing/downloading | — | disabled | — |
| Batch running | disabled | becomes 停止整批 | disabled |
| Batch running + add | append only via batch add | — | — |

---

## 4. Download tab UI

### Layout when `queue.length > 0`

```text
[下载中]       // single or batch active download; batch stages prefixed
[批量队列]     // only if queue non-empty
[当前链接]
[格式]
[任务]         // single「开始下载」hidden or disabled while batch running
```

### Batch Section controls

| Control | Behavior |
|---------|----------|
| Header | `批量队列 · N 条` + counts (完成/失败/等待/进行中) |
| 统一格式 | Action sheet; disabled while `running` |
| Primary | `开始批量下载` or `停止整批` |
| 重试全部失败 | When failed exist and `!running` → all failed → pending |
| 清空已完成 | When completed exist |
| 清空队列 | `!running`, destructive confirm |
| Rows | Status icon + title/URL + subtitle (format or error) |
| Row actions | 复制链接; 移出 (not probing/downloading); 重试 (failed/cancelled); 取消 |

### Progress and copy

- Top progress reuses existing pin + fraction UI
- Example stage: `批量 2/5 · 下载视频流`
- Batch finished status: `批量完成：成功 a · 失败 b · 取消 c`
- FAB cancel during batch item download: confirm whether cancel current only (default continue batch) vs already stopping all

### Status strings (selected)

| Scene | Copy |
|-------|------|
| No URLs | `未找到有效的公开链接。` |
| Enqueued | `已加入队列 N 条` (+ truncation note) |
| All dupes | `这些链接已在队列中。` |
| Start with no pending | `没有等待中的任务。` |

---

## 5. Logging

Emit (with URL redaction consistent with runtime logs):

- `batch.add` — count, truncated?
- `batch.start` / `batch.stop` / `batch.finished` — ok/fail/cancel counts
- `batch.item.*` — probe/download/completed/failed with itemId  
Existing `probe.*` / `download.*` may still fire per item with `taskId`.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Shell/WebView host noise from concurrency | Sequential runner; block single analyze/download while batch running |
| N save dialogs | No `ask` / no Files picker during batch |
| Login blocks queue | Fail item; guide to single-link login |
| Lost queue on exit | Accept for v1; successes already in history |
| Power/data | Caps 20/30; sequential only |
| `index.tsx` size | Logic in `batch-queue.ts` |

---

## 7. Testing

### Automated / scriptable

- `extractAllURLs`: multi-line, Douyin share text, dedupe, trailing punctuation, cap 20
- `batch-queue`: enqueue dedupe, counts, next pending, failed→pending, clear completed

### Project

- TypeScript diagnostics clean for Yoinks
- `scripting-ts project "Yoinks"` launches

### Device

1. Single-link regression: paste → analyze → format → download  
2. Batch: 2–3 public URLs from clipboard → confirm → sequential run  
3. Stop batch → remaining pending → start again  
4. Retry failed  
5. History shows successes  
6. While running, `+` only batch-append  

---

## 8. Implementation phases

| Phase | Deliverable |
|-------|-------------|
| **P0** | `extractAllURLs`, `batch-queue.ts`, menu entry, confirm enqueue, queue Section (list/manage without runner) |
| **P1** | Sequential runner, progress prefix, cancel current, stop batch, history/save rules |
| **P2** | Retry all failed, log events polish, copy polish |

Do not implement until this written spec is explicitly approved.

## 9. Success criteria

1. 「批量添加…」visible; normal paste still single-URL.  
2. Three valid clipboard links → confirm → queue 3 → start → sequential completion (partial fail allowed).  
3. Stop mid-batch leaves remaining pending; can resume.  
4. Successes appear under 记录; failures retryable.  
5. Single-link main path has no behavior regression.

## Out of scope follow-ups (post-v1)

- Playlist flat expand  
- Intent multi-URL batch confirm  
- Optional queue persistence  
- Per-item format override  
