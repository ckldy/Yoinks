/**
 * Static checks: extractAllURLs + batch-queue pure state.
 * Run: scripting-ts run verify_batch_queue.ts
 */
import { Script } from "scripting"
import type { MediaProbe } from "./services/media"
import { BATCH_ADD_MAX, BATCH_QUEUE_MAX, extractAllURLs, extractFirstURL } from "./services/media"
import {
  batchItemTitle,
  clearBatchQueue,
  clearCompletedBatchItems,
  clearFinishedBatchItems,
  countBatchItems,
  createBatchQueueState,
  displayBatchItems,
  enqueueURLs,
  formatBatchHeader,
  nextPendingItem,
  removeBatchItem,
  retryAllFailed,
  retryBatchItem,
  shortenBatchURL,
  updateBatchItem,
} from "./services/batch-queue"

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

let passed = 0
function check(name: string, condition: boolean) {
  assert(condition, name)
  passed += 1
  console.log(`ok ${passed}: ${name}`)
}

// --- extractAllURLs ---
const multi = extractAllURLs(`
https://youtu.be/aaa
看这个 https://www.bilibili.com/video/BV1xx 和 https://youtu.be/aaa
https://v.douyin.com/AbCdEf/
`)
check("extractAllURLs finds multiple unique", multi.length === 3)
check("extractAllURLs dedupes youtu.be", multi.filter((u) => u.includes("youtu.be/aaa")).length === 1)
check("extractAllURLs keeps document order", multi[0].includes("youtu.be/aaa") && multi[1].includes("bilibili.com") && multi[2].includes("v.douyin.com"))
check("extractAllURLs strips trailing slash for dedupe", multi[2] === "https://v.douyin.com/AbCdEf")

const douyinShare = extractAllURLs("0.53 复制打开抖音，看看【x】的作品 https://v.douyin.com/AbC123/ 这是文案#话题")
check("extractAllURLs prefers douyin short link in share text", douyinShare.length === 1 && douyinShare[0].includes("v.douyin.com/AbC123"))

const trailing = extractAllURLs("https://example.com/v/1。\nhttps://example.com/v/2，")
check("extractAllURLs strips trailing CJK punctuation", trailing.every((u) => !/[。，]$/.test(u)) && trailing.length === 2)

check("extractFirstURL still single", extractFirstURL("https://a.com/1 https://b.com/2") === "https://a.com/1")
check("BATCH caps defined", BATCH_ADD_MAX === 20 && BATCH_QUEUE_MAX === 30)

// --- batch-queue ---
let state = createBatchQueueState("recommended", "mp4")
const many = Array.from({ length: 25 }, (_, i) => `https://example.com/v/${i}`)
let result = enqueueURLs(state, many, BATCH_ADD_MAX)
state = result.state
check("enqueue truncates per-add to 20", result.added === 20 && result.truncated === 5)
check("queue length 20", state.items.length === 20)

result = enqueueURLs(state, ["https://example.com/v/0", "https://example.com/v/99"])
state = result.state
check("duplicate pending skipped", result.skippedDuplicate === 1 && result.added === 1)
check("enqueue returns actual added URL", result.addedSourceURLs.length === 1 && result.addedSourceURLs[0] === "https://example.com/v/99")

const probeMarker = { title: "member", choices: [] } as unknown as MediaProbe
const authorized = enqueueURLs(createBatchQueueState(), [{
  url: "https://www.youtube.com/watch?v=member",
  title: "会员视频",
  probe: probeMarker,
  probeAuthorizedPlatform: "youtube",
}])
check(
  "enqueue preserves authorized probe platform without cookie data",
  authorized.state.items[0]?.probe === probeMarker && authorized.state.items[0]?.probeAuthorizedPlatform === "youtube",
)

const pending = nextPendingItem(state)
check("next pending is first", pending?.sourceURL === "https://example.com/v/0")

state = updateBatchItem(state, state.items[0].id, { status: "failed", errorMessage: "need login" })
state = retryBatchItem(state, state.items[0].id)
check("retry failed -> pending", state.items[0].status === "pending" && !state.items[0].errorMessage)

state = updateBatchItem(state, state.items[0].id, { status: "completed", title: "done" })
state = updateBatchItem(state, state.items[1].id, { status: "failed", errorMessage: "x" })
state = updateBatchItem(state, state.items[2].id, { status: "cancelled", errorMessage: "已取消" })
state = retryAllFailed(state)
check("retry all failed+cancelled", state.items[1].status === "pending" && state.items[2].status === "pending" && state.items[0].status === "completed")

const beforeClear = state.items.length
state = clearCompletedBatchItems(state)
check("clear completed removes only completed", state.items.length === beforeClear - 1 && !state.items.some((i) => i.status === "completed"))

state = updateBatchItem(state, state.items[0].id, { status: "completed" })
state = updateBatchItem(state, state.items[1].id, { status: "cancelled" })
const beforeFinished = state.items.length
state = clearFinishedBatchItems(state)
check(
  "clear finished removes completed+cancelled",
  state.items.length === beforeFinished - 2
    && !state.items.some((i) => i.status === "completed" || i.status === "cancelled"),
)

const orderState = createBatchQueueState()
let mixed = enqueueURLs(orderState, ["https://a.com/1", "https://a.com/2", "https://a.com/3", "https://a.com/4"], 10).state
mixed = updateBatchItem(mixed, mixed.items[0].id, { status: "completed", title: "c" })
mixed = updateBatchItem(mixed, mixed.items[1].id, { status: "failed" })
mixed = updateBatchItem(mixed, mixed.items[2].id, { status: "downloading" })
// items[3] stays pending
const ordered = displayBatchItems(mixed.items)
check(
  "display order active then pending then failed then completed",
  ordered[0].status === "downloading"
    && ordered[1].status === "pending"
    && ordered[2].status === "failed"
    && ordered[3].status === "completed",
)
check("shortenBatchURL keeps host", shortenBatchURL("https://www.example.com/very/long/path/here").startsWith("www.example.com"))
check("batchItemTitle prefers title", batchItemTitle({ ...mixed.items[0], title: "Hello", sourceURL: "https://x.com/y" }) === "Hello")

const counts = countBatchItems(state.items)
check("header includes total", formatBatchHeader(counts).includes(`${counts.total} 条`))

const blocked = state.items[0]
state = updateBatchItem(state, blocked.id, { status: "downloading" })
const afterRemove = removeBatchItem(state, blocked.id)
check("cannot remove downloading item", afterRemove.items.some((i) => i.id === blocked.id))

state = updateBatchItem(state, blocked.id, { status: "pending" })
state = removeBatchItem(state, blocked.id)
check("can remove pending item", !state.items.some((i) => i.id === blocked.id))

// fill toward session max
state = createBatchQueueState()
const fill = Array.from({ length: BATCH_QUEUE_MAX }, (_, i) => `https://example.com/q/${i}`)
result = enqueueURLs(state, fill, BATCH_QUEUE_MAX)
state = result.state
result = enqueueURLs(state, ["https://example.com/overflow"], 5)
check("session full rejects", result.rejectedFull === 1 && state.items.length === BATCH_QUEUE_MAX)

state = clearBatchQueue({ ...state, running: true })
check("clear blocked while running", state.items.length === BATCH_QUEUE_MAX)
state = clearBatchQueue({ ...state, running: false })
check("clear when idle", state.items.length === 0)

console.log(`verify_batch_queue: ${passed} passed`)
Script.exit(0)
