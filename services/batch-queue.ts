import type { AutomaticDownloadFormatStrategy, PreferredContainer } from "./preferences"
import type { DownloadResult } from "./media"
import { BATCH_QUEUE_MAX } from "./media"

export type BatchItemStatus =
  | "pending"
  | "probing"
  | "downloading"
  | "completed"
  | "failed"
  | "cancelled"

export type BatchItem = {
  id: string
  sourceURL: string
  status: BatchItemStatus
  title?: string
  errorMessage?: string
  choiceLabel?: string
  result?: DownloadResult
  addedAt: number
}

export type BatchQueueState = {
  items: BatchItem[]
  formatStrategy: AutomaticDownloadFormatStrategy
  preferredContainer: PreferredContainer
  running: boolean
  stopRequested: boolean
  activeItemId: string | null
}

export type BatchCounts = {
  total: number
  pending: number
  probing: number
  downloading: number
  completed: number
  failed: number
  cancelled: number
  active: number
}

export type EnqueueResult = {
  state: BatchQueueState
  added: number
  skippedDuplicate: number
  truncated: number
  rejectedFull: number
}

function createItemId(): string {
  return `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function createBatchQueueState(
  formatStrategy: AutomaticDownloadFormatStrategy = "recommended",
  preferredContainer: PreferredContainer = "mp4",
): BatchQueueState {
  return {
    items: [],
    formatStrategy,
    preferredContainer,
    running: false,
    stopRequested: false,
    activeItemId: null,
  }
}

export function countBatchItems(items: BatchItem[]): BatchCounts {
  const counts: BatchCounts = {
    total: items.length,
    pending: 0,
    probing: 0,
    downloading: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    active: 0,
  }
  for (const item of items) {
    counts[item.status] += 1
    if (item.status === "probing" || item.status === "downloading") counts.active += 1
  }
  return counts
}

function isBlockingDuplicate(status: BatchItemStatus): boolean {
  return status === "pending"
    || status === "failed"
    || status === "cancelled"
    || status === "probing"
    || status === "downloading"
}

/** Enqueue URLs; dedupe against pending/failed/cancelled/active; allow re-add of completed. */
export function enqueueURLs(state: BatchQueueState, urls: string[], perAddMax = 20): EnqueueResult {
  let added = 0
  let skippedDuplicate = 0
  let truncated = 0
  let rejectedFull = 0
  const items = [...state.items]
  const limited = urls.length > perAddMax ? urls.slice(0, perAddMax) : urls
  truncated = Math.max(0, urls.length - limited.length)

  for (const sourceURL of limited) {
    if (items.length >= BATCH_QUEUE_MAX) {
      rejectedFull += 1
      continue
    }
    const duplicate = items.some((item) => item.sourceURL === sourceURL && isBlockingDuplicate(item.status))
    if (duplicate) {
      skippedDuplicate += 1
      continue
    }
    items.push({
      id: createItemId(),
      sourceURL,
      status: "pending",
      addedAt: Date.now(),
    })
    added += 1
  }

  return {
    state: { ...state, items },
    added,
    skippedDuplicate,
    truncated,
    rejectedFull,
  }
}

export function updateBatchItem(
  state: BatchQueueState,
  itemId: string,
  patch: Partial<Omit<BatchItem, "id" | "sourceURL" | "addedAt">>,
): BatchQueueState {
  return {
    ...state,
    items: state.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
  }
}

export function removeBatchItem(state: BatchQueueState, itemId: string): BatchQueueState {
  const target = state.items.find((item) => item.id === itemId)
  if (!target) return state
  if (target.status === "probing" || target.status === "downloading") return state
  return {
    ...state,
    items: state.items.filter((item) => item.id !== itemId),
    activeItemId: state.activeItemId === itemId ? null : state.activeItemId,
  }
}

export function retryBatchItem(state: BatchQueueState, itemId: string): BatchQueueState {
  return {
    ...state,
    items: state.items.map((item) => {
      if (item.id !== itemId) return item
      if (item.status !== "failed" && item.status !== "cancelled") return item
      return {
        ...item,
        status: "pending" as const,
        errorMessage: undefined,
        choiceLabel: undefined,
        result: undefined,
      }
    }),
  }
}

export function retryAllFailed(state: BatchQueueState): BatchQueueState {
  return {
    ...state,
    items: state.items.map((item) => {
      // Include cancelled so one tap recovers both post-run leftovers.
      if (item.status !== "failed" && item.status !== "cancelled") return item
      return {
        ...item,
        status: "pending" as const,
        errorMessage: undefined,
        choiceLabel: undefined,
        result: undefined,
      }
    }),
  }
}

export function clearCompletedBatchItems(state: BatchQueueState): BatchQueueState {
  return {
    ...state,
    items: state.items.filter((item) => item.status !== "completed"),
  }
}

/** Remove completed + cancelled (keep pending/active/failed for retry). */
export function clearFinishedBatchItems(state: BatchQueueState): BatchQueueState {
  return {
    ...state,
    items: state.items.filter((item) => item.status !== "completed" && item.status !== "cancelled"),
  }
}

/** Compact URL for list rows (host + short path). */
export function shortenBatchURL(url: string, maxLength = 48): string {
  try {
    const parsed = new URL(url)
    const path = decodeURI(parsed.pathname || "/")
    const bare = `${parsed.host}${path === "/" ? "" : path}`
    if (bare.length <= maxLength) return bare
    return `${bare.slice(0, Math.max(0, maxLength - 1))}…`
  } catch {
    if (url.length <= maxLength) return url
    return `${url.slice(0, Math.max(0, maxLength - 1))}…`
  }
}

function batchDisplayRank(status: BatchItemStatus): number {
  switch (status) {
    case "downloading":
    case "probing":
      return 0
    case "pending":
      return 1
    case "failed":
      return 2
    case "cancelled":
      return 3
    case "completed":
      return 4
  }
}

/** Stable display order: active → pending → failed → cancelled → completed. */
export function displayBatchItems(items: BatchItem[]): BatchItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const rank = batchDisplayRank(a.item.status) - batchDisplayRank(b.item.status)
      if (rank !== 0) return rank
      return a.index - b.index
    })
    .map((entry) => entry.item)
}

export function clearBatchQueue(state: BatchQueueState): BatchQueueState {
  if (state.running) return state
  return {
    ...state,
    items: [],
    stopRequested: false,
    activeItemId: null,
  }
}

export function nextPendingItem(state: BatchQueueState): BatchItem | null {
  return state.items.find((item) => item.status === "pending") || null
}

export function setBatchFormatStrategy(
  state: BatchQueueState,
  formatStrategy: AutomaticDownloadFormatStrategy,
  preferredContainer?: PreferredContainer,
): BatchQueueState {
  return {
    ...state,
    formatStrategy,
    preferredContainer: preferredContainer ?? state.preferredContainer,
  }
}

export function beginBatchRun(state: BatchQueueState): BatchQueueState {
  return {
    ...state,
    running: true,
    stopRequested: false,
  }
}

export function requestBatchStop(state: BatchQueueState): BatchQueueState {
  return {
    ...state,
    stopRequested: true,
  }
}

export function endBatchRun(state: BatchQueueState): BatchQueueState {
  return {
    ...state,
    running: false,
    stopRequested: false,
    activeItemId: null,
  }
}

export function formatBatchHeader(counts: BatchCounts): string {
  if (counts.total === 0) return "批量队列"
  const parts: string[] = []
  if (counts.completed) parts.push(`完成 ${counts.completed}`)
  if (counts.failed) parts.push(`失败 ${counts.failed}`)
  if (counts.pending) parts.push(`等待 ${counts.pending}`)
  if (counts.active) parts.push(`进行中 ${counts.active}`)
  if (counts.cancelled) parts.push(`取消 ${counts.cancelled}`)
  const detail = parts.length ? `（${parts.join(" · ")}）` : ""
  return `批量队列 · ${counts.total} 条${detail}`
}

export function batchItemSubtitle(item: BatchItem): string {
  if (item.status === "failed" && item.errorMessage) return item.errorMessage
  if (item.status === "completed") {
    return item.choiceLabel ? `已完成 · ${item.choiceLabel}` : "已完成"
  }
  if (item.status === "cancelled") return "已取消"
  if (item.status === "pending") return "等待中"
  if (item.status === "probing") return "分析中"
  if (item.status === "downloading") {
    return item.choiceLabel ? `下载中 · ${item.choiceLabel}` : "下载中"
  }
  if (item.choiceLabel) return item.choiceLabel
  return shortenBatchURL(item.sourceURL)
}

export function batchItemTitle(item: BatchItem): string {
  if (item.title) return item.title
  return shortenBatchURL(item.sourceURL)
}

export function batchStatusIcon(status: BatchItemStatus): string {
  switch (status) {
    case "pending": return "circle"
    case "probing": return "waveform.path.ecg"
    case "downloading": return "arrow.down.circle"
    case "completed": return "checkmark.circle.fill"
    case "failed": return "xmark.circle.fill"
    case "cancelled": return "minus.circle"
  }
}
