import { Script } from "scripting"
import { resolveInitialMediaChoice, type MediaChoice } from "./services/media"

const video = (id: string): MediaChoice => ({ id, label: id, kind: "video", formatExpression: id })
const audio = (id: string): MediaChoice => ({ id, label: id, kind: "audio", formatExpression: id })

const checks: Array<[string, boolean]> = [
  ["auto-loads the only video alongside audio alternatives", resolveInitialMediaChoice([video("v1"), audio("a1"), audio("a2")])?.id === "v1"],
  ["does not auto-load when multiple videos are available", resolveInitialMediaChoice([video("v1"), video("v2"), audio("a1")]) === null],
  ["does not auto-load audio-only probes", resolveInitialMediaChoice([audio("a1")]) === null],
  ["does not auto-load an empty probe", resolveInitialMediaChoice([]) === null],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Initial media choice checks failed: ${failed.join(", ")}`)
console.log(`Initial media choice checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
