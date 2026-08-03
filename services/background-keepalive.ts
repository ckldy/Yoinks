import { Script } from "scripting"

// 下载后台保活：利用 Scripting BackgroundKeeper 在 App 切后台后继续运行进程，
// 使分段 fetch / HLS / ffmpeg 合并等所有 JS 侧下载逻辑不被系统挂起。
//
// 注意：BackgroundKeeper 的队列按脚本粒度管理（同脚本多次 keepAlive 只算一个请求，
// 一次 stopKeepAlive 即全部释放），因此必须用本地引用计数保证 stop 只发生在
// 最后一个持有者释放时——否则并发下载时先结束的任务会把后者的保活一起停掉。

let heldCount = 0
let requested = false

/**
 * 请求下载期间的后台保活，返回释放函数。
 * - 仅主 App 环境（Script.env === "index"）可用；verify/脚本环境静默降级为无操作。
 * - 并发安全：多个下载同时持有，最后一个释放时才调用 stopKeepAlive。
 * - 限制：保活时长由 iOS 决定（有限时长，高内存/低电量下系统可能仍会终止 App）。
 */
export function beginDownloadKeepAlive(): () => void {
  if (Script.env === "index" && !requested) {
    requested = true
    BackgroundKeeper.keepAlive().catch(() => {})
  }
  heldCount += 1
  let released = false
  return () => {
    if (released) return
    released = true
    heldCount = Math.max(0, heldCount - 1)
    if (heldCount === 0 && requested) {
      requested = false
      BackgroundKeeper.stopKeepAlive().catch(() => {})
    }
  }
}
