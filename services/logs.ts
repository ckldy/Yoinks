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
const HISTORY_DIR = Path.join(LOG_DIR, "history")
const LATEST_LOG_PATH = Path.join(LOG_DIR, "latest.jsonl")
const DEBUG_MODE_KEY = "yoinks.debug-mode-enabled"
const MAX_LATEST_BYTES = 512 * 1024
const MAX_HISTORY_BYTES = 4 * 1024 * 1024
const MAX_TEXT_LENGTH = 32_000

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function safeText(value: unknown, limit = MAX_TEXT_LENGTH): string {
  return String(value ?? "")
    .replace(/(["']?(?:cookie|authorization|x-csrf-token)["']?\s*[:=]\s*)[^\s,;"'}]+/gi, "$1[redacted]")
    .replace(/(["']?(?:set-cookie)["']?\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/^[^\r\n]*\t(?:TRUE|FALSE)\t[^\r\n]*\t(?:TRUE|FALSE)\t\d+\t[^\r\n]*\t[^\r\n]+$/gm, "[redacted cookie record]")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, limit)
}

export function redactURL(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}${url.search ? "?[redacted]" : ""}`
  } catch {
    return safeText(value, 300)
  }
}

function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(details)) {
    if (/token|cookie|password|authorization|secret/i.test(key)) {
      result[key] = "[redacted]"
    } else if (/url/i.test(key) && typeof value === "string") {
      result[key] = redactURL(value)
    } else if (typeof value === "string") {
      result[key] = safeText(value)
    } else if (typeof value === "number" || typeof value === "boolean" || value == null) {
      result[key] = value
    } else {
      result[key] = safeText(JSON.stringify(value))
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
  if (!(await FileManager.exists(HISTORY_DIR))) await FileManager.createDirectory(HISTORY_DIR, true)
}

async function trimLatestLog() {
  try {
    if (!FileManager.existsSync(LATEST_LOG_PATH) || FileManager.statSync(LATEST_LOG_PATH).size <= MAX_LATEST_BYTES) return
    const content = FileManager.readAsStringSync(LATEST_LOG_PATH)
    const tail = content.slice(-Math.floor(MAX_LATEST_BYTES * 0.75))
    const firstNewline = tail.indexOf("\n")
    FileManager.writeAsStringSync(LATEST_LOG_PATH, firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail)
  } catch {}
}

async function directorySize(path: string): Promise<number> {
  if (!(await FileManager.exists(path))) return 0
  const entries = await FileManager.readDirectory(path, true)
  let total = 0
  for (const entry of entries) {
    if (await FileManager.isFile(entry)) total += (await FileManager.stat(entry)).size
  }
  return total
}

async function trimHistory() {
  try {
    let total = await directorySize(HISTORY_DIR)
    if (total <= MAX_HISTORY_BYTES || !(await FileManager.exists(HISTORY_DIR))) return
    const days = (await FileManager.readDirectory(HISTORY_DIR))
      .filter((path) => FileManager.isDirectorySync(path))
      .sort((a, b) => a.localeCompare(b))
    for (const dayPath of days) {
      if (total <= MAX_HISTORY_BYTES) break
      const removed = await directorySize(dayPath)
      await FileManager.remove(dayPath)
      total -= removed
    }
  } catch {}
}

function taskLogPath(taskId: string, date = new Date()): string {
  return Path.join(HISTORY_DIR, dayKey(date), `${taskId}.jsonl`)
}

export function isDebugModeEnabled(): boolean {
  return Storage.get<boolean>(DEBUG_MODE_KEY) === true
}

export function setDebugModeEnabled(enabled: boolean): void {
  Storage.set(DEBUG_MODE_KEY, enabled)
}

export function createTaskId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`
}

export async function logEvent(event: Omit<YoinksLogEvent, "timestamp">): Promise<void> {
  if (!isDebugModeEnabled()) return
  const now = new Date()
  const payload: YoinksLogEvent = {
    timestamp: now.toISOString(),
    level: event.level,
    event: safeText(event.event, 120),
    taskId: event.taskId,
    details: sanitizeDetails(event.details),
  }
  const line = `${JSON.stringify(payload)}\n`
  try {
    await ensureDirectories()
    await FileManager.appendText(LATEST_LOG_PATH, line)
    if (payload.taskId) {
      const path = taskLogPath(payload.taskId, now)
      const parent = Path.join(HISTORY_DIR, dayKey(now))
      if (!(await FileManager.exists(parent))) await FileManager.createDirectory(parent, true)
      await FileManager.appendText(path, line)
      await trimHistory()
    }
    await trimLatestLog()
  } catch {}
}

export async function readLogPage(filter: LogFilter, offset: number, limit: number): Promise<LogPage> {
  try {
    if (!(await FileManager.exists(LATEST_LOG_PATH))) {
      return { events: [], totalMatching: 0, totalAvailable: 0, hasMore: false, sizeBytes: 0 }
    }
    const content = await FileManager.readAsString(LATEST_LOG_PATH)
    const all = parseEvents(content).reverse()
    const matching = all.filter((event) => matchingFilter(event, filter))
    const events = matching.slice(offset, offset + limit)
    return {
      events,
      totalMatching: matching.length,
      totalAvailable: all.filter((event) => event.level !== "debug").length,
      hasMore: offset + events.length < matching.length,
      sizeBytes: FileManager.statSync(LATEST_LOG_PATH).size,
      lastWrittenAt: all[0]?.timestamp,
    }
  } catch {
    return { events: [], totalMatching: 0, totalAvailable: 0, hasMore: false, sizeBytes: 0 }
  }
}

export async function readLatestLog(): Promise<string> {
  try {
    if (!(await FileManager.exists(LATEST_LOG_PATH))) return "尚无 Yoinks 日志。"
    return await FileManager.readAsString(LATEST_LOG_PATH)
  } catch (error) {
    return `读取日志失败：${safeText(error)}`
  }
}

export async function clearLogs(): Promise<void> {
  try {
    if (await FileManager.exists(LATEST_LOG_PATH)) await FileManager.remove(LATEST_LOG_PATH)
  } catch {}
}

export function getLogDirectory(): string {
  return LOG_DIR
}
