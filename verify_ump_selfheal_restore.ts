// verify_ump_selfheal_restore.ts — 破坏性恢复验证：模拟 yt_dlp_plugins 整体丢失，
// 验证 ensureYtseComponent 自动从固化备份恢复（离线、不联网）。结束前恢复原状。
import { Path, Script } from "scripting"
import { ensureYtseComponent, getToolStatus, restoreYtseVendor } from "./services/media"

declare const FileManager: any

const results: Record<string, unknown> = {}
let renamedAway = ""

void (async () => {
  try {
    const status0 = await getToolStatus()
    if (!status0.ytseSite) throw new Error("无 usersite")
    const site = status0.ytseSite
    const pluginsDir = Path.join(site, "yt_dlp_plugins")
    const moved = `${pluginsDir}.lost-sim`

    // 确保备份已存在（若还没有则先做一次备份）
    const backed = await (async () => {
      try {
        const { backupYtseVendor } = await import("./services/media")
        return await backupYtseVendor(site)
      } catch {
        return false
      }
    })()
    results.backupReady = backed

    // 模拟丢失：移走 yt_dlp_plugins 目录
    if (FileManager.existsSync(pluginsDir)) {
      if (FileManager.existsSync(moved)) FileManager.removeSync(moved)
      FileManager.renameSync(pluginsDir, moved)
      renamedAway = moved
      results.simulatedLoss = true
    }

    // 此时 check 应报告 patched=false（dist-info 残留 → installed=true）
    const lost = await ensureYtseComponent({ force: true, allowNetworkInstall: false })
    results.lostState = lost
    results.action = lost.action

    // 复检：应已恢复并补丁完整
    const final = await getToolStatus()
    results.final = {
      ytseVersion: final.ytseVersion,
      ytsePatched: final.ytsePatched,
      ytseMissing: final.ytseMissing,
      pluginsExists: FileManager.existsSync(pluginsDir),
    }
    results.pass = final.ytsePatched && FileManager.existsSync(pluginsDir)
    if (!results.pass) throw new Error("丢失模拟后未能自动恢复")
  } catch (error) {
    results.pass = false
    results.error = error instanceof Error ? error.message : String(error)
  } finally {
    // 清理模拟遗留（若 ensure 未恢复成功，从备份强制恢复 + 移除 .lost-sim）
    try {
      const status = await getToolStatus()
      if (status.ytseSite && renamedAway) {
        const pluginsDir = Path.join(status.ytseSite, "yt_dlp_plugins")
        if (!FileManager.existsSync(pluginsDir)) {
          await restoreYtseVendor(status.ytseSite)
          await ensureYtseComponent({ force: true, allowNetworkInstall: false })
        }
      }
      if (renamedAway && FileManager.existsSync(renamedAway)) FileManager.removeSync(renamedAway)
    } catch {
      // 清理失败不影响主结果，交给人工处理
    }
  }
  Script.exit(results)
})()
