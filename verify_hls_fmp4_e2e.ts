import { fetch, Path, Script } from "scripting"
import { downloadHlsSegmentsNative } from "./services/hls"
import { quote, runCommand } from "./services/shell-utils"

const FIXTURE_DIR = "/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripting-agent/workspace/6ED9B49B-4F31-4EFB-A9BE-AA98FC666578/hls-fixture-fmp4"
const WORK_ROOT = Path.join(FileManager.documentsDirectory, "Yoinks", "tmp", "hls-e2e-fmp4")

async function main(): Promise<void> {
  const checks: Array<[string, boolean]> = []
  const work = Path.join(WORK_ROOT, "work")
  const destination = Path.join(WORK_ROOT, "out.mp4")
  console.log("step: server start")
  const server = new HttpServer()
  server.registerFilesFromDirectory("/static/:file", FIXTURE_DIR)
  const startError = server.start({ port: 0, forceIPv4: true })
  if (startError) throw new Error(`HttpServer start failed: ${startError}`)
  console.log("step: server started port", server.port)
  const sourceURL = `http://127.0.0.1:${server.port}/static/playlist.m3u8`

  try {
    console.log("step: fetch playlist")
    const probe = await fetch(sourceURL)
    console.log("step: playlist status", probe.status)
    await probe.text() // 消费 body，避免悬挂连接阻止事件循环退出
    console.log("step: create work dir")
    if (FileManager.existsSync(WORK_ROOT)) FileManager.removeSync(WORK_ROOT)
    await FileManager.createDirectory(work, true)
    console.log("step: download start")
    const manifest = await downloadHlsSegmentsNative({
      sourceURL,
      destination,
      workDirectory: work,
      onProgress: (value) => console.log("  progress:", value.stage),
    })
    console.log("step: download done", JSON.stringify(manifest))

    checks.push(["fMP4 解密下载返回清单摘要", manifest !== undefined && manifest.endList && manifest.segmentCount === 2])
    checks.push(["输出 MP4 已生成", FileManager.existsSync(destination) && (FileManager.statSync(destination).size || 0) > 0])

    console.log("step: ffprobe")
    const probeResult = await runCommand(`ffprobe -v error -show_entries stream=codec_type -of csv=p=0 ${quote(destination)}`, 60)
    console.log("step: ffprobe exit", probeResult.exitCode, "out", JSON.stringify(probeResult.output))
    checks.push(["ffprobe 检测到视频流", /video/i.test(String(probeResult.output || "").trim())])

    console.log("step: check init + segments")
    checks.push(["EXT-X-MAP init 段已下载", FileManager.existsSync(Path.join(work, "seg_init.bin"))])
    // fMP4 分支为字节拼接：产物应以 init 段（ftyp）开头，证明 init 段置于最前
    const destData = FileManager.existsSync(destination) ? await FileManager.readAsData(destination) : null
    const destBytes = destData?.toUint8Array()
    const destType = destBytes ? String.fromCharCode(destBytes[4] || 0, destBytes[5] || 0, destBytes[6] || 0, destBytes[7] || 0) : ""
    console.log("step: concat head box type", destType)
    checks.push(["拼接产物以 init 段（ftyp/styp）开头", destType === "ftyp" || destType === "styp"])

    const firstSeg = Path.join(work, "seg_00000.ts")
    const segData = FileManager.existsSync(firstSeg) ? await FileManager.readAsData(firstSeg) : null
    const bytes = segData?.toUint8Array()
    const type = bytes ? String.fromCharCode(bytes[4] || 0, bytes[5] || 0, bytes[6] || 0, bytes[7] || 0) : ""
    console.log("step: decrypted seg box type", type)
    checks.push(["解密后分片为 fMP4 box", type === "styp" || type === "moof"])
  } catch (error) {
    console.log("step: caught error:", error instanceof Error ? error.message : String(error))
    checks.push(["端到端下载未抛错", false])
  } finally {
    console.log("step: server stop")
    server.stop()
  }

  console.log("step: cleanup")
  if (FileManager.existsSync(WORK_ROOT)) {
    try {
      FileManager.removeSync(WORK_ROOT)
    } catch (e) {
      console.log("cleanup error", e)
    }
  }
  const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
  if (failed.length) {
    console.error(`HLS fMP4 e2e checks failed: ${failed.join(", ")}`)
    Script.exit({ passed: 0 })
    return
  }
  console.log(`HLS fMP4 e2e checks passed (${checks.length})`)
  Script.exit({ passed: checks.length })
}

void main()
