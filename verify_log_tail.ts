import { Script } from "scripting"
import { retainLogTailWithinBytes } from "./services/logs"

const asciiLine = '{"event":"a"}\n'
const chineseLine = '{"title":"中文"}\n'
const checks: Array<[string, boolean]> = [
  ["retains complete tail rows", retainLogTailWithinBytes(`${asciiLine}${chineseLine}`, new TextEncoder().encode(chineseLine).length) === chineseLine],
  ["does not split multibyte text", retainLogTailWithinBytes(chineseLine, new TextEncoder().encode(chineseLine).length - 1) === ""],
  ["drops an oversized leading row", retainLogTailWithinBytes(`${chineseLine}${asciiLine}`, new TextEncoder().encode(asciiLine).length) === asciiLine],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Log tail checks failed: ${failed.join(", ")}`)
console.log(`Log tail checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
