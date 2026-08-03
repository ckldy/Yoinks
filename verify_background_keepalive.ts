import { Script } from "scripting"

// 验证下载后台保活（BackgroundKeeper）接入：
// 1) services/background-keepalive.ts 存在，导出 beginDownloadKeepAlive
// 2) 引用计数：仅主 App 环境请求保活；最后一个持有者释放时才 stopKeepAlive
// 3) index.tsx 单链下载 startDownload 与批量下载 runOneDownload 均包裹保活
const keepAliveSource = FileManager.readAsStringSync(`${Script.directory}/services/background-keepalive.ts`)
const indexSource = FileManager.readAsStringSync(`${Script.directory}/index.tsx`)

const checks: Array<[string, boolean]> = [
  ["keepalive module exports beginDownloadKeepAlive", /export function beginDownloadKeepAlive\(\): \(\) => void/.test(keepAliveSource)],
  // 引用计数：并发多个下载时，最后一个释放才 stop
  ["ref count guards stopKeepAlive", /heldCount = Math\.max\(0, heldCount - 1\)/.test(keepAliveSource) && /if \(heldCount === 0 && requested\) \{/.test(keepAliveSource)],
  ["keepAlive requested only once until released", /if \(Script\.env === "index" && !requested\) \{/.test(keepAliveSource) && /requested = true/.test(keepAliveSource)],
  ["non-index env silently degrades", /Script\.env === "index"/.test(keepAliveSource)],
  ["release is idempotent", /let released = false\n\s*return \(\) => \{\n\s*if \(released\) return\n\s*released = true/.test(keepAliveSource)],
  // index.tsx 单链下载：try 前 begin，finally 里 release
  ["single download begins keepalive", /const releaseDownloadKeepAlive = beginDownloadKeepAlive\(\)\n\s*try \{\n\s*const platform = detectMediaPlatform\(validURL\)/.test(indexSource)],
  ["single download releases in finally", /finally \{\n\s*releaseDownloadKeepAlive\(\)\n\s*const platform = detectMediaPlatform\(validURL\)/.test(indexSource)],
  // index.tsx 批量下载：runOneDownload 内 begin + finally release
  ["batch download begins keepalive", /let cookieFile: string \| undefined\n\s*const releaseDownloadKeepAlive = beginDownloadKeepAlive\(\)/.test(indexSource)],
  ["batch download releases in finally", /finally \{\n\s*releaseDownloadKeepAlive\(\)\n\s*if \(cookieFile && !getImportedCookiePath\(\)\)/.test(indexSource)],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Background keepalive checks failed: ${failed.join(", ")}`)
console.log(`Background keepalive checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
