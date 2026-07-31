import { Script } from "scripting"

const source = FileManager.readAsStringSync(`${Script.directory}/browser.tsx`)
const checks: Array<[string, boolean]> = [
  ["uses a 1.5 second capture delay", /const CAPTURE_DELAY_MS = 1500/.test(source)],
  ["defines a delayed capture helper", /async function captureAfterDelay\(\): Promise<number>/.test(source)],
  ["waits before scanning candidates", /await new Promise<void>\(resolve => setTimeout\(resolve, CAPTURE_DELAY_MS\)\)[\s\S]*return captureCurrentPage\(\)/.test(source)],
  ["floating short press uses delayed capture", /showFloatingFeedback\(entry, "正在等待媒体地址…"\)[\s\S]*const count = await captureAfterDelay\(\)/.test(source)],
  ["menu command uses delayed capture", /GM\.registerMenuCommand\("导入本页媒体候选到 Yoinks", async \(\) => \{\s*await captureAfterDelay\(\)/.test(source)],
  ["long press still cancels click capture", /if \(longPressTriggered\) return/.test(source)],
]
const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Safari delayed capture checks failed: ${failed.join(", ")}`)
console.log(`Safari delayed capture checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
