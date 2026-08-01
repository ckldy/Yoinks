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
  ["long press still cancels click capture", /if \(longPressTriggered \|\| suppressClick\) \{ suppressClick = false; return \}/.test(source)],
  ["click triggers playback synchronously inside the user gesture", /showFloatingFeedback\(entry, "正在等待媒体地址…"\)[\s\S]*triggerPlaybackIfIdle\(\)[\s\S]*await captureCurrentPage\(\)/.test(source)],
  ["playback trigger calls video.play and clicks player container", /function triggerPlaybackIfIdle[\s\S]*video\.play\(\)[\s\S]*dispatchEvent\(new MouseEventCtor\("click"/.test(source)],
  ["capture returns waitingForPlayback when player idle", /Promise<\{ count: number; hasFrameClue: boolean; waitingForPlayback\?: boolean \}>/.test(source) && /\.\.\.\(candidates\.length === 0 && hasMediaElement\(\) \? \{ waitingForPlayback: true \} : \{\}\)/.test(source)],
  ["listens for playback media then recaptures", /const startMedia = collectMediaLikeURLs\(\)[\s\S]*const listenDeadline = Date\.now\(\) \+ LISTEN_TIMEOUT_MS[\s\S]*collectMediaLikeURLs\(\)\.size > startMedia\.size \|\| videoStarted\(\)[\s\S]*candidatesAfterPlayback[\s\S]*GM\.setValue\(STORAGE_KEY, envelopeAfter\)/.test(source)],
  ["waiting-for-playback feedback is user-facing", /showFloatingFeedback\(entry, result\.count \? `已捕获 \$\{result\.count\} 个候选` : result\.waitingForPlayback \? "请点击页面播放按钮，播放后自动捕获"/.test(source)],
  ["listens when main media src is unresolved even with preview candidates", /if \(hasMediaElement\(\) && !mainMediaResolved\(\)\)/.test(source) && /function mainMediaResolved[\s\S]*currentSrc \|\| element\.src/.test(source)],
  ["version bumped to 1.1.9", /\/\/ @version 1\.1\.9/.test(source)],
]
const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Safari delayed capture checks failed: ${failed.join(", ")}`)
console.log(`Safari delayed capture checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
