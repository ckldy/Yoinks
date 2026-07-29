/**
 * Static checks: parseOutputPaths / listWorkMediaFiles / resolveDownloadedMediaPath.
 * Run: scripting-ts run verify_output_paths.ts
 */
import { Path, Script } from "scripting"
import {
  listWorkMediaFiles,
  parseOutputPaths,
  resolveDownloadedMediaPath,
} from "./services/media"

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

async function main() {
  let passed = 0
  function check(name: string, condition: boolean) {
    assert(condition, name)
    passed += 1
    console.log(`ok ${passed}: ${name}`)
  }

  // --- parseOutputPaths ---
  check(
    "plain absolute mp4 line",
    parseOutputPaths("/tmp/work/a [BV1].video.mp4\n").includes("/tmp/work/a [BV1].video.mp4"),
  )
  check(
    "m4s intermediate accepted",
    parseOutputPaths("/tmp/work/a [BV1].video.m4s").includes("/tmp/work/a [BV1].video.m4s"),
  )
  check(
    "Destination line parsed",
    parseOutputPaths("[download] Destination: /tmp/work/clip.mp4").includes("/tmp/work/clip.mp4"),
  )
  check(
    "already downloaded line parsed",
    parseOutputPaths("[download] /tmp/work/clip.mp4 has already been downloaded").includes("/tmp/work/clip.mp4"),
  )
  check(
    "merging formats quoted path",
    parseOutputPaths('[Merger] Merging formats into "/tmp/work/out.mp4"').includes("/tmp/work/out.mp4"),
  )
  check(
    "ignores host noise without path",
    parseOutputPaths("Write scripts settings successfully\nScript window host view deinit").length === 0,
  )
  check(
    "title with hash keeps local absolute path extension",
    parseOutputPaths("/tmp/work/foo#bar [id].video.mp4").includes("/tmp/work/foo#bar [id].video.mp4"),
  )

  // --- work directory fallback (real FS) ---
  const root = Path.join(FileManager.temporaryDirectory, `yoinks-verify-output-${Date.now()}`)
  await FileManager.createDirectory(root, true)
  const videoPath = Path.join(root, "demo [BV1].video.mp4")
  const audioPath = Path.join(root, "demo [BV1].audio.m4a")
  await FileManager.writeAsString(videoPath, "video-bytes")
  await FileManager.writeAsString(audioPath, "audio-bytes")

  const listed = listWorkMediaFiles(root)
  check("listWorkMediaFiles finds both streams", listed.length === 2)
  check(
    "listWorkMediaFiles nameHint filters video",
    listWorkMediaFiles(root, ".video.").length === 1 && listWorkMediaFiles(root, ".video.")[0] === videoPath,
  )

  const viaFallback = resolveDownloadedMediaPath({
    output: "Write scripts settings successfully",
    workDirectory: root,
    nameHint: ".video.",
  })
  check("resolve falls back to work dir video", viaFallback === videoPath)

  const viaStdout = resolveDownloadedMediaPath({
    output: `${audioPath}\n`,
    workDirectory: root,
    nameHint: ".video.",
  })
  check("resolve prefers existing stdout path", viaStdout === audioPath)

  const missing = resolveDownloadedMediaPath({
    output: "no paths here",
    workDirectory: Path.join(root, "empty-subdir-not-created"),
    nameHint: ".video.",
  })
  check("resolve empty when nothing exists", missing == null)

  try {
    FileManager.removeSync(root)
  } catch {}

  console.log(`\nverify_output_paths: ${passed}/12 passed`)
  Script.exit({ passed })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  Script.exit(1)
})
