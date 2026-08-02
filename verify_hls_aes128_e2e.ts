import { Path, Script } from "scripting"
import { downloadHlsSegmentsNative } from "./services/hls"
import { quote, runCommand } from "./services/shell-utils"

// 端到端：AES-128 加密 HLS → 原生下载 → 解密 → ffmpeg 合成 → ffprobe 验证有视频流。
// fixture 由 ffmpeg(h264_videotoolbox) 生成真实 TS 分片，node crypto 按 HLS 规范
// AES-128-CBC 加密（默认序号 IV），清单含 #EXT-X-KEY:METHOD=AES-128（无显式 IV）。

const FIXTURE_DIR = "/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripting-agent/workspace/6ED9B49B-4F31-4EFB-A9BE-AA98FC666578/hls-fixture"
const WORK_ROOT = Path.join(FileManager.documentsDirectory, "Yoinks", "tmp", "hls-e2e-aes128")

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
    if (FileManager.existsSync(WORK_ROOT)) FileManager.removeSync(WORK_ROOT)
    await FileManager.createDirectory(work, true)

    const stages: string[] = []
    const manifest = await downloadHlsSegmentsNative({
      sourceURL,
      destination,
      workDirectory: work,
      onProgress: (value) => stages.push(value.stage),
    })

    checks.push(["解密下载返回清单摘要", manifest !== undefined && manifest.endList && manifest.segmentCount === 3])
    checks.push(["输出 MP4 已生成", FileManager.existsSync(destination) && (FileManager.statSync(destination).size || 0) > 0])

    // ffprobe 校验真实视频流（解密 + concat 正确性：错误 key 会导致无法解析/无流）
    const probe = await runCommand(`ffprobe -v error -show_entries stream=codec_type -of csv=p=0 ${quote(destination)}`, 60)
    const types = String(probe.output || "").trim()
    checks.push(["ffprobe 检测到视频流", /video/i.test(types)])
    checks.push(["ffprobe 检测到音频流", /audio/i.test(types)])

    // 加密路径进度文案
    checks.push(["加密路径使用解密进度文案", stages.some((s) => s.includes("下载并解密分片"))])

    // 解密后分片首字节应为 TS 同步字节（0x47），直接验证产物质量而非仅依赖 ffprobe
    const firstSeg = Path.join(work, "seg_00000.ts")
    const segData = FileManager.existsSync(firstSeg) ? await FileManager.readAsData(firstSeg) : null
    checks.push(["解密后分片以 0x47 开头", segData !== null && segData.toUint8Array()?.[0] === 0x47])
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
  if (failed.length) throw new Error(`HLS AES-128 e2e checks failed: ${failed.join(", ")}`)
  console.log(`HLS AES-128 e2e checks passed (${checks.length})`)
  Script.exit({ passed: checks.length })
}

void main()
