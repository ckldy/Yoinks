import { Script } from "scripting"

// 验证 downloadDirectSegmented（B站 durl / YouTube 直链分段下载）的取消与计数修复：
// 1) 读循环内每块数据前有取消检查点（原实现取消后需等整段读完，表现为「取消停止不下来」）
// 2) 段失败重试时从总计数扣除本段已写入字节（原实现重复计数导致「已下载 > 总大小」）
// 3) 取消错误不再静默 sleep 重试，立即向上抛出
const mediaSource = FileManager.readAsStringSync(`${Script.directory}/services/media.ts`)

const checks: Array<[string, boolean]> = [
  // 1) 读循环内取消检查点：while 循环体内先检查 isCancelFlagSet 再读块
  ["read loop checks cancel before each chunk", /while \(true\) \{\n\s*\/\/ 取消检查点：每块数据读取前检查/.test(mediaSource) && /if \(options\.isCancelFlagSet\(\)\) throw new Error\("下载已取消"\)/.test(mediaSource)],
  // 2) 段计数提到 attempt 循环外，失败重试时扣除
  ["segment byte counter hoisted outside attempt loop", /\/\/ 该段当前尝试已写入的字节数：失败重试前从总计数中扣除/.test(mediaSource) && /let size = 0\n\s*for \(let attempt = 0; attempt < 3; attempt \+= 1\)/.test(mediaSource)],
  ["each attempt resets segment counter", /size = 0\n\s*try \{\n\s*const controller = new AbortController\(\)/.test(mediaSource)],
  ["failed attempt deducts bytes from total counter", /\/\/ 扣除本段本次尝试已写入的字节（重试将重新下载整段），避免 downloaded 虚增/.test(mediaSource) && /downloaded = Math\.max\(0, downloaded - size\)/.test(mediaSource)],
  // 3) 取消错误直接抛出，不进入重试等待
  ["cancel error rethrown without retry sleep", /\/\/ 取消错误不再静默重试，立即向上抛出（取消时其他段也通过检查点退出）/.test(mediaSource) && /if \(options\.isCancelFlagSet\(\) \|\| \(error instanceof Error && error\.message === "下载已取消"\)\) throw error/.test(mediaSource)],
  // 回归：取消检查点仍在原有位置（worker 领取段前、attempt 开头、完成后）
  ["existing cancel checks preserved (worker loop)", /while \(assigned\.length > 0\) \{\n\s*const index = assigned\.shift\(\)!\n\s*if \(options\.isCancelFlagSet\(\)\) return/.test(mediaSource)],
  ["existing cancel checks preserved (post-download)", /if \(options\.isCancelFlagSet\(\)\) throw new Error\("下载已取消"\)\n\s*if \(segmentResults\.some/.test(mediaSource)],
  ["single-connection fallback still guarded", /if \(!segmented\) \{\n\s*await downloadURLToFileWithProgress/.test(mediaSource)],
  ["B站/YouTube segmented path still keyed on concurrentFragments", /isBilibiliDurlChoice\(options\.choice\) \|\| options\.choice\.id\.startsWith\("youtube-"\)\) && options\.concurrentFragments > 1/.test(mediaSource)],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Segmented cancel/counter checks failed: ${failed.join(", ")}`)
console.log(`Segmented cancel/counter checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
