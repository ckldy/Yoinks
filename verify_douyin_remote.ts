import { Script } from "scripting"
import { extractDetailQualities, remoteQualitiesToCandidates } from "./services/douyin-remote"

let passed = 0
let total = 0

function check(name: string, condition: boolean, detail?: string) {
  total += 1
  if (condition) {
    passed += 1
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`)
  } else {
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

function main() {
  const detailJSON = {
    aweme_detail: {
      aweme_id: "7674423673071296878",
      desc: "你能做到几条？ #10大强势法则",
      video: {
        play_addr: { url_list: ["https://v3-dy.douyinvod.com/a.mp4"], width: 720, height: 1280, url_key: "key-a" },
        play_addr_265: { url_list: ["https://v3-dy.douyinvod.com/a265.mp4"], width: 720, height: 1280, url_key: "key-a265" },
        download_addr: { url_list: ["https://v3-dy.douyinvod.com/dl.mp4"], width: 540, height: 960, url_key: "key-dl" },
        bit_rate: [
          { gear_name: "1080p", is_h265: false, bit_rate: 3149519, format: "mp4", play_addr: { url_list: ["https://v3-dy.douyinvod.com/1080.mp4"], width: 1080, height: 1920, url_key: "key-1080" } },
          { gear_name: "720p", is_h265: false, bit_rate: 1574892, format: "mp4", play_addr: { url_list: ["https://v3-dy.douyinvod.com/720.mp4"], width: 720, height: 1280, url_key: "key-720" } },
          { gear_name: "540p", is_h265: false, bit_rate: 786949, format: "mp4", play_addr: { url_list: ["https://v3-dy.douyinvod.com/540.mp4"], width: 540, height: 960, url_key: "key-540" } },
          { gear_name: "1080p_h265", is_h265: 1, bit_rate: 2200000, format: "mp4", play_addr: { url_list: ["https://v3-dy.douyinvod.com/1080-h265.mp4"], width: 1080, height: 1920, url_key: "key-1080-h265" } },
        ],
      },
    },
  }

  const result = extractDetailQualities(detailJSON)
  check("detail-parse-not-null", result !== null)
  if (!result) {
    console.log(`RESULT 0/${total}`)
    Script.exit("failed")
    return
  }
  check("detail-aweme-id", result.awemeId === "7674423673071296878", result.awemeId)
  check("detail-desc", result.desc.includes("10大强势法则"), result.desc)
  check("detail-quality-count", result.qualities.length >= 6, `count=${result.qualities.length}`)
  // 排序：最高分辨率在前（竖屏 1080p = height 1920；H.265 与 H.264 同高并列按码率）
  const top = result.qualities[0]
  check("detail-sorted-top-1080p", top !== undefined && top.height === 1920, `top=${top?.height}p ${top?.codec}`)
  const topH265 = result.qualities.find((q) => q.codec === "H.265" && q.height === 1920)
  check("detail-h265-present", Boolean(topH265), topH265?.label ?? "missing")
  // 去重：bit_rate 里没有与 play_addr 相同的 URL
  const urls = result.qualities.map((q) => q.url)
  check("detail-dedupe", new Set(urls).size === urls.length, `${urls.length} urls`)
  // 无 url_list 的 bit_rate 项被跳过
  const partial = extractDetailQualities({
    aweme_detail: {
      video: {
        play_addr: { url_list: ["https://x/a.mp4"] },
        bit_rate: [{ gear_name: "empty", play_addr: null }],
      },
    },
  })
  check("detail-skip-empty-bitrate", partial !== null && partial.qualities.length === 1, `count=${partial?.qualities.length}`)
  // 简化格式（douyin-quality.mjs 的中间产物）不是 Camoufox 原始 detail，不支持属预期
  const simplified = extractDetailQualities({
    aweme_id: "123",
    desc: "simplified",
    default_play: { url: "https://x/default.mp4", height: 720, width: 1280 },
    bit_rates: [{ bitrate: 1000000, h265: false, gear: "720p", height: 720, width: 1280, url: "https://x/br.mp4" }],
  })
  check("simplified-format-unsupported", simplified === null, "仅支持原始 aweme/detail 响应（含 video 字段）")

  // 候选生成
  if (result) {
    const candidates = remoteQualitiesToCandidates(result, { "User-Agent": "ua" }, "https://www.douyin.com/")
    check("candidates-count", candidates.length === result.qualities.length, `count=${candidates.length}`)
    check("candidates-label-remote-prefix", candidates[0]?.label.startsWith("remote_"), candidates[0]?.label ?? "missing")
    check("candidates-headers-referer", candidates[0]?.headers.Referer === "https://www.douyin.com/")
    check("candidates-headers-ua", candidates[0]?.headers["User-Agent"] === "ua")
  }

  // 空/非法输入
  check("null-input", extractDetailQualities(null) === null)
  check("no-video-input", extractDetailQualities({ aweme_detail: { desc: "x" } }) === null)

  console.log(`RESULT ${passed}/${total}`)
  Script.exit(passed === total ? "done" : "failed")
}

main()
