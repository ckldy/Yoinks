import { Script } from "scripting"
import { publicPlayerFetchTimeoutMilliseconds } from "./services/media"

void (async () => {
  const checks: Array<[string, boolean]> = []
  const check = (name: string, passed: boolean) => checks.push([name, passed])

  check("no deadline uses the 12 s public-player budget", publicPlayerFetchTimeoutMilliseconds() === 12_000)
  check("expired deadline is 0 (fetch is skipped)", publicPlayerFetchTimeoutMilliseconds(Date.now() - 1000) === 0)
  const clamped = publicPlayerFetchTimeoutMilliseconds(Date.now() + 5000)
  check("clamps a future deadline to its remaining time", clamped > 4500 && clamped <= 5000)
  check("clamps a deadline longer than the budget to 12 s", publicPlayerFetchTimeoutMilliseconds(Date.now() + 60_000) === 12_000)

  const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
  if (failed.length) throw new Error(`Public player deadline checks failed: ${failed.join(", ")}`)
  console.log(`Public player deadline checks passed (${checks.length})`)
  Script.exit({ passed: checks.length })
})().catch((error) => Script.exit({ error: error instanceof Error ? error.message : String(error) }))
