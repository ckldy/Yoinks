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
  ZStack,
  useEffect,
  useObservable,
  useRef,
  useState,
} from "scripting"
import {
  consumeSkippedClipboardURL,
  rememberSkippedClipboardURL,
} from "./services/launch-clipboard"
import {
  clearLogs,
  getLogDirectory,
  isVerboseLogEnabled,
  logEvent,
  readLogPage,
  setVerboseLogEnabled,
  type LogFilter,
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
  resolveAutomaticChoice,
  saveResult,
  type ConcurrentDownloads,
  type DownloadProgress,
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
  listRecentLinks,
  rememberRecentLink,
  type RecentLinkRecord,
} from "./services/link-history"
import {
  getPreferences,
  setPreferences,
  type AutomaticDownloadFormatStrategy,
  type PreferredContainer,
  type PreviewAutoplayMode,
  type YoinksPreferences,
} from "./services/preferences"
import {
  beginPlatformLogin,
  clearPlatformLogin,
  createTaskCookieFile,
  disposePlatformSession,
  restorePersistentPlatformSession,
  type AuthPlatform,
  type PlatformAuthSession,
  authPlatformLabel,
  isAuthPlatform,
  isFreshCookieError,
  supportedAuthPlatforms,
} from "./services/platform-auth"
import { openOnlinePreview, type OnlinePreviewOptions } from "./services/online-preview"
import type { HLSPlayerService } from "./services/player/hls-player-service"

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
  photos: "相册",
  files: "文件",
  ask: "每次询问",
}
const PREVIEW_AUTOPLAY_LABELS: Record<PreviewAutoplayMode, string> = {
  muted: "静音自动播放",
  audible: "有声自动播放",
}
const AUTOMATIC_DOWNLOAD_FORMAT_LABELS: Record<AutomaticDownloadFormatStrategy, string> = {
  "recommended": "推荐",
  "highest-video": "最高画质视频",
  "highest-audio": "最高质量音频",
  "preferred-container": "指定容器格式",
}
const PREFERRED_CONTAINER_LABELS: Record<PreferredContainer, string> = {
  mp4: "MP4",
  mkv: "MKV",
  avi: "AVI",
  wmv: "WMV",
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatHistoryDate(iso: string): string {
  const date = new Date(iso)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

function formatDownloadBytes(downloaded: number, total: number): string {
  return `${formatBytes(downloaded)} / ${formatBytes(total)}`
}

function formatDownloadSpeed(speed: number, eta: number): string {
  if (!speed || speed < 1) return "计算中..."
  const etaStr = eta && eta > 0 ? ` · 预计 ${Math.round(eta)}s` : ""
  return `${formatBytes(speed)}/s${etaStr}`
}

function statusIcon(ok: boolean): string {
  return ok ? "checkmark.circle.fill" : "xmark.circle.fill"
}

function toolLabel(tools: ToolStatus | null): string {
  if (!tools) return "下载引擎：未就绪"
  if (!tools.ytDlpVersion) return "下载引擎：未安装"
  return `yt-dlp ${tools.ytDlpVersion} · 就绪`
}

function LogDetailView({ event }: { event: YoinksLogEvent }) {
  const dismiss = Navigation.useDismiss()
  return (
    <List navigationTitle="日志详情" navigationBarTitleDisplayMode="inline" toolbar={{ cancellationAction: <Button title="关闭" action={dismiss} /> }}>
      <Section header={<Text>事件</Text>}>
        <VStack alignment="leading" spacing={4} padding={{ vertical: 4 }}>
          <Text font="headline">{event.event}</Text>
          <Text font="caption" foregroundStyle="secondaryLabel">{event.timestamp}</Text>
          <HStack spacing={6}>
            <Text font="caption2" foregroundStyle={event.level === "error" ? "red" : event.level === "warn" ? "orange" : event.level === "debug" ? "gray" : "green"}>
              {event.level.toUpperCase()}
            </Text>
            {event.taskId ? <Text font="caption2" foregroundStyle="secondaryLabel">{event.taskId}</Text> : null}
          </HStack>
        </VStack>
      </Section>
      {event.details ? (
        <Section header={<Text>详情</Text>}>
          <Text font="body" foregroundStyle="label">{JSON.stringify(event.details, null, 2)}</Text>
        </Section>
      ) : null}
    </List>
  )
}

function ChangelogView() {
  const dismiss = Navigation.useDismiss()
  return (
    <List navigationTitle="更新内容" navigationBarTitleDisplayMode="inline" toolbar={{ cancellationAction: <Button title="关闭" action={dismiss} /> }}>
      <Section header={<Text>版本 1.2.0 (2026-07-24)</Text>}>
        <Text font="body">• A：下载进度分段映射 + 阶段清 progress + UI 节流，避免进度回跳与高频刷新</Text>
        <Text font="body">• B：紧凑进度置顶 + 右下浮层取消，下载中可正常滑动列表</Text>
        <Text font="body">• C：m3u8/HLS 经 FFmpeg 直连，失败时 BackgroundURLSession 回退</Text>
      </Section>
      <Section header={<Text>版本 1.1.10 (2026-07-24)</Text>}>
        <Text font="body">• 下载中进度置顶，取消与进度始终可见；链接/格式在下方可继续浏览</Text>
      </Section>
      <Section header={<Text>版本 1.1.9 (2026-07-24)</Text>}>
        <Text font="body">• 下载页去掉默认保存方式入口，统一在设置中管理</Text>
        <Text font="body">• 下载中文件大小与速度合并为一行</Text>
      </Section>
      <Section header={<Text>版本 1.1.8 (2026-07-24)</Text>}>
        <Text font="body">• 去掉下载页底部空白区块，列表末尾不再多一截空页</Text>
      </Section>
      <Section header={<Text>版本 1.1.7 (2026-07-24)</Text>}>
        <Text font="body">• 下载进度保留在任务区；列表底部留白，下载中仍可上滑查看链接/格式</Text>
      </Section>
      <Section header={<Text>版本 1.1.6 (2026-07-24)</Text>}>
        <Text font="body">• 下载同分辨率只保留一路并优先 H.264，减少 AV1 导致的验证失败</Text>
        <Text font="body">• AV1/损坏流验证失败给出可操作提示；格式列表标注编码</Text>
      </Section>
      <Section header={<Text>版本 1.1.5 (2026-07-24)</Text>}>
        <Text font="body">• 双流预览优先 H.264 视频轨，避免 AV1/HEVC 黑屏有声</Text>
        <Text font="body">• probe 从 http_headers 回填 Referer；视频轨失败时停掉孤立音频</Text>
      </Section>
      <Section header={<Text>版本 1.1.4 (2026-07-24)</Text>}>
        <Text font="body">• 在线预览：DASH 纯视频配对 audioUrl 双流（不整包同步 player skill）</Text>
        <Text font="body">• 关闭预览页不再因 12 秒超时误报「在线预览失败」</Text>
      </Section>
      <Section header={<Text>版本 1.1.2 (2026-07-24)</Text>}>
        <Text font="body">• 运行日志改为单一 runtime.jsonl（主链里程碑 + warn/error）</Text>
        <Text font="body">• 设置页始终可查看/清空运行日志；临时详细日志约 15 分钟</Text>
        <Text font="body">• 不改变下载与在线预览主链逻辑</Text>
      </Section>
      <Section header={<Text>版本 1.1.1 (2026-07-22)</Text>}>
        <Text font="body">• 重构在线预览功能，使用 media-player-skill 的 HLSPlayerService</Text>
        <Text font="body">• 移除旧的登录重试流程和下载兜底逻辑</Text>
        <Text font="body">• 完整使用 skill 的 headers/referer/origin/baseUrl 配置</Text>
        <Text font="body">• 诚实降级：Referer/Origin 由 WebView 上下文处理，原生 HLS 回退明确报告 customHeadersApplied: false</Text>
      </Section>
      <Section header={<Text>版本 1.1.0</Text>}>
        <Text font="body">• 新增三标签页架构：记录 / 下载 / 设置</Text>
        <Text font="body">• 新增偏好设置持久化，自动迁移旧配置</Text>
        <Text font="body">• 新增下载历史记录管理（保留、清理、删除）</Text>
        <Text font="body">• 新增简化版历史链接（最近 10 条）</Text>
        <Text font="body">• 新增最小运行日志（脱敏、128 KB 滚动）</Text>
        <Text font="body">• 新增 Assistant Tool 只读工具：读取最小运行日志</Text>
        <Text font="body">• 修复抖音标题含 # 导致输出路径被截断的问题</Text>
      </Section>
      <Section header={<Text>版本 1.0.0</Text>}>
        <Text font="body">• 初始版本：公开媒体链接下载、格式选择、登录重试、TLS 兼容、FFmpeg 合并、媒体验证</Text>
      </Section>
    </List>
  )
}

function AboutView() {
  const dismiss = Navigation.useDismiss()
  return (
    <List navigationTitle="关于 Yoinks" navigationBarTitleDisplayMode="inline" toolbar={{ cancellationAction: <Button title="关闭" action={dismiss} /> }}>
      <Section header={<Text>Yoinks for Scripting</Text>}>
        <VStack alignment="leading" spacing={8} padding={{ vertical: 8 }}>
          <Text font="headline">Yoinks</Text>
          <Text font="body" foregroundStyle="secondaryLabel">在 Scripting 中复刻 Yoinks 的核心下载体验</Text>
          <HStack spacing={4}>
            <Text font="caption" foregroundStyle="secondaryLabel">版本</Text>
            <Text font="caption" foregroundStyle="secondaryLabel">1.1.1</Text>
          </HStack>
        </VStack>
      </Section>
      <Section header={<Text>技术说明</Text>}>
        <VStack alignment="leading" spacing={6} padding={{ vertical: 4 }}>
          <Text font="body" foregroundStyle="secondaryLabel">原版 Yoinks 基于 Node.js 生态（npm 依赖、完整 ffmpeg、完整 yt-dlp 等）。</Text>
          <Text font="body" foregroundStyle="secondaryLabel">Scripting 提供的是模拟 Node.js 运行时：</Text>
          <Text font="body" foregroundStyle="secondaryLabel">• 无 npm / package.json 支持</Text>
          <Text font="body" foregroundStyle="secondaryLabel">• 无完整 ffmpeg（仅内置 lgpl 版，无 libx264/265）</Text>
          <Text font="body" foregroundStyle="secondaryLabel">• Shell 执行受 waitUntilExit 兼容性限制</Text>
          <Text font="body" foregroundStyle="secondaryLabel">• Python 环境无法直接发现内置 ffmpeg</Text>
          <Text font="body" foregroundStyle="secondaryLabel">本项目保留 Yoinks 名称与核心下载体验，针对 Scripting 环境做了适配：使用 yt-dlp 独立二进制 + 内置 ffmpeg（videotoolbox 硬编），探测优先的格式选择、登录/Cookie 重试、结构化日志等均保留。</Text>
        </VStack>
      </Section>
      <Section header={<Text>致谢</Text>}>
        <VStack alignment="leading" spacing={6} padding={{ vertical: 4 }}>
          <Text font="body" foregroundStyle="secondaryLabel">上游项目： https://github.com/pablostanley/yoinks/tree/main</Text>
          <Text font="body" foregroundStyle="secondaryLabel">感谢 Pablo Stanley 创作原版 Yoinks。</Text>
        </VStack>
      </Section>
    </List>
  )
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
  const [progress, setProgress] = useState<DownloadProgress>({ fraction: 0, stage: "准备就绪" })
  const [status, setStatus] = useState("粘贴一个公开媒体链接，然后选择输出格式。")
  const [result, setResult] = useState<DownloadResult | null>(null)
  const [completedSaveMode, setCompletedSaveMode] = useState<SaveMode | null>(null)
  const [history, setHistory] = useState<DownloadHistoryRecord[]>([])
  const [historyAvailability, setHistoryAvailability] = useState<Record<string, boolean>>({})
  const [historySummary, setHistorySummary] = useState<HistoryStorageSummary>({ totalRecords: 0, availableCount: 0, managedBytes: 0 })
  const [recentLinks, setRecentLinks] = useState<RecentLinkRecord[]>(() => listRecentLinks())
  const [verboseLog, setVerboseLogState] = useState(() => isVerboseLogEnabled())
  const [enteringURL, setEnteringURL] = useState(false)
  const [platformSessions, setPlatformSessions] = useState<Partial<Record<AuthPlatform, PlatformAuthSession>>>({})
  const loggedInSessions = Object.values(platformSessions).filter((session): session is PlatformAuthSession => session != null)
  const platformSessionsRef = useRef<Partial<Record<AuthPlatform, PlatformAuthSession>>>({})
  const launchClipboardCheckedRef = useRef(false)
  const closingRef = useRef(false)
  const analysisGenerationRef = useRef(0)
  const launchClipboardSuppressedRef = useRef(false)
  const previewPlayerRef = useRef<HLSPlayerService | null>(null)
  /** A: 限制进度 UI 刷新，避免 List 高频重绘打断滑动 */
  const progressUiRef = useRef({ lastAt: 0, lastKey: "" })

  const applyProgressUi = (p: DownloadProgress, force = false) => {
    const pct = Math.round((p.fraction || 0) * 100)
    const key = `${p.stage}|${pct}|${Math.floor((p.downloadedBytes || 0) / 100_000)}`
    const now = Date.now()
    if (!force && key === progressUiRef.current.lastKey && now - progressUiRef.current.lastAt < 450) return
    progressUiRef.current = { lastAt: now, lastKey: key }
    setProgress(p)
  }

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
    if (!listRecentLinks().length) {
      for (const record of [...records].reverse()) rememberRecentLink(record.sourceURL)
      setRecentLinks(listRecentLinks())
    }
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
      if (!preferences.retainOriginalFiles) await removeHistoryManagedFile(record)
      const pruned = await pruneHistoryStorage(preferences)
      if (pruned.failedPaths.length) {
        await logEvent({ level: "warn", event: "history.prune.partial", taskId: downloaded.taskId, details: { failedPaths: pruned.failedPaths, managedBytes: pruned.managedBytes, totalRecords: pruned.totalRecords } })
      }
      await refreshHistory()
      return await isHistoryFileAvailable(record)
    } catch (error) {
      await logEvent({ level: "warn", event: "history.write.failed", taskId: downloaded.taskId, details: { message: error instanceof Error ? error.message : String(error), filePath: downloaded.filePath } })
      setStatus("下载已完成，但未能写入下载记录。")
      return await FileManager.exists(downloaded.filePath)
    }
  }

  const changeVerboseLog = (enabled: boolean) => {
    void (async () => {
      await setVerboseLogEnabled(enabled)
      setVerboseLogState(isVerboseLogEnabled())
    })()
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

  // Cleanup preview player on unmount
  useEffect(() => {
    return () => {
      if (previewPlayerRef.current) {
        void previewPlayerRef.current.destroy()
        previewPlayerRef.current = null
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
      if (cookieFile) await FileManager.remove(cookieFile).catch(() => {})
    }
  }

  const analyzeMedia = async (nextURL?: string) => {
    const gen = ++analysisGenerationRef.current
    const sourceURL = extractFirstURL(nextURL || url)
    if (!sourceURL) {
      setStatus("请先粘贴或输入有效的公开链接。")
      return
    }
    if (analyzing) return
    setAnalyzing(true)
    setProbe(null)
    setSelectedChoice(null)
    setResult(null)
    setCompletedSaveMode(null)
    setProgress({ fraction: 0.02, stage: "正在解析媒体" })
    const platform = detectMediaPlatform(sourceURL)
    setStatus(platform === "douyin" ? "正在通过匿名 WebView 解析抖音页面…" : "yt-dlp 正在准备探测。")

    try {
      // 抖音：全程匿名 WebView，不挂登录会话 / 不弹登录
      let session = platform !== "douyin" && isAuthPlatform(platform) ? await sessionForPlatform(platform) : null
      let probeResult: MediaProbe
      try {
        probeResult = await probeWithPlatformSession(sourceURL, session)
      } catch (firstError) {
        if (gen !== analysisGenerationRef.current) return
        const firstMessage = firstError instanceof Error ? firstError.message : String(firstError)
        // 仅小红书等仍走 Cookie 登录重探；抖音永不进入登录分支
        if (platform !== "douyin" && isAuthPlatform(platform) && isFreshCookieError(firstMessage)) {
          await logEvent({
            level: "warn",
            event: "probe.login-required",
            details: { sourceURL, platform, message: firstMessage },
          })
          setStatus(`${authPlatformLabel(platform)}需要登录后才能继续探测。`)
          const loggedIn = await loginForPlatform(platform)
          if (gen !== analysisGenerationRef.current) return
          if (!loggedIn) {
            setProbe(null)
            await logEvent({ level: "error", event: "probe.failed", details: { sourceURL, message: firstMessage, loginCancelled: true } })
            setStatus(`探测失败：${firstMessage}`)
            return
          }
          session = loggedIn
          setStatus("登录完成，正在重新探测……")
          probeResult = await probeWithPlatformSession(sourceURL, session)
        } else {
          throw firstError
        }
      }
      if (gen !== analysisGenerationRef.current) return
      setProbe(probeResult)
      if (platform === "douyin" && probeResult.choices.length === 1) {
        setSelectedChoice(probeResult.choices[0])
      }
      setStatus(
        platform === "douyin"
          ? `抖音解析完成：${probeResult.choices[0]?.label || "已生成候选"}`
          : `探测完成：${probeResult.choices.length} 种可用格式，${probeResult.choices.length} 个格式条目。`
      )
      await logEvent({ level: "info", event: "probe.completed", taskId: sourceURL, details: { title: probeResult.title, choiceCount: probeResult.choices.length, formatCount: probeResult.choices.reduce((sum, c) => sum + (c.formatExpression ? 1 : 0), 0) } })
    } catch (error) {
      if (gen !== analysisGenerationRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      setProbe(null)
      await logEvent({ level: "error", event: "probe.failed", details: { sourceURL, message } })
      setStatus(`探测失败：${message}`)
    } finally {
      if (gen === analysisGenerationRef.current) setAnalyzing(false)
    }
  }

  const chooseFormat = async () => {
    if (!probe) return
    const actions = probe.choices.map((choice) => ({ label: choice.label }))
    const choice = await Dialog.actionSheet({ title: probe.title, message: `共 ${probe.choices.length} 个格式条目`, actions, cancelButton: true })
    if (choice == null) return
    selectMediaChoice(probe.choices[choice])
  }

  const chooseSaveMode = async () => {
    const actions = (["ask", "photos", "files"] as SaveMode[]).map((mode) => ({ label: SAVE_LABELS[mode] }))
    const choice = await Dialog.actionSheet({ title: "默认保存方式", actions, cancelButton: true })
    if (choice == null) return
    updateSaveMode((Object.keys(SAVE_LABELS) as SaveMode[])[choice])
  }

  const chooseConcurrency = async () => {
    const actions = ([1, 2, 4, 8] as const).map((c) => ({ label: CONCURRENCY_LABELS[c as ConcurrentDownloads] }))
    const choice = await Dialog.actionSheet({ title: "下载并发线程数", actions, cancelButton: true })
    if (choice == null) return
    const next = ([1, 2, 4, 8] as ConcurrentDownloads[])[choice]
    setConcurrentFragments(next)
    updatePreferences({ ...preferences, concurrentFragments: next })
  }

  const choosePreviewAutoplayMode = async () => {
    const actions = (["muted", "audible"] as PreviewAutoplayMode[]).map((m) => ({ label: PREVIEW_AUTOPLAY_LABELS[m] }))
    const choice = await Dialog.actionSheet({ title: "在线预览自动播放模式", actions, cancelButton: true })
    if (choice == null) return
    const next = (["muted", "audible"] as PreviewAutoplayMode[])[choice]
    updatePreferences({ ...preferences, previewAutoplayMode: next })
  }

  const chooseAutomaticDownloadFormat = async () => {
    const actions = (["recommended", "highest-video", "highest-audio", "preferred-container"] as AutomaticDownloadFormatStrategy[]).map((s) => ({ label: AUTOMATIC_DOWNLOAD_FORMAT_LABELS[s] }))
    const choice = await Dialog.actionSheet({ title: "自动下载格式策略", actions, cancelButton: true })
    if (choice == null) return
    const next = (["recommended", "highest-video", "highest-audio", "preferred-container"] as AutomaticDownloadFormatStrategy[])[choice]
    updatePreferences({ ...preferences, automaticDownloadFormatStrategy: next })
  }

  const choosePreferredContainer = async () => {
    const actions = (["mp4", "mkv", "avi", "wmv"] as PreferredContainer[]).map((c) => ({ label: PREFERRED_CONTAINER_LABELS[c] }))
    const choice = await Dialog.actionSheet({ title: "指定视频容器格式", actions, cancelButton: true })
    if (choice == null) return
    const next = (["mp4", "mkv", "avi", "wmv"] as PreferredContainer[])[choice]
    updatePreferences({ ...preferences, preferredContainer: next })
  }

  const chooseManagedBytes = async () => {
    const actions = [
      { label: "不限" },
      { label: "512 MB" },
      { label: "1 GB" },
      { label: "2 GB（默认）" },
      { label: "5 GB" },
    ]
    const choice = await Dialog.actionSheet({ title: "本地原文件存储上限", actions, cancelButton: true })
    if (choice == null) return
    const bytes = choice === 0 ? null : choice === 1 ? 512 * 1024 * 1024 : choice === 2 ? 1024 * 1024 * 1024 : choice === 3 ? 2 * 1024 * 1024 * 1024 : 5 * 1024 * 1024 * 1024
    updatePreferences({ ...preferences, maxManagedBytes: bytes })
  }

  const chooseHistoryLimit = async () => {
    const actions = [
      { label: "不限" },
      { label: "50 条" },
      { label: "100 条（默认）" },
      { label: "200 条" },
      { label: "500 条" },
    ]
    const choice = await Dialog.actionSheet({ title: "下载记录数量上限", actions, cancelButton: true })
    if (choice == null) return
    const records = choice === 0 ? null : choice === 1 ? 50 : choice === 2 ? 100 : choice === 3 ? 200 : 500
    updatePreferences({ ...preferences, maxHistoryRecords: records })
  }

  const install = async () => {
    const name = "yt-dlp"
    const detail = `将下载并安装 ${name}（约 15 MB）。安装后即可开始下载。`
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

  const clearCurrentLink = (preserveResult = false) => {
    launchClipboardSuppressedRef.current = true
    analysisGenerationRef.current += 1
    disposeTemporarySession()
    setURL("")
    setProbe(null)
    setSelectedChoice(null)
    if (!preserveResult) {
      setResult(null)
      setCompletedSaveMode(null)
    }
    setStatus(preserveResult ? "下载完成，当前链接已清除。" : "当前链接已清除。")
  }

  const closeYoinks = () => {
    closingRef.current = true
    const current = extractFirstURL(url)
    if (current) rememberSkippedClipboardURL(current)
    clearCurrentLink()
    void logEvent({ level: "info", event: "script.closed", details: { skippedClipboardURL: current || null } })
    dismiss()
  }

  const useRecentLink = async (record: RecentLinkRecord) => {
    if (analyzing || downloading) return
    launchClipboardSuppressedRef.current = false
    analysisGenerationRef.current += 1
    await logEvent({ level: "info", event: "recent-link.selected", details: { sourceURL: record.url } })
    disposeTemporarySession()
    setURL(record.url)
    setProbe(null)
    setSelectedChoice(null)
    setResult(null)
    setCompletedSaveMode(null)
    setStatus("正在分析历史链接。")
    await analyzeMedia(record.url)
  }

  const chooseRecentLink = async () => {
    if (!recentLinks.length) {
      setStatus("尚无历史链接。")
      return
    }
    const choice = await Dialog.actionSheet({ title: "历史链接", message: "保留最近 10 条使用过的链接。", actions: recentLinks.map((record) => ({ label: record.url })), cancelButton: true })
    if (choice == null) return
    await useRecentLink(recentLinks[choice])
  }

  const openHistoryActions = async (record: DownloadHistoryRecord) => {
    const available = await isHistoryFileAvailable(record)
    const canSaveToPhotos = record.mediaKind === "video" || record.mediaKind === "image"
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
      if (action === "播放") await QuickLook.previewURLs([record.filePath])
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
  }

  const changeRetention = async (enabled: boolean) => {
    const next = setPreferences({ ...preferences, retainOriginalFiles: enabled })
    setPreferencesState(next)
    if (!enabled) {
      const pruned = await pruneHistoryStorage(next)
      await refreshHistory()
      if (pruned.failedPaths.length) {
        await logEvent({ level: "warn", event: "history.prune.partial", details: { failedPaths: pruned.failedPaths, managedBytes: pruned.managedBytes, totalRecords: pruned.totalRecords } })
      }
    }
  }

  const clearPlatformAuth = async () => {
    const confirmed = await Dialog.confirm({ title: "清除所有平台登录状态", message: "将清除所有平台的 Cookie 和持久化会话。", confirmLabel: "清除", cancelLabel: "取消" })
    if (!confirmed) return
    await Promise.all(supportedAuthPlatforms().map((platform) => clearPlatformLogin(platform)))
    updatePlatformSessions(() => ({}))
    setStatus("已清除登录状态。")
  }

  const pasteURL = async () => {
    const clip = await Pasteboard.getString()
    const valid = extractFirstURL(clip)
    if (!valid) {
      setStatus("剪贴板中未发现有效链接。")
      await logEvent({ level: "info", event: "paste.invalid", details: { clipboard: clip } })
      return
    }
    launchClipboardSuppressedRef.current = false
    analysisGenerationRef.current += 1
    await logEvent({ level: "info", event: "paste.accepted", details: { sourceURL: valid, platform: detectMediaPlatform(valid) } })
    setURL(valid)
    setProbe(null)
    setSelectedChoice(null)
    setResult(null)
    setCompletedSaveMode(null)
    setStatus("正在分析链接。")
    await analyzeMedia(valid)
  }

  const enterURL = async () => {
    setEnteringURL(true)
    const input = await Dialog.prompt({ title: "手动输入媒体链接", message: "请粘贴或输入公开的媒体链接。", placeholder: "https://...", confirmLabel: "确定", cancelLabel: "取消" })
    setEnteringURL(false)
    if (!input) return
    const valid = extractFirstURL(input)
    if (!valid) {
      setStatus("输入的链接无效。")
      return
    }
    launchClipboardSuppressedRef.current = false
    analysisGenerationRef.current += 1
    await logEvent({ level: "info", event: "paste.accepted", details: { sourceURL: valid, platform: detectMediaPlatform(valid) } })
    setURL(valid)
    setProbe(null)
    setSelectedChoice(null)
    setResult(null)
    setCompletedSaveMode(null)
    setStatus("正在分析链接。")
    await analyzeMedia(valid)
  }

  const chooseLinkSource = async () => {
    const choice = await Dialog.actionSheet({ title: "添加媒体链接", actions: [{ label: "从剪贴板粘贴" }, { label: "手动输入" }], cancelButton: true })
    if (choice === 0) await pasteURL()
    if (choice === 1) await enterURL()
  }

  const previewSelectedChoice = async () => {
    if (!selectedChoice?.previewURL || !probe) {
      setStatus("当前格式没有可用的预览链接。请重新分析后再试。")
      return
    }

    const previewOptions: OnlinePreviewOptions = {
      url: selectedChoice.previewURL,
      title: probe.title,
      autoplayMode: preferences.previewAutoplayMode,
      webpageURL: probe.webpageURL,
      previewReferer: selectedChoice.previewReferer,
      previewHeaders: selectedChoice.previewHeaders,
      // DASH video-only: pair separate audio stream (no full player-skill sync).
      audioUrl: selectedChoice.previewAudioURL,
    }

    const result = await openOnlinePreview(previewOptions)

    if (result.status === "presented") {
      // Session player is disposed when the sheet dismisses.
      previewPlayerRef.current = result.player
      return
    }

    if (result.status === "invalid-url") {
      setStatus("预览链接无效")
      await Dialog.alert({ title: "在线预览失败", message: result.message })
      return
    }

    // failed
    setStatus("在线预览无法打开")
    await Dialog.alert({ title: "在线预览失败", message: result.message })
  }

      const startDownload = async (insecureTLS = false, automatic?: { sourceURL: string; choice: MediaChoice; probeTitle: string; toolStatus: ToolStatus | null }, retriedTransientAccess = false) => {
    const availableTools = automatic?.toolStatus || tools
    const validURL = extractFirstURL(automatic?.sourceURL || url)
    if (!validURL) {
      setStatus("请先粘贴或输入有效的公开链接。")
      return
    }
    const earlyPlatform = detectMediaPlatform(validURL)
    if (earlyPlatform !== "douyin" && !availableTools?.ytDlpVersion) {
      setStatus("请先安装 yt-dlp。")
      return
    }

    let downloadChoice = automatic?.choice || selectedChoice
    // C: 纯 m3u8 直链常无法 yt-dlp 探测，给合成 choice 走 HLS 管线
    if (!downloadChoice && /\.m3u8|application\/x-mpegurl|application\/vnd\.apple\.mpegurl/i.test(validURL)) {
      downloadChoice = {
        id: "m3u8",
        label: "HLS / m3u8",
        kind: "video",
        formatExpression: "m3u8",
        container: "mp4",
      }
    }
    if (!downloadChoice) {
      setStatus("请先分析链接并选择实际可用格式。")
      return
    }

    setDownloading(true)
    setCancelPath(null)
    setResult(null)
    setCompletedSaveMode(null)
    progressUiRef.current = { lastAt: 0, lastKey: "" }
    applyProgressUi({ fraction: 0.02, stage: "正在解析媒体" }, true)
    setStatus(earlyPlatform === "douyin" ? "正在匿名下载抖音媒体…" : "yt-dlp 正在准备下载。")

    try {
      const platform = detectMediaPlatform(validURL)
      // 抖音不走 Cookie 登录会话
      const session = platform !== "douyin" && isAuthPlatform(platform) ? await sessionForPlatform(platform) : null
      const downloaded = await downloadMedia({
        url: validURL,
        choice: downloadChoice,
        cookieFile: session ? await createTaskCookieFile(session) : undefined,
        concurrentFragments,
        insecureTLS,
        onProgress: (p: DownloadProgress) => applyProgressUi(p),
        onCancelPath: (path: string) => setCancelPath(path),
        authorizedPlatform: session?.platform,
      })
      setDownloading(false)
      setCancelPath(null)

      const available = await recordCompletedDownload(downloaded, saveMode, downloadChoice.label || probe?.title || "未知标题")
      if (available) {
        setResult(downloaded)
        setCompletedSaveMode(saveMode)
        setStatus("下载完成。")
        await rememberRecentLink(validURL)
        setRecentLinks(listRecentLinks())
      } else {
        setStatus("下载完成但文件不可用。")
      }
    } catch (error) {
      setDownloading(false)
      setCancelPath(null)
      const message = error instanceof Error ? error.message : String(error)
      if (!insecureTLS && message.includes("暂时无法访问")) {
        setStatus("来源暂时拒绝访问，正在重试下载。")
        await startDownload(insecureTLS, automatic, true)
        return
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
          await startDownload(true, automatic, retriedTransientAccess)
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

  

function HistoryView() {
  const dismiss = Navigation.useDismiss()
  return (
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
            <Button key={record.id} action={() => void openHistoryActions(record)}>
              <HStack spacing={12}>
                <Image systemName={record.mediaKind === "audio" ? "music.note" : record.mediaKind === "image" ? "photo" : "play.rectangle"} foregroundStyle={record.mediaKind === "audio" ? "purple" : record.mediaKind === "image" ? "orange" : "blue"} frame={{ width: 24 }} />
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
            </Button>
          )) : <Text foregroundStyle="secondaryLabel">尚无下载记录。</Text>}
        </Section>
        <Section title="存储">
          <Text foregroundStyle="secondaryLabel">已管理 {formatBytes(historySummary.managedBytes)}</Text>
          <Button title="清空下载记录和原文件" systemImage="trash" role="destructive" action={() => void clearHistory()} disabled={!history.length} />
        </Section>
      </List>
    </NavigationStack>
  )
}

function DownloadView() {
  return (
    <NavigationStack>
      <List
        navigationTitle="Yoinks"
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          cancellationAction: <Button title="关闭" action={closeYoinks} />,
          topBarTrailing: <Button title="" systemImage="plus" action={() => void chooseLinkSource()} disabled={downloading || analyzing || enteringURL} />,
        }}
      >
        {/* B: 紧凑进度置顶；取消改右下浮层，避免占 List 行程 */}
        {downloading ? (
          <Section header={<Text>下载中</Text>} footer={<Text font="caption" foregroundStyle="secondaryLabel">{status}</Text>}>
            <VStack alignment="leading" spacing={6} padding={{ vertical: 2 }}>
              <HStack>
                <Text font="subheadline" lineLimit={1}>{progress.stage}</Text>
                <Spacer />
                <Text font="caption" foregroundStyle="secondaryLabel">{Math.round(progress.fraction * 100)}%</Text>
              </HStack>
              <ProgressView value={progress.fraction} />
              <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{`${formatDownloadBytes(progress.downloadedBytes || 0, progress.totalBytes || 0)} · ${formatDownloadSpeed(progress.speed || 0, progress.eta || 0)}`}</Text>
            </VStack>
          </Section>
        ) : null}

        <Section title="当前链接">
          <VStack alignment="leading" spacing={5}>
            <Text foregroundStyle={url ? "label" : "secondaryLabel"} lineLimit={3}>{url || "从剪贴板粘贴或手动添加公开媒体链接。"}</Text>
            {mediaPlatformLabel(url) ? <Text font="caption" foregroundStyle="secondaryLabel">来源：{mediaPlatformLabel(url)}</Text> : null}
          </VStack>
          {!url ? <Button title="添加媒体链接" systemImage="plus.circle" action={() => void chooseLinkSource()} disabled={downloading || analyzing || enteringURL} /> : null}
          <Button title="历史链接" systemImage="clock.arrow.circlepath" action={() => void chooseRecentLink()} disabled={!recentLinks.length || analyzing || downloading} />
          {url ? <Button title={analyzing ? "分析中……" : "重新分析链接"} systemImage="waveform.path.ecg" action={() => void analyzeMedia()} disabled={(detectMediaPlatform(url) !== "douyin" && !tools?.ytDlpVersion) || analyzing || downloading} /> : null}
          {url ? <Button title="清除链接" systemImage="xmark.circle" role="destructive" action={clearCurrentLink} disabled={analyzing || downloading} /> : null}
        </Section>

        <Section title="格式">
          {!probe ? <Text foregroundStyle="secondaryLabel">添加链接后将自动识别可下载格式。</Text> : (
            <>
              <VStack alignment="leading" spacing={3}>
                <Text font="headline" lineLimit={2}>{probe.title}</Text>
                {probe.uploader ? <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{probe.uploader}</Text> : null}
              </VStack>
              <Button title={selectedChoice?.label || "选择格式"} systemImage={selectedChoice?.kind === "audio" ? "music.note" : selectedChoice?.kind === "image" ? "photo" : "play.rectangle"} action={() => void chooseFormat()} disabled={downloading || analyzing} />
              <Button title="在线预览" systemImage="play.circle" action={() => void previewSelectedChoice()} disabled={!selectedChoice?.previewURL || downloading || analyzing} />
            </>
          )}
        </Section>

        {!downloading ? (
          <Section header={<Text>任务</Text>} footer={<Text font="caption" foregroundStyle="secondaryLabel">{status}</Text>}>
            <Button title="开始下载" systemImage="arrow.down.circle.fill" action={() => void startDownload()} disabled={!url || (detectMediaPlatform(url) !== "douyin" && !tools?.ytDlpVersion) || installing || !selectedChoice || analyzing} />
            {result && completedSaveMode && completedSaveMode !== "ask" ? <Button title="播放" systemImage="play.circle" action={() => void QuickLook.previewURLs([result.filePath], true)} /> : null}
            {result ? <Button title="分享" systemImage="square.and.arrow.up" action={() => void ShareSheet.present([result.filePath])} /> : null}
          </Section>
        ) : null}
      </List>
    </NavigationStack>
  )
}



  // LogListView - inline log viewer
  const LogListView = () => {
    const dismiss = Navigation.useDismiss()
    const [page, setPage] = useState<LogPageData | null>(null)
    const [filter, setFilter] = useState<LogFilter>("all")
    const [loading, setLoading] = useState(false)

    const loadPage = async (offset = 0) => {
      setLoading(true)
      try {
        const data = await readLogPage(filter, offset, 20)
        setPage(data)
      } finally {
        setLoading(false)
      }
    }

    useEffect(() => {
      loadPage()
    }, [filter])

    return (
      <List navigationTitle="运行日志" navigationBarTitleDisplayMode="inline" toolbar={{ cancellationAction: <Button title="关闭" action={dismiss} /> }}>
        <Section>
          <HStack spacing={8}>
            <Text font="caption" foregroundStyle="secondaryLabel">筛选：</Text>
            {["all", "info", "warn", "error"].map((f) => (
              <Button key={f} title={f === "all" ? "全部" : f} action={() => { setFilter(f as LogFilter); loadPage(); }} disabled={filter === f} />
            ))}
          </HStack>
        </Section>
        <Section header={<Text>{page ? `显示 ${page.events.length} 条 / 共 ${page.totalMatching} 条` : "加载中..."}</Text>}>
          {page?.events.map((event) => (
            <Button key={event.timestamp + event.event} action={() => void Navigation.present({ element: <LogDetailView event={event} /> })}>
              <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
                <HStack spacing={6}>
                  <Text font="subheadline">{event.event}</Text>
                  <Text font="caption2" foregroundStyle={event.level === "error" ? "red" : event.level === "warn" ? "orange" : event.level === "debug" ? "gray" : "green"}>
                    {event.level.toUpperCase()}
                  </Text>
                  {event.taskId ? <Text font="caption2" foregroundStyle="secondaryLabel">{event.taskId}</Text> : null}
                </HStack>
                <Text font="caption2" foregroundStyle="tertiaryLabel">{event.timestamp}</Text>
              </VStack>
            </Button>
          ))}
          {page?.hasMore && !loading && (
            <Button title="加载更早" systemImage="chevron.down" action={() => loadPage((page?.events.length || 0))} />
          )}
          {loading && <ProgressView />}
        </Section>
      </List>
    )
  }

  // Helper function to check for certificate errors
  const isCertificateError = (message: string): boolean => {
    return /certificate|SSL|TLS|untrusted|verify.*cert|self.signed|expired|hostname.*mismatch/i.test(message)
  }

return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
    <TabView selection={activeTab as any} tint="systemGreen" tabViewStyle="sidebarAdaptable">
      <Tab title="记录" systemImage="clock.arrow.circlepath" value={HISTORY_TAB}>
        <HistoryView />
      </Tab>

      <Tab title="下载" systemImage="arrow.down.circle.fill" value={DOWNLOAD_TAB}>
        <DownloadView />
      </Tab>

      <Tab title="设置" systemImage="gearshape.fill" value={SETTINGS_TAB}>
        <NavigationStack>
          <List
            navigationTitle="设置"
            navigationBarTitleDisplayMode="inline"
            toolbar={{ cancellationAction: <Button title="关闭" action={closeYoinks} /> }}
          >
            <Section title="下载偏好">
              <Button title={`默认保存方式：${SAVE_LABELS[saveMode]}`} systemImage="square.and.arrow.down" action={() => void chooseSaveMode()} disabled={downloading || analyzing} />
              <Button title={`下载并发：${CONCURRENCY_LABELS[concurrentFragments]}`} systemImage="arrow.triangle.2.circlepath" action={() => void chooseConcurrency()} disabled={downloading || analyzing} />
              <Button title={`在线预览：${PREVIEW_AUTOPLAY_LABELS[preferences.previewAutoplayMode]}`} systemImage="play.circle" action={() => void choosePreviewAutoplayMode()} disabled={downloading || analyzing} />
            </Section>
            <Section title="自动下载">
              <Toggle title="剪贴板分析后自动下载" systemImage="arrow.down.circle" value={preferences.automaticDownloadEnabled} onChanged={(value) => updatePreferences({ ...preferences, automaticDownloadEnabled: value })} />
              <Button title={`自动下载格式：${AUTOMATIC_DOWNLOAD_FORMAT_LABELS[preferences.automaticDownloadFormatStrategy]}`} systemImage="slider.horizontal.3" action={() => void chooseAutomaticDownloadFormat()} disabled={downloading || analyzing} />
              {preferences.automaticDownloadFormatStrategy === "preferred-container" ? <Button title={`指定视频格式：${PREFERRED_CONTAINER_LABELS[preferences.preferredContainer]}`} systemImage="film" action={() => void choosePreferredContainer()} disabled={downloading || analyzing} /> : null}
              <Text font="caption" foregroundStyle="secondaryLabel">启动进入下载页时会自动分析剪贴板中的公开链接。自动下载默认关闭。</Text>
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
                <Text frame={{ maxWidth: "infinity", alignment: "leading" }}>{toolLabel(tools)}</Text>
                {!tools?.ytDlpVersion ? <Button title={installing ? "安装中" : "安装"} action={() => void install()} disabled={installing || loadingTools} /> : null}
              </HStack>
              <Button title="检查下载引擎" systemImage="arrow.clockwise" action={() => void refreshTools()} disabled={loadingTools || downloading} />
              {loggedInSessions.length ? <Button title="清除登录状态" systemImage="person.crop.circle.badge.xmark" role="destructive" action={() => void clearPlatformAuth()} disabled={downloading || analyzing} /> : <Text font="caption" foregroundStyle="secondaryLabel">登录仅服务小红书等 yt-dlp 站点；抖音全程匿名 WebView，无需登录。</Text>}
            </Section>
            <Section title="运行日志">
              <Button title="查看运行日志" systemImage="list.bullet" action={() => void Navigation.present({ element: <LogListView /> })} />
              <Toggle title="临时详细日志（15 分钟）" systemImage="ladybug" value={verboseLog} onChanged={changeVerboseLog} />
              <Button title="清空运行日志" systemImage="trash" role="destructive" action={() => void (async () => {
                const confirmed = await Dialog.confirm({ title: "清空运行日志？", message: "仅删除本地 runtime 日志文件，不影响下载记录与媒体文件。" })
                if (!confirmed) return
                await clearLogs()
                setStatus("运行日志已清空。")
              })()} />
              <Text font="caption" foregroundStyle="secondaryLabel">默认只记录主链里程碑与警告/错误。临时详细日志约 15 分钟后自动关闭，不影响下载与在线预览。</Text>
            </Section>
          </List>
        </NavigationStack>
      </Tab>
    </TabView>
    {downloading ? (
      <VStack
        spacing={10}
        padding={{ trailing: 18, bottom: 72 }}
        frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "bottomTrailing" as any }}
      >
        <Button action={() => void stopDownload()} frame={{ width: 58, height: 58 }} glassEffect>
          <Image systemName="xmark.circle.fill" foregroundStyle="label" frame={{ width: 36, height: 36 }} />
        </Button>
      </VStack>
    ) : null}
    </ZStack>
  )
}

async function run() {
  try {
    await Navigation.present({ element: <View /> })
  } finally {
    Script.exit()
  }
}

void run()