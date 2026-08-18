// verify_remote_xiaohongshu.ts — 小红书配方验证（match 逻辑 + URL 提取 + 缺 token 检测 + 真实 e2e）
import { Script } from "scripting"
import { resolveRemoteMedia } from "./services/remote-resolver"
import { xiaohongshuRecipe } from "./services/recipes/xiaohongshu"
import { extractFirstURL, xiaohongshuMissingToken } from "./services/media"
import { getPreferences } from "./services/preferences"

let passed = 0
let total = 0
function check(name: string, condition: boolean, detail?: string) {
  total += 1
  if (condition) { passed += 1; console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`) }
  else { console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`) }
}

async function main() {
  // 1. match 逻辑
  check("match-xhslink", xiaohongshuRecipe.match("https://xhslink.com/a/abc123") === true)
  check("match-xhslink-cn", xiaohongshuRecipe.match("https://xhslink.cn/o/6TE5M3UWw0o") === true)
  check("match-xhs-explore", xiaohongshuRecipe.match("https://www.xiaohongshu.com/explore/6a664b84000000000401fb29?xsec_token=xx") === true)
  check("match-xhs-share", xiaohongshuRecipe.match("https://www.xiaohongshu.com/discovery/item/6a664b84000000000401fb29") === true)
  check("match-not-douyin", xiaohongshuRecipe.match("https://www.douyin.com/video/123") === false)
  check("match-not-youtube", xiaohongshuRecipe.match("https://www.youtube.com/watch?v=abc") === false)
  check("ipbound-false", xiaohongshuRecipe.ipBound === false)

  // 1.5 URL 提取完整性（xsec_token 不能被清洗/截断）与缺 token 前置检测
  const TOKEN = "AB6eCQXuMXxbKUV6r00umgi_AS5z7B_XKrgxsYGVYtLio="
  const FULL = `https://www.xiaohongshu.com/discovery/item/6a5d8852000000000503afdc?xsec_token=${TOKEN}&xsec_source=pc_share`
  check("extract-url-token", extractFirstURL(FULL) === FULL)
  check("extract-url-share-text", extractFirstURL(`复制打开小红书！ ${FULL}，复制此链接`) === FULL)
  check("extract-url-xhslink-cn", extractFirstURL(`分享：https://xhslink.cn/o/6TE5M3UWw0o 复制打开`) === "https://xhslink.cn/o/6TE5M3UWw0o")
  check("missing-token-detected", xiaohongshuMissingToken("https://www.xiaohongshu.com/discovery/item/6a6043d2000000000f01f88b?source=webshare&xhsshare=WeChatSession&xsec_source=pc_share") === true)
  check("missing-token-with-token", xiaohongshuMissingToken(FULL) === false)
  check("missing-token-xhslink-cn", xiaohongshuMissingToken("https://xhslink.cn/o/6TE5M3UWw0o") === false)

  // 2. 真实 e2e（带 xsec_token 的视频笔记）
  const preferences = getPreferences()
  if (!preferences.douyinRemoteToken) {
    console.log("SKIP e2e: 未配置 douyinRemoteToken")
    Script.exit(passed === total ? "done" : "failed")
    return
  }
  const config = { enabled: true, endpoint: preferences.douyinRemoteEndpoint, token: preferences.douyinRemoteToken }
  const t1 = Date.now()
  const result = await resolveRemoteMedia({
    config,
    url: "https://www.xiaohongshu.com/explore/6a664b84000000000401fb29?xsec_token=AB6eCQXuMXxbKUV6r00umgi_AS5z7B_XKrgxsYGVYtLio=",
    log: (m) => console.log(`[xhs] ${m}`),
    noCache: true,
  })
  console.log(`e2e: ${((Date.now() - t1) / 1000).toFixed(1)}s`)
  check("e2e-not-null", result !== null)
  if (result) {
    check("e2e-platform", result.platform === "xiaohongshu", result.platform)
    check("e2e-title", result.title.length > 0, result.title.slice(0, 40))
    check("e2e-candidates-1", result.candidates.length === 1, `count=${result.candidates.length}`)
    const c = result.candidates[0]
    check("e2e-kind-mp4", c.kind === "mp4", c.kind)
    check("e2e-url-xhscdn", /xhscdn\.com\/stream\//.test(c.url), c.url.slice(0, 80))
    console.log(`  url: ${c.url.slice(0, 120)}`)
    console.log(`  title: ${result.title.slice(0, 60)}`)
  }

  // 3. 无 token 裸 URL → 应返回 null（404 拦截）
  const t2 = Date.now()
  const noToken = await resolveRemoteMedia({
    config,
    url: "https://www.xiaohongshu.com/explore/6a445db70000000022008cbc",
    log: (m) => console.log(`[xhs-notoken] ${m}`),
    noCache: true,
  })
  console.log(`noToken: ${((Date.now() - t2) / 1000).toFixed(1)}s`)
  check("e2e-notoken-null", noToken === null)

  Script.exit(passed === total ? "done" : "failed")
}

main().catch((error) => {
  console.log(`main error ${error instanceof Error ? error.message : String(error)}`)
  Script.exit("failed")
})
