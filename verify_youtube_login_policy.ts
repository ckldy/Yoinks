import { Script } from "scripting"
import { isYouTubeBotCheckError, isYouTubeMembersOnlyError } from "./services/platform-auth"

const cases: Array<{ name: string; input: string; membersOnly: boolean; botCheck: boolean }> = [
  { name: "members-only 英文", input: "Join this channel to get access to members-only content", membersOnly: true, botCheck: false },
  { name: "members-only 中文", input: "成为此频道的会员即可观看会员专享的内容", membersOnly: true, botCheck: false },
  { name: "bot 风控", input: "Sign in to confirm you’re not a bot", membersOnly: false, botCheck: true },
  { name: "bot 风控(ascii)", input: "Sign in to confirm you're not a bot. Use --cookies-from-browser", membersOnly: false, botCheck: true },
  { name: "普通 403", input: "HTTP Error 403: Forbidden", membersOnly: false, botCheck: false },
]

let failed = 0
for (const c of cases) {
  const membersOnly = isYouTubeMembersOnlyError(c.input)
  const botCheck = isYouTubeBotCheckError(c.input)
  const ok = membersOnly === c.membersOnly && botCheck === c.botCheck
  if (!ok) failed += 1
  console.log(`${ok ? "✓" : "✗"} ${c.name}: membersOnly=${membersOnly} botCheck=${botCheck}`)
}
if (failed > 0) {
  console.error(`FAIL: ${failed}/${cases.length}`)
  Script.exit(1)
}
console.log(`PASS: youtube login policy detection (${cases.length} assertions)`)
Script.exit(0)
