import { Script } from "scripting"
import { quote } from "./services/media"

const checks: Array<[string, boolean]> = [
  ["keeps apostrophes inside one double-quoted argument", quote("/Downloads/You probably don't realize.mp4") === `"/Downloads/You probably don't realize.mp4"`],
  ["escapes backslashes and double quotes", quote('/Downloads/a "quoted" file.mp4') === '"/Downloads/a \\\"quoted\\\" file.mp4"'],
  ["preserves spaces, Chinese, and shell metacharacters", quote("/Downloads/中文 # ? & (test).mp4") === '"/Downloads/中文 # ? & (test).mp4"'],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Shell quote checks failed: ${failed.join(", ")}`)
console.log(`Shell quote checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
