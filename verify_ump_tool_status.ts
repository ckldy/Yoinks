// verify_ump_tool_status.ts — 验证 getToolStatus 的 UMP 组件检测（只读，不安装）
import { Script } from "scripting"
import { getToolStatus } from "./services/media"

void (async () => {
  try {
    const status = await getToolStatus()
    Script.exit({
      ytDlpVersion: status.ytDlpVersion,
      ytseVersion: status.ytseVersion,
      ytsePatched: status.ytsePatched,
      ytseMissing: status.ytseMissing,
    })
  } catch (error) {
    Script.exit({ error: error instanceof Error ? error.message : String(error) })
  }
})()
