/**
 * Static checks for probe resilience helpers (deinit noise + fresh cookies + transient).
 * Run: scripting-ts run verify_probe_resilience.ts
 */
import { Script } from "scripting"
import { isHostDeinitNoise, isTransientProbeFailure } from "./services/media"
import { isFreshCookieError } from "./services/platform-auth"

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

let passed = 0
function check(name: string, condition: boolean) {
  assert(condition, name)
  passed += 1
  console.log(`ok ${passed}: ${name}`)
}

check(
  "deinit only is noise",
  isHostDeinitNoise("Script window host view deinit Script window host view deinit"),
)
check(
  "WebView log only is noise",
  isHostDeinitNoise("[WebView][LOG] [c0]"),
)
check(
  "real ERROR is not noise",
  !isHostDeinitNoise("ERROR: [Douyin] x: Fresh cookies (not necessarily logged in) are needed"),
)
check(
  "mixed deinit + ERROR is not pure noise",
  !isHostDeinitNoise("Script window host view deinit\nERROR: [Douyin] x: Fresh cookies are needed"),
)
check(
  "empty is not noise",
  !isHostDeinitNoise(""),
)
check(
  "timeout is transient",
  isTransientProbeFailure("[vm.tiktok] ZP8: Unable to download webpage: timed out (caused by TransportError('timed out'))"),
)
check(
  "WebView log is transient",
  isTransientProbeFailure("[WebView][LOG] [c0]"),
)
check(
  "fresh cookies not transient",
  !isTransientProbeFailure("[Douyin] x: Fresh cookies (not necessarily logged in) are needed"),
)
check(
  "fresh cookies phrase",
  isFreshCookieError("[Douyin] 766: Fresh cookies (not necessarily logged in) are needed"),
)
check(
  "login required phrase",
  isFreshCookieError("login required to download"),
)
check(
  "unrelated SSL not cookie",
  !isFreshCookieError("SSL: CERTIFICATE_VERIFY_FAILED"),
)

console.log(`\nverify_probe_resilience: ${passed}/11 passed`)
Script.exit({ passed })
