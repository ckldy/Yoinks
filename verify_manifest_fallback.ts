import { fetch, Path, Script } from "scripting"
import { downloadHlsSegmentsNative } from "./services/hls"
import { quote, runCommand } from "./services/shell-utils"
import { sanitizeSafariMediaCandidates } from "./services/safari-media-candidates"

// 端到端：清单端点 404 时，downloadHlsSegmentsNative 用采集器运行时代理捕获的
// manifestFallbackText 兜底（fetch 失败 → 用 #EXTM3U 文本）→ 分片正常下载 → ffprobe 验证。
// fixture：复用 hls-fixture 目录的 playlist.m3u8 / seg_*.ts（由现有 make_fixture 生成）。

const FIXTURE_DIR = "/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripting-agent/workspace/6ED9B49B-4F31-4EFB-A9BE-AA98FC666578/hls-fixture"
const WORK_ROOT = Path.join(FileManager.documentsDirectory, "Yoinks", "tmp", "manifest-fallback-e2e")

async function main(): Promise<void> {
  const checks: Array<[string, boolean]> = []
  const work = Path.join(WORK_ROOT, "work")
  const destination = Path.join(WORK_ROOT, "out.mp4")

  const server = new HttpServer()
  server.registerFilesFromDirectory("/static/:file", FIXTURE_DIR)
  const startError = server.start({ port: 0, forceIPv4: true })
  if (startError) throw new Error(`HttpServer start failed: ${startError}`)
  // 清单端点故意 404：分片仍可访问，清单文本来自 fallback。
  const missingManifestURL = `http://127.0.0.1:${server.port}/static/nonexistent.m3u8`

  try {
    const fallbackText = await readFallbackText(FIXTURE_DIR)
    if (!fallbackText) throw new Error("fallback fixture missing")

    // 确认清单端点确实 404（否则测试无意义）
    const probe404 = await fetch(missingManifestURL)
    const probe404ok = probe404.status === 404
    await probe404.text()
    checks.push(["清单端点确实 404", probe404ok])

    if (FileManager.existsSync(WORK_ROOT)) FileManager.removeSync(WORK_ROOT)
    await FileManager.createDirectory(work, true)

    const manifest = await downloadHlsSegmentsNative({
      sourceURL: missingManifestURL,
      destination,
      workDirectory: work,
      manifestFallbackText: fallbackText,
    })

    checks.push(["fallback 清单解析成功（404 兜底）", manifest !== undefined && manifest.endList && manifest.segmentCount === 3])
    checks.push(["输出 MP4 已生成", FileManager.existsSync(destination) && (FileManager.statSync(destination).size || 0) > 0])
    const probeResult = await runCommand(`ffprobe -v error -show_entries stream=codec_type -of csv=p=0 ${quote(destination)}`, 60)
    const types = String(probeResult.output || "").trim()
    checks.push(["ffprobe 检测到视频流", /video/i.test(types)])

    // —— sanitize 白名单单测 ——
    const validEnvelope = sanitizeSafariMediaCandidates({
      version: 1,
      pageURL: "https://example.com/watch",
      capturedAt: Date.now(),
      candidates: [{ id: "c1", url: "https://cdn.example/stream?id=1", kind: "hls", pageURL: "https://example.com/watch" }],
      manifestCache: { "https://cdn.example/stream?id=1": "#EXTM3U\n#EXTINF:2,\nseg.ts\n#EXT-X-ENDLIST\n" },
    })
    checks.push(["sanitize 接受合法 manifestCache", validEnvelope?.manifestCache?.["https://cdn.example/stream?id=1"]?.startsWith("#EXTM3U") === true])

    const htmlInjected = sanitizeSafariMediaCandidates({
      version: 1,
      pageURL: "https://example.com/watch",
      capturedAt: Date.now(),
      candidates: [{ id: "c1", url: "https://cdn.example/stream?id=1", kind: "hls", pageURL: "https://example.com/watch" }],
      manifestCache: { "https://cdn.example/stream?id=1": "<html><script>alert(1)</script></html>" },
    })
    checks.push(["sanitize 拒绝非 #EXTM3U 文本", !htmlInjected?.manifestCache])

    const tooLarge = sanitizeSafariMediaCandidates({
      version: 1,
      pageURL: "https://example.com/watch",
      capturedAt: Date.now(),
      candidates: [{ id: "c1", url: "https://cdn.example/stream?id=1", kind: "hls", pageURL: "https://example.com/watch" }],
      manifestCache: { "https://cdn.example/stream?id=1": "#EXTM3U\n" + "x".repeat(600 * 1024) },
    })
    checks.push(["sanitize 拒绝超长清单文本", !tooLarge?.manifestCache])

    const manyEntries = sanitizeSafariMediaCandidates({
      version: 1,
      pageURL: "https://example.com/watch",
      capturedAt: Date.now(),
      candidates: [{ id: "c1", url: "https://cdn.example/stream?id=1", kind: "hls", pageURL: "https://example.com/watch" }],
      manifestCache: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`https://cdn.example/m${i}.m3u8`, "#EXTM3U\n"])) as Record<string, string>,
    })
    checks.push(["sanitize 限制 manifestCache ≤3 条", !manyEntries?.manifestCache || Object.keys(manyEntries.manifestCache).length <= 3])

    const runtimeSource = sanitizeSafariMediaCandidates({
      version: 1,
      pageURL: "https://example.com/watch",
      capturedAt: Date.now(),
      candidates: [{ id: "c1", url: "https://cdn.example/stream?id=1", kind: "hls", pageURL: "https://example.com/watch", source: "runtime" }],
    })
    checks.push(["sanitize 保留 runtime 来源", runtimeSource?.candidates[0]?.captureSource === "runtime"])
  } catch (error) {
    checks.push(["端到端未抛错", false])
    console.error("e2e error:", error instanceof Error ? error.message : String(error))
  } finally {
    server.stop()
  }

  if (FileManager.existsSync(WORK_ROOT)) {
    try {
      FileManager.removeSync(WORK_ROOT)
    } catch {}
  }
  const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
  if (failed.length) {
    console.error(`Manifest fallback checks failed: ${failed.join(", ")}`)
    Script.exit({ passed: 0 })
    return
  }
  console.log(`Manifest fallback checks passed (${checks.length})`)
  Script.exit({ passed: checks.length })
}

function readFallbackText(dir: string): Promise<string | undefined> {
  return FileManager.readAsString(Path.join(dir, "playlist.m3u8")).catch(() => undefined)
}

void main()
