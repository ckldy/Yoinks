import { AppEvents, Notification, type ScenePhase } from "scripting"
import { getPreferences } from "./preferences"
import { logEvent } from "./logs"

// 下载结果通知：App 处于后台时，下载完成/失败发本地通知提示用户。
// 前台不通知（界面已有状态显示，避免打扰）。

let currentPhase: ScenePhase = "active"
let tracking = false

function trackScenePhase() {
  if (tracking) return
  tracking = true
  try {
    AppEvents.scenePhase.addListener((phase) => {
      currentPhase = phase
    })
  } catch {
    // verify/非主 App 环境无 AppEvents：保持 active，通知静默不发送
  }
}

// 模块加载即注册监听：确保任何时刻 scenePhase 都是最新的（
// 否则首次后台下载完成时才注册会错过 background 事件，导致不通知）。
trackScenePhase()

function isBackground(): boolean {
  return currentPhase === "background" || currentPhase === "inactive"
}

async function sendNotification(kind: "complete" | "failed", title: string, body: string): Promise<boolean> {
  try {
    const sent = await Notification.schedule({
      title,
      body,
      threadIdentifier: "yoinks-download",
      // 点击通知只把 App 带回前台显示原有实例，不重新运行脚本（runScript 会新开一个 Yoinks）。
      tapAction: "none",
    })
    await logEvent({ level: "info", event: `download.notify.${kind}`, details: { title, sent } })
    return sent
  } catch (error) {
    await logEvent({
      level: "warn",
      event: `download.notify.${kind}.failed`,
      details: { message: error instanceof Error ? error.message : String(error) },
    })
    return false
  }
}

/** 下载完成通知（仅后台 + 开关开启时发送）。 */
export async function notifyDownloadComplete(fileName: string, extra?: string): Promise<boolean> {
  if (!getPreferences().notifyDownloadComplete) return false
  if (!isBackground()) return false
  return sendNotification("complete", "下载完成", extra ? `${fileName}\n${extra}` : fileName)
}

/** 下载失败通知（仅后台 + 开关开启时发送；取消不通知）。 */
export async function notifyDownloadFailed(fileName: string, message: string): Promise<boolean> {
  if (!getPreferences().notifyDownloadComplete) return false
  if (!isBackground()) return false
  return sendNotification("failed", "下载失败", `${fileName}\n${message}`)
}

/** 批量下载完成汇总通知（仅后台 + 开关开启时发送）。 */
export async function notifyBatchFinished(ok: number, fail: number, cancelled: number): Promise<boolean> {
  if (!getPreferences().notifyDownloadComplete) return false
  if (!isBackground()) return false
  const parts: string[] = [`成功 ${ok}`]
  if (fail > 0) parts.push(`失败 ${fail}`)
  if (cancelled > 0) parts.push(`取消 ${cancelled}`)
  return sendNotification("complete", "批量下载完成", parts.join(" · "))
}
