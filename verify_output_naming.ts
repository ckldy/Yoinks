import { Script } from "scripting"
import { safeOutputStem } from "./services/media"

const checks: Array<[string, boolean]> = [
  ["keeps readable title", safeOutputStem("示例 视频", "fallback") === "示例 视频"],
  ["removes forbidden filename characters", safeOutputStem('a/b:c*d?e"f<g>h|i', "fallback") === "a b c d e f g h i"],
  ["uses fallback for empty title", safeOutputStem("  . ", "fallback") === "fallback"],
  ["caps long title at 160 characters", safeOutputStem("a".repeat(161), "fallback").length === 160],
  ["trims dots and whitespace", safeOutputStem(" . 标题 . ", "fallback") === "标题"],
]

const failed = checks.filter(([, ok]) => !ok).map(([name]) => name)
if (failed.length) throw new Error(`Output naming checks failed: ${failed.join(", ")}`)
console.log(`Output naming checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
