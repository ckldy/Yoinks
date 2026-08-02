import { fetch, Path, Script } from "scripting"
import { downloadHlsSegmentsNative } from "./services/hls"
import { quote, runCommand } from "./services/shell-utils"

// 端到端：#EXT-X-BYTERANGE 分片（单文件按字节范围分片）→ Range 下载 → TS concat → ffprobe 验证。
// fixture：ffmpeg 生成单个 TS 文件，node 按 188 字节对齐切成 2 段，m3u8 用 BYTERANGE 引用同一文件。

const FIXTURE_DIR = "/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripting-agent/workspace/6ED9B49B-4F31-4EFB-A9BE-AA98FC666578/hls-fixture-byterange"
const WORK_ROOT = Path.join(FileManager.documentsDirectory, "Yoinks", "tmp", "hls-e2e-byterange")

async function main(): Promise<void> {
  const checks: Array<[string, boolean]> = []
  const work = Path.join(WORK_ROOT, "work")
  const destination = Path.join(WORK_ROOT, "out.mp4")

  const server = new HttpServer()
  server.registerFilesFromDirectory("/static/:file", FIXTURE_DIR)
  const startError = server.start({ port: 0, forceIPv4: true })
  if (startError) throw new Error(`HttpServer start failed: ${startError}`)
  const sourceURL = `http://127.0.0.1:${server.port}/static/playlist.m3u8`

  try {
    const probe = await fetch(sourceURL)
    await probe.text() // 消费 body
    if (FileManager.existsSync(WORK_ROOT)) FileManager.removeSync(WORK_ROOT)
    await FileManager.createDirectory(work, true)

    const manifest = await downloadHlsSegmentsNative({ sourceURL, destination, workDirectory: work })

    checks.push(["BYTERANGE 下载返回清单摘要", manifest !== undefined && manifest.endList && manifest.segmentCount === 2])
    checks.push(["输出 MP4 已生成", FileManager.existsSync(destination) && (FileManager.statSync(destination).size || 0) > 0])

    const probeResult = await runCommand(`ffprobe -v error -show_entries stream=codec_type -of csv=p=0 ${quote(destination)}`, 60)
    const types = String(probeResult.output || "").trim()
    checks.push(["ffprobe 检测到视频流", /video/i.test(types)])
    checks.push(["ffprobe 检测到音频流", /audio/i.test(types)])

    // 两个分段都写盘（Range 拉取成功）
    checks.push(["分段 1 已写盘", FileManager.existsSync(Path.join(work, "seg_00000.ts"))])
    checks.push(["分段 2 已写盘", FileManager.existsSync(Path.join(work, "seg_00001.ts"))])
  } catch (error) {
    checks.push(["端到端下载未抛错", false])
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
    console.error(`HLS BYTERANGE e2e checks failed: ${failed.join(", ")}`)
    Script.exit({ passed: 0 })
    return
  }
  console.log(`HLS BYTERANGE e2e checks passed (${checks.length})`)
  Script.exit({ passed: checks.length })
}

void main()
