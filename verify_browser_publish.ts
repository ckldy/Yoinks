import { Script } from "scripting"
import { readBrowserSourceVersion, stripBrowserTypeScript } from "./services/browser-script"

// 验证 browser.tsx.src -> 纯 JS userscript 的转换器（services/browser-script.ts）：
// 产出必须是无 TS 类型的合法 JS、保留 userscript 元数据、与源码版本一致、关键符号齐全。

const source = FileManager.readAsStringSync(`${Script.directory}/browser.tsx.src`)

let js: string
try {
  js = stripBrowserTypeScript(source)
} catch (error) {
  throw new Error(`stripBrowserTypeScript failed: ${error instanceof Error ? error.message : String(error)}`)
}

// 先写临时产物供外部检查/语法验证（即使 checks 失败也能看到）
void (async () => {
  try {
    const tempPath = `${FileManager.appGroupDocumentsDirectory ?? Script.directory}/tmp_yoinks_user_script_check.js`
    await FileManager.writeAsString(tempPath, js)
    console.log(`TEMP_OUTPUT=${tempPath}`)
  } catch (error) {
    console.log(`TEMP_WRITE_FAILED=${error instanceof Error ? error.message : String(error)}`)
  }
})()

const checks: Array<[string, boolean]> = [
  // 元数据块保留
  ["userscript metadata block preserved", /\/\/ ==UserScript==/.test(js) && /\/\/ @name Yoinks/.test(js)],
  ["version matches source", /\/\/\s*@version\s+(\S+)/.test(js) && js.match(/\/\/\s*@version\s+(\S+)/)?.[1] === readBrowserSourceVersion()],
  ["connect wildcard preserved", /\/\/ @connect \*/.test(js)],
  // TS 类型已剥离
  ["no declare statements", !/declare\s+const/.test(js)],
  ["no type definitions", !/\btype\s+(CandidateKind|Candidate|CaptureSession|FrameReport)\b/.test(js)],
  ["no TS type annotations remain", !/\b(?:string\[\]|Candidate\[\]|Set<string>|Promise<|Array<|Record<|Map<string)/.test(js)],
  ["no as-assertions remain", !/\sas\s+(?:any|const|Record|CaptureSession|FrameReport|Candidate\[\]|unknown|Array<)/.test(js)],
  ["no parameter type annotations", !/\([^)]*:\s*(?:string|number|boolean|any|unknown|Candidate|CandidateKind|FrameReport|CaptureSession|void|any\[\]|string\[\])(?:\)|,)/.test(js) && !/\bfunction\s*\([^)]*this\s*:/.test(js)],
  // 关键运行时符号齐全
  ["PH_MEDIA_ENDPOINT_RE preserved", /PH_MEDIA_ENDPOINT_RE/.test(js)],
  ["PLAYER_CONFIG_DECL_PATTERN preserved", /PLAYER_CONFIG_DECL_PATTERN/.test(js)],
  ["PLAYER_CONFIG_URL_KEY_PATTERN preserved", /PLAYER_CONFIG_URL_KEY_PATTERN/.test(js)],
  ["iframeQueryMediaURLs preserved", /function iframeQueryMediaURLs\(\)/.test(js)],
  ["maccmsPlayerConfigURLs preserved", /function maccmsPlayerConfigURLs\(\)/.test(js)],
  ["detectPageGate preserved", /function detectPageGate\(\)/.test(js)],
  ["listen skip hls/dash condition", /\!candidates\.some\(c => c\.kind === "hls" \|\| c\.kind === "dash"\)/.test(js)],
  ["PLAYER_MEDIA_DEFINITION_PATTERN preserved", /PLAYER_MEDIA_DEFINITION_PATTERN/.test(js)],
  ["resolvePHMediaEndpoint preserved", /function resolvePHMediaEndpoint\(endpoint\)/.test(js)],
  ["gmFetchText preserved", /function gmFetchText\(url, timeoutMs\)/.test(js)],
  ["collectCandidates async preserved", /async function collectCandidates\(\)/.test(js)],
  ["installFloatingEntry preserved", /async function installFloatingEntry\(alwaysVisible\)/.test(js)],
  ["reload menu command preserved", /重新加载页面以应用插件更新/.test(js)],
  ["no floating version label (version shown in Scripting management only)", !/yoinks-plugin-version/.test(js)],
  ["diagnostic browserVersion preserved", /browserVersion: String\(GM_info/.test(js)],
  // v1.3.4：Video Sniffer 内容嗅探（无扩展名 HLS 端点补捕获）
  ["HLS_CONTENT_TYPE_RE preserved", /HLS_CONTENT_TYPE_RE/.test(js)],
  ["isHlsBodyText preserved", /function isHlsBodyText\(/.test(js)],
  ["cacheManifestText preserved", /function cacheManifestText\(/.test(js)],
  ["XHR hls load hook added", /__vsHlsHooked/.test(js)],
  // v1.3.4：界面（候选计数徽章 + 加载脉冲 + 状态色 + 轻量面板 + 剪贴板）
  ["candidate badge markup present", /yoinks-media-candidate-badge/.test(js)],
  ["capture panel markup present", /Yoinks 捕获候选/.test(js)],
  ["copyText helper present", /function copyText\(/.test(js)],
  ["setCaptureState helper present", /setCaptureState/.test(js)],
  ["kindSummary helper present", /kindSummary/.test(js)],
  // 回归：firstPublicFrameURL 的 bestScore 必须保留（转换器曾把 `let best: string | undefined,
  // bestScore = -1` 错误吞成 `let best = -1`，导致 ReferenceError 采集失败）
  ["firstPublicFrameURL bestScore declared", /let bestScore = -1/.test(js)],
  // 回归：对象类型返回注解的联合后缀必须一并剥离（转换器曾把
  // `function detectPageGate(): { ... } | null {` 残留成 `function detectPageGate() | null {`，
  // 导致 Safari 注入时报 Unexpected token '|'）
  ["no union suffix after object return type", !/\bfunction\s+\w+\([^)]*\)\s*\|\s*(?:null|undefined|string|number|boolean|\w+)\s*\{/.test(js)],
  // 逻辑等价：关键行数接近（类型剥离最多删 ~40 行）
  ["output length plausible", js.split("\n").length >= source.split("\n").length - 60 && js.split("\n").length <= source.split("\n").length + 10],
]

const failed = checks.filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`Browser publish checks failed: ${failed.join(", ")}`)
console.log(`Browser publish checks passed (${checks.length})`)
// 供外部 node --check 验证语法：写入临时产物
void (async () => {
  try {
    const tempPath = `${FileManager.appGroupDocumentsDirectory ?? Script.directory}/tmp_yoinks_user_script_check.js`
    await FileManager.writeAsString(tempPath, js)
    console.log(`TEMP_OUTPUT=${tempPath}`)
  } catch (error) {
    console.log(`TEMP_WRITE_FAILED=${error instanceof Error ? error.message : String(error)}`)
  }
  Script.exit({ passed: checks.length })
})()
