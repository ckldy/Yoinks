import { Script } from "scripting"
import { redactURL } from "./logs"
import { quote, runCommand } from "./shell-utils"

// Yoinks Safari 浏览器插件的更新入口：把项目 browser.tsx.src（TSX 源码）转换为纯 JS 用户脚本
// （Yoinks.user.js）并同步到 Safari 扩展的 userscripts 目录，由 Scripting 的「Safari 浏览器脚本」
// 管理（开关/编辑/更新/删除）。Safari 扩展直接读取该目录，同步后只需刷新页面即可生效。
// 注意：项目内不再放 browser.tsx（避免 app 构建项目版导致双注入），仅保留 browser.tsx.src 作源码。

const BROWSER_SOURCE_FILE = "browser.tsx.src"
export const PUBLISHED_USERSCRIPT_NAME = "Yoinks.user.js"

export type BrowserPluginStatus = {
  expected: string | null
  current: string | null
  currentKnown: boolean
  upToDate: boolean
  published: string | null
}

export function browserSourcePath(): string {
  return `${Script.directory}/${BROWSER_SOURCE_FILE}`
}

export function publishedUserscriptPath(): string {
  return `${FileManager.safariBrowserUserscriptsDirectory}/${PUBLISHED_USERSCRIPT_NAME}`
}

export function safariStorageFilePath(): string {
  return `${FileManager.safariBrowserStorageDirectory}/Yoinks.json`
}

/** 读取 browser.tsx.src 元数据块的 @version（期望版本）。 */
export function readBrowserSourceVersion(): string | null {
  try {
    const source = FileManager.readAsStringSync(browserSourcePath())
    const match = source.match(/\/\/\s*@version\s+(\S+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/** 读取 Safari 扩展存储 Yoinks.json 中最近一次捕获诊断的 browserVersion（当前注入版本）。 */
export function readSafariCurrentVersion(): string | null {
  try {
    const path = safariStorageFilePath()
    if (!FileManager.existsSync(path)) return null
    const storage = JSON.parse(FileManager.readAsStringSync(path))
    const diagnostic = storage?.["yoinks-media-candidates-diagnostic-v1"]
    if (!diagnostic || typeof diagnostic !== "object") return null
    const version = (diagnostic as Record<string, unknown>).browserVersion
    return typeof version === "string" && version.trim() ? version.trim() : null
  } catch {
    return null
  }
}

export function getBrowserPluginStatus(): BrowserPluginStatus {
  const expected = readBrowserSourceVersion()
  const current = readSafariCurrentVersion()
  return {
    expected,
    current,
    currentKnown: Boolean(current),
    upToDate: Boolean(expected && current && expected === current),
    published: readPublishedVersion(),
  }
}

function readPublishedVersion(): string | null {
  try {
    const path = publishedUserscriptPath()
    if (!FileManager.existsSync(path)) return null
    const source = FileManager.readAsStringSync(path)
    const match = source.match(/\/\/\s*@version\s+(\S+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * 剥离 browser.tsx.src 的 TS 类型（针对本文件风格），产出可直接作为 userscript 的纯 JS。
 * 保留 // ==UserScript== 元数据块与全部运行时逻辑；转换失败抛错。
 */
export function stripBrowserTypeScript(source: string): string {
  let out = source
  // 1) 删除 declare 声明行
  out = out
    .split("\n")
    .filter((line) => !/^\s*declare\s+/.test(line))
    .join("\n")
  // 2) 删除 type 定义块（单行或到花括号平衡的多行）
  out = removeTypeDefinitionBlocks(out)
  // 3) 泛型实例化：new Set<string>() -> new Set() 等
  out = out.replace(/\bnew\s+(Set|Map|Promise)\s*<[^>]*>/g, "new $1")
  // 4) 内联对象返回类型：): Promise<{...}> / ): {...}  ->  )
  //    对象类型可能带联合后缀（如 `): { ... } | null {`），必须一并剥掉：
  //    否则 `function detectPageGate(): { kind: "vip"; ... } | null {` 会残留
  //    `function detectPageGate() | null {`，导致 Safari 注入时报
  //    "Unexpected token '|'. Expected an opening '{' at the start of a function body."
  out = out.replace(/\)\s*:\s*Promise<\{[^}]*\}>(?:\s*\|\s*[^{}=\n;]+)?/g, ")")
  out = out.replace(/\)\s*:\s*\{[^}]*\}(?:\s*\|\s*[^{}=\n;]+)?/g, ")")
  // 5) 函数声明签名：function name(params): RET {  ->  function name(strippedParams) {
  out = out.replace(/function\s+\w+\s*\([^)]*\)\s*:\s*[^{]+\{/g, (match: string) => {
    const open = match.indexOf("(")
    const close = match.indexOf(")", open)
    const head = match.slice(0, open + 1)
    const params = match.slice(open + 1, close)
    return `${head}${stripParamTypes(params)}) {`
  })
  // 5b) 匿名函数表达式：function (this: any, a: T, ...r: any[]): RET {  ->  function (a, ...r) {
  //     函数声明由规则 5 处理；匿名表达式无名字（如 xhr 代理 function (this, ...)）会被漏掉，
  //     部署产物残留 `this: any` 等类型标注导致 Safari 语法错误。此处一并剥离参数类型、
  //     删除 TS 的 this 参数（JS 不允许 this 作参数名）并处理可选返回类型。
  out = out.replace(/function\s*\(([^)]*)\)\s*(?::\s*[^{]+\s*)?\{/g, (_match: string, params: string) => `function (${stripFunctionParams(params)}) {`)
  // 6) 类型谓词箭头：(value): value is string =>  ->  (value) =>
  out = out.replace(/\((\w+)\)\s*:\s*\1\s+is\s+[\w]+(?=\s*=>)/g, "($1)")
  // 7) 箭头函数参数与返回类型：(a: T): R =>  ->  (a) =>
  //    先处理带返回类型的（(node: unknown): void =>），再处理无返回类型的参数。
  out = out.replace(/\(([^()]*)\)\s*:\s*[^{}=\n;]+\s*=>/g, (_match: string, params: string) => `(${stripParamTypes(params)}) =>`)
  out = out.replace(/\(([^()]*)\)\s*=>/g, (_match: string, params: string) => `(${stripParamTypes(params)}) =>`)
  // 8) 变量类型注解：const x: T = / , x: T =   ->  const x = / , x =
  //    限定单行且不含 { } =，避免误伤对象字面量与跨行吞内容。
  //    内联对象数组类型（Array<{...}>）单独处理（含 { } 无法走通用规则）。
  out = out.replace(/\b(const|let|var)\s+(\w+)\s*:\s*Array<\{[^}]*\}>\s*=/g, "$1 $2 =")
  // 无赋值的 let 类型声明：let json: unknown（行尾）-> let json；必须先于下面的通用
  // `x: T =` 规则执行：否则 `let best: string | undefined, bestScore = -1` 会被
  // `([^=\n{}]+?)` 把 `, bestScore ` 吞进类型组，错误替换成 `let best = -1`（丢失 bestScore）。
  // 字符类含空格以匹配 `string | undefined` 这类带空格的联合类型。
  out = out.replace(/\blet\s+(\w+)\s*:\s*[A-Za-z_$][\w$<>\[\]|. ]*\s*(?=[;,\n])/g, "let $1")
  // 函数类型变量：let cleanup: (() => void) | null = null -> let cleanup = null。
  // 通用规则会把函数类型内的 `=>` 误当作赋值箭头，故必须优先处理。
  out = out.replace(/\b(const|let|var)\s+(\w+)\s*:\s*\(\s*\(\s*\)\s*=>\s*[^)]*\)\s*(?:\|\s*[^=\n{}]+)?\s*=/g, "$1 $2 =")
  out = out.replace(/\b(const|let|var)\s+(\w+)\s*:\s*([^=\n{}]+?)\s*=(?![>])/g, "$1 $2 =")
  // 内联对象类型变量：let dragState: { ... } | null = null  ->  let dragState = null
  out = out.replace(/\blet\s+(\w+)\s*:\s*\{[^}]*\}(?:\s*\|\s*[^=\n{}]+)?\s*=/g, "let $1 =")
  // 9) 类型断言（as Array<{...}> / as Record<...> 的对象类型可能含逗号/花括号，用非贪婪跨段）
  out = out.replace(/\s+as\s+any\[\]/g, " ")
  out = out.replace(/\s+as\s+any\b/g, " ")
  out = out.replace(/\s+as\s+const\b/g, " ")
  out = out.replace(/\s+as\s+(?:Array|Record)\s*<[\s\S]*?>/g, " ")
  out = out.replace(/\s+as\s+[A-Za-z_$][\w$]*\[\]/g, " ")
  out = out.replace(/\s+as\s+[A-Za-z_$][\w$]*\b/g, " ")
  // 逗号分隔的变量声明序列（前一个是已赋值声明）：const x = new Set(), y: T = []  ->  y =
  // 放在类型断言之后，此时 as Array<{...}> 已删除（含 ; 的泛型不会阻断）。
  // 要求逗号前是 = 赋值，避免误伤对象字面量里的键值对与展开（... ===）。
  out = out.replace(/(=\s*[^,;\n]+),\s*(\w+)\s*:\s*([^=\n{}]+?)\s*=(?![>])/g, "$1, $2 =")
  // 10) 残留类型关键词检查（browser.tsx.src 不应当再出现）
  const leftovers = out.match(/\b(?:CandidateKind|CaptureSession|FrameReport|Promise<|Array<|Record<|Set<|Map<)\b/)
  if (leftovers) throw new Error(`类型剥离残留：${leftovers[0]}`)
  // 10b) 残留参数类型标注检查：函数声明/表达式/箭头参数里不应再有 `: ` 类型（对象字面量键值冒号除外）
  const paramLeftovers = out.match(/\b(?:function\s*|function\s+\w+\s*)\([^)]*:[^)]*\)/)
  if (paramLeftovers) throw new Error(`参数类型剥离残留：${paramLeftovers[0].slice(0, 80)}`)
  const functionVariableLeftovers = out.match(/\b(?:const|let|var)\s+\w+\s*:\s*\(\s*\(\s*\)\s*=>/)
  if (functionVariableLeftovers) throw new Error(`函数类型变量剥离残留：${functionVariableLeftovers[0]}`)
  return out
}

function stripParamTypes(params: string): string {
  return params.replace(/([A-Za-z_$][\w$]*)\??\s*:\s*[^,)]+/g, "$1")
}

function stripFunctionParams(params: string): string {
  // 删除 TS 的 this 参数（JS 不允许 this 作参数名），再按普通参数剥离类型；
  // this 在开头时删除会残留前导逗号（`, method`），需要清掉。
  const withoutThis = params.replace(/(^|,\s*)this\??\s*:\s*[^,)]+/g, "$1")
  return stripParamTypes(withoutThis.replace(/^,\s*/, ""))
}

function removeTypeDefinitionBlocks(source: string): string {
  const lines = source.split("\n")
  const result: string[] = []
  let inTypeBlock = false
  let depth = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!inTypeBlock && /^type\s+[A-Za-z_$][\w$]*\b/.test(trimmed)) {
      // 跳过注释行之后真正的 type 定义；单行无 { 则直接跳过
      if (!trimmed.includes("{")) continue
      inTypeBlock = true
      depth = 0
      for (const ch of line) {
        if (ch === "{") depth += 1
        else if (ch === "}") depth -= 1
      }
      if (depth <= 0) inTypeBlock = false
      continue
    }
    if (inTypeBlock) {
      for (const ch of line) {
        if (ch === "{") depth += 1
        else if (ch === "}") depth -= 1
      }
      if (depth <= 0) inTypeBlock = false
      continue
    }
    result.push(line)
  }
  return result.join("\n")
}

/** 发布：browser.tsx.src -> 纯 JS -> userscripts/Yoinks.user.js。返回 { ok, path, version }。 */
export async function publishBrowserUserscript(): Promise<{ ok: boolean; path: string; version: string | null; error?: string }> {
  try {
    const sourcePath = browserSourcePath()
    if (!FileManager.existsSync(sourcePath)) {
      return { ok: false, path: "", version: null, error: `未找到 ${BROWSER_SOURCE_FILE}` }
    }
    const source = FileManager.readAsStringSync(sourcePath)
    const js = stripBrowserTypeScript(source)
    const dir = FileManager.safariBrowserUserscriptsDirectory
    if (!FileManager.existsSync(dir)) {
      return { ok: false, path: "", version: null, error: "Safari 浏览器脚本目录不可用" }
    }
    const path = `${dir}/${PUBLISHED_USERSCRIPT_NAME}`
    await FileManager.writeAsString(path, js)
    // 发布后自检：用 node vm.Script 编译产物（只解析不执行），防转换器残留 TS 语法
    // 导致 Safari 注入失败（曾因匿名函数表达式参数 `function (this: any, ...)` 未被剥离而踩坑）。
    const syntax = await runCommand(`node -e \"new (require('vm').Script)(require('fs').readFileSync(process.argv[1], 'utf8')); console.log('SYNTAX_OK')\" ${quote(path)}`, 60).catch(() => ({ exitCode: 1, output: "" }))
    if (syntax.exitCode !== 0 || !String(syntax.output || "").includes("SYNTAX_OK")) {
      return { ok: false, path, version: null, error: `部署产物语法自检失败：${String(syntax.output || "").slice(0, 200)}` }
    }
    const version = source.match(/\/\/\s*@version\s+(\S+)/)?.[1] ?? null
    return { ok: true, path, version }
  } catch (error) {
    return { ok: false, path: "", version: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 发布结果的简要展示。 */
export function summarizePublishResult(result: Awaited<ReturnType<typeof publishBrowserUserscript>>): string {
  if (!result.ok) return `发布失败：${result.error || "未知错误"}`
  return `已发布 ${result.version ? `v${result.version} ` : ""}→ ${redactURL(result.path)}`
}
