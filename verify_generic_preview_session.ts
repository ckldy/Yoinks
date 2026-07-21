import { Script } from "scripting"
import { cookieDomainMatchesPreviewHost, previewLoginHostname } from "./services/generic-preview-session"

const checks: Array<[string, boolean]> = [
  ["https host", previewLoginHostname("https://www.example.com/watch?v=1") === "www.example.com"],
  ["http host", previewLoginHostname("http://short.example.com/a") === "short.example.com"],
  ["non-http rejected", previewLoginHostname("file:///tmp/video.mp4") === null],
  ["IP rejected", previewLoginHostname("https://127.0.0.1/video") === null],
  ["invalid rejected", previewLoginHostname("not a url") === null],
  ["exact cookie domain", cookieDomainMatchesPreviewHost("example.com", "example.com")],
  ["parent cookie domain", cookieDomainMatchesPreviewHost(".example.com", "www.example.com")],
  ["subdomain cookie domain", cookieDomainMatchesPreviewHost("login.example.com", "example.com")],
  ["unrelated cookie domain", !cookieDomainMatchesPreviewHost("unrelated.test", "example.com")],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Generic preview session checks failed: ${failed.join(", ")}`)
console.log(`Generic preview session checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
