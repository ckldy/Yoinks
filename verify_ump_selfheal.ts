// verify_ump_selfheal.ts — 验证 UMP 组件自愈链（ensure → 固化备份 → 无害恢复 → 复检）
// 不删除任何组件文件：restore 是从 vendor 覆盖回 usersite（当前均为已修补完整形态，等效无操作）。
import { Path, Script } from "scripting"
import { backupYtseVendor, ensureYtseComponent, getToolStatus, restoreYtseVendor } from "./services/media"

declare const FileManager: any

const results: Record<string, unknown> = {}

void (async () => {
  try {
    // 1. 自愈检查（force 绕过 60s 缓存；不联网）
    const ensure1 = await ensureYtseComponent({ force: true, allowNetworkInstall: false })
    results.ensure1 = ensure1
    if (!ensure1.ok) throw new Error(`自愈检查失败：${ensure1.action}`)

    // 2. 取 site 路径并固化备份
    const status = await getToolStatus()
    const site = status.ytseSite
    results.site = site
    results.evidence = status.ytseEvidence
    if (!site) throw new Error("未取得 usersite 路径")
    const backed = await backupYtseVendor(site)
    results.backup = backed
    if (!backed) throw new Error("固化备份失败")

    // 3. 确认两个 vendor 目录存在（AppGroup + 项目 iCloud）
    const appGroupVendor = Path.join(FileManager.appGroupDocumentsDirectory, "yoinks-ump-vendor")
    const projectVendor = Path.join(Script.directory, "python", "ump-vendor")
    results.vendorAppGroup = FileManager.existsSync(Path.join(appGroupVendor, "yt_dlp_plugins"))
    results.vendorProject = FileManager.existsSync(Path.join(projectVendor, "yt_dlp_plugins"))

    // 4. 无害恢复（从 vendor 覆盖回 usersite，验证复制机制与路径）
    const restored = await restoreYtseVendor(site)
    results.restore = restored
    if (!restored) throw new Error("备份恢复失败")

    // 5. 恢复后复检（force 重查）
    const ensure2 = await ensureYtseComponent({ force: true, allowNetworkInstall: false })
    results.ensure2 = ensure2
    if (!ensure2.ok) throw new Error(`恢复后复检失败：${ensure2.action}`)

    // 6. 最终工具状态
    const final = await getToolStatus()
    results.final = {
      ytDlpVersion: final.ytDlpVersion,
      ytseVersion: final.ytseVersion,
      ytsePatched: final.ytsePatched,
      ytseMissing: final.ytseMissing,
    }
    if (!final.ytsePatched) throw new Error("最终 UMP 组件未就绪")

    results.pass = true
  } catch (error) {
    results.pass = false
    results.error = error instanceof Error ? error.message : String(error)
  }
  Script.exit(results)
})()
