import {
  Button,
  HStack,
  Image,
  List,
  Navigation,
  NavigationStack,
  ProgressView,
  Script,
  Section,
  Spacer,
  Text,
  Toggle,
  VStack,
  Tab,
  TabView,
  useEffect,
  useObservable,
  useRef,
  useState,
} from "scripting"
import {
  clearLogs,
  getLogDirectory,
  isDebugModeEnabled,
  logEvent,
  readLatestLog,
  readLogPage,
  setDebugModeEnabled,
  type LogFilter,
  type LogLevel,
  type LogPage as LogPageData,
  type YoinksLogEvent,
} from "./services/logs"
import {
  cancelDownload,
  detectMediaPlatform,
  downloadMedia,
  extractFirstURL,
  getToolStatus,
  installYtDlp,
  mediaPlatformLabel,
  probeMedia,
  saveResult,
  type ConcurrentDownloads,
  type DownloadResult,
  type MediaChoice,
  type MediaProbe,
  type SaveMode,
  type ToolStatus,
} from "./services/media"
import {
  addHistoryRecord,
  clearHistoryRecordsAndFiles,
  deleteHistoryRecord,
  getHistoryStorageSummary,
  isHistoryFileAvailable,
  listHistoryRecords,
  pruneHistoryStorage,
  removeHistoryManagedFile,
  type DownloadHistoryRecord,
  type HistoryStorageSummary,
} from "./services/history"
import {
  getPreferences,
  setPreferences,
  type YoinksPreferences,
} from "./services/preferences"
import {
  authPlatformLabel,
  beginPlatformLogin,
  clearPlatformLogin,
  createTaskCookieFile,
  disposePlatformSession,
  isAuthPlatform,
  isFreshCookieError,
  removeTaskCookieFile,
  restorePersistentPlatformSession,
  supportedAuthPlatforms,
  type AuthPlatform,
  type PlatformAuthSession,
} from "./services/platform-auth"

const HISTORY_TAB = 0
const DOWNLOAD_TAB = 1
const SETTINGS_TAB = 2
type YoinksTab = typeof HISTORY_TAB | typeof DOWNLOAD_TAB | typeof SETTINGS_TAB

const CONCURRENCY_LABELS: Record<ConcurrentDownloads, string> = {
  1: "单线程",
  2: "2 线程（推荐）",
  4: "4 线程",
  8: "8 线程",
}
const SAVE_LABELS: Record<SaveMode, string> = {
  ask: "下载后询问",
  photos: "自动保存到相册",
  files: "自动导出到文件",
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatHistoryDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false })
}

function toolLabel(status: ToolStatus | null) {
  if (!status) return "正在检查"
  return status.ytDlpVersion ? `yt-dlp ${status.ytDlpVersion}` : "yt-dlp 未安装"
}

function statusIcon(installed: boolean) {
  return installed ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
}

function isCertificateError(message: string): boolean {
  return /CERTIFICATE_VERIFY_FAILED|certificate verify failed|self-signed certificate/i.test(message)
}

const INITIAL_LOG_EVENT_LIMIT = 20
const LOG_FILTER_LABELS: Record<LogFilter, string> = {
  all: "全部",
  info: "信息",
  warn: "警告",
  error: "错误",
}
const LOG_LEVEL_STYLE: Record<LogLevel, { label: string; icon: string; color: string }> = {
  debug: { label: "调试", icon: "ladybug", color: "secondaryLabel" },
  info: { label: "信息", icon: "info.circle.fill", color: "blue" },
  warn: { label: "警告", icon: "exclamationmark.triangle.fill", color: "orange" },
  error: { label: "错误", icon: "xmark.octagon.fill", color: "red" },
}

function formatLogTimestamp(timestamp?: string): string {
  if (!timestamp) return "尚无记录"
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString("zh-CN", { hour12: false })
}

function formatLogSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function logSummary(event: YoinksLogEvent): string {
  const entries = Object.entries(event.details || {})
  if (!entries.length) return event.taskId ? `任务：${event.taskId}` : "无附加信息"
  return entries.slice(0, 2).map(([key, value]) => `${key}=${String(value)}`).join(" · ")
}

function LogDetailPage(props: { event: YoinksLogEvent }) {
  const dismiss = Navigation.useDismiss()
  const style = LOG_LEVEL_STYLE[props.event.level]
  return (
    <NavigationStack>
      <List navigationTitle="日志详情" navigationBarTitleDisplayMode="inline" toolbar={{ cancellationAction: <Button title="关闭" action={dismiss} /> }}>
        <Section title="事件">
          <HStack spacing={8}>
            <Image systemName={style.icon} foregroundStyle={style.color as any} />
            <Text font="headline">{style.label} · {props.event.event}</Text>
          </HStack>
          <Text font="caption" foregroundStyle="secondaryLabel">{formatLogTimestamp(props.event.timestamp)}</Text>
          {props.event.taskId ? <Text font="caption" foregroundStyle="secondaryLabel">任务：{props.event.taskId}</Text> : null}
        </Section>
        <Section title="已脱敏详情">
          {Object.entries(props.event.details || {}).length ? Object.entries(props.event.details || {}).map(([key, value]) => (
            <VStack alignment="leading" spacing={3} key={key}>
              <Text font="caption" foregroundStyle="secondaryLabel">{key}</Text>
              <Text>{String(value)}</Text>
            </VStack>
          )) : <Text foregroundStyle="secondaryLabel">此事件没有附加字段。</Text>}
        </Section>
      </List>
    </NavigationStack>
  )
}

function AboutPage() {
  const dismiss = Navigation.useDismiss()
  const openUpstreamProject = async () => {
    try {
      await Safari.present("https://github.com/pablostanley/yoinks/tree/main", true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await Dialog.alert({ title: "无法打开项目页面", message })
    }
  }

  return (
    <NavigationStack>
      <List navigationTitle="关于 Yoinks" navigationBarTitleDisplayMode="inline" toolbar={{ cancellationAction: <Button title="关闭" action={dismiss} /> }}>
        <Section title="Yoinks">
          <Text>Yoinks 是基于 Scripting 的公开媒体链接下载工具：先探测可用格式，再按选择下载和保存。</Text>
        </Section>
        <Section title="功能与特点">
          <Text>支持格式优先选择、可用时的在线预览、音视频下载与 FFmpeg 合并，以及保存到相册或文件。</Text>
          <Text>下载记录和本地原文件可统一管理；需要登录的平台会在探测或下载时提供登录重试。调试模式开启后可查看结构化运行日志。</Text>
        </Section>
        <Section title="原版兼容性">
          <Text>Scripting 中的 Node.js 运行能力由 Swift 与 JavaScript 层模拟，并非完整的原生 Node.js 运行时。即使依赖包齐全，执行 Node 或 npm run 仍可能因 waitUntilExit 等兼容性问题无法正常运行。</Text>
          <Text>因此当前版本保留 Yoinks 的名称与核心下载体验，未能完整复现原项目的全部能力。待 Scripting 作者进一步完善 npm 与 Node 运行支持后，脚本将继续跟进更新。</Text>
        </Section>
        <Section title="致谢">
          <Button title="打开 Yoinks 开源项目" systemImage="arrow.up.right.square" action={() => void openUpstreamProject()} />
          <Text font="caption" foregroundStyle="secondaryLabel">感谢 Pablo Stanley 与 Yoinks 开源项目提供的灵感。</Text>
        </Section>
      </List>
    </NavigationStack>
  )
}

function LogPage() {
  const dismiss = Navigation.useDismiss()
  const [filter, setFilter] = useState<LogFilter>("all")
  const [limit, setLimit] = useState(INITIAL_LOG_EVENT_LIMIT)
  const [loadingMore, setLoadingMore] = useState(false)
  const [page, setPage] = useState<LogPageData>({ events: [], totalMatching: 0, totalAvailable: 0, hasMore: false, sizeBytes: 0 })

  const refresh = async (nextFilter = filter, nextLimit = limit) => {
    setPage(await readLogPage(nextFilter, 0, nextLimit))
  }

  useEffect(() => { void refresh("all", INITIAL_LOG_EVENT_LIMIT) }, [])

  const loadNextEvent = async () => {
    if (loadingMore || !page.hasMore) return
    const nextLimit = limit + 1
    setLoadingMore(true)
    try {
      setPage(await readLogPage(filter, 0, nextLimit))
      setLimit(nextLimit)
    } finally {
      setLoadingMore(false)
    }
  }

  const chooseFilter = async () => {
    const filters: LogFilter[] = ["all", "info", "warn", "error"]
    const selection = await Dialog.actionSheet({ title: "日志级别", actions: filters.map((value) => ({ label: LOG_FILTER_LABELS[value] })), cancelButton: true })
    if (selection == null) return
    const nextFilter = filters[selection]
    setFilter(nextFilter)
    setLimit(INITIAL_LOG_EVENT_LIMIT)
    await refresh(nextFilter, INITIAL_LOG_EVENT_LIMIT)
  }

  const clear = async () => {
    const confirmed = await Dialog.confirm({ title: "清空运行日志", message: "只会清空当前日志；按任务归档的历史日志将保留。", confirmLabel: "清空", cancelLabel: "取消" })
    if (!confirmed) return
    await clearLogs()
    setLimit(INITIAL_LOG_EVENT_LIMIT)
    await refresh(filter, INITIAL_LOG_EVENT_LIMIT)
  }

  const showDetail = async (event: YoinksLogEvent) => {
    await Navigation.present({ element: <LogDetailPage event={event} /> })
  }

  return (
    <NavigationStack>
      <List navigationTitle="运行日志" navigationBarTitleDisplayMode="inline" toolbar={{ cancellationAction: <Button title="关闭" action={dismiss} /> }}>
        <Section title="筛选与维护">
          <Button title={`级别：${LOG_FILTER_LABELS[filter]}`} systemImage="line.3.horizontal.decrease.circle" action={() => void chooseFilter()} />
          <Button title="刷新日志" systemImage="arrow.clockwise" action={() => { setLimit(INITIAL_LOG_EVENT_LIMIT); void refresh(filter, INITIAL_LOG_EVENT_LIMIT) }} />
          <Button title="清空运行日志" systemImage="trash" role="destructive" action={() => void clear()} />
        </Section>
        <Section title="状态">
          <Text>当前记录：{page.totalAvailable} 条</Text>
          <Text>筛选结果：{page.totalMatching} 条</Text>
          <Text>文件大小：{formatLogSize(page.sizeBytes)}</Text>
          <Text>最后写入：{formatLogTimestamp(page.lastWrittenAt)}</Text>
        </Section>
        <Section title="最近事件（新到旧）">
          {page.events.map((event, index) => {
            const style = LOG_LEVEL_STYLE[event.level]
            return <Button key={`${event.timestamp}-${event.event}-${index}`} onAppear={index === page.events.length - 1 ? () => void loadNextEvent() : undefined} action={() => void showDetail(event)}>{
              <HStack spacing={10}>
                <Image systemName={style.icon} foregroundStyle={style.color as any} frame={{ width: 20 }} />
                <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
                  <Text font="subheadline" lineLimit={1}>{style.label.toUpperCase()} · {event.event}</Text>
                  <Text font="caption" foregroundStyle="secondaryLabel">{formatLogTimestamp(event.timestamp)}</Text>
                  <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{logSummary(event)}</Text>
                </VStack>
              </HStack>
            }</Button>
          })}
          {!page.events.length ? <Text foregroundStyle="secondaryLabel">尚无符合条件的日志。</Text> : null}
          {loadingMore ? <HStack><ProgressView /><Text font="caption" foregroundStyle="secondaryLabel">正在加载更早的日志</Text></HStack> : null}
        </Section>
      </List>
    </NavigationStack>
  )
}

function isHTTPURL(source: string): boolean {
  try {
    const url = new URL(source)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function mediaSourceURL(source: string): string {
  return isHTTPURL(source) ? source : `file://${encodeURI(source)}`
}

function safeJavaScriptString(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

function playerHTML(source: string, useRelativeLocalURL = false): string {
  const mediaURL = safeJavaScriptString(
    useRelativeLocalURL
      ? encodeURI(source.slice(source.lastIndexOf("/") + 1))
      : mediaSourceURL(source),
  )
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
  html, body { width: 100%; height: 100%; margin: 0; background: #000; overflow: hidden; }
  video { width: 100%; height: 100%; object-fit: contain; background: #000; }
</style>
</head>
<body>
<video id="player" controls autoplay playsinline></video>
<script>
  const player = document.getElementById("player")
  player.src = ${mediaURL}
  const report = (event) => {
    window.webkit.messageHandlers.mediaEvent.postMessage({
      event,
      currentTime: player.currentTime,
      duration: player.duration,
      error: player.error ? player.error.message : null,
    })
  }
  player.addEventListener("loadedmetadata", () => report("loadedmetadata"))
  player.addEventListener("playing", () => report("playing"))
  player.addEventListener("error", () => report("error"))
  player.play().catch(() => report("play.failed"))
</script>
</body>
</html>`
}

async function presentHTML5Player(source: string, title: string): Promise<void> {
  const webView = new WebViewController({ ephemeral: true })
  const isRemote = isHTTPURL(source)
  if (!isRemote && !source.startsWith("/")) throw new Error("本地视频路径无效")
  const localDirectory = source.slice(0, source.lastIndexOf("/"))
  const localPagePath = `${source}.yoinks-player.html`
  try {
    await webView.addScriptMessageHandler("mediaEvent", (details: Record<string, unknown> = {}) => {
      void logEvent({ level: details.event === "error" ? "error" : "info", event: "html5-player.event", details: { ...details, title } })
      return true
    })
    const loaded = isRemote
      ? await webView.loadHTML(playerHTML(source), source)
      : await (async () => {
          await FileManager.writeAsString(localPagePath, playerHTML(source, true))
          return webView.loadFile(localPagePath, localDirectory)
        })()
    if (!loaded) throw new Error("无法加载视频页面")
    await logEvent({ level: "info", event: "html5-player.opened", details: { title, isRemote } })
    await webView.present({ fullscreen: true, navigationTitle: "播放" })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await logEvent({ level: "error", event: "html5-player.failed", details: { title, message } })
    await Dialog.alert({ title: "播放失败", message })
  } finally {
    webView.dispose()
    if (!isRemote && await FileManager.exists(localPagePath)) await FileManager.remove(localPagePath)
  }
}

function View() {
  const dismiss = Navigation.useDismiss()
  const activeTab = useObservable<YoinksTab>(DOWNLOAD_TAB)
  const [preferences, setPreferencesState] = useState<YoinksPreferences>(() => getPreferences())
  const [url, setURL] = useState(() => extractFirstURL(typeof Script.queryParameters.url === "string" ? Script.queryParameters.url : "") || "")
  const [probe, setProbe] = useState<MediaProbe | null>(null)
  const [selectedChoice, setSelectedChoice] = useState<MediaChoice | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [saveMode, setSaveMode] = useState<SaveMode>(() => getPreferences().defaultSaveMode)
  const [concurrentFragments, setConcurrentFragments] = useState<ConcurrentDownloads>(() => getPreferences().concurrentFragments)
  const [tools, setTools] = useState<ToolStatus | null>(null)
  const [loadingTools, setLoadingTools] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [cancelPath, setCancelPath] = useState<string | null>(null)
  const [progress, setProgress] = useState({ fraction: 0, stage: "准备就绪" })
  const [status, setStatus] = useState("粘贴一个公开媒体链接，然后选择输出格式。")
  const [result, setResult] = useState<DownloadResult | null>(null)
  const [completedSaveMode, setCompletedSaveMode] = useState<SaveMode | null>(null)
  const [latestLog, setLatestLog] = useState("")
  const [history, setHistory] = useState<DownloadHistoryRecord[]>([])
  const [historyAvailability, setHistoryAvailability] = useState<Record<string, boolean>>({})
  const [historySummary, setHistorySummary] = useState<HistoryStorageSummary>({ totalRecords: 0, availableCount: 0, managedBytes: 0 })
  const [debugMode, setDebugModeState] = useState(() => isDebugModeEnabled())
  const [enteringURL, setEnteringURL] = useState(false)
  const [platformSessions, setPlatformSessions] = useState<Partial<Record<AuthPlatform, PlatformAuthSession>>>({})
  const loggedInSessions = Object.values(platformSessions).filter((session): session is PlatformAuthSession => session != null)
  const platformSessionsRef = useRef<Partial<Record<AuthPlatform, PlatformAuthSession>>>({})

  const updateSaveMode = (next: SaveMode) => {
    const nextPreferences = setPreferences({ ...preferences, defaultSaveMode: next })
    setPreferencesState(nextPreferences)
    setSaveMode(nextPreferences.defaultSaveMode)
  }

  const selectMediaChoice = (nextChoice: MediaChoice | null) => {
    setSelectedChoice(nextChoice)
    if (nextChoice?.kind === "audio" && saveMode === "photos") updateSaveMode("files")
  }

  const refreshHistory = async () => {
    const [records, summary] = await Promise.all([listHistoryRecords(), getHistoryStorageSummary()])
    const availability = await Promise.all(records.map(async (record) => [record.id, await isHistoryFileAvailable(record)] as const))
    setHistory(records)
    setHistoryAvailability(Object.fromEntries(availability))
    setHistorySummary(summary)
  }

  const updatePreferences = (next: YoinksPreferences) => {
    const saved = setPreferences(next)
    setPreferencesState(saved)
    setSaveMode(saved.defaultSaveMode)
    setConcurrentFragments(saved.concurrentFragments)
    return saved
  }

  const recordCompletedDownload = async (downloaded: DownloadResult, mode: SaveMode, title: string): Promise<boolean> => {
    const record: DownloadHistoryRecord = {
      id: downloaded.taskId,
      createdAt: new Date().toISOString(),
      taskId: downloaded.taskId,
      title,
      sourceURL: downloaded.sourceURL,
      filePath: downloaded.filePath,
      fileName: downloaded.fileName,
      fileSizeBytes: downloaded.fileSizeBytes,
      mediaKind: downloaded.choice.kind,
      formatLabel: downloaded.choice.label,
      saveMode: mode,
    }
    try {
      await addHistoryRecord(record)
      if (preferences.retainOriginalFiles) {
        const pruned = await pruneHistoryStorage(preferences)
        if (pruned.failedPaths.length) {
          await logEvent({ level: "warn", event: "history.prune.partial", taskId: downloaded.taskId, details: { failedPaths: pruned.failedPaths, managedBytes: pruned.managedBytes, totalRecords: pruned.totalRecords } })
        }
      } else {
        await removeHistoryManagedFile(record)
      }
      await refreshHistory()
      return await isHistoryFileAvailable(record)
    } catch (error) {
      await logEvent({ level: "warn", event: "history.write.failed", taskId: downloaded.taskId, details: { message: error instanceof Error ? error.message : String(error), filePath: downloaded.filePath } })
      setStatus("下载已完成，但未能写入下载记录。")
      return await FileManager.exists(downloaded.filePath)
    }
  }

  const changeDebugMode = (enabled: boolean) => {
    setDebugModeEnabled(enabled)
    setDebugModeState(enabled)
    if (enabled) void logEvent({ level: "info", event: "debug-mode.enabled" })
  }

  const updatePlatformSessions = (updater: (current: Partial<Record<AuthPlatform, PlatformAuthSession>>) => Partial<Record<AuthPlatform, PlatformAuthSession>>) => {
    setPlatformSessions((current) => {
      const next = updater(current)
      platformSessionsRef.current = next
      return next
    })
  }

  const refreshTools = async () => {
    setLoadingTools(true)
    try {
      const current = await getToolStatus()
      setTools(current)
      setStatus(current.ytDlpVersion ? "下载引擎已就绪。" : "需要安装 yt-dlp 才能下载。")
    } catch (error) {
      setStatus(`工具检测失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setLoadingTools(false)
    }
  }

  const refreshLoggedInSessions = async () => {
    await Promise.all(supportedAuthPlatforms().map((platform) => sessionForPlatform(platform)))
  }

  useEffect(() => {
    void refreshTools()
    void refreshHistory()
    void refreshLoggedInSessions()
    return () => {
      for (const session of Object.values(platformSessionsRef.current)) {
        if (session?.retention === "temporary") disposePlatformSession(session)
      }
    }
  }, [])

  const disposeTemporarySession = (platform?: AuthPlatform) => {
    updatePlatformSessions((current) => {
      const next = { ...current }
      for (const candidate of Object.keys(next) as AuthPlatform[]) {
        if (platform && candidate !== platform) continue
        const session = next[candidate]
        if (session?.retention === "temporary") {
          disposePlatformSession(session)
          delete next[candidate]
        }
      }
      return next
    })
  }

  const sessionForPlatform = async (platform: AuthPlatform): Promise<PlatformAuthSession | null> => {
    const current = platformSessionsRef.current[platform]
    if (current) return current
    const restored = await restorePersistentPlatformSession(platform)
    if (restored) updatePlatformSessions((sessions) => ({ ...sessions, [platform]: restored }))
    return restored
  }

  const loginForPlatform = async (platform: AuthPlatform): Promise<PlatformAuthSession | null> => {
    const choice = await Dialog.actionSheet({
      title: `${authPlatformLabel(platform)}需要登录状态`,
      message: "平台要求近期 Cookie 才能继续。仅本次使用会在关闭 Yoinks、替换链接或下载结束后清除；保留登录状态可用于该平台之后的下载。",
      actions: [{ label: "仅本次使用" }, { label: "保留登录状态" }],
      cancelButton: true,
    })
    if (choice == null) return null
    const retention = choice === 0 ? "temporary" : "persistent"
    setStatus(`请在${authPlatformLabel(platform)}页面完成登录，完成后关闭页面。`)
    const session = await beginPlatformLogin(platform, retention)
    updatePlatformSessions((current) => ({ ...current, [platform]: session }))
    await logEvent({ level: "info", event: "platform-auth.login.completed", details: { platform, retention } })
    return session
  }

  const probeWithPlatformSession = async (sourceURL: string, session: PlatformAuthSession | null): Promise<MediaProbe> => {
    let cookieFile: string | null = null
    try {
      if (session) cookieFile = await createTaskCookieFile(session)
      return await probeMedia(sourceURL, { cookieFile: cookieFile || undefined, authorizedPlatform: session?.platform })
    } finally {
      await removeTaskCookieFile(cookieFile)
    }
  }

  const downloadWithPlatformSession = async (sourceURL: string, platform: AuthPlatform | null, insecureTLS: boolean, session: PlatformAuthSession | null): Promise<DownloadResult> => {
    let cookieFile: string | null = null
    try {
      if (session) cookieFile = await createTaskCookieFile(session)
      return await downloadMedia({
        url: sourceURL,
        choice: selectedChoice!,
        concurrentFragments,
        insecureTLS,
        cookieFile: cookieFile || undefined,
        authorizedPlatform: platform || undefined,
        onProgress: (value) => {
          setProgress(value)
          setStatus(value.stage)
        },
        onCancelPath: setCancelPath,
      })
    } finally {
      await removeTaskCookieFile(cookieFile)
    }
  }

  const clearPlatformAuth = async () => {
    const sessions = loggedInSessions
    if (!sessions.length) return
    let session = sessions[0]
    if (sessions.length > 1) {
      const choice = await Dialog.actionSheet({
        title: "选择要清除的登录状态",
        actions: sessions.map((item) => ({ label: item.accountLabel, role: "destructive" as const })),
        cancelButton: true,
      })
      if (choice == null) return
      session = sessions[choice]
    }
    const confirmed = await Dialog.confirm({
      title: "清除登录状态",
      message: `将清除 ${session.accountLabel} 的 Yoinks 登录状态。`,
      confirmLabel: "清除",
      cancelLabel: "取消",
    })
    if (!confirmed) return
    const removed = await clearPlatformLogin(session.platform)
    disposePlatformSession(platformSessionsRef.current[session.platform])
    updatePlatformSessions((current) => {
      const next = { ...current }
      delete next[session.platform]
      return next
    })
    await logEvent({ level: "info", event: "platform-auth.cleared", details: { platform: session.platform, cookieCount: removed } })
    setStatus("登录状态已清除。")
  }


  const showLogs = async () => {
    await Navigation.present({ element: <LogPage /> })
  }

  const copyLogs = async () => {
    const text = latestLog || await readLatestLog()
    await Pasteboard.setString(text)
    setStatus("最近日志已复制到剪贴板。")
  }

  const openLogFolder = async () => {
    await QuickLook.previewURLs([getLogDirectory()], true)
  }

  const pasteURL = async () => {
    await logEvent({ level: "info", event: "paste.requested" })
    try {
      if (!(await Pasteboard.hasStrings)) {
        await logEvent({ level: "warn", event: "paste.empty" })
        setStatus("剪贴板中没有文本链接。")
        return
      }
      const next = extractFirstURL(await Pasteboard.getString())
      if (!next) {
        await logEvent({ level: "warn", event: "paste.invalid" })
        setStatus("剪贴板中没有有效的公开 http 或 https 链接。")
        return
      }
      await logEvent({ level: "info", event: "paste.accepted", details: { sourceURL: next, platform: detectMediaPlatform(next) } })
      disposeTemporarySession()
      setURL(next)
      setProbe(null)
      setSelectedChoice(null)
      setResult(null)
      setStatus("链接已粘贴，正在自动分析。")
      await analyzeMedia(next)
    } catch (error) {
      await logEvent({ level: "error", event: "paste.failed", details: { message: error instanceof Error ? error.message : String(error) } })
      setStatus("无法读取剪贴板。请在 设置 > Scripting > Paste from Other Apps 中允许访问。")
    }
  }

  const enterURL = async () => {
    if (enteringURL) return
    setEnteringURL(true)
    await logEvent({ level: "info", event: "manual-url.requested" })
    try {
      const raw = await Dialog.prompt({
        title: "媒体链接",
        message: "支持公开的 http 或 https 页面链接。",
        placeholder: "https://...",
        confirmLabel: "使用链接",
        cancelLabel: "取消",
        selectAll: true,
      })
      if (raw == null) {
        await logEvent({ level: "info", event: "manual-url.cancelled" })
        return
      }
      const next = extractFirstURL(raw)
      if (!next) {
        await logEvent({ level: "warn", event: "manual-url.invalid" })
        setStatus("请输入有效的公开 http 或 https 链接。")
        return
      }
      await logEvent({ level: "info", event: "manual-url.accepted", details: { sourceURL: next, platform: detectMediaPlatform(next) } })
      disposeTemporarySession()
      setURL(next)
      setProbe(null)
      setSelectedChoice(null)
      setResult(null)
      setStatus("媒体链接已设置，正在自动分析。")
      await analyzeMedia(next)
    } finally {
      setEnteringURL(false)
    }
  }

  const analyzeMedia = async (source?: string) => {
    if (analyzing || downloading) return
    const validURL = extractFirstURL(source || url)
    if (!validURL) {
      setStatus("请先粘贴或输入有效的公开链接。")
      return
    }
    let availableTools = tools
    if (!availableTools?.ytDlpVersion) {
      setStatus("正在检查下载引擎。")
      try {
        availableTools = await getToolStatus()
        setTools(availableTools)
      } catch (error) {
        setStatus(`工具检测失败：${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }
    if (!availableTools.ytDlpVersion) {
      setStatus("请先安装 yt-dlp。")
      return
    }
    setAnalyzing(true)
    setProbe(null)
    setSelectedChoice(null)
    setStatus("正在分析媒体和可用格式。")
    try {
      const platform = detectMediaPlatform(validURL)
      const session = isAuthPlatform(platform) ? await sessionForPlatform(platform) : null
      const nextProbe = await probeWithPlatformSession(validURL, session)
      setProbe(nextProbe)
      selectMediaChoice(nextProbe.choices[0] || null)
      setStatus(`已找到 ${nextProbe.choices.length} 个可下载格式。`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const platform = detectMediaPlatform(validURL)
      if (isAuthPlatform(platform) && isFreshCookieError(message)) {
        try {
          const session = await loginForPlatform(platform)
          if (session) {
            setStatus(`正在使用${authPlatformLabel(platform)}登录状态重新分析。`)
            const nextProbe = await probeWithPlatformSession(validURL, session)
            setProbe(nextProbe)
            selectMediaChoice(nextProbe.choices[0] || null)
            setStatus(`已找到 ${nextProbe.choices.length} 个可下载格式。`)
            return
          }
        } catch (loginError) {
          const loginMessage = loginError instanceof Error ? loginError.message : String(loginError)
          await logEvent({ level: "error", event: "platform-auth.login.failed", details: { platform, message: loginMessage } })
          setStatus(loginMessage)
          await Dialog.alert({ title: `${authPlatformLabel(platform)}登录未完成`, message: loginMessage })
          return
        }
      }
      await logEvent({ level: "error", event: "probe.failed", details: { sourceURL: validURL, message } })
      setStatus(message)
      setLatestLog(await readLatestLog())
      await Dialog.alert({ title: "媒体分析失败", message: `${message}\n\n诊断日志已写入：${getLogDirectory()}` })
    } finally {
      setAnalyzing(false)
    }
  }

  const chooseFormat = async () => {
    if (!probe?.choices.length) {
      setStatus("请先分析链接。")
      return
    }
    const choice = await Dialog.actionSheet({
      title: "可直接下载格式",
      message: probe.title,
      actions: probe.choices.map((item) => ({ label: item.label })),
      cancelButton: true,
    })
    if (choice != null) {
      const nextChoice = probe.choices[choice]
      selectMediaChoice(nextChoice)
    }
  }

  const chooseSaveMode = async () => {
    const values: SaveMode[] = selectedChoice?.kind === "audio" ? ["ask", "files"] : ["ask", "photos", "files"]
    const choice = await Dialog.actionSheet({
      title: "下载完成后",
      actions: values.map((value) => ({ label: SAVE_LABELS[value] })),
      cancelButton: true,
    })
    if (choice != null) updateSaveMode(values[choice])
  }

  const chooseConcurrency = async () => {
    const values: ConcurrentDownloads[] = [1, 2, 4, 8]
    const choice = await Dialog.actionSheet({
      title: "下载并发",
      message: "仅对支持分片的来源生效；单文件格式会保持单连接。",
      actions: values.map((value) => ({ label: CONCURRENCY_LABELS[value] })),
      cancelButton: true,
    })
    if (choice != null) {
      const next = values[choice]
      updatePreferences({ ...preferences, concurrentFragments: next })
    }
  }

  const install = async () => {
    const name = "yt-dlp"
    const detail = "将执行 python3 -m pip install --upgrade yt-dlp。"
    const confirmed = await Dialog.confirm({ title: `安装 ${name}`, message: detail, confirmLabel: "安装", cancelLabel: "取消" })
    if (!confirmed) return
    setInstalling(true)
    setStatus(`正在安装 ${name}...`)
    try {
      const version = await installYtDlp()
      setStatus(`${name} ${version} 已安装。`)
      await refreshTools()
    } catch (error) {
      setStatus(`安装失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setInstalling(false)
    }
  }

  const previewSelectedChoice = async () => {
    if (!selectedChoice?.previewURL || !probe) {
      setStatus("当前格式没有可用的预览链接。请重新分析后再试。")
      return
    }
    await presentHTML5Player(selectedChoice.previewURL, probe.title)
  }

  const startDownload = async (insecureTLS = false) => {
    if (!tools?.ytDlpVersion) {
      setStatus("请先安装 yt-dlp。")
      return
    }
    const validURL = extractFirstURL(url)
    if (!validURL) {
      setStatus("请先粘贴或输入有效的公开链接。")
      return
    }

    if (!selectedChoice) {
      setStatus("请先分析链接并选择实际可用格式。")
      return
    }

    setDownloading(true)
    setCancelPath(null)
    setResult(null)
    setCompletedSaveMode(null)
    setProgress({ fraction: 0.02, stage: "正在解析媒体" })
    setStatus("yt-dlp 正在准备下载。")

    try {
      const platform = detectMediaPlatform(validURL)
      const session = isAuthPlatform(platform) ? await sessionForPlatform(platform) : null
      const downloaded = await downloadWithPlatformSession(validURL, isAuthPlatform(platform) ? platform : null, insecureTLS, session)
      const effectiveSaveMode: SaveMode = downloaded.choice.kind === "audio" && saveMode === "photos" ? "files" : saveMode
      if (effectiveSaveMode !== saveMode) updateSaveMode(effectiveSaveMode)
      const saveStatus = await saveResult(downloaded.filePath, downloaded.fileName, effectiveSaveMode, downloaded.taskId)
      setResult(downloaded)
      setStatus(saveStatus)
      if (effectiveSaveMode !== "ask") setCompletedSaveMode(effectiveSaveMode)
      const sourceFileAvailable = await recordCompletedDownload(downloaded, effectiveSaveMode, probe?.title || downloaded.fileName)
      if (!sourceFileAvailable) {
        setResult(null)
        setCompletedSaveMode(null)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const logs = await readLatestLog()
      setLatestLog(logs)
      setStatus(message)
      const platform = detectMediaPlatform(validURL)
      if (isAuthPlatform(platform) && isFreshCookieError(message)) {
        try {
          const session = await loginForPlatform(platform)
          if (session) {
            setStatus(`正在使用${authPlatformLabel(platform)}登录状态重新下载。`)
            const downloaded = await downloadWithPlatformSession(validURL, platform, insecureTLS, session)
            const effectiveSaveMode: SaveMode = downloaded.choice.kind === "audio" && saveMode === "photos" ? "files" : saveMode
            if (effectiveSaveMode !== saveMode) updateSaveMode(effectiveSaveMode)
            const saveStatus = await saveResult(downloaded.filePath, downloaded.fileName, effectiveSaveMode, downloaded.taskId)
            setResult(downloaded)
            setStatus(saveStatus)
            if (effectiveSaveMode !== "ask") setCompletedSaveMode(effectiveSaveMode)
      const sourceFileAvailable = await recordCompletedDownload(downloaded, effectiveSaveMode, probe?.title || downloaded.fileName)
      if (!sourceFileAvailable) {
        setResult(null)
        setCompletedSaveMode(null)
      }
            return
          }
        } catch (loginError) {
          const loginMessage = loginError instanceof Error ? loginError.message : String(loginError)
          await logEvent({ level: "error", event: "platform-auth.download-login.failed", details: { platform, message: loginMessage } })
          setStatus(loginMessage)
          await Dialog.alert({ title: `${authPlatformLabel(platform)}登录未完成`, message: loginMessage })
          return
        }
      }
      if (!insecureTLS && isCertificateError(message)) {
        const retry = await Dialog.confirm({
          title: "证书校验失败",
          message: "当前网络返回了未受信任的 TLS 证书。兼容模式会仅对本次下载跳过证书校验。请只在你信任当前网络时继续。",
          confirmLabel: "继续下载",
          cancelLabel: "取消",
        })
        if (retry) {
          setStatus("正在以证书兼容模式重试。")
          await startDownload(true)
          return
        }
      }
      if (message !== "下载已取消") await Dialog.alert({ title: "下载失败", message: `${message}\n\n任务日志已写入：${getLogDirectory()}` })
    } finally {
      const platform = detectMediaPlatform(validURL)
      if (isAuthPlatform(platform)) disposeTemporarySession(platform)
      setDownloading(false)
      setCancelPath(null)
    }
  }

  const stopDownload = async () => {
    if (!cancelPath) return
    const confirmed = await Dialog.confirm({
      title: "取消下载",
      message: "当前下载将停止，未完成的临时文件会被清理。",
      confirmLabel: "取消下载",
      cancelLabel: "继续下载",
    })
    if (!confirmed) return
    await cancelDownload(cancelPath)
    setStatus("正在取消下载。")
  }

  const chooseLinkSource = async () => {
    const choice = await Dialog.actionSheet({
      title: "添加媒体链接",
      actions: [{ label: "从剪贴板粘贴" }, { label: "手动输入" }],
      cancelButton: true,
    })
    if (choice === 0) await pasteURL()
    if (choice === 1) await enterURL()
  }

  const openHistoryActions = async (record: DownloadHistoryRecord) => {
    const available = await isHistoryFileAvailable(record)
    const canSaveToPhotos = record.mediaKind === "video"
    const actions = [
      ...(available ? [{ label: "播放" }, { label: "分享" }] : []),
      ...(available && canSaveToPhotos ? [{ label: "保存到相册" }] : []),
      ...(available ? [{ label: "导出到文件" }] : []),
      { label: "重新下载" },
      { label: "打开来源链接" },
      { label: "复制来源链接" },
      { label: available ? "删除记录和本地文件" : "删除记录", role: "destructive" as const },
    ]
    const choice = await Dialog.actionSheet({ title: record.title, message: `${record.formatLabel} · ${formatHistoryDate(record.createdAt)}`, actions, cancelButton: true })
    if (choice == null) return
    const action = actions[choice].label
    try {
      if (action === "播放") await QuickLook.previewURLs([record.filePath], true)
      if (action === "分享") await ShareSheet.present([record.filePath])
      if (action === "保存到相册") await saveResult(record.filePath, record.fileName, "photos", record.taskId)
      if (action === "导出到文件") await saveResult(record.filePath, record.fileName, "files", record.taskId)
      if (action === "重新下载") {
        setURL(record.sourceURL)
        setProbe(null)
        setSelectedChoice(null)
        setResult(null)
        activeTab.setValue(DOWNLOAD_TAB)
        await analyzeMedia(record.sourceURL)
      }
      if (action === "打开来源链接") await Safari.present(record.sourceURL, true)
      if (action === "复制来源链接") {
        await Pasteboard.setString(record.sourceURL)
        setStatus("来源链接已复制。")
      }
      if (action === "删除记录和本地文件" || action === "删除记录") {
        const confirmed = await Dialog.confirm({ title: "删除下载记录", message: action === "删除记录和本地文件" ? "将删除此记录及 Yoinks 保存的原文件。" : "将删除此记录。", confirmLabel: "删除", cancelLabel: "取消" })
        if (!confirmed) return
        await deleteHistoryRecord(record, action === "删除记录和本地文件")
        await refreshHistory()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await logEvent({ level: "warn", event: "history.action.failed", taskId: record.taskId, details: { action, message, filePath: record.filePath } })
      await Dialog.alert({ title: "操作失败", message })
    }
  }

  const clearHistory = async () => {
    const confirmed = await Dialog.confirm({ title: "清空下载记录", message: "将删除所有下载记录和 Yoinks 保存的原文件，不会删除相册或文件 App 中的副本。", confirmLabel: "清空", cancelLabel: "取消" })
    if (!confirmed) return
    const result = await clearHistoryRecordsAndFiles()
    await refreshHistory()
    setStatus(`已清理 ${result.deletedRecords} 条记录和 ${result.deletedFiles} 个原文件。`)
    if (result.failedPaths.length) await logEvent({ level: "warn", event: "history.clear.partial", details: { failedPaths: result.failedPaths } })
  }

  const chooseManagedBytes = async () => {
    const values: Array<number | null> = [512 * 1024 * 1024, 1024 * 1024 * 1024, 2 * 1024 * 1024 * 1024, 5 * 1024 * 1024 * 1024, null]
    const choice = await Dialog.actionSheet({ title: "本地文件上限", actions: values.map((value) => ({ label: value == null ? "不限" : formatBytes(value) })), cancelButton: true })
    if (choice == null) return
    const next = updatePreferences({ ...preferences, maxManagedBytes: values[choice] })
    const result = await pruneHistoryStorage(next)
    await refreshHistory()
    if (result.failedPaths.length) setStatus("部分旧文件无法清理，请在记录页处理。")
  }

  const chooseHistoryLimit = async () => {
    const values: Array<number | null> = [25, 50, 100, 200, null]
    const choice = await Dialog.actionSheet({ title: "下载记录上限", actions: values.map((value) => ({ label: value == null ? "不限" : `${value} 条` })), cancelButton: true })
    if (choice == null) return
    const next = updatePreferences({ ...preferences, maxHistoryRecords: values[choice] })
    const result = await pruneHistoryStorage(next)
    await refreshHistory()
    if (result.failedPaths.length) setStatus("部分旧文件无法清理，请在记录页处理。")
  }

  const changeRetention = async (enabled: boolean) => {
    const next = updatePreferences({ ...preferences, retainOriginalFiles: enabled })
    if (!enabled) return
    const result = await pruneHistoryStorage(next)
    await refreshHistory()
    if (result.failedPaths.length) setStatus("部分旧文件无法清理，请在记录页处理。")
  }

  return (
    <TabView selection={activeTab as any} tint="systemGreen" tabViewStyle="sidebarAdaptable">
      <Tab title="记录" systemImage="clock.arrow.circlepath" value={HISTORY_TAB}>
        <NavigationStack>
          <List
            navigationTitle="下载记录"
            navigationBarTitleDisplayMode="inline"
            toolbar={{
              cancellationAction: <Button title="关闭" action={dismiss} />,
              topBarTrailing: <Button title="" systemImage="arrow.clockwise" action={() => void refreshHistory()} />,
            }}
          >
            <Section header={<Text>{`记录 ${historySummary.totalRecords} 条 · 本地文件 ${historySummary.availableCount} 个`}</Text>} footer={<Text font="caption" foregroundStyle="secondaryLabel">仅管理 Yoinks 下载目录中的原文件，不会删除相册或文件 App 中的副本。</Text>}>
              {history.length ? history.map((record) => (
                <Button key={record.id} action={() => void openHistoryActions(record)}>{
                  <HStack spacing={12}>
                    <Image systemName={record.mediaKind === "audio" ? "music.note" : "play.rectangle"} foregroundStyle={record.mediaKind === "audio" ? "purple" : "blue"} frame={{ width: 24 }} />
                    <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
                      <Text font="headline" lineLimit={2}>{record.title || record.fileName}</Text>
                      <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{record.formatLabel} · {historyAvailability[record.id] ? "本地文件可用" : "文件已清理"}</Text>
                      <HStack>
                        <Text font="caption2" foregroundStyle="secondaryLabel">{formatBytes(record.fileSizeBytes)}</Text>
                        <Spacer />
                        <Text font="caption2" foregroundStyle="secondaryLabel">{formatHistoryDate(record.createdAt)}</Text>
                      </HStack>
                    </VStack>
                  </HStack>
                }</Button>
              )) : <Text foregroundStyle="secondaryLabel">尚无下载记录。</Text>}
            </Section>
            <Section title="存储">
              <Text foregroundStyle="secondaryLabel">已管理 {formatBytes(historySummary.managedBytes)}</Text>
              <Button title="清空下载记录和原文件" systemImage="trash" role="destructive" action={() => void clearHistory()} disabled={!history.length} />
            </Section>
          </List>
        </NavigationStack>
      </Tab>

      <Tab title="下载" systemImage="arrow.down.circle.fill" value={DOWNLOAD_TAB}>
        <NavigationStack>
          <List
            navigationTitle="Yoinks"
            navigationBarTitleDisplayMode="inline"
            toolbar={{
              cancellationAction: <Button title="关闭" action={dismiss} />,
              topBarTrailing: <Button title="" systemImage="plus" action={() => void chooseLinkSource()} disabled={downloading || analyzing || enteringURL} />,
            }}
          >
            <Section title="当前链接">
              <VStack alignment="leading" spacing={5}>
                <Text foregroundStyle={url ? "label" : "secondaryLabel"} lineLimit={3}>{url || "从剪贴板粘贴或手动添加公开媒体链接。"}</Text>
                {mediaPlatformLabel(url) ? <Text font="caption" foregroundStyle="secondaryLabel">来源：{mediaPlatformLabel(url)}</Text> : null}
              </VStack>
              {url ? <Button title="重新分析链接" systemImage="waveform.path.ecg" action={() => void analyzeMedia()} disabled={!tools?.ytDlpVersion || analyzing || downloading} /> : null}
            </Section>

            <Section title="格式与保存">
              {!probe ? <Text foregroundStyle="secondaryLabel">添加链接后将自动识别可下载格式。</Text> : (
                <>
                  <VStack alignment="leading" spacing={3}>
                    <Text font="headline" lineLimit={2}>{probe.title}</Text>
                    {probe.uploader ? <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{probe.uploader}</Text> : null}
                  </VStack>
                  <Button title={selectedChoice?.label || "选择格式"} systemImage={selectedChoice?.kind === "audio" ? "music.note" : "play.rectangle"} action={() => void chooseFormat()} disabled={downloading || analyzing} />
                  <Button title="在线预览" systemImage="play.circle" action={() => void previewSelectedChoice()} disabled={!selectedChoice?.previewURL || downloading || analyzing} />
                </>
              )}
              <Button title={`默认保存方式：${SAVE_LABELS[saveMode]}`} systemImage={saveMode === "photos" ? "photo.on.rectangle" : saveMode === "files" ? "folder" : "questionmark.circle"} action={() => void chooseSaveMode()} disabled={downloading || analyzing} />
            </Section>

            <Section header={<Text>{downloading ? "下载中" : "任务"}</Text>} footer={<Text font="caption" foregroundStyle="secondaryLabel">{status}</Text>}>
              {downloading ? (
                <VStack alignment="leading" spacing={10} padding={{ vertical: 6 }}>
                  <HStack><Text font="subheadline">{progress.stage}</Text><Spacer /><Text font="caption" foregroundStyle="secondaryLabel">{Math.round(progress.fraction * 100)}%</Text></HStack>
                  <ProgressView value={progress.fraction} />
                  <Button title="取消下载" systemImage="xmark" role="destructive" action={() => void stopDownload()} />
                </VStack>
              ) : <Button title="开始下载" systemImage="arrow.down.circle.fill" action={() => void startDownload()} disabled={!url || !tools?.ytDlpVersion || installing || !selectedChoice || analyzing} />}
              {result && completedSaveMode && completedSaveMode !== "ask" ? <Button title="播放" systemImage="play.circle" action={() => void QuickLook.previewURLs([result.filePath], true)} /> : null}
              {result ? <Button title="分享" systemImage="square.and.arrow.up" action={() => void ShareSheet.present([result.filePath])} /> : null}
            </Section>
          </List>
        </NavigationStack>
      </Tab>

      <Tab title="设置" systemImage="gearshape.fill" value={SETTINGS_TAB}>
        <NavigationStack>
          <List navigationTitle="设置" navigationBarTitleDisplayMode="inline" toolbar={{ cancellationAction: <Button title="关闭" action={dismiss} /> }}>
            <Section title="下载偏好">
              <Button title={`默认保存方式：${SAVE_LABELS[saveMode]}`} systemImage="square.and.arrow.down" action={() => void chooseSaveMode()} disabled={downloading || analyzing} />
              <Button title={`下载并发：${CONCURRENCY_LABELS[concurrentFragments]}`} systemImage="arrow.triangle.2.circlepath" action={() => void chooseConcurrency()} disabled={downloading || analyzing} />
            </Section>
            <Section title="本地存储">
              <Text font="caption" foregroundStyle="secondaryLabel">自动清理优先删除最早的 Yoinks 原文件和对应记录。</Text>
              <Toggle title="保留原文件" systemImage="internaldrive" value={preferences.retainOriginalFiles} onChanged={(value) => void changeRetention(value)} />
              <Text foregroundStyle="secondaryLabel">当前：{historySummary.availableCount} 个文件 · {formatBytes(historySummary.managedBytes)}</Text>
              <Button title={`本地文件上限：${preferences.maxManagedBytes == null ? "不限" : formatBytes(preferences.maxManagedBytes)}`} systemImage="externaldrive" action={() => void chooseManagedBytes()} />
              <Button title={`下载记录上限：${preferences.maxHistoryRecords == null ? "不限" : `${preferences.maxHistoryRecords} 条`}`} systemImage="list.number" action={() => void chooseHistoryLimit()} />
            </Section>
            <Section title="工具与登录">
              <HStack spacing={10}>
                <Image systemName={statusIcon(Boolean(tools?.ytDlpVersion))} foregroundStyle={tools?.ytDlpVersion ? "green" : "orange"} />
                <Text frame={{ maxWidth: "infinity", alignment: "leading" as any }}>{toolLabel(tools)}</Text>
                {!tools?.ytDlpVersion ? <Button title={installing ? "安装中" : "安装"} action={() => void install()} disabled={installing || loadingTools} /> : null}
              </HStack>
              <Button title="检查下载引擎" systemImage="arrow.clockwise" action={() => void refreshTools()} disabled={loadingTools || downloading} />
              {loggedInSessions.length ? <Button title="清除登录状态" systemImage="person.crop.circle.badge.xmark" role="destructive" action={() => void clearPlatformAuth()} disabled={downloading || analyzing} /> : <Text font="caption" foregroundStyle="secondaryLabel">需要登录的平台会在探测或下载时请求登录。</Text>}
            </Section>
            <Section title="诊断日志">
              <Toggle title="调试模式" systemImage="ladybug" value={debugMode} onChanged={changeDebugMode} />
              {debugMode ? <><Button title="查看运行日志" systemImage="list.bullet.rectangle" action={() => void showLogs()} /><Button title="复制最近日志" systemImage="doc.on.doc" action={() => void copyLogs()} /><Button title="打开日志目录" systemImage="folder" action={() => void openLogFolder()} /></> : <Text font="caption" foregroundStyle="secondaryLabel">开启调试模式后记录并查看运行日志。</Text>}
            </Section>
            <Section title="关于">
              <Button title="关于 Yoinks" systemImage="info.circle" action={() => void Navigation.present({ element: <AboutPage /> })} />
            </Section>
          </List>
        </NavigationStack>
      </Tab>
    </TabView>
  )
}

async function run() {
  try {
    await Navigation.present({ element: <View /> })
  } finally {
    Script.exit()
  }
}

run()
