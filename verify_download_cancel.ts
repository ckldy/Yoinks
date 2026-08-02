import { Script } from "scripting"

const mediaSource = FileManager.readAsStringSync(`${Script.directory}/services/media.ts`)
// HLS 分片下载器已拆分到 services/hls.ts；下载器相关断言读 hls.ts，
// downloadMedia 的 m3u8 分支与引擎检查等仍读 media.ts / index.tsx。
const hlsSource = FileManager.readAsStringSync(`${Script.directory}/services/hls.ts`)

// 与 downloadHlsSegmentsNative 加密检测一致的正则（METHOD=NONE 显式无加密，不算加密）。
const KEY_ENCRYPTED = /^\s*#EXT-X-KEY:[^\r\n]*METHOD\s*=\s*(?!NONE\b)\S+/im
const KEY_ANY = /^\s*#EXT-X-KEY:/m

const checks: Array<[string, boolean]> = [
  // curl 分批模式：批次缩小，取消响应最快一个批次
  ["curl batches shrink to 30 segments", /const BATCH = 30/.test(hlsSource)],
  ["batch loop still stops when cancel flag is set", /for \(let start = 0; start < count && !options\.isCancelFlagSet\?\.\(\); start \+= BATCH\)/.test(hlsSource)],
  // 每片与整体超时收短：批内无法 kill curl（Shell.run 无取消），只能等当前批结束
  ["batch curl enforces per-transfer max-time", /\[\"curl\", \"-k\", \"-sS\", \"-f\", \"-Z\", `--parallel-max \$\{PARALLEL\}`, \"--connect-timeout 15\", \"--max-time 30\"\]/.test(hlsSource)],
  ["batch runCommand timeout shortened from 600s to 150s", /await runCommand\(curlParts\.join\(\" \"\), 150\)/.test(hlsSource)],
  ["single-segment retry also bounded", /curl -k -sS -f --connect-timeout 15 --max-time 30 \$\{headerArgs\}/.test(hlsSource) && /runCommand\(`curl[^`]*`, 60\)/.test(hlsSource)],
  // 取消后轮询给出明确反馈，避免误以为页面卡死
  ["cancel shows explicit stopping feedback", /正在停止（等待当前批次结束）…/.test(hlsSource)],
  ["cancel feedback freezes progress", /if \(options\.isCancelFlagSet\?\.\(\)\) \{\n\s*\/\/ 取消请求已写入/.test(hlsSource)],
  ["cancel after batch throws 下载已取消", /if \(options\.isCancelFlagSet\?\.\(\)\) throw new Error\(\"下载已取消\"\)/.test(hlsSource)],
  // 原生分片路径：取消 throw 也要走 finally 清理，保证取消后可立即重新下载；
  // 但原生返回 undefined（清单不支持）时要保留 taskDirectory 供 ffmpeg 分支使用。
  ["native path cleans taskDirectory on cancel", /if \(nativeCompleted\) \{\n\s*cancelBackgroundDownloads\(\)/.test(mediaSource) && /FileManager\.removeSync\(taskDirectory\)/.test(mediaSource)],
  ["native unsupported playlist keeps taskDirectory for ffmpeg", /原生返回 undefined（清单不支持）时保留 taskDirectory 供 ffmpeg 分支使用/.test(mediaSource) && /if \(nativeCompleted\) \{/.test(mediaSource)],
  ["native path releases background downloads", /cancelBackgroundDownloads\(\)\n\s*try \{\n\s*if \(FileManager\.existsSync\(taskDirectory\)\)/.test(mediaSource)],
  // index.tsx：取消后 UI 恢复（继续下载可重新开始）
  ["startDownload restores UI in catch", /setDownloading\(false\)\n\s*setCancelPath\(null\)\n\s*const message = error instanceof Error \? error\.message : String\(error\)/.test(FileManager.readAsStringSync(`${Script.directory}/index.tsx`))],
  // yt-dlp 缺失防御：HLS/直链/抖音不依赖 yt-dlp，不因引擎缺失禁用“开始下载”
  ["startDownload only gates yt-dlp when the choice needs it", /const choiceNeedsYtDlp = !downloadChoice \|\| \(downloadChoice\.formatExpression !== "direct"/.test(FileManager.readAsStringSync(`${Script.directory}/index.tsx`))],
  ["download button uses canDownloadWithoutYtDlp", /canDownloadWithoutYtDlp\(url, selectedChoice\)/.test(FileManager.readAsStringSync(`${Script.directory}/index.tsx`)) && /function canDownloadWithoutYtDlp/.test(FileManager.readAsStringSync(`${Script.directory}/index.tsx`))],
  ["installYtDlp tolerates SSL trust failures via trusted-host", /python3 -m pip install --trusted-host pypi\.org --trusted-host files\.pythonhosted\.org --upgrade yt-dlp/.test(mediaSource)],
  // METHOD=NONE 误判修复：显式无加密应允许原生分片（8xx3 这类清单此前被跳过原生分片落入 ffmpeg）
  ["encryption parsed by parseHlsMediaPlaylist", /function parseHlsMediaPlaylist/.test(hlsSource) && /method === "NONE"/.test(hlsSource) && /plan\.method = "aes-128"/.test(hlsSource)],
  ["METHOD=NONE is not treated as encrypted", !KEY_ENCRYPTED.test("#EXT-X-KEY:METHOD=NONE\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\nhttps://cdn.example/seg-001.ts")],
  ["legacy KEY_ANY would have rejected METHOD=NONE (root cause)", KEY_ANY.test("#EXT-X-KEY:METHOD=NONE")],
  ["AES-128 now decrypted natively (no longer rejected)", /if \(plan\.method === "aes-128"\)/.test(hlsSource) && /downloadHlsSegmentsEncrypted\(/.test(hlsSource)],
  ["SAMPLE-AES still falls back via unsupported", /if \(plan\.method === "unsupported"\) return undefined/.test(hlsSource)],
  // fetch-first：原生 NSURLSession（HTTP/2 复用，同预览）优先，curl 分批兜底
  ["native strategy defaults to fetch-first", /const HLS_NATIVE_MODE: \"curl\" \| \"fetch\" = \"fetch\"/.test(hlsSource)],
  ["fetch downloader exists with speed gate", /async function downloadHlsSegmentsFetch/.test(hlsSource) && /const GATE = Math\.min\(24, count\)/.test(hlsSource) && /> 16000\) fetchSlow = true/.test(hlsSource)],
  ["fetch keeps the measured stable concurrency", /const maxConcurrent = 4/.test(hlsSource)],
  ["slow native download falls back to curl batches", /fetched\.slow\) \{[\s\S]*?downloadHlsSegmentsCurlBatches\(downloadOptions, segments, count\)/.test(hlsSource)],
  ["failed native download falls back to curl batches", /download\.m3u8\.fetch-fallback[\s\S]{0,260}downloadHlsSegmentsCurlBatches\(downloadOptions, segments, count\)/.test(hlsSource)],
  ["curl batches still reuse already-written segments", /const fileExists = \(index: number\)(?:: boolean)? => \{/.test(hlsSource)],
  // 优化 A：curl 兑底只补缺失分片（fetch-first 兜底复用已写 seg_*，避免全量重下）
  ["curl main batch skips already-written segments", /只补缺失分片：fetch-first 兜底时复用已写 seg_\*/.test(hlsSource) && /const pending = Array\.from\(\{ length: end - start \}, \(_, i\) => start \+ i\)\.filter\(\(index\) => !fileExists\(index\)\)/.test(hlsSource)],
  ["curl empty batch is skipped entirely", /if \(pending\.length\) \{/.test(hlsSource)],
  ["curl retry only scans missing segments", /const missing = pending\.filter\(\(index\) => !fileExists\(index\)\)/.test(hlsSource)],
  // 优化 D：curl 路径显示已下字节与实时速度（与 fetch 路径一致）
  ["curl progress reports bytes and speed", /正在下载分片 \$\{done\} \/ \$\{count\}\$\{speedLabel\}/.test(hlsSource) && /downloadedBytes: bytes \|\| undefined/.test(hlsSource) && /speed: speed \|\| undefined/.test(hlsSource)],
  // 优化 B：无 referer 的 m3u8 直链也 native-first（统一 HLS 管线，快、可取消）
  ["direct m3u8 without referer also tries native-first", /if \(isM3U8URL\(sourceURL\) \|\| options\.choice\.formatExpression === "m3u8" \|\| options\.choice\.id === "m3u8"\) \{[\s\S]{0,600}let nativeCompleted = false[\s\S]{0,300}downloadHlsSegmentsNative\(/.test(mediaSource)],
  ["no-referer native error falls back to ffmpeg with warning", /download\.m3u8\.native-skipped/.test(mediaSource)],
  ["no-referer native failure keeps taskDirectory for ffmpeg fallback", /if \(nativeError\) \{\n\s*if \(nativeError === "下载已取消" \|\| isCancelFlagSet\(\)\) \{\n\s*nativeCompleted = true\n\s*throw new Error\("下载已取消"\)/.test(mediaSource)],
  ["safari import native error still throws", /download\.m3u8\.native-segments\.failed/.test(mediaSource) && /throw new Error\(nativeError\)/.test(mediaSource)],
  ["native downloader defaults to Safari UA for direct m3u8", /const userAgent = options\.userAgent \|\| MOBILE_SAFARI_UA/.test(hlsSource)],
  ["manifest summary defaults to Safari UA", /const ua = userAgent \|\| MOBILE_SAFARI_UA/.test(hlsSource)],
  // ffmpeg 分支取消：给出停止反馈 + 启动前复查 + 超时收短（进程无法 kill，只能缩短等待）
  ["ffmpeg cancel shows stopping feedback", /正在停止（等待 FFmpeg 结束）…/.test(mediaSource)],
  ["ffmpeg branch re-checks cancel before starting", /取消请求可能在进入 ffmpeg 分支前已写入；此时不再无谓启动 ffmpeg。/.test(mediaSource) && /if \(isCancelFlagSet\(\)\) throw new Error\("下载已取消"\)/.test(mediaSource)],
  ["ffmpeg runCommand timeout shortened to 600s", /-allowed_extensions ALL -i \$\{quote\(sourceURL\)\} -c copy -bsf:a aac_adtstoasc -movflags \+faststart \$\{quote\(workPath\)\}`,\n        600,/m.test(mediaSource)],
  // 下载前重复检测：相同 URL 已成功下载且文件可用时提示
  ["duplicate download detection exists", /async function findExistingDownload/.test(FileManager.readAsStringSync(`${Script.directory}/index.tsx`)) && /该链接已下载过/.test(FileManager.readAsStringSync(`${Script.directory}/index.tsx`))],
  ["duplicate prompt only for manual downloads", /if \(!automatic\) \{\n\s*const existing = await findExistingDownload\(validURL\)/.test(FileManager.readAsStringSync(`${Script.directory}/index.tsx`))],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Download cancel checks failed: ${failed.join(", ")}`)
console.log(`Download cancel checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
