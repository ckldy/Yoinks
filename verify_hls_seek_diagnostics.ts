import { Script } from "scripting"

const source = FileManager.readAsStringSync(`${Script.directory}/services/player/hls-player-service.ts`)
const seekHandlerStart = source.indexOf('addScriptMessageHandler("seekDiagnostic"')
const seekHandlerEnd = source.indexOf('addScriptMessageHandler("requestMode"', seekHandlerStart)
const seekHandler = seekHandlerStart >= 0 ? source.slice(seekHandlerStart, seekHandlerEnd >= 0 ? seekHandlerEnd : undefined) : ""
const pollingStart = source.indexOf("function stopSeekPolling")
const pollingEnd = source.indexOf("function stopOrphanAudio", pollingStart)
const pollingSource = pollingStart >= 0 ? source.slice(pollingStart, pollingEnd >= 0 ? pollingEnd : undefined) : ""
const checks: Array<[string, boolean]> = [
  ["reports seek start", /reportSeekDiagnostic\('seek\.start'\)/.test(source)],
  ["reports seek completion", /reportSeekDiagnostic\('seek\.completed'\)/.test(source)],
  ["reports waiting and stalled", /video\.onwaiting[\s\S]*seek\.waiting[\s\S]*video\.onstalled[\s\S]*seek\.stalled/.test(source)],
  ["reports HLS errors without a URL", /reportSeekDiagnostic\('hls\.error', \{ hlsType: String\(data\.type \|\| ''\), hlsDetails: String\(data\.details \|\| ''\), fatal: !!data\.fatal \}\)/.test(source)],
  ["reports fragment timing without a URL", /latestLoadedFragment = \{ start: finiteSeconds\(fragment\.start\), end: finiteSeconds\(fragment\.start \+ fragment\.duration\), sn:/.test(source)],
  ["routes diagnostics through the existing log sanitizer", /addScriptMessageHandler\("seekDiagnostic"[\s\S]*logEvent\(/.test(source)],
  ["keeps polling read-only", !/(?:\.play\(|currentTime\s*=|startLoad\(|recoverMediaError\(|loadSource\(|\.destroy\()/.test(pollingSource)],
  ["uses native HLS before hls.js when headers are empty", /Object\.keys\(customHeaders\)\.length === 0 && video\.canPlayType\('application\/vnd\.apple\.mpegurl'\)[\s\S]*reportMode\('native-fallback', false\)[\s\S]*video\.src = src;[\s\S]*else if \(window\.Hls && Hls\.isSupported\(\)\)/.test(source)],
  ["keeps hls.js available for allowed custom headers", /else if \(window\.Hls && Hls\.isSupported\(\)\)[\s\S]*reportMode\('hls\.js', Object\.keys\(customHeaders\)\.length > 0\)/.test(source)],
  ["restores native video controls without A1 custom controls", /<video id="video" controls/.test(source) && !/hls-custom-controls|hlsProgress|commitHlsSeek|scrubTimeFromClientX/.test(source)],
  ["does not log sensitive network fields", !/(?:sourceURL|fragment\.url|cookie|authorization|headers|keyUri)/i.test(seekHandler)],
  ["limits seek diagnostics to hls.js playback", /function bindMediaEvents\(enableSeekDiagnostics\)[\s\S]*if \(enableSeekDiagnostics\) \{[\s\S]*reportSeekDiagnostic\('seek\.start'\)[\s\S]*bindDirectMediaEvents\(\)[\s\S]*bindMediaEvents\(false\)[\s\S]*else if \(window\.Hls && Hls\.isSupported\(\)\)[\s\S]*bindMediaEvents\(true\)/.test(source)],
  ["stops seek polling when preview is destroyed", /function destroy\(\) \{\s*stopSeekPolling\('destroyed'\);/.test(source)],
]
const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`HLS playback checks failed: ${failed.join(", ")}`)
console.log(`HLS playback checks passed (${checks.length})`)
Script.exit({ passed: checks.length })
