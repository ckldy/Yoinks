import { Script } from "scripting"

const source = FileManager.readAsStringSync(`${Script.directory}/browser.tsx`)
const checks: Array<[string, boolean]> = [
  ["uses a 1.5 second capture delay", /const CAPTURE_DELAY_MS = 1500/.test(source)],
  ["top-level capture waits before scanning candidates", /await wait\(CAPTURE_DELAY_MS\)\s*\n\s*const topLevel = collectCandidates\(\)/.test(source)],
  ["frames wait before their local scan", /async function reportFrame[\s\S]*await wait\(CAPTURE_DELAY_MS\)[\s\S]*candidates: collectCandidates\(\)/.test(source)],
  ["uses a bounded frame report window", /const SESSION_WAIT_MS = 2600/.test(source)],
  ["uses an event-driven unique frame report slot", /const REPORT_STORAGE_KEY = "yoinks-media-candidates-frame-report-v1"/.test(source) && /activeReports\.set\(value\.reportId, value\)/.test(source)],
  ["clears temporary session and report values after capture", /finally \{[\s\S]*await GM\.setValue\(REPORT_STORAGE_KEY, null\)[\s\S]*await GM\.setValue\(SESSION_STORAGE_KEY, null\)/.test(source)],
  ["floating short press shows delayed-capture feedback", /showFloatingFeedback\(entry, "正在等待媒体地址…"\)[\s\S]*await captureCurrentPage\(\)/.test(source)],
  ["menu command starts the bounded capture session", /GM\.registerMenuCommand\("导入本页媒体候选到 Yoinks", captureCurrentPage\)/.test(source)],
  ["long press still cancels click capture", /if \(longPressTriggered\) return/.test(source)],
]
const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Safari delayed capture checks failed: ${failed.join(", ")}`)
console.log(`Safari delayed capture checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
