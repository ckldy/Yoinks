import { Script } from "scripting"

// 验证下载完成通知：
// 1) services/download-notify.ts 导出三个通知函数，模块加载即注册 scenePhase 监听
// 2) 仅后台（scenePhase !== active）+ 开关开启时发送；前台/关闭开关不打扰
// 3) index.tsx 单链成功/失败/批量完成接入；设置页有开关 Toggle
// 4) preferences 含 notifyDownloadComplete 字段（默认 true）
const notifySource = FileManager.readAsStringSync(`${Script.directory}/services/download-notify.ts`)
const indexSource = FileManager.readAsStringSync(`${Script.directory}/index.tsx`)
const prefsSource = FileManager.readAsStringSync(`${Script.directory}/services/preferences.ts`)

const checks: Array<[string, boolean]> = [
  // 模块导出
  ["exports notifyDownloadComplete", /export async function notifyDownloadComplete/.test(notifySource)],
  ["exports notifyDownloadFailed", /export async function notifyDownloadFailed/.test(notifySource)],
  ["exports notifyBatchFinished", /export async function notifyBatchFinished/.test(notifySource)],
  // 监听在模块加载时注册（不依赖首次下载）
  ["scenePhase listener registered at module load", /\/\/ 模块加载即注册监听：确保任何时刻 scenePhase 都是最新的/.test(notifySource) && /AppEvents\.scenePhase\.addListener/.test(notifySource)],
  ["listener registration guarded for verify env", /AppEvents\.scenePhase\.addListener\(\(phase\) => \{[\s\S]{0,120}catch \{/.test(notifySource)],
  // 仅后台发送
  ["only sends when background", /function isBackground\(\): boolean \{[\s\S]{0,120}currentPhase === "background" \|\| currentPhase === "inactive"/.test(notifySource)],
  ["background gate before schedule", /if \(!isBackground\(\)\) return false\n\s*return sendNotification/.test(notifySource)],
  // 开关
  ["respects preference toggle", /if \(!getPreferences\(\)\.notifyDownloadComplete\) return false/.test(notifySource)],
  // 点击通知不重开实例：tapAction 必须是 none（runScript 会新开一个 Yoinks）
  ["tap on notification only foregrounds app (no runScript)", /tapAction: "none"/.test(notifySource) && !/\.tapAction: \{ type: "runScript"/.test(notifySource)],
  ["preferences field with default true", /notifyDownloadComplete: boolean/.test(prefsSource) && /notifyDownloadComplete: true,/.test(prefsSource)],
  // index.tsx 接入
  ["single download success notifies", /setStatus\(saveMessage \|\| "下载完成。"\)\n\s*\/\/ App 在后台时通知下载完成（前台不打扰，界面已有状态显示）\n\s*await notifyDownloadComplete\(downloaded\.fileName\)/.test(indexSource)],
  ["single download failure notifies (not on cancel)", /if \(message !== "下载已取消"\) \{\n\s*await notifyDownloadFailed\(/.test(indexSource)],
  ["batch finished notifies", /event: "batch\.finished",[\s\S]{0,160}await notifyBatchFinished\(ok, fail, cancelledCount\)/.test(indexSource)],
  ["settings toggle exists", /<Toggle title="后台下载完成通知" systemImage="bell\.badge" value=\{preferences\.notifyDownloadComplete\}/.test(indexSource)],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Download notify checks failed: ${failed.join(", ")}`)
console.log(`Download notify checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
