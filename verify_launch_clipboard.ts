import { Script } from "scripting"
import { shouldInspectLaunchClipboard } from "./services/launch-clipboard"

function check(name: string, actual: boolean, expected = true) {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, got ${actual}`)
  console.log(`ok: ${name}`)
}

check("first idle launch can inspect", shouldInspectLaunchClipboard({ checked: false, suppressed: false, hasURL: false, analyzing: false, downloading: false, batchRunning: false }))
check("guard blocks repeated inspection", shouldInspectLaunchClipboard({ checked: true, suppressed: false, hasURL: false, analyzing: false, downloading: false, batchRunning: false }), false)
check("explicit URL blocks inspection", shouldInspectLaunchClipboard({ checked: false, suppressed: false, hasURL: true, analyzing: false, downloading: false, batchRunning: false }), false)
check("cleared-link suppression blocks inspection", shouldInspectLaunchClipboard({ checked: false, suppressed: true, hasURL: false, analyzing: false, downloading: false, batchRunning: false }), false)
check("analysis blocks inspection", shouldInspectLaunchClipboard({ checked: false, suppressed: false, hasURL: false, analyzing: true, downloading: false, batchRunning: false }), false)
check("download blocks inspection", shouldInspectLaunchClipboard({ checked: false, suppressed: false, hasURL: false, analyzing: false, downloading: true, batchRunning: false }), false)
check("batch blocks inspection", shouldInspectLaunchClipboard({ checked: false, suppressed: false, hasURL: false, analyzing: false, downloading: false, batchRunning: true }), false)

console.log("verify_launch_clipboard: 7/7 passed")
Script.exit()
