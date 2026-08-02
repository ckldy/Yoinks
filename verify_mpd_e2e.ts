import { fetch, Path, Script } from "scripting"
import { downloadMpdNative } from "./services/mpd"
import { quote, runCommand } from "./services/shell-utils"

// 端到端：DASH MPD（SegmentTemplate，视频轨 + 音频轨）→ MPD→m3u8 桥接 → 视频/音频轨分别
// 走 HLS 分片管线（fMP4 字节拼接）→ ffmpeg 合并 → ffprobe 验证 video + audio。
// fixture：ffmpeg fmp4 生成 init_v.mp4/v0-*.m4s（视频）与 init_a.mp4/a0-*.m4s（音频），manifest.mpd 引用。

const FIXTURE_DIR = "/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripting-agent/workspace/6ED9B49B-4F31-4EFB-A9BE-AA98FC666578/mpd-fixture"
const WORK_ROOT = Path.join(FileManager.documentsDirectory, "Yoinks", "tmp", "mpd-e2e")

async function main(): Promise<void> {
  const checks: Array<[string, boolean]> = []
  const work = Path.join(WORK_ROOT, "work")
  const destination = Path.join(WORK_ROOT, "out.mp4")

  const server = new HttpServer()
  server.registerFilesFromDirectory("/static/:file", FIXTURE_DIR)
  const startError = server.start({ port: 0, forceIPv4: true })
  if (startError) throw new Error(`HttpServer start failed: ${startError}`)
  const sourceURL = `http://127.0.0.1:${server.port}/static/manifest.mpd`

  try {
    const probe = await fetch(sourceURL)
    await probe.text() // 消费 body
    if (FileManager.existsSync(WORK_ROOT)) FileManager.removeSync(WORK_ROOT)
    await FileManager.createDirectory(work, true)

    const manifest = await downloadMpdNative({ sourceURL, destination, workDirectory: work })

    checks.push(["MPD 下载返回视频轨清单摘要", manifest !== undefined && manifest.endList && manifest.segmentCount === 2])
    checks.push(["输出 MP4 已生成", FileManager.existsSync(destination) && (FileManager.statSync(destination).size || 0) > 0])

    const probeResult = await runCommand(`ffprobe -v error -show_entries stream=codec_type -of csv=p=0 ${quote(destination)}`, 60)
    const types = String(probeResult.output || "").trim()
    checks.push(["ffprobe 检测到视频流", /video/i.test(types)])
    checks.push(["ffprobe 检测到音频流（音视频合并成功）", /audio/i.test(types)])

    // 中间产物：视频轨与音频轨分别下载
    checks.push(["视频轨中间文件已生成", FileManager.existsSync(Path.join(work, "mpd_video.mp4"))])
    checks.push(["音频轨中间文件已生成", FileManager.existsSync(Path.join(work, "mpd_audio.mp4"))])
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
    console.error(`MPD e2e checks failed: ${failed.join(", ")}`)
    Script.exit({ passed: 0 })
    return
  }
  console.log(`MPD e2e checks passed (${checks.length})`)
  Script.exit({ passed: checks.length })
}

void main()
