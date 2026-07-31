import { Script } from "scripting"
import { redactURL, safeText, shouldPersist, summarizeOutput } from "./services/logs"

const signedURL = "https://cdn.example.com/video.mp4?token=secret&expires=123"
const sanitized = safeText(`failed: ${signedURL} and https://example.com/page?session=private`)
const noisy = [
  "Script window host view deinit",
  "ERROR: [BiliBili] Unsupported URL",
  "WebViewController disposed.",
  "yt-dlp: HTTP Error 403",
].join("\n")

const checks: Array<[string, boolean]> = [
  ["redacts a URL query", redactURL(signedURL) === "https://cdn.example.com/video.mp4?[redacted]"],
  ["redacts every embedded URL query", sanitized === "failed: https://cdn.example.com/video.mp4?[redacted] and https://example.com/page?[redacted]"],
  ["redacts authorization header", safeText("Authorization: Bearer private-token") === "Authorization: [redacted]"],
  ["preserves UTF-8 path text", redactURL("https://example.com/中文?token=secret") === "https://example.com/中文?[redacted]"],
  ["summarizeOutput drops host noise", !summarizeOutput(noisy).includes("Script window host view deinit")],
  ["summarizeOutput keeps ERROR lines", /Unsupported URL/.test(summarizeOutput(noisy)) && /HTTP Error 403/.test(summarizeOutput(noisy))],
  ["persists launch clipboard acceptance", shouldPersist({ timestamp: "", level: "info", event: "clipboard-launch.accepted" })],
  ["persists automatic download selection", shouldPersist({ timestamp: "", level: "info", event: "auto-download.selected" })],
  ["persists Safari candidate import", shouldPersist({ timestamp: "", level: "info", event: "safari-candidate.imported" })],
  ["persists Safari page probe fallback", shouldPersist({ timestamp: "", level: "info", event: "safari-candidate.page-probe.fallback" })],
  ["persists direct media fallback", shouldPersist({ timestamp: "", level: "info", event: "probe.direct-media.fallback" })],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Log redaction checks failed: ${failed.join(", ")}`)
console.log(`Log redaction checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
