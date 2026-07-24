import { Path, Script } from "scripting"

export type LogLevel = "debug" | "info" | "warn" | "error"
export type LogFilter = "all" | "info" | "warn" | "error"

export type YoinksLogEvent = {
  timestamp: string
  level: LogLevel
  event: string
  taskId?: string
  details?: Record<string, unknown>
}

export type LogPage = {
  events: YoinksLogEvent[]
  totalMatching: number
  totalAvailable: number
  hasMore: boolean
  sizeBytes: number
  lastWrittenAt?: string
}

const LOG_DIR = Path.join(Script.directory, "logs")
const RUNTIME_LOG_PATH = Path.join(LOG_DIR, "runtime.jsonl")
/** Legacy paths kept only for one-time migration / clear. */
const LEGACY_LATEST_LOG_PATH = Path.join(LOG_DIR, "latest.jsonl")
const LEGACY_MINIMAL_LOG_PATH = Path.join(LOG_DIR, "minimal.jsonl")
const LEGACY_HISTORY_DIR = Path.join(LOG_DIR, "history")

const VERBOSE_MODE_KEY = "yoinks.debug-mode-enabled"
const VERBOSE_UNTIL_KEY = "yoinks.verbose-log-until"
const VERBOSE_TTL_MS = 15 * 60 * 1000
const MAX_RUNTIME_BYTES = 128 * 1024
const MAX_TEXT_LENGTH = 32_000
const MAX_DETAIL_STRING = 2_000
const MAX_OUTPUT_SUMMARY = 800

/**
 * Main-chain milestones always kept (even at info).
 * warn/error always kept regardless of event name.
 * Outside this set, info/debug are dropped unless temporary verbose is on.
 * Boundary: does not change download/preview behavior — only what is persisted.
 */
const MAIN_CHAIN_EVENTS = new Set([
  "paste.accepted",
  "manual-url.accepted",
  "paste.invalid",
  "probe.started",
  "probe.completed",
  "probe.failed",
  "probe.output.retry",
  "probe.ssl.retry",
  "probe.deinit.retry",
  "probe.transient.retry",
  "probe.login-required",
  "download.started",
  "download.completed",
  "download.failed",
  "download.cancel.requested",
  "merge.ffmpeg.completed",
  "verify.completed",
  "save.photos.completed",
  "save.photos.failed",
  "save.files.completed",
  "save.files.cancelled",
  "platform-auth.login.completed",
  "platform-auth.login.failed",
  "platform-auth.download-login.failed",
  "preview.playing",
  "preview.failed",
  "preview.login-requested",
  "preview.fallback-download",
  "history.prune.partial",
  "history.write.failed",
  "history.action.failed",
  "history.clear.partial",
  "tools.install.failed",
  "verbose-log.enabled",
  "verbose-log.disabled",
])

export function safeText(value: unknown, limit = MAX_TEXT_LENGTH): string {
  return String(value ?? "")
    .replace(/(["']?authorization["']?\s*[:=]\s*)(?:bearer\s+)?[^\r\n]+/gi, "$1[redacted]")
    .replace(/(["']?(?:cookie|x-csrf-token)["']?\s*[:=]\s*)[^\s,;"'}]+/gi, "$1[redacted]")
    .replace(/(["']?(?:set-cookie)["']?\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactURL(url.replace(/[),.;]+$/, "")))
    .replace(/^[^\r\n]*\t(?:TRUE|FALSE)\t[^\r\n]*\t(?:TRUE|FALSE)\t\d+\t[^\r\n]*\t[^\r\n]+$/gm, "[redacted cookie record]")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, limit)
}

export function redactURL(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${decodeURI(url.pathname)}${url.search ? "?[redacted]" : ""}`
  } catch {
    return String(value).replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, 300)
  }
}

/** Prefer yt-dlp / ffmpeg style error lines; drop host deinit noise. */
export function summarizeOutput(value: unknown, limit = MAX_OUTPUT_SUMMARY): string {
  const raw = String(value ?? "")
  if (!raw) return ""
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/Script window host view deinit|Transpile JSContext|webview viewmodel cleanup|WebViewController disposed|load start|load stop|set channel/i.test(line))

  const preferred = lines.filter((line) =>
    /ERROR|WARNING|Unsupported URL|HTTP Error|certificate|SSL|TLS|ffmpeg|yt-dlp|Traceback|Exception|failed|Unable|denied|403|404|401/i.test(line)
  )
  const chosen = (preferred.length ? preferred : lines).slice(-12).join(" ")
  return safeText(chosen || raw, limit)
}

function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(details)) {
    if (/token|cookie|password|authorization|secret/i.test(key)) {
      result[key] = "[redacted]"
    } else if (/url/i.test(key) && typeof value === "string") {
      result[key] = redactURL(value)
    } else if (typeof value === "string" && /^(output|message|stderr|stdout|error)$/i.test(key)) {
      result[key] = summarizeOutput(value)
    } else if (typeof value === "string") {
      result[key] = safeText(value, MAX_DETAIL_STRING)
    } else if (typeof value === "number" || typeof value === "boolean" || value == null) {
      result[key] = value
    } else {
      result[key] = safeText(JSON.stringify(value), MAX_DETAIL_STRING)
    }
  }
  return result
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
}

function parseEvent(line: string): YoinksLogEvent | null {
  try {
    const parsed = JSON.parse(line) as Partial<YoinksLogEvent>
    if (typeof parsed.timestamp !== "string" || !isLogLevel(parsed.level) || typeof parsed.event !== "string") return null
    return {
      timestamp: parsed.timestamp,
      level: parsed.level,
      event: safeText(parsed.event, 120),
      taskId: typeof parsed.taskId === "string" ? safeText(parsed.taskId, 160) : undefined,
      details: parsed.details && typeof parsed.details === "object" ? sanitizeDetails(parsed.details as Record<string, unknown>) : undefined,
    }
  } catch {
    return null
  }
}

function parseEvents(content: string): YoinksLogEvent[] {
  return content
    .split(/(?=\{\"timestamp\":)/)
    .map((chunk) => parseEvent(chunk.trim().replace(/[\r\n]+/g, " ")))
    .filter((event): event is YoinksLogEvent => event != null)
}

function matchingFilter(event: YoinksLogEvent, filter: LogFilter): boolean {
  return event.level !== "debug" && (filter === "all" || event.level === filter)
}

async function ensureDirectories() {
  if (!(await FileManager.exists(LOG_DIR))) await FileManager.createDirectory(LOG_DIR, true)
}

export function retainLogTailWithinBytes(content: string, maxBytes: number): string {
  const lines = content.split(/\r?\n/)
  if (lines.at(-1) === "") lines.pop()
  const retained: string[] = []
  let retainedBytes = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = `${lines[index]}\n`
    const lineBytes = new TextEncoder().encode(line).length
    if (retainedBytes + lineBytes > maxBytes) break
    retained.unshift(lines[index])
    retainedBytes += lineBytes
  }
  return retained.length ? `${retained.join("\n")}\n` : ""
}

async function trimRuntimeLog() {
  try {
    if (!FileManager.existsSync(RUNTIME_LOG_PATH) || FileManager.statSync(RUNTIME_LOG_PATH).size <= MAX_RUNTIME_BYTES) return
    const content = FileManager.readAsStringSync(RUNTIME_LOG_PATH)
    const tail = retainLogTailWithinBytes(content, MAX_RUNTIME_BYTES)
    if (tail !== content) FileManager.writeAsStringSync(RUNTIME_LOG_PATH, tail)
  } catch {}
}

function isVerboseActiveUnlocked(): boolean {
  const until = Storage.get<number>(VERBOSE_UNTIL_KEY)
  if (typeof until === "number" && until > Date.now()) return true
  if (typeof until === "number" && until <= Date.now()) {
    Storage.set(VERBOSE_UNTIL_KEY, 0)
    Storage.set(VERBOSE_MODE_KEY, false)
  }
  return false
}

/** Temporary verbose window (default 15 min). Does not change media behavior. */
export function isVerboseLogEnabled(): boolean {
  return isVerboseActiveUnlocked()
}

/** @deprecated Use isVerboseLogEnabled — kept so old UI/call sites compile. */
export function isDebugModeEnabled(): boolean {
  return isVerboseLogEnabled()
}

let logWriteQueue: Promise<void> = Promise.resolve()
let legacyMigrated = false

function enqueueLogWrite(operation: () => Promise<void>): Promise<void> {
  const scheduled = logWriteQueue.then(operation, operation)
  logWriteQueue = scheduled.catch(() => {})
  return scheduled
}

function isLegacyMainChainEvent(event: YoinksLogEvent): boolean {
  if (event.level === "warn" || event.level === "error") return true
  return MAIN_CHAIN_EVENTS.has(event.event)
}

async function migrateLegacyLogsOnce() {
  if (legacyMigrated) return
  legacyMigrated = true
  try {
    if (await FileManager.exists(RUNTIME_LOG_PATH)) return
    const merged: YoinksLogEvent[] = []
    // Prefer already-filtered minimal; only pull main-chain rows from latest.
    for (const path of [LEGACY_MINIMAL_LOG_PATH, LEGACY_LATEST_LOG_PATH]) {
      if (!(await FileManager.exists(path))) continue
      for (const event of parseEvents(await FileManager.readAsString(path))) {
        if (isLegacyMainChainEvent(event)) merged.push(event)
      }
    }
    if (!merged.length) return
    await ensureDirectories()
    merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    // De-dupe identical timestamp+event+taskId triples from dual legacy files.
    const seen = new Set<string>()
    const unique: YoinksLogEvent[] = []
    for (const event of merged) {
      const key = `${event.timestamp}|${event.level}|${event.event}|${event.taskId ?? ""}`
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(event)
    }
    const lines = unique.map((event) => `${JSON.stringify(event)}\n`).join("")
    FileManager.writeAsStringSync(RUNTIME_LOG_PATH, retainLogTailWithinBytes(lines, MAX_RUNTIME_BYTES))
  } catch {}
}

export async function setVerboseLogEnabled(enabled: boolean): Promise<void> {
  await enqueueLogWrite(async () => {
    if (!enabled) {
      Storage.set(VERBOSE_UNTIL_KEY, 0)
      Storage.set(VERBOSE_MODE_KEY, false)
      return
    }
    const until = Date.now() + VERBOSE_TTL_MS
    Storage.set(VERBOSE_UNTIL_KEY, until)
    Storage.set(VERBOSE_MODE_KEY, true)
    await migrateLegacyLogsOnce()
    // Record enablement as a main-chain milestone for supportability.
    const payload: YoinksLogEvent = {
      timestamp: new Date().toISOString(),
      level: "info",
      event: "verbose-log.enabled",
      details: { until: new Date(until).toISOString(), ttlMinutes: VERBOSE_TTL_MS / 60_000 },
    }
    try {
      await ensureDirectories()
      await FileManager.appendText(RUNTIME_LOG_PATH, `${JSON.stringify(payload)}\n`)
      await trimRuntimeLog()
    } catch {}
  })
}

/** @deprecated Use setVerboseLogEnabled */
export async function setDebugModeEnabled(enabled: boolean): Promise<void> {
  await setVerboseLogEnabled(enabled)
}

export function createTaskId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`
}

function shouldPersist(payload: YoinksLogEvent): boolean {
  if (payload.level === "warn" || payload.level === "error") return true
  if (MAIN_CHAIN_EVENTS.has(payload.event)) return true
  if (isVerboseActiveUnlocked()) return payload.level !== "debug"
  return false
}

export async function logEvent(event: Omit<YoinksLogEvent, "timestamp">): Promise<void> {
  const now = new Date()
  const payload: YoinksLogEvent = {
    timestamp: now.toISOString(),
    level: event.level,
    event: safeText(event.event, 120),
    taskId: event.taskId,
    details: sanitizeDetails(event.details),
  }
  await enqueueLogWrite(async () => {
    try {
      await migrateLegacyLogsOnce()
      if (!shouldPersist(payload)) return
      await ensureDirectories()
      await FileManager.appendText(RUNTIME_LOG_PATH, `${JSON.stringify(payload)}\n`)
      await trimRuntimeLog()
    } catch {
      // Logging must never break download / preview.
    }
  })
}

export async function readLogPage(filter: LogFilter, offset: number, limit: number): Promise<LogPage> {
  try {
    await migrateLegacyLogsOnce()
    if (!(await FileManager.exists(RUNTIME_LOG_PATH))) {
      return { events: [], totalMatching: 0, totalAvailable: 0, hasMore: false, sizeBytes: 0 }
    }
    const content = await FileManager.readAsString(RUNTIME_LOG_PATH)
    const all = parseEvents(content).reverse()
    const matching = all.filter((event) => matchingFilter(event, filter))
    const events = matching.slice(offset, offset + limit)
    return {
      events,
      totalMatching: matching.length,
      totalAvailable: all.filter((event) => event.level !== "debug").length,
      hasMore: offset + events.length < matching.length,
      sizeBytes: FileManager.statSync(RUNTIME_LOG_PATH).size,
      lastWrittenAt: all[0]?.timestamp,
    }
  } catch {
    return { events: [], totalMatching: 0, totalAvailable: 0, hasMore: false, sizeBytes: 0 }
  }
}

/** Runtime log (Plan A). Name kept for Assistant tool compatibility. */
export async function readMinimalLog(): Promise<YoinksLogEvent[]> {
  try {
    await migrateLegacyLogsOnce()
    if (!(await FileManager.exists(RUNTIME_LOG_PATH))) return []
    return parseEvents(await FileManager.readAsString(RUNTIME_LOG_PATH)).map((event) => ({
      ...event,
      details: sanitizeDetails(event.details),
    }))
  } catch {
    return []
  }
}

export async function readRuntimeLog(): Promise<YoinksLogEvent[]> {
  return readMinimalLog()
}

export async function readLatestLog(): Promise<string> {
  try {
    await migrateLegacyLogsOnce()
    if (!(await FileManager.exists(RUNTIME_LOG_PATH))) return "尚无 Yoinks 运行日志。"
    return await FileManager.readAsString(RUNTIME_LOG_PATH)
  } catch (error) {
    return `读取日志失败：${safeText(error)}`
  }
}

export async function clearLogs(): Promise<void> {
  await enqueueLogWrite(async () => {
    for (const path of [RUNTIME_LOG_PATH, LEGACY_LATEST_LOG_PATH, LEGACY_MINIMAL_LOG_PATH]) {
      try {
        if (await FileManager.exists(path)) await FileManager.remove(path)
      } catch {}
    }
    try {
      if (await FileManager.exists(LEGACY_HISTORY_DIR)) await FileManager.remove(LEGACY_HISTORY_DIR)
    } catch {}
  })
}

export function getLogDirectory(): string {
  return LOG_DIR
}

export function getRuntimeLogPath(): string {
  return RUNTIME_LOG_PATH
}
