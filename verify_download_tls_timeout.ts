/**
 * Static checks: download TLS timeout detection + compactMessage.
 * Run: scripting-ts run verify_download_tls_timeout.ts
 */
import { Script } from "scripting"
import { compactMessage, isDownloadTlsTimeout } from "./services/media"

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

let passed = 0
function check(name: string, condition: boolean) {
  assert(condition, name)
  passed += 1
  console.log(`ok ${passed}: ${name}`)
}

const glued =
  "[download]  18.7% of   51.07MiB at  159.16KiB/s ETA 04:27ERROR: [download] Got error: _ssl.c:1015: The handshake operation timed out. Giving up after 3 retries Traceback (most recent call last): error=IDENTITY if not fatal else lambda e: self.report_error(f'\\r[download] Got error: {e}'),"

check("handshake timeout detected", isDownloadTlsTimeout(glued))
check(
  "Got error timed out detected",
  isDownloadTlsTimeout("ERROR: [download] Got error: The read operation timed out"),
)
check(
  "probe webpage timeout is not download-tls",
  !isDownloadTlsTimeout("ERROR: [generic] x: Unable to download webpage: timed out (caused by TransportError('timed out'))"),
)
check("empty not tls timeout", !isDownloadTlsTimeout(""))
check(
  "certificate verify not treated as handshake timeout alone",
  !isDownloadTlsTimeout("ERROR: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed"),
)

const friendly = compactMessage(glued)
check(
  "compactMessage prefers TLS handshake wording",
  friendly.includes("TLS") || friendly.includes("握手超时"),
)
check(
  "compactMessage does not leak IDENTITY traceback",
  !friendly.includes("IDENTITY") && !friendly.includes("report_error"),
)

const probeMsg = compactMessage(
  "ERROR: [generic] x: Unable to download webpage: timed out (caused by TransportError('timed out'))",
)
check("probe timeout keeps open-page wording", probeMsg.includes("打开页面超时") || probeMsg.includes("识别不到格式"))

const hostNoise = compactMessage("Write scripts settings successfully Write scripts settings successfully")
check("host noise message stays friendly", hostNoise.includes("宿主") || hostNoise.includes("重试"))

console.log(`\nverify_download_tls_timeout: ${passed}/9 passed`)
Script.exit({ passed })
