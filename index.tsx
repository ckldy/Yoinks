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
  shouldInspectLaunchClipboard,
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
  BATCH_ADD_MAX,
  BATCH_QUEUE_MAX,
  cancelDownload,
  detectMediaPlatform,
  downloadMedia,
  extractAllURLs,
  extractFirstURL,
  getToolStatus,
  installYtDlp,
  mediaPlatformLabel,
  probeMedia,
  probeSafariPublicPlayerFrame,
  resolveAutomaticChoice,
  resolveInitialMediaChoice,
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
  batchItemSubtitle,
  batchItemTitle,
  batchStatusIcon,
  beginBatchRun,
  clearBatchQueue,
  clearFinishedBatchItems,
  countBatchItems,
  createBatchQueueState,
  displayBatchItems,
  endBatchRun,
  enqueueURLs,
  formatBatchHeader,
  nextPendingItem,
  removeBatchItem,
  requestBatchStop,
  retryAllFailed,
  retryBatchItem,
  setBatchFormatStrategy,
  shortenBatchURL,
  updateBatchItem,
  type BatchItem,
  type BatchQueueState,
} from "./services/batch-queue"
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
  candidateDetailValue,
  clearMediaCandidates,
  filterMediaCandidates,
  listMediaCandidates,
  rememberMediaCandidate,
  safariCandidateNeedsTitleAlignment,
  safariManifestNeedsTitleAlignment,
  type MediaCandidate,
  type MediaCandidateFilter,
} from "./services/media-candidates"
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
  importCookieFile,
  getImportedCookiePath,
  clearImportedCookie,
} from "./services/platform-auth"
import { openOnlinePreview, type OnlinePreviewOptions } from "./services/online-preview"
import {
  clearSafariMediaCandidates,
  isLikelyHLSAudioRendition,
  readSafariMediaCandidateDiagnostic,
  readSafariMediaCandidates,
  safariCandidateContainerHint,
  safariCandidateQualityHint,
  safariCandidateSummary,
  safariPageReferer,
  type SafariMediaCandidate,
} from "./services/safari-media-candidates"
import { activeTaskIdFromCancelPath, clearDownloadCache, downloadCacheSize } from "./services/cache"
import type { DashPlayerService } from "./services/player/dash-player-service"
import type { HLSPlayerService } from "./services/player/hls-player-service"
import { DiscoverTab } from "./components/DiscoverTab"

const HISTORY_TAB = 0
const DISCOVER_TAB = 1
const DOWNLOAD_TAB = 2
const SETTINGS_TAB = 3
type YoinksTab = typeof HISTORY_TAB | typeof DISCOVER_TAB | typeof DOWNLOAD_TAB | typeof SETTINGS_TAB

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

function isXStatusURL(value: string): boolean {
  try {
    const url = new URL(value)
    return /(^|\.)(x\.com|twitter\.com)$/i.test(url.hostname) && /^\/(?:i\/web\/)?status\/\d+(?:\/video\/\d+)?\/?$/i.test(url.pathname)
  } catch {
    return false
  }
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

function formatDownloadBytes(downloaded?: number, total?: number): string {
  if (total && total > 0) return `${formatBytes(downloaded || 0)} / ${formatBytes(total)}`
  return downloaded && downloaded > 0 ? `已下载 ${formatBytes(downloaded)}` : "正在统计已下载大小…"
}

function formatDownloadSpeed(speed?: number, eta?: number): string {
  if (!speed || speed < 1) return "速度统计中…"
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

/**
 * 该 URL/已选格式是否走不依赖 yt-dlp 的下载管线：
 * HLS 原生分片（fetch/curl/ffmpeg）、原生直链（BackgroundURLSession）、抖音匿名下载。
 * 这些管线即使 yt-dlp 环境异常也不应被“开始下载”按钮禁用。
 */
function canDownloadWithoutYtDlp(u: string | null | undefined, choice?: MediaChoice | null): boolean {
  if (!u) return false
  if (detectMediaPlatform(u) === "douyin") return true
  if (/\.m3u8|application\/x-mpegurl|application\/vnd\.apple\.mpegurl/i.test(u)) return true
  if (choice && (choice.formatExpression === "direct" || choice.formatExpression === "m3u8" || choice.id === "m3u8")) return true
  return false
}

/** 历史记录中相同来源 URL 且文件仍可用的最近一条；无则返回 null。 */
async function findExistingDownload(url: string): Promise<DownloadHistoryRecord | null> {
  const records = await listHistoryRecords()
  for (const record of records) {
    if (record.sourceURL !== url) continue
    if (await isHistoryFileAvailable(record)) return record
  }
  return null
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
      <Section header={<Text>版本 1.4.5 (2026-07-26)</Text>}>
        <Text font="body">• HEVC / AV1 / VP9：下载后仅流拷贝合成 MKV，不再强制转码 H.264</Text>
        <Text font="body">• 格式列表标注「外部播放器 · 容器·MKV」；请用 Infuse / VLC / nPlayer 等打开</Text>
        <Text font="body">• H.264 + AAC 仍合并为 MP4；本机 ffprobe 对硬编码不可靠时改为软验证放行</Text>
      </Section>
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
  /** tmp 下载缓存字节数；null 表示尚未计算。 */
  const [downloadCacheBytes, setDownloadCacheBytes] = useState<number | null>(null)
  const [cacheClearing, setCacheClearing] = useState(false)
  /** A stopped Shell probe may still be unwinding; do not queue another probe behind it. */
  const [analysisDraining, setAnalysisDraining] = useState(false)
  const [saveMode, setSaveMode] = useState<SaveMode>(() => getPreferences().defaultSaveMode)
  const [concurrentFragments, setConcurrentFragments] = useState<ConcurrentDownloads>(() => getPreferences().concurrentFragments)
  const [tools, setTools] = useState<ToolStatus | null>(null)
  const [loadingTools, setLoadingTools] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [previewing, setPreviewing] = useState(false)
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
  const [batchQueue, setBatchQueue] = useState<BatchQueueState>(() =>
    createBatchQueueState(getPreferences().automaticDownloadFormatStrategy, getPreferences().preferredContainer),
  )
  const batchQueueRef = useRef<BatchQueueState>(batchQueue)
  const batchCancelPathRef = useRef<string | null>(null)
  const [platformSessions, setPlatformSessions] = useState<Partial<Record<AuthPlatform, PlatformAuthSession>>>({})
  const loggedInSessions = Object.values(platformSessions).filter((session): session is PlatformAuthSession => session != null)
  const platformSessionsRef = useRef<Partial<Record<AuthPlatform, PlatformAuthSession>>>({})
  const probeAuthorizedPlatformRef = useRef<AuthPlatform | null>(null)
  const [importedCookieActive, setImportedCookieActive] = useState<boolean>(Boolean(getImportedCookiePath()))
   const [mediaCandidates, setMediaCandidates] = useState<MediaCandidate[]>(() => listMediaCandidates())
  const [mediaCandidateFilter, setMediaCandidateFilter] = useState<MediaCandidateFilter>("all")
   const [showAllMediaCandidates, setShowAllMediaCandidates] = useState(false)
  const launchClipboardCheckedRef = useRef(false)
  const closingRef = useRef(false)
  const analysisGenerationRef = useRef(0)
  const analysisBusyRef = useRef(false)
  /** 停止等待后的释放说明：常规探测 45 秒，Safari 公开播放器解析 12 秒。 */
  const analysisStopNoteRef = useRef("后台探测将在完成或 45 秒超时后释放。")
  const launchClipboardSuppressedRef = useRef(false)
   /** Safari 直链可能带短期签名；仅在当前下载周期内标记，绝不写入最近链接历史。 */
   const safariCandidateURLRef = useRef<string | null>(null)
   /** Safari 公开页面 URL；仅本次探测/下载作 Referer，绝不持久化或导入 Cookie。 */
   const safariCandidateRefererRef = useRef<string | null>(null)
  const safariCandidateMediaKindRef = useRef<"video" | "audio" | null>(null)
   /** Safari 候选页面标题；仅直链回退时替代无元数据 URL 的退化标题。 */
   const safariCandidateTitleRef = useRef<string | null>(null)
   /** 直链路径（hls/dash/inferred）启用页面标题覆盖；不影响传给探测的媒体类型上下文。 */
   const safariCandidateTitleAlignRef = useRef<boolean>(false)
   const previewPlayerRef = useRef<HLSPlayerService | DashPlayerService | null>(null)
  /** A: 限制进度 UI 刷新，避免 List 高频重绘打断滑动 */
  const progressUiRef = useRef({ lastAt: 0, lastKey: "" })

  const isCertificateError = (message: string): boolean => {
    return /certificate|SSL|TLS|untrusted|verify.*cert|self.signed|expired|hostname.*mismatch/i.test(message)
  }

  const applyProgressUi = (p: DownloadProgress, force = false) => {
    const pct = Math.round((p.fraction || 0) * 100)
    const key = `${p.stage}|${pct}|${Math.floor((p.downloadedBytes || 0) / 100_000)}`
    const now = Date.now()
    if (!force && key === progressUiRef.current.lastKey && now - progressUiRef.current.lastAt < 450) return
    progressUiRef.current = { lastAt: now, lastKey: key }
    setProgress(p)
  }

  const setBatchQueueSynced = (next: BatchQueueState | ((current: BatchQueueState) => BatchQueueState)) => {
    setBatchQueue((current) => {
      const resolved = typeof next === "function" ? next(current) : next
      batchQueueRef.current = resolved
      return resolved
    })
  }

  const patchBatchItem = (
    itemId: string,
    patch: Partial<Omit<BatchItem, "id" | "sourceURL" | "addedAt">>,
  ) => {
    setBatchQueueSynced((current) => updateBatchItem(current, itemId, patch))
  }

  const updateSaveMode = (next: SaveMode) => {
    const nextPreferences = setPreferences({ ...preferences, defaultSaveMode: next })
    setPreferencesState(nextPreferences)
    setSaveMode(nextPreferences.defaultSaveMode)
  }

  const selectMediaChoice = (nextChoice: MediaChoice | null) => {
    setSelectedChoice(nextChoice)
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
      sourceURL: downloaded.sourceURL === safariCandidateURLRef.current
         ? (() => { const source = new URL(downloaded.sourceURL); source.search = ""; source.hash = ""; return source.toString() })()
         : downloaded.sourceURL,
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

  const probeWithPlatformSession = async (sourceURL: string, session: PlatformAuthSession | null, referer?: string, safariMediaKind?: "video" | "audio", skipPublicPlayerFallback = false): Promise<MediaProbe> => {
    let cookieFile: string | null = null
    try {
      // 仅在调用方明确选择登录会话时使用 Cookie；匿名探测不能被全局导入 Cookie 隐式改变。
      const imported = session ? getImportedCookiePath() : null
      if (imported) cookieFile = imported
      else if (session) cookieFile = await createTaskCookieFile(session)
      return await probeMedia(sourceURL, { cookieFile: cookieFile || undefined, authorizedPlatform: session?.platform, referer, safariMediaKind, skipPublicPlayerFallback })
    } finally {
      if (cookieFile && session && !getImportedCookiePath()) await FileManager.remove(cookieFile).catch(() => {})
    }
  }

  const preflightDiscoverItem = async (sourceURL: string): Promise<{ probe: MediaProbe; probeAuthorizedPlatform?: AuthPlatform }> => {
    const platform = detectMediaPlatform(sourceURL)
    const anonymousFirst = platform === "youtube" || platform === "douyin"
    let session = !anonymousFirst && isAuthPlatform(platform) ? await sessionForPlatform(platform) : null
    try {
      return { probe: await probeWithPlatformSession(sourceURL, session), probeAuthorizedPlatform: session?.platform }
    } catch (firstError) {
      const message = firstError instanceof Error ? firstError.message : String(firstError)
      if (platform === "youtube" && isFreshCookieError(message)) {
        session = await sessionForPlatform("youtube")
        if (session) return { probe: await probeWithPlatformSession(sourceURL, session), probeAuthorizedPlatform: session.platform }
        throw new Error("该视频需要 YouTube 会员登录；请先通过单链流程登录后再重试")
      }
      if (platform !== "douyin" && isAuthPlatform(platform) && isFreshCookieError(message)) {
        throw new Error(`需先登录${authPlatformLabel(platform)}（设置或单链流程）后再重试`)
      }
      throw firstError
    }
  }

  const analyzeMedia = async (nextURL?: string, autoDownloadRequested = false, skipPublicPlayerFallback = false): Promise<boolean | undefined> => {
    let analysisCompleted = false
    const gen = ++analysisGenerationRef.current
    const sourceURL = extractFirstURL(nextURL || url)
    if (!sourceURL) {
      setStatus("请先粘贴或输入有效的公开链接。")
      return
    }
    if (analyzing || analysisBusyRef.current) {
      setStatus("上一项分析正在停止，请等待其释放后再试。")
      return
    }
    if (batchQueueRef.current.running) {
      setStatus("批量下载进行中，请用「批量添加」追加链接。")
      return
    }
    analysisBusyRef.current = true
    setAnalysisDraining(false)
    setAnalyzing(true)
    analysisStopNoteRef.current = "后台探测将在完成或 45 秒超时后释放。"
    probeAuthorizedPlatformRef.current = null
    setProbe(null)
    setSelectedChoice(null)
    setResult(null)
    setCompletedSaveMode(null)
    setProgress({ fraction: 0.02, stage: "正在解析媒体" })
    const platform = detectMediaPlatform(sourceURL)
    const isSafariCandidate = sourceURL === safariCandidateURLRef.current
    const safariReferer = isSafariCandidate ? safariCandidateRefererRef.current || undefined : undefined
    const safariMediaKind = isSafariCandidate ? safariCandidateMediaKindRef.current || undefined : undefined
    setStatus(platform === "douyin" ? "正在通过匿名 WebView 解析抖音页面…" : "yt-dlp 正在准备探测。")

    try {
      // YouTube 与抖音默认匿名，避免 WebView Cookie 与 android_vr 客户端组合导致格式不可用；仅在匿名访问受限时才登录重探。
      const anonymousFirst = platform === "youtube" || platform === "douyin"
      let session = !anonymousFirst && isAuthPlatform(platform) ? await sessionForPlatform(platform) : null
      let probeResult: MediaProbe
      try {
        probeResult = await probeWithPlatformSession(sourceURL, session, safariReferer, safariMediaKind, skipPublicPlayerFallback)
      } catch (firstError) {
        if (gen !== analysisGenerationRef.current) return
        const firstMessage = firstError instanceof Error ? firstError.message : String(firstError)
        // Douyin never enters the login branch; YouTube reaches it only after anonymous access is denied.
        if (platform !== "douyin" && isAuthPlatform(platform) && isFreshCookieError(firstMessage)) {
          await logEvent({
            level: "warn",
            event: "probe.login-required",
            details: { sourceURL, platform, message: firstMessage },
          })
          setStatus(`${authPlatformLabel(platform)}需要登录后才能继续探测。`)
          const loggedIn = platform === "youtube"
            ? (await sessionForPlatform("youtube")) || await loginForPlatform(platform)
            : await loginForPlatform(platform)
          if (gen !== analysisGenerationRef.current) return
          if (!loggedIn) {
            setProbe(null)
            await logEvent({ level: "error", event: "probe.failed", details: { sourceURL, message: firstMessage, loginCancelled: true } })
            setStatus(`探测失败：${firstMessage}`)
            return
          }
          session = loggedIn
          setStatus("登录完成，正在重新探测……")
          probeResult = await probeWithPlatformSession(sourceURL, session, safariReferer, safariMediaKind, skipPublicPlayerFallback)
        } else {
          throw firstError
        }
      }
      if (gen !== analysisGenerationRef.current) return
      probeAuthorizedPlatformRef.current = session?.platform || null
      // Safari 来源页失败后会退回实际直链；该直链通常只有随机 path，不能作为用户可见标题或文件名。
      // inferred/hls/dash 直链路径经 safariCandidateTitleAlignRef 启用页面标题覆盖。
      if ((safariMediaKind || safariCandidateTitleAlignRef.current) && safariCandidateTitleRef.current) {
        probeResult = { ...probeResult, title: safariCandidateTitleRef.current }
      }
      setProbe(probeResult)
      // Only X bare status URLs are intentionally pinned to /video/N during probe.
      // Do not replace direct Safari HLS manifest URLs with yt-dlp's derived webpage URL.
      if (isXStatusURL(sourceURL) && probeResult.webpageURL && probeResult.webpageURL !== sourceURL) {
        setURL(probeResult.webpageURL)
      }
      const initialChoice = resolveInitialMediaChoice(probeResult.choices)
      if (initialChoice) setSelectedChoice(initialChoice)
      const hlsAudioOnly = isLikelyHLSAudioRendition(sourceURL)
        && probeResult.choices.length > 0
        && probeResult.choices.every((choice) => choice.kind === "audio")
      setStatus(
        platform === "douyin"
          ? `抖音解析完成：${probeResult.choices[0]?.label || "已生成候选"}`
          : hlsAudioOnly
            ? "该 HLS 清单只包含音频轨。若需要视频，请在 Safari 选择 master.m3u8 或视频清单后再导入。"
            : `探测完成：${probeResult.choices.length} 种可用格式，${probeResult.choices.length} 个格式条目。`
      )
      await logEvent({ level: "info", event: "probe.completed", taskId: sourceURL, details: { title: probeResult.title, choiceCount: probeResult.choices.length, formatCount: probeResult.choices.reduce((sum, c) => sum + (c.formatExpression ? 1 : 0), 0) } })
      analysisCompleted = true
      if (autoDownloadRequested && preferences.automaticDownloadEnabled) {
        const resolved = resolveAutomaticChoice(probeResult.choices, preferences.automaticDownloadFormatStrategy, preferences.preferredContainer)
        if (!resolved.choice) {
          await logEvent({ level: "warn", event: "auto-download.skipped", taskId: sourceURL, details: { reason: "no-choice", strategy: preferences.automaticDownloadFormatStrategy } })
          setStatus("自动下载未开始：没有匹配统一格式的可用媒体。")
          return
        }
        setSelectedChoice(resolved.choice)
        await logEvent({ level: "info", event: "auto-download.selected", taskId: sourceURL, details: { choiceId: resolved.choice.id, choiceLabel: resolved.choice.label, strategy: preferences.automaticDownloadFormatStrategy, usedFallback: resolved.usedFallback } })
        void startDownload(false, { sourceURL, choice: resolved.choice, probeTitle: probeResult.title, toolStatus: tools })
      }
    } catch (error) {
      if (gen !== analysisGenerationRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      setProbe(null)
      await logEvent({ level: "error", event: "probe.failed", details: { sourceURL, message } })
      setStatus(isLikelyHLSAudioRendition(sourceURL) && /未找到可下载的视频格式|no video formats|Requested format is not available/i.test(message)
        ? "该 HLS 清单看起来是音频子清单，未包含可下载视频。请在 Safari 选择 master.m3u8 或视频清单后再导入。"
        : `探测失败：${message}`)
    } finally {
      analysisBusyRef.current = false
      setAnalysisDraining(false)
      if (gen === analysisGenerationRef.current) setAnalyzing(false)
    }
    return analysisCompleted
  }

  // The only automatic-download entry: inspect the launch clipboard once while the
  // Download tab is idle. Manual paste, typed links and Safari candidates call
  // analyzeMedia without the automatic flag.
  useEffect(() => {
    void (async () => {
      const inspection = {
        checked: launchClipboardCheckedRef.current,
        suppressed: launchClipboardSuppressedRef.current,
        hasURL: Boolean(extractFirstURL(url)),
        analyzing: analysisBusyRef.current,
        downloading,
        batchRunning: batchQueueRef.current.running,
      }
      if (!shouldInspectLaunchClipboard(inspection)) {
        if (inspection.checked || inspection.suppressed || inspection.hasURL) {
          await logEvent({ level: "info", event: "clipboard-launch.skipped", details: { reason: inspection.checked ? "already-checked" : inspection.suppressed ? "suppressed" : "existing-url" } })
        }
        return
      }
      launchClipboardCheckedRef.current = true
      await logEvent({ level: "info", event: "clipboard-launch.checked", details: {} })
      let clip = ""
      try {
        clip = (await Pasteboard.getString()) || ""
      } catch (error) {
        await logEvent({ level: "info", event: "clipboard-launch.read-failed", details: { message: error instanceof Error ? error.message : String(error) } })
        return
      }
      if (!clip.trim()) {
        await logEvent({ level: "info", event: "clipboard-launch.empty", details: {} })
        return
      }
      const valid = extractFirstURL(clip)
      if (!valid) {
        await logEvent({ level: "info", event: "clipboard-launch.invalid", details: {} })
        return
      }
      if (consumeSkippedClipboardURL(valid)) {
        await logEvent({ level: "info", event: "clipboard-launch.skipped", details: { reason: "previously-dismissed" } })
        return
      }
      if (analysisBusyRef.current || batchQueueRef.current.running) {
        await logEvent({ level: "info", event: "clipboard-launch.skipped", details: { reason: "became-busy" } })
        return
      }
      safariCandidateURLRef.current = null
      safariCandidateRefererRef.current = null
      safariCandidateTitleAlignRef.current = false
      setURL(valid)
      setProbe(null)
      setSelectedChoice(null)
      setResult(null)
      setCompletedSaveMode(null)
      setStatus("正在分析启动时剪贴板中的链接。")
      await logEvent({ level: "info", event: "clipboard-launch.accepted", details: { sourceURL: valid, platform: detectMediaPlatform(valid) } })
      await analyzeMedia(valid, true)
    })()
  }, [])

  const stopAnalysis = async () => {
    if (!analyzing || !analysisBusyRef.current) return
    analysisGenerationRef.current += 1
    setAnalyzing(false)
    setAnalysisDraining(true)
    setProbe(null)
    setSelectedChoice(null)
    setProgress({ fraction: 0, stage: "分析已停止" })
    setStatus(`已停止等待分析结果；${analysisStopNoteRef.current}`)
    await logEvent({ level: "info", event: "probe.stop-requested", details: { mode: "discard-result" } })
  }

  const chooseFormat = async () => {
    if (!probe) return
    const actions = probe.choices.map((choice) => ({ label: choice.label }))
    const choice = await Dialog.actionSheet({ title: probe.title, message: `共 ${probe.choices.length} 个格式条目`, actions, cancelButton: true })
    if (choice == null) return
    selectMediaChoice(probe.choices[choice])
  }

  const chooseSaveMode = async () => {
    const modes: SaveMode[] = ["ask", "photos", "files"]
    const actions = modes.map((mode) => ({ label: SAVE_LABELS[mode] }))
    const choice = await Dialog.actionSheet({ title: "默认保存方式", actions, cancelButton: true })
    if (choice == null) return
    updateSaveMode(modes[choice])
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

  /** Shared default for auto-download and new/idle batch queues. */
  const applyDefaultFormatStrategy = (next: AutomaticDownloadFormatStrategy, preferredContainer = preferences.preferredContainer) => {
    const saved = updatePreferences({
      ...preferences,
      automaticDownloadFormatStrategy: next,
      preferredContainer,
    })
    if (!batchQueueRef.current.running) {
      setBatchQueueSynced(setBatchFormatStrategy(batchQueueRef.current, saved.automaticDownloadFormatStrategy, saved.preferredContainer))
    }
    return saved
  }

  const chooseAutomaticDownloadFormat = async () => {
    const actions = (["recommended", "highest-video", "highest-audio", "preferred-container"] as AutomaticDownloadFormatStrategy[]).map((s) => ({ label: AUTOMATIC_DOWNLOAD_FORMAT_LABELS[s] }))
    const choice = await Dialog.actionSheet({ title: "默认统一格式", actions, cancelButton: true })
    if (choice == null) return
    const next = (["recommended", "highest-video", "highest-audio", "preferred-container"] as AutomaticDownloadFormatStrategy[])[choice]
    applyDefaultFormatStrategy(next)
    setStatus(
      batchQueueRef.current.running
        ? "默认格式已保存，将用于下次批量（当前批次不改）。"
        : "默认统一格式已更新。",
    )
  }

  const choosePreferredContainer = async () => {
    const actions = (["mp4", "mkv", "avi", "wmv"] as PreferredContainer[]).map((c) => ({ label: PREFERRED_CONTAINER_LABELS[c] }))
    const choice = await Dialog.actionSheet({ title: "指定视频容器格式", actions, cancelButton: true })
    if (choice == null) return
    const next = (["mp4", "mkv", "avi", "wmv"] as PreferredContainer[])[choice]
    applyDefaultFormatStrategy(preferences.automaticDownloadFormatStrategy, next)
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
    safariCandidateURLRef.current = null
    safariCandidateRefererRef.current = null
    safariCandidateTitleAlignRef.current = false
    setURL("")
    setProbe(null)
    setSelectedChoice(null)
    if (!preserveResult) {
      setResult(null)
      setCompletedSaveMode(null)
    }
    setStatus(preserveResult ? "下载完成，当前链接已清除。" : "当前链接已清除。")
  }

  useEffect(() => {
    setShowAllMediaCandidates(false)
  }, [mediaCandidates])

  // 挂载时计算一次下载缓存大小，供设置页展示；清理后由 handler 刷新。
  useEffect(() => {
    void downloadCacheSize().then(setDownloadCacheBytes)
  }, [])

  const refreshDownloadCache = async () => {
    setDownloadCacheBytes(await downloadCacheSize())
  }

  const clearDownloadCacheNow = async () => {
    await refreshDownloadCache()
    const confirmed = await Dialog.confirm({
      title: "清理下载缓存",
      message: "将删除未在运行任务的临时分片与工作文件（不影响已下载的成品文件与相册）。确认继续？",
      confirmLabel: "清理",
      cancelLabel: "取消",
    })
    if (!confirmed) return
    setCacheClearing(true)
    try {
      const activeTaskId = activeTaskIdFromCancelPath(cancelPath)
      const result = await clearDownloadCache(activeTaskId)
      await refreshDownloadCache()
      setStatus(result.removedItems > 0
        ? `已清理下载缓存：${formatBytes(result.removedBytes)}，${result.removedItems} 项。`
        : "下载缓存已是最新，无需清理。")
      await logEvent({ level: "info", event: "cache.cleared", details: { removedBytes: result.removedBytes, removedItems: result.removedItems, activeTaskId: activeTaskId || null } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatus(`清理下载缓存失败：${message}`)
      await logEvent({ level: "error", event: "cache.clear.failed", details: { message } })
    } finally {
      setCacheClearing(false)
    }
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
    safariCandidateURLRef.current = null
    safariCandidateRefererRef.current = null
    safariCandidateTitleAlignRef.current = false
    setURL(record.url)
    setProbe(null)
    setSelectedChoice(null)
    setResult(null)
    setCompletedSaveMode(null)
    setStatus("正在分析历史链接。")
    await analyzeMedia(record.url)
  }

  const analyzeSafariCandidate = async (candidate: SafariMediaCandidate, playerFrameURL?: string, directOnly = false) => {
    launchClipboardSuppressedRef.current = false
    analysisGenerationRef.current += 1
    disposeTemporarySession()
    // 公开播放器 recovered 候选的 url 已是真实直链（如 s39.bigcdn.cc/.../1080.mp4），
    // 页面优先只会再次触发来源页 yt-dlp 失败；directOnly 直接分析直链，一次到位。
    const preferPageFormats = !directOnly && (candidate.kind === "video" || candidate.kind === "audio")
    const analysisURL = preferPageFormats ? candidate.pageURL : candidate.url
    safariCandidateURLRef.current = analysisURL
    safariCandidateRefererRef.current = preferPageFormats ? null : safariPageReferer(candidate.pageURL) || null
    const alignManifestTitle = safariManifestNeedsTitleAlignment(candidate.kind, candidate.pageTitle)
    safariCandidateMediaKindRef.current = preferPageFormats ? null : alignManifestTitle ? "video" : candidate.kind === "video" || candidate.kind === "audio" ? candidate.kind : null
    safariCandidateTitleRef.current = candidate.pageTitle || null
    // 直链路径（hls/dash/inferred）的探测标题通常是 URL 文件名（如 "play"），用 Safari 页面标题覆盖。
    safariCandidateTitleAlignRef.current = !preferPageFormats
    setURL(analysisURL)
    setProbe(null)
    setSelectedChoice(null)
    setResult(null)
    setCompletedSaveMode(null)
    activeTab.setValue(DOWNLOAD_TAB)
    setMediaCandidates(rememberMediaCandidate({ source: "safari", url: candidate.url, pageURL: candidate.pageURL, title: candidate.pageTitle, kind: candidate.kind === "inferred" ? "page" : candidate.kind, captureSource: candidate.captureSource, qualityHint: safariCandidateQualityHint(candidate) || undefined, containerHint: safariCandidateContainerHint(candidate) }))
    await logEvent({ level: "info", event: "safari-candidate.imported", details: { candidateURL: candidate.url, pageURL: candidate.pageURL, analysisURL, kind: candidate.kind, strategy: preferPageFormats ? "page-formats-first" : "candidate-direct", safariRefererApplied: Boolean(safariCandidateRefererRef.current) } })
    setStatus(preferPageFormats ? "正在进入 Safari 来源视频页获取可选格式。" : "正在分析 Safari 导入的媒体链接。")
    const analyzed = await analyzeMedia(analysisURL, false, preferPageFormats)
    if (analyzed || !preferPageFormats) {
      if (analyzed) await clearSafariMediaCandidates()
      return
    }
    // 页面优先探测失败：正片常藏在跨域 iframe 的静态播放器里（如 mydaddy.cc 的
    // fluidplayer 3 清晰度），先尝试公开播放器 iframe 解析，成功则优先采用；
    // 失败再回退到 Safari 采集的直接媒体资源。
    if (playerFrameURL) {
      setStatus("来源页未返回格式，正在匿名解析其公开播放器 iframe。")
      const frameProbe = await probeSafariPublicPlayerFrame(playerFrameURL, candidate.pageTitle, candidate.pageURL)
      if (frameProbe?.choices.length) {
        const recovered: SafariMediaCandidate[] = frameProbe.choices.map((choice, index) => ({ id: `public-player-${index + 1}`, url: choice.sourceURL || choice.previewURL || playerFrameURL, kind: choice.id.includes("hls") ? "hls" : choice.id.includes("dash") ? "dash" : choice.kind === "audio" ? "audio" : "video", pageURL: playerFrameURL, pageTitle: frameProbe.title || candidate.pageTitle, discoveredAt: candidate.discoveredAt, captureSource: "metadata" }))
        if (recovered.length === 1) { await analyzeSafariCandidate(recovered[0], undefined, true); return }
        const selected = await Dialog.actionSheet({ title: "公开播放器候选", message: "仅解析公开页面、同源脚本与公开 JSON；不使用 Cookie、授权或请求头。", actions: recovered.map(safariCandidate => ({ label: safariCandidateSummary(safariCandidate) })), cancelButton: true })
        if (selected != null && recovered[selected]) { await analyzeSafariCandidate(recovered[selected], undefined, true); return }
        return
      }
      await logEvent({ level: "warn", event: "safari-candidate.frame-probe.fallback", details: { frameURL: playerFrameURL, candidateURL: candidate.url } })
    }
    safariCandidateURLRef.current = candidate.url
    safariCandidateRefererRef.current = safariPageReferer(candidate.pageURL) || null
    safariCandidateMediaKindRef.current = candidate.kind === "video" || candidate.kind === "audio" ? candidate.kind : null
    safariCandidateTitleAlignRef.current = true
    setURL(candidate.url)
    setStatus("来源页未返回格式，正在回退至 Safari 采集的直接媒体资源。")
    await logEvent({ level: "warn", event: "safari-candidate.page-probe.fallback", details: { candidateURL: candidate.url, pageURL: candidate.pageURL, kind: candidate.kind } })
    if (await analyzeMedia(candidate.url)) await clearSafariMediaCandidates()
  }

  const importSafariMediaCandidate = async () => {
    if (analyzing || analysisBusyRef.current || downloading || batchQueueRef.current.running) return
    const [envelope, diagnostic] = await Promise.all([readSafariMediaCandidates(), readSafariMediaCandidateDiagnostic()])
    if (!envelope) {
      if (diagnostic) await logEvent({ level: "warn", event: "safari-candidate.empty", details: { candidateCount: diagnostic.candidateCount, topLevelCandidateCount: diagnostic.topLevelCandidateCount, frameReportCount: diagnostic.frameReportCount, frameCandidateCount: diagnostic.frameCandidateCount, mediaLikeResourceCount: diagnostic.mediaLikeResourceCount, iframeCount: diagnostic.iframeCount, waitMs: diagnostic.waitMs, errorKind: diagnostic.errorKind || null } })
      const summary = diagnostic ? `最近采集：候选 ${diagnostic.candidateCount}，媒体类资源 ${diagnostic.mediaLikeResourceCount}，iframe ${diagnostic.iframeCount}，frame 报告 ${diagnostic.frameReportCount}。` : ""
      setStatus(`Safari 暂无可导入的媒体候选。${summary}请在 Safari 扩展菜单运行“导入本页媒体候选到 Yoinks”。`)
      return
    }
    if (envelope.playerFrameURL) {
      // 公开播放器链路优先：正片常藏在跨域 iframe 播放器（如 mydaddy.cc fluidplayer 的
      // 360/720/1080），且来源页 yt-dlp 大多不支持。解析成功则一次到位展示格式；
      // 失败再回退下方候选列表。锁定页面（禁止重复点击/新操作）并支持「停止分析」。
      analysisBusyRef.current = true
      setAnalysisDraining(false)
      setAnalyzing(true)
      setProbe(null)
      setSelectedChoice(null)
      setProgress({ fraction: 0.02, stage: "正在解析媒体" })
      analysisStopNoteRef.current = "后台公开播放器解析将在完成或 12 秒超时后释放。"
      setStatus("正在匿名解析 Safari 公开播放器链路（最长 12 秒；可点「停止分析」终止）。")
      const parseGen = analysisGenerationRef.current
      let probe: MediaProbe | null = null
      try {
        probe = await probeSafariPublicPlayerFrame(envelope.playerFrameURL, envelope.pageTitle, envelope.pageURL)
      } finally {
        analysisBusyRef.current = false
        setAnalysisDraining(false)
        if (parseGen === analysisGenerationRef.current) setAnalyzing(false)
      }
      if (parseGen !== analysisGenerationRef.current) return
      if (probe?.choices.length) {
        const frameURL = envelope.playerFrameURL
        const recovered: SafariMediaCandidate[] = probe.choices.map((choice, index) => ({ id: `public-player-${index + 1}`, url: choice.sourceURL || choice.previewURL || frameURL, kind: choice.id.includes("hls") ? "hls" : choice.id.includes("dash") ? "dash" : choice.kind === "audio" ? "audio" : "video", pageURL: frameURL, pageTitle: probe.title || envelope.pageTitle, discoveredAt: envelope.capturedAt, captureSource: "metadata" }))
        if (recovered.length === 1) { await analyzeSafariCandidate(recovered[0], undefined, true); return }
        const selected = await Dialog.actionSheet({ title: "公开播放器候选", message: "仅解析公开页面、同源脚本与公开 JSON；不使用 Cookie、授权或请求头。", actions: recovered.map(safariCandidate => ({ label: safariCandidateSummary(safariCandidate) })), cancelButton: true })
        if (selected != null && recovered[selected]) { await analyzeSafariCandidate(recovered[selected], undefined, true); return }
        return
      }
      await logEvent({ level: "warn", event: "safari-candidate.frame-probe.empty", details: { frameURL: envelope.playerFrameURL, candidateCount: envelope.candidates.length } })
    }
    for (const candidate of envelope.candidates) {
      rememberMediaCandidate({
        source: "safari",
        url: candidate.url,
        pageURL: candidate.pageURL,
        title: candidate.pageTitle,
        kind: candidate.kind === "inferred" ? "page" : candidate.kind,
        captureSource: candidate.captureSource,
        qualityHint: safariCandidateQualityHint(candidate) || undefined,
        containerHint: safariCandidateContainerHint(candidate),
      })
    }
    setMediaCandidates(listMediaCandidates())
    if (envelope.candidates.length === 1) {
      await analyzeSafariCandidate(envelope.candidates[0], envelope.playerFrameURL)
      return
    }
    const actions = envelope.candidates.map((candidate) => ({ label: safariCandidateSummary(candidate) }))
    const selected = await Dialog.actionSheet({
      title: "Safari 媒体候选",
      message: `${envelope.pageTitle || "当前页面"} · ${new Date(envelope.capturedAt).toLocaleString()}\n${diagnostic ? `诊断：候选 ${diagnostic.candidateCount} · 媒体类资源 ${diagnostic.mediaLikeResourceCount} · iframe ${diagnostic.iframeCount} · 资源域名 ${diagnostic.resourceHostCount}\n` : ""}优先选择“推荐 · 自适应”HLS/DASH；标注“备用直链”的 MP4 仅包含其固定画质。\n仅导入公开 URL，不包含 Cookie、授权或请求头。`, 
      actions,
      cancelButton: true,
    })
    if (selected == null) return
    const candidate = envelope.candidates[selected]
    if (!candidate) return
    await analyzeSafariCandidate(candidate, envelope.playerFrameURL)
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
    clearImportedCookie()
    setImportedCookieActive(false)
    updatePlatformSessions(() => ({}))
    setStatus("已清除登录状态。")
  }

  const handleImportCookie = async () => {
    try {
      const path = await importCookieFile()
      if (!path) return
      setImportedCookieActive(true)
      setStatus("Cookie 文件已导入，探测和下载将优先使用。")
      await logEvent({ level: "info", event: "platform-auth.cookie.imported", details: {} })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await Dialog.alert({ title: "导入失败", message })
    }
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
    safariCandidateURLRef.current = null
    safariCandidateRefererRef.current = null
    safariCandidateMediaKindRef.current = null
       safariCandidateTitleRef.current = null
       safariCandidateTitleAlignRef.current = false
    setMediaCandidates(rememberMediaCandidate({ source: "manual", url: valid, kind: "page" }))
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
    safariCandidateURLRef.current = null
    safariCandidateRefererRef.current = null
    safariCandidateMediaKindRef.current = null
       safariCandidateTitleRef.current = null
       safariCandidateTitleAlignRef.current = false
    setMediaCandidates(rememberMediaCandidate({ source: "manual", url: valid, kind: "page" }))
    await logEvent({ level: "info", event: "paste.accepted", details: { sourceURL: valid, platform: detectMediaPlatform(valid) } })
    setURL(valid)
    setProbe(null)
    setSelectedChoice(null)
    setResult(null)
    setCompletedSaveMode(null)
    setStatus("正在分析链接。")
    await analyzeMedia(valid)
  }

  const confirmAndEnqueueURLs = async (urls: string[]) => {
    if (!urls.length) {
      setStatus("未找到有效的公开链接。")
      return
    }
    const capped = urls.slice(0, BATCH_ADD_MAX)
    const truncated = urls.length - capped.length
    const room = Math.max(0, BATCH_QUEUE_MAX - batchQueueRef.current.items.length)
    if (room <= 0) {
      setStatus(`队列已满（最多 ${BATCH_QUEUE_MAX} 条），请先清空或移出部分任务。`)
      return
    }
    const willAdd = Math.min(capped.length, room)
    const previewSource = capped.slice(0, willAdd)
    const previewLines = previewSource.slice(0, 5).map((item, index) => `${index + 1}. ${shortenBatchURL(item, 56)}`)
    if (previewSource.length > 5) previewLines.push(`…其余 ${previewSource.length - 5} 条`)
    if (truncated > 0) previewLines.push(`单次上限 ${BATCH_ADD_MAX}，已截取前 ${BATCH_ADD_MAX} 条`)
    if (capped.length > room) previewLines.push(`队列剩余空位 ${room}，将只加入 ${willAdd} 条`)
    const confirmed = await Dialog.confirm({
      title: willAdd === urls.length ? `识别到 ${urls.length} 条链接` : `将加入 ${willAdd} / ${urls.length} 条`,
      message: previewLines.join("\n"),
      confirmLabel: "加入队列",
      cancelLabel: "取消",
    })
    if (!confirmed) return
    const result = enqueueURLs(batchQueueRef.current, capped, BATCH_ADD_MAX)
    setBatchQueueSynced(result.state)
    await logEvent({
      level: "info",
      event: "batch.add",
      details: {
        added: result.added,
        skippedDuplicate: result.skippedDuplicate,
        truncated: result.truncated || truncated,
        rejectedFull: result.rejectedFull,
        queueSize: result.state.items.length,
      },
    })
    if (result.added === 0 && result.skippedDuplicate > 0) {
      setStatus("这些链接已在队列中。")
      return
    }
    if (result.added === 0) {
      setStatus(result.rejectedFull ? `队列已满，未能加入。最多 ${BATCH_QUEUE_MAX} 条。` : "没有新链接加入队列。")
      return
    }
    const notes: string[] = [`已加入队列 ${result.added} 条`]
    if (result.skippedDuplicate) notes.push(`跳过重复 ${result.skippedDuplicate}`)
    if (result.truncated || truncated) notes.push(`截断 ${result.truncated || truncated}`)
    if (result.rejectedFull) notes.push(`空位不足未入 ${result.rejectedFull}`)
    setStatus(`${notes.join(" · ")}。共 ${result.state.items.length} 条，可点「开始批量下载」。`)
  }

  const handleDiscoverEnqueue = async (items: Array<{ url: string; title?: string }>) => {
    const resolved: Array<{ url: string; title?: string; probe: MediaProbe; probeAuthorizedPlatform?: AuthPlatform }> = []
    let failed = 0
    for (const item of items) {
      try {
        const preflight = await preflightDiscoverItem(item.url)
        resolved.push({
          url: item.url,
          title: preflight.probe.title || item.title,
          probe: preflight.probe,
          probeAuthorizedPlatform: preflight.probeAuthorizedPlatform,
        })
      } catch (error) {
        failed += 1
        await logEvent({ level: "warn", event: "discover.enqueue.probe.failed", details: { sourceURL: item.url, message: error instanceof Error ? error.message : String(error) } })
      }
    }
    const result = enqueueURLs(batchQueueRef.current, resolved, BATCH_ADD_MAX)
    setBatchQueueSynced(result.state)
    if (result.added > 0) {
      let candidates = mediaCandidates
      const addedURLs = new Set(result.addedSourceURLs)
      for (const item of resolved) {
        if (addedURLs.has(item.url)) candidates = rememberMediaCandidate({ source: "discover", url: item.url, title: item.title, kind: "page" })
      }
      setMediaCandidates(candidates)
    }
    void logEvent({
      level: "info",
      event: "discover.enqueue",
      details: {
        added: result.added,
        skippedDuplicate: result.skippedDuplicate,
        truncated: result.truncated,
        rejectedFull: result.rejectedFull,
        queueSize: result.state.items.length,
      },
    })
    if (failed) setStatus(`已加入 ${result.added} 条；${failed} 条无法解析，未加入队列。`)
    return failed ? { ...result, rejectedProbe: failed } : result
  }

  /** Queue-local: paste clipboard URLs into batch with no confirm dialogs. */
  const quickEnqueueFromClipboard = async () => {
    const clip = await Pasteboard.getString()
    const urls = extractAllURLs(clip)
    if (!urls.length) {
      setStatus("剪贴板中未发现有效链接。")
      await logEvent({ level: "info", event: "batch.add", details: { mode: "clipboard-direct", added: 0, empty: true } })
      return
    }
    if (batchQueueRef.current.items.length >= BATCH_QUEUE_MAX) {
      setStatus(`队列已满（最多 ${BATCH_QUEUE_MAX} 条），请先清理或移出部分任务。`)
      return
    }
    const result = enqueueURLs(batchQueueRef.current, urls, BATCH_ADD_MAX)
    setBatchQueueSynced(result.state)
    await logEvent({
      level: "info",
      event: "batch.add",
      details: {
        mode: "clipboard-direct",
        added: result.added,
        skippedDuplicate: result.skippedDuplicate,
        truncated: result.truncated,
        rejectedFull: result.rejectedFull,
        queueSize: result.state.items.length,
      },
    })
    if (result.added === 0 && result.skippedDuplicate > 0) {
      setStatus("这些链接已在队列中。")
      return
    }
    if (result.added === 0) {
      setStatus(result.rejectedFull ? `队列已满，未能加入。最多 ${BATCH_QUEUE_MAX} 条。` : "没有新链接加入队列。")
      return
    }
    const notes: string[] = [`已从剪贴板加入 ${result.added} 条`]
    if (result.skippedDuplicate) notes.push(`跳过重复 ${result.skippedDuplicate}`)
    if (result.truncated) notes.push(`截断 ${result.truncated}`)
    if (result.rejectedFull) notes.push(`空位不足未入 ${result.rejectedFull}`)
    setStatus(`${notes.join(" · ")}。共 ${result.state.items.length} 条。`)
  }

  const removeBatchItemSwipe = async (item: BatchItem) => {
    if (item.status === "probing" || item.status === "downloading") {
      setStatus("进行中的条目无法删除，请先停止或等其结束。")
      return
    }
    const next = removeBatchItem(batchQueueRef.current, item.id)
    if (next.items.length === batchQueueRef.current.items.length) {
      setStatus("无法删除该条目。")
      return
    }
    setBatchQueueSynced(next)
    await logEvent({
      level: "info",
      event: "batch.item.removed",
      details: { itemId: item.id, status: item.status, remaining: next.items.length },
    })
    setStatus(next.items.length ? "已从队列删除。" : "已从队列删除，队列已空。")
  }

  const batchAddFromClipboard = async () => {
    const clip = await Pasteboard.getString()
    await confirmAndEnqueueURLs(extractAllURLs(clip))
  }

  const batchAddFromPrompt = async () => {
    setEnteringURL(true)
    const input = await Dialog.prompt({
      title: "批量添加链接",
      message: `每行一条或空格分隔，单次最多 ${BATCH_ADD_MAX} 条。`,
      placeholder: "https://...\nhttps://...",
      confirmLabel: "识别",
      cancelLabel: "取消",
    })
    setEnteringURL(false)
    if (!input) return
    await confirmAndEnqueueURLs(extractAllURLs(input))
  }

  const chooseBatchAddSource = async () => {
    const choice = await Dialog.actionSheet({
      title: "批量添加",
      actions: [{ label: "从剪贴板提取全部链接" }, { label: "多行粘贴 / 手动输入" }],
      cancelButton: true,
    })
    if (choice === 0) await batchAddFromClipboard()
    if (choice === 1) await batchAddFromPrompt()
  }

  const chooseLinkSource = async () => {
    // Spec: while batch running, only allow batch append.
    if (batchQueueRef.current.running) {
      await chooseBatchAddSource()
      return
    }
    const choice = await Dialog.actionSheet({
      title: "添加媒体链接",
      actions: [{ label: "从剪贴板粘贴" }, { label: "手动输入" }, { label: "批量添加…" }],
      cancelButton: true,
    })
    if (choice === 0) await pasteURL()
    if (choice === 1) await enterURL()
    if (choice === 2) await chooseBatchAddSource()
  }

  const chooseBatchFormatStrategy = async () => {
    if (batchQueueRef.current.running) return
    const strategies = ["recommended", "highest-video", "highest-audio", "preferred-container"] as AutomaticDownloadFormatStrategy[]
    const choice = await Dialog.actionSheet({
      title: "批量统一格式",
      actions: strategies.map((s) => ({ label: AUTOMATIC_DOWNLOAD_FORMAT_LABELS[s] })),
      cancelButton: true,
    })
    if (choice == null) return
    const nextStrategy = strategies[choice]
    let nextContainer = batchQueueRef.current.preferredContainer
    if (nextStrategy === "preferred-container") {
      const containers = ["mp4", "mkv", "avi", "wmv"] as PreferredContainer[]
      const containerChoice = await Dialog.actionSheet({
        title: "指定容器格式",
        actions: containers.map((c) => ({ label: PREFERRED_CONTAINER_LABELS[c] })),
        cancelButton: true,
      })
      if (containerChoice == null) return
      nextContainer = containers[containerChoice]
    }
    setBatchQueueSynced(setBatchFormatStrategy(batchQueueRef.current, nextStrategy, nextContainer))
  }

  const openBatchItemActions = async (item: BatchItem) => {
    const canRemove = item.status !== "probing" && item.status !== "downloading"
    const canRetry = item.status === "failed" || item.status === "cancelled"
    const filePath = item.result?.filePath
    const fileAvailable = Boolean(filePath && item.status === "completed" && FileManager.existsSync(filePath))
    const actions = [
      ...(fileAvailable ? [{ label: "播放" }, { label: "分享" }] : []),
      { label: "复制链接" },
      ...(canRetry ? [{ label: "重试" }] : []),
      ...(canRemove ? [{ label: "移出队列", role: "destructive" as const }] : []),
    ]
    const choice = await Dialog.actionSheet({
      title: batchItemTitle(item),
      message: batchItemSubtitle(item),
      actions,
      cancelButton: true,
    })
    if (choice == null) return
    const action = actions[choice].label
    try {
      if (action === "播放" && filePath) {
        await QuickLook.previewURLs([filePath], true)
        return
      }
      if (action === "分享" && filePath) {
        await ShareSheet.present([filePath])
        return
      }
      if (action === "复制链接") {
        await Pasteboard.setString(item.sourceURL)
        setStatus("链接已复制。")
        return
      }
      if (action === "重试") {
        setBatchQueueSynced(retryBatchItem(batchQueueRef.current, item.id))
        setStatus("已重新加入等待队列。")
        return
      }
      if (action === "移出队列") {
        setBatchQueueSynced(removeBatchItem(batchQueueRef.current, item.id))
        setStatus("已移出队列。")
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await Dialog.alert({ title: "操作失败", message })
    }
  }

  const clearBatchFinished = () => {
    const next = clearFinishedBatchItems(batchQueueRef.current)
    const removed = batchQueueRef.current.items.length - next.items.length
    setBatchQueueSynced(next)
    setStatus(removed > 0 ? `已清理 ${removed} 条已完成/已取消项。` : "没有可清理的已完成项。")
  }

  const clearBatchAll = async () => {
    if (batchQueueRef.current.running) {
      setStatus("批量进行中，无法清空队列。")
      return
    }
    const confirmed = await Dialog.confirm({
      title: "清空批量队列",
      message: "将移除所有等待、失败与已完成条目（不删除已下载文件）。",
      confirmLabel: "清空",
      cancelLabel: "取消",
    })
    if (!confirmed) return
    setBatchQueueSynced(clearBatchQueue(batchQueueRef.current))
    setStatus("批量队列已清空。")
  }

  const retryBatchFailed = () => {
    const before = countBatchItems(batchQueueRef.current.items)
    const next = retryAllFailed(batchQueueRef.current)
    const after = countBatchItems(next.items)
    setBatchQueueSynced(next)
    const recovered = after.pending - before.pending
    setStatus(recovered > 0 ? `已将 ${recovered} 条失败/取消项重新加入等待。` : "没有可重试的项。")
  }

  const stopWholeBatch = async () => {
    if (!batchQueueRef.current.running) return
    const confirmed = await Dialog.confirm({
      title: "停止整批",
      message: "将取消当前下载，剩余等待项保留，可再次开始。",
      confirmLabel: "停止整批",
      cancelLabel: "继续",
    })
    if (!confirmed) return
    setBatchQueueSynced(requestBatchStop(batchQueueRef.current))
    await logEvent({
      level: "info",
      event: "batch.stop",
      details: {
        activeItemId: batchQueueRef.current.activeItemId,
        pending: countBatchItems(batchQueueRef.current.items).pending,
      },
    })
    const path = batchCancelPathRef.current || cancelPath
    if (path) {
      await cancelDownload(path)
      setStatus("正在停止整批…")
    } else {
      setStatus("已请求停止整批。")
    }
  }

  const startBatchDownload = async () => {
    if (batchQueueRef.current.running) {
      await stopWholeBatch()
      return
    }
    const counts = countBatchItems(batchQueueRef.current.items)
    if (!counts.pending) {
      setStatus(counts.failed ? "没有等待中的任务。可先重试失败项。" : "没有等待中的任务。")
      return
    }
    if (analyzing || downloading) {
      setStatus("请等待当前单链分析或下载结束后再开始批量。")
      return
    }

    setBatchQueueSynced(beginBatchRun(batchQueueRef.current))
    setDownloading(true)
    setCancelPath(null)
    batchCancelPathRef.current = null
    setResult(null)
    setCompletedSaveMode(null)
    progressUiRef.current = { lastAt: 0, lastKey: "" }
    await logEvent({ level: "info", event: "batch.start", details: { pending: counts.pending, total: counts.total } })

    let ok = 0
    let fail = 0
    let cancelledCount = 0

    try {
      while (true) {
        const state = batchQueueRef.current
        if (state.stopRequested) break
        const item = nextPendingItem(state)
        if (!item) break

        const indexLabel = () => {
          const items = batchQueueRef.current.items
          const ordinal = items.findIndex((i) => i.id === item.id) + 1
          return `${Math.max(ordinal, 1)}/${items.length}`
        }

        setBatchQueueSynced((current) => ({
          ...updateBatchItem(current, item.id, { status: "probing", errorMessage: undefined }),
          activeItemId: item.id,
        }))
        applyProgressUi({ fraction: 0.02, stage: `批量 ${indexLabel()} · 正在分析` }, true)
        setStatus(`批量 ${indexLabel()} · 分析中`)
        await logEvent({
          level: "info",
          event: "batch.item.probe",
          details: { itemId: item.id, index: indexLabel(), platform: detectMediaPlatform(item.sourceURL) },
        })

        const platform = detectMediaPlatform(item.sourceURL)
        if (platform !== "douyin" && !tools?.ytDlpVersion) {
          fail += 1
          patchBatchItem(item.id, { status: "failed", errorMessage: "请先安装 yt-dlp" })
          await logEvent({ level: "error", event: "batch.item.failed", details: { itemId: item.id, reason: "no-ytdlp" } })
          continue
        }

        let probeResult: MediaProbe
        let probeSession: PlatformAuthSession | null = null
        if (item.probe) {
          probeResult = item.probe
          if (item.probeAuthorizedPlatform) {
            try {
              probeSession = await sessionForPlatform(item.probeAuthorizedPlatform)
            } catch (error) {
              fail += 1
              const message = error instanceof Error ? error.message : String(error)
              patchBatchItem(item.id, { status: "failed", errorMessage: `登录状态已失效，请重新登录后重试：${message}`.slice(0, 200) })
              await logEvent({ level: "warn", event: "batch.item.failed", details: { itemId: item.id, reason: "authorized-session-unavailable", platform: item.probeAuthorizedPlatform } })
              continue
            }
            if (!probeSession) {
              fail += 1
              patchBatchItem(item.id, { status: "failed", errorMessage: `登录状态已失效，请重新登录${authPlatformLabel(item.probeAuthorizedPlatform)}后重试` })
              await logEvent({ level: "warn", event: "batch.item.failed", details: { itemId: item.id, reason: "authorized-session-missing", platform: item.probeAuthorizedPlatform } })
              continue
            }
          }
          await logEvent({ level: "info", event: "batch.item.probe.reused", details: { itemId: item.id, title: probeResult.title, choiceCount: probeResult.choices.length, authorizedPlatform: item.probeAuthorizedPlatform } })
        } else try {
          // YouTube batch items probe anonymously first; only access-restricted items use an existing session.
          const anonymousFirst = platform === "youtube" || platform === "douyin"
          const session = !anonymousFirst && isAuthPlatform(platform) ? await sessionForPlatform(platform) : null
          probeSession = session
          try {
            probeResult = await probeWithPlatformSession(item.sourceURL, session)
          } catch (firstError) {
            const firstMessage = firstError instanceof Error ? firstError.message : String(firstError)
            if (platform === "youtube" && isFreshCookieError(firstMessage)) {
              const youtubeSession = await sessionForPlatform("youtube")
              if (youtubeSession) {
                probeSession = youtubeSession
                probeResult = await probeWithPlatformSession(item.sourceURL, youtubeSession)
              } else {
                fail += 1
                const msg = "该视频需要 YouTube 会员登录；请先通过单链流程登录后再重试"
                patchBatchItem(item.id, { status: "failed", errorMessage: msg })
                await logEvent({
                  level: "warn",
                  event: "batch.item.failed",
                  details: { itemId: item.id, reason: "login-required", platform },
                })
                continue
              }
            } else if (platform !== "douyin" && isAuthPlatform(platform) && isFreshCookieError(firstMessage)) {
              fail += 1
              const msg = `需先登录${authPlatformLabel(platform)}（设置或单链流程）后再重试`
              patchBatchItem(item.id, { status: "failed", errorMessage: msg })
              await logEvent({
                level: "warn",
                event: "batch.item.failed",
                details: { itemId: item.id, reason: "login-required", platform },
              })
              continue
            } else {
              throw firstError
            }
          }
        } catch (error) {
          if (batchQueueRef.current.stopRequested) {
            cancelledCount += 1
            patchBatchItem(item.id, { status: "cancelled", errorMessage: "已取消" })
            await logEvent({
              level: "info",
              event: "batch.item.cancelled",
              details: { itemId: item.id, stage: "probe", stopWhole: true },
            })
            break
          }
          fail += 1
          const message = error instanceof Error ? error.message : String(error)
          patchBatchItem(item.id, { status: "failed", errorMessage: message.slice(0, 200) })
          await logEvent({ level: "error", event: "batch.item.failed", details: { itemId: item.id, stage: "probe", message } })
          continue
        }

        if (batchQueueRef.current.stopRequested) {
          cancelledCount += 1
          patchBatchItem(item.id, { status: "cancelled", errorMessage: "已取消" })
          await logEvent({
            level: "info",
            event: "batch.item.cancelled",
            details: { itemId: item.id, stage: "after-probe", stopWhole: true },
          })
          break
        }

        const resolved = resolveAutomaticChoice(
          probeResult.choices,
          batchQueueRef.current.formatStrategy,
          batchQueueRef.current.preferredContainer,
        )
        const choice = resolved.choice
        if (!choice) {
          fail += 1
          patchBatchItem(item.id, {
            status: "failed",
            title: probeResult.title,
            errorMessage: "没有可用格式",
          })
          await logEvent({
            level: "error",
            event: "batch.item.failed",
            details: { itemId: item.id, stage: "format", reason: "no-choice" },
          })
          continue
        }

        patchBatchItem(item.id, {
          status: "downloading",
          title: probeResult.title,
          choiceLabel: choice.label,
        })
        applyProgressUi({ fraction: 0.05, stage: `批量 ${indexLabel()} · 准备下载` }, true)
        setStatus(`批量 ${indexLabel()} · ${probeResult.title}`)
        await logEvent({
          level: "info",
          event: "batch.item.download",
          details: {
            itemId: item.id,
            index: indexLabel(),
            choiceId: choice.id,
            choiceLabel: choice.label,
            title: probeResult.title,
          },
        })

        const runOneDownload = async (insecureTLS: boolean): Promise<DownloadResult> => {
          const session = probeSession
          const importedCookie = session ? getImportedCookiePath() : null
          let cookieFile: string | undefined
          try {
            if (importedCookie) cookieFile = importedCookie
            else if (session) cookieFile = await createTaskCookieFile(session)
            return await downloadMedia({
              url: item.sourceURL,
              choice,
              cookieFile,
              concurrentFragments,
              insecureTLS,
              onProgress: (p: DownloadProgress) => {
                applyProgressUi({
                  ...p,
                  stage: `批量 ${indexLabel()} · ${p.stage}`,
                })
              },
              onCancelPath: (path: string) => {
                batchCancelPathRef.current = path
                setCancelPath(path)
              },
              authorizedPlatform: session?.platform,
              outputTitle: probeResult.title || item.title,
            })
          } finally {
            if (cookieFile && !getImportedCookiePath()) await FileManager.remove(cookieFile).catch(() => {})
            if (session?.retention === "temporary") disposeTemporarySession(platform as AuthPlatform)
          }
        }

        try {
          let downloaded: DownloadResult
          try {
            downloaded = await runOneDownload(false)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (message === "下载已取消" || batchQueueRef.current.stopRequested) throw error
            if (isCertificateError(message)) {
              await logEvent({
                level: "warn",
                event: "batch.item.tls-retry",
                details: { itemId: item.id },
              })
              downloaded = await runOneDownload(true)
            } else {
              throw error
            }
          }

          // 批量任务只自动保存图片/视频到相册；文件和每次询问均保留原文件，避免连续弹出系统面板。
          const batchSaveMode = saveMode
          if (batchSaveMode === "photos" && (choice.kind === "video" || choice.kind === "image")) {
            try {
              await saveResult(downloaded.filePath, downloaded.fileName, "photos", downloaded.taskId)
            } catch (saveError) {
              await logEvent({
                level: "warn",
                event: "batch.item.save.failed",
                details: {
                  itemId: item.id,
                  message: saveError instanceof Error ? saveError.message : String(saveError),
                },
              })
            }
          }

          await recordCompletedDownload(downloaded, batchSaveMode, probeResult.title || choice.label)
          await rememberRecentLink(item.sourceURL)
          setRecentLinks(listRecentLinks())

          ok += 1
          patchBatchItem(item.id, {
            status: "completed",
            title: probeResult.title,
            choiceLabel: choice.label,
            result: downloaded,
            errorMessage: undefined,
          })
          await logEvent({
            level: "info",
            event: "batch.item.completed",
            details: { itemId: item.id, taskId: downloaded.taskId },
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (message === "下载已取消" || batchQueueRef.current.stopRequested) {
            cancelledCount += 1
            patchBatchItem(item.id, { status: "cancelled", errorMessage: "已取消" })
            await logEvent({
              level: "info",
              event: "batch.item.cancelled",
              details: {
                itemId: item.id,
                stopWhole: batchQueueRef.current.stopRequested,
              },
            })
            if (batchQueueRef.current.stopRequested) break
            // cancel current only → continue next pending
            continue
          }
          fail += 1
          patchBatchItem(item.id, {
            status: "failed",
            title: probeResult.title,
            choiceLabel: choice.label,
            errorMessage: message.slice(0, 200),
          })
          await logEvent({
            level: "error",
            event: "batch.item.failed",
            details: { itemId: item.id, stage: "download", message },
          })
        } finally {
          batchCancelPathRef.current = null
          setCancelPath(null)
        }
      }
    } finally {
      setBatchQueueSynced(endBatchRun(batchQueueRef.current))
      setDownloading(false)
      setCancelPath(null)
      batchCancelPathRef.current = null
      const summary = `批量完成：成功 ${ok} · 失败 ${fail} · 取消 ${cancelledCount}`
      const exportHint = saveMode === "files" && ok > 0 ? "；文件已保留在 Yoinks 下载目录，请到「记录」中逐个导出。" : ""
      setStatus(summary + exportHint)
      applyProgressUi({ fraction: fail === 0 && cancelledCount === 0 && ok > 0 ? 1 : 0, stage: summary }, true)
      await logEvent({
        level: "info",
        event: "batch.finished",
        details: { ok, fail, cancelled: cancelledCount },
      })
    }
  }

  const previewSelectedChoice = async () => {
    if (previewing) return
    if (!selectedChoice?.previewURL || !probe) {
      setStatus("当前格式没有可用的预览链接。请重新分析后再试。")
      return
    }

    setPreviewing(true)
    try {
    const previewOptions: OnlinePreviewOptions = {
      url: selectedChoice.previewURL,
      title: probe.title,
      autoplayMode: preferences.previewAutoplayMode,
      webpageURL: probe.webpageURL,
      previewReferer: selectedChoice.previewReferer,
      previewHeaders: selectedChoice.previewHeaders,
      // DASH video-only: pair separate audio stream (no full player-skill sync).
      audioUrl: selectedChoice.previewAudioURL,
      duration: probe.duration,
      videoCodec: selectedChoice.previewVideoCodec,
      audioCodec: selectedChoice.previewAudioCodec,
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
    } finally {
      previewPlayerRef.current = null
      setPreviewing(false)
    }
  }

      const startDownload = async (insecureTLS = false, automatic?: { sourceURL: string; choice: MediaChoice; probeTitle: string; toolStatus: ToolStatus | null }, retriedTransientAccess = false) => {
    const availableTools = automatic?.toolStatus || tools
    const validURL = extractFirstURL(automatic?.sourceURL || url)
    if (!validURL) {
      setStatus("请先粘贴或输入有效的公开链接。")
      return
    }
    const earlyPlatform = detectMediaPlatform(validURL)

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
    // HLS 原生分片 / 原生直链 / 抖音不依赖 yt-dlp；仅需要 yt-dlp 探测的格式才要求引擎可用。
    const choiceNeedsYtDlp = !downloadChoice || (downloadChoice.formatExpression !== "direct" && downloadChoice.formatExpression !== "m3u8" && downloadChoice.id !== "m3u8")
    if (earlyPlatform !== "douyin" && choiceNeedsYtDlp && !availableTools?.ytDlpVersion) {
      setStatus("请先安装 yt-dlp。")
      return
    }
    if (!downloadChoice) {
      setStatus("请先分析链接并选择实际可用格式。")
      return
    }

    // 重复下载检测：仅手动下载时提示（自动下载/批量不打断），相同 URL 已成功下载且文件可用。
    if (!automatic) {
      const existing = await findExistingDownload(validURL)
      if (existing) {
        const confirmed = await Dialog.confirm({
          title: "该链接已下载过",
          message: `「${existing.title}」已成功下载为 ${existing.fileName}（${formatBytes(existing.fileSizeBytes)}）。\n是否仍要再次下载？`,
          confirmLabel: "仍要下载",
          cancelLabel: "取消",
        })
        if (!confirmed) {
          setStatus("已取消：该链接已在记录中。")
          return
        }
      }
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
      // YouTube 必须沿用本次探测的授权状态：匿名格式只能匿名下载。
      const useSession = platform !== "youtube" || probeAuthorizedPlatformRef.current === "youtube"
      const session = useSession && platform !== "douyin" && isAuthPlatform(platform) ? await sessionForPlatform(platform) : null
      const importedCookie = session ? getImportedCookiePath() : null
      const downloaded = await downloadMedia({
        url: validURL,
        choice: downloadChoice,
        cookieFile: importedCookie || (session ? await createTaskCookieFile(session) : undefined),
        concurrentFragments,
        insecureTLS,
        onProgress: (p: DownloadProgress) => applyProgressUi(p),
        onCancelPath: (path: string) => setCancelPath(path),
        authorizedPlatform: session?.platform,
        referer: validURL === safariCandidateURLRef.current ? safariCandidateRefererRef.current || undefined : undefined,
        outputTitle: automatic?.probeTitle || probe?.title,
      })
      setDownloading(false)
      setCancelPath(null)

      let saveMessage = ""
      try {
        saveMessage = await saveResult(downloaded.filePath, downloaded.fileName, saveMode, downloaded.taskId)
      } catch (saveError) {
        const message = saveError instanceof Error ? saveError.message : String(saveError)
        await logEvent({
          level: "warn",
          event: "download.save.failed",
          taskId: downloaded.taskId,
          details: { mode: saveMode, message },
        })
        saveMessage = `下载完成，但${message}；文件已保留在 Yoinks 下载目录。`
      }

      const available = await recordCompletedDownload(downloaded, saveMode, downloadChoice.label || probe?.title || "未知标题")
      if (available) {
        setResult(downloaded)
        setCompletedSaveMode(saveMode)
        setStatus(saveMessage || "下载完成。")
        if (validURL !== safariCandidateURLRef.current) {
          await rememberRecentLink(validURL)
          setRecentLinks(listRecentLinks())
        }
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
        setStatus("证书校验失败，正在以兼容模式重试。")
        await startDownload(true, automatic, retriedTransientAccess)
        return
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
    const path = cancelPath || batchCancelPathRef.current
    if (!path) return
    const isBatch = batchQueueRef.current.running
    const confirmed = await Dialog.confirm({
      title: isBatch ? "取消当前下载" : "取消下载",
      message: isBatch
        ? "将停止当前这一条。若未点「停止整批」，将继续队列中的下一项。"
        : "当前下载将停止，未完成的临时文件会被清理。",
      confirmLabel: isBatch ? "取消当前" : "取消下载",
      cancelLabel: "继续下载",
    })
    if (!confirmed) return
    await cancelDownload(path)
    setStatus(isBatch ? "正在取消当前批量项…" : "正在取消下载。")
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
          topBarTrailing: <Button title="" systemImage="plus" action={() => void chooseLinkSource()} disabled={enteringURL || analyzing || (downloading && !batchQueue.running)} />,
        }}
      >
        {/* B: 紧凑进度置顶；取消改右下浮层，避免占 List 行程 */}
        {downloading ? (
          <Section
            header={<Text>{batchQueue.running ? "批量下载中" : "下载中"}</Text>}
            footer={<Text font="caption" foregroundStyle="secondaryLabel">{status}</Text>}
          >
            <VStack alignment="leading" spacing={6} padding={{ vertical: 2 }}>
              <HStack>
                <Text font="subheadline" lineLimit={1}>{progress.stage}</Text>
                <Spacer />
                <Text font="caption" foregroundStyle="secondaryLabel">{Math.round(progress.fraction * 100)}%</Text>
              </HStack>
              <ProgressView value={progress.fraction} />
              <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{`${formatDownloadBytes(progress.downloadedBytes, progress.totalBytes)} · ${formatDownloadSpeed(progress.speed, progress.eta)}`}</Text>
            </VStack>
          </Section>
        ) : null}

        {batchQueue.items.length > 0 ? (() => {
          const counts = countBatchItems(batchQueue.items)
          const formatLabel = batchQueue.formatStrategy === "preferred-container"
            ? `${AUTOMATIC_DOWNLOAD_FORMAT_LABELS[batchQueue.formatStrategy]} · ${PREFERRED_CONTAINER_LABELS[batchQueue.preferredContainer]}`
            : AUTOMATIC_DOWNLOAD_FORMAT_LABELS[batchQueue.formatStrategy]
          const retryable = counts.failed + counts.cancelled
          const finished = counts.completed + counts.cancelled
          const rows = displayBatchItems(batchQueue.items)
          return (
            <Section
              header={<Text>{formatBatchHeader(counts)}</Text>}
              footer={<Text font="caption" foregroundStyle="secondaryLabel">「从剪贴板添加」直接入队不弹确认；左滑可删除。点条目可播放/分享。</Text>}
            >
              <Button
                title="从剪贴板添加"
                systemImage="doc.on.clipboard"
                action={() => void quickEnqueueFromClipboard()}
                disabled={enteringURL || analyzing}
              />
              <Button
                title={`统一格式：${formatLabel}`}
                systemImage="slider.horizontal.3"
                action={() => void chooseBatchFormatStrategy()}
                disabled={batchQueue.running || analyzing}
              />
              <Button
                title={batchQueue.running ? "停止整批" : "开始批量下载"}
                systemImage={batchQueue.running ? "stop.circle" : "arrow.down.circle.fill"}
                action={() => void startBatchDownload()}
                disabled={batchQueue.running ? false : (analyzing || downloading || !counts.pending)}
              />
              {retryable > 0 && !batchQueue.running ? (
                <Button title={`重试失败/取消（${retryable}）`} systemImage="arrow.clockwise" action={retryBatchFailed} />
              ) : null}
              {finished > 0 ? (
                <Button title={`清理已结束（${finished}）`} systemImage="checkmark.circle" action={clearBatchFinished} disabled={batchQueue.running} />
              ) : null}
              <Button title="清空队列" systemImage="trash" role="destructive" action={() => void clearBatchAll()} disabled={batchQueue.running} />
              {rows.map((item) => {
                const canSwipeDelete = item.status !== "probing" && item.status !== "downloading"
                return (
                  <HStack
                    key={item.id}
                    spacing={12}
                    trailingSwipeActions={canSwipeDelete ? {
                      allowsFullSwipe: true,
                      actions: [
                        <Button
                          title="删除"
                          role="destructive"
                          action={() => void removeBatchItemSwipe(item)}
                        />,
                      ],
                    } : undefined}
                  >
                    <Button action={() => void openBatchItemActions(item)} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
                      <HStack spacing={12}>
                        <Image
                          systemName={batchStatusIcon(item.status)}
                          foregroundStyle={
                            item.status === "failed" ? "red"
                              : item.status === "completed" ? "green"
                                : item.status === "downloading" || item.status === "probing" ? "blue"
                                  : "secondaryLabel"
                          }
                          frame={{ width: 22 }}
                        />
                        <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
                          <Text font="subheadline" lineLimit={2}>{batchItemTitle(item)}</Text>
                          <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={2}>{batchItemSubtitle(item)}</Text>
                        </VStack>
                      </HStack>
                    </Button>
                  </HStack>
                )
              })}
            </Section>
          )
        })() : null}

        <Section title="当前链接">
          <VStack alignment="leading" spacing={5}>
            <Text foregroundStyle={url ? "label" : "secondaryLabel"} lineLimit={3}>{url || "从剪贴板粘贴或手动添加公开媒体链接。"}</Text>
            {mediaPlatformLabel(url) ? <Text font="caption" foregroundStyle="secondaryLabel">来源：{mediaPlatformLabel(url)}</Text> : null}
          </VStack>
          {!url ? <Button title="添加媒体链接" systemImage="plus.circle" action={() => void chooseLinkSource()} disabled={enteringURL || analyzing || (downloading && !batchQueue.running)} /> : null}
          <Button title="从 Safari 导入媒体候选" systemImage="safari" action={() => void importSafariMediaCandidate()} disabled={analyzing || analysisDraining || downloading || batchQueue.running} />
           <Button title="历史链接" systemImage="clock.arrow.circlepath" action={() => void chooseRecentLink()} disabled={!recentLinks.length || analyzing || analysisDraining || downloading || batchQueue.running} />
          {analyzing ? <Button title="停止分析" systemImage="stop.circle" role="destructive" action={() => void stopAnalysis()} /> : null}
          {url ? <Button title={analysisDraining ? "正在停止分析……" : analyzing ? "分析中……" : "重新分析链接"} systemImage="waveform.path.ecg" action={() => void analyzeMedia()} disabled={(detectMediaPlatform(url) !== "douyin" && !tools?.ytDlpVersion) || analyzing || analysisDraining || downloading || batchQueue.running} /> : null}
          {url ? <Button title="清除链接" systemImage="xmark.circle" role="destructive" action={clearCurrentLink} disabled={analyzing || analysisDraining || downloading || batchQueue.running} /> : null}
        </Section>

        {mediaCandidates.length ? <Section title="最近候选库">
          <Button title={`筛选：${mediaCandidateFilter === "all" ? "全部" : mediaCandidateFilter === "recommended" ? "推荐" : mediaCandidateFilter.toUpperCase()}`} systemImage="line.3.horizontal.decrease.circle" action={() => void (async () => { const filters: MediaCandidateFilter[] = ["all", "recommended", "hls", "dash", "video", "audio", "page"]; const selected = await Dialog.actionSheet({ title: "筛选候选", actions: filters.map(filter => ({ label: filter === "all" ? "全部" : filter === "recommended" ? "推荐" : filter.toUpperCase() })), cancelButton: true }); if (selected != null) setMediaCandidateFilter(filters[selected]) })()} disabled={analyzing || downloading} />
          <Button title="读取 Safari 最新采集" systemImage="arrow.clockwise" action={() => void importSafariMediaCandidate()} disabled={analyzing || analysisDraining || downloading || batchQueue.running} />
          <Button title="清空候选" systemImage="trash" role="destructive" action={() => void (async () => { if (await Dialog.confirm({ title: "清空最近候选", message: "这不会删除下载记录或文件。", confirmLabel: "清空", cancelLabel: "取消" })) { clearMediaCandidates(); setMediaCandidates([]) } })()} disabled={analyzing || downloading} />
          {(showAllMediaCandidates ? filterMediaCandidates(mediaCandidates, mediaCandidateFilter) : filterMediaCandidates(mediaCandidates, mediaCandidateFilter).slice(0, 3)).map((candidate) => <Button key={candidate.id} title={`${candidate.source === "safari" ? "Safari" : candidate.source === "discover" ? "发现" : "手动"} · ${candidate.kind || "页面"} · ${candidate.qualityHint || candidate.containerHint || candidate.title || new URL(candidate.url).host}`} systemImage="info.circle" action={() => void (async () => { const safariOnly = candidate.source === "safari"; const confirmed = await Dialog.confirm({ title: candidate.title || new URL(candidate.url).host, message: `类型：${candidate.kind || "未知"}\n采集来源：${candidate.captureSource || (safariOnly ? "未知" : "不适用")}\n质量：${candidateDetailValue(candidate.qualityHint, safariOnly)}\n容器：${candidateDetailValue(candidate.containerHint, safariOnly)}\n编码/音轨/大小：${candidateDetailValue(undefined, safariOnly)}\n\n仅在确认后分析此候选。`, confirmLabel: "导入并分析", cancelLabel: "取消" }); if (!confirmed) return; if (safariOnly && candidate.pageURL && candidate.kind) { await analyzeSafariCandidate({ id: candidate.id, url: candidate.url, kind: candidate.kind === "page" ? "inferred" : candidate.kind, pageURL: candidate.pageURL, pageTitle: candidate.title, discoveredAt: candidate.createdAt, captureSource: candidate.captureSource }); return } safariCandidateURLRef.current = safariOnly ? candidate.url : null; safariCandidateRefererRef.current = safariOnly ? safariPageReferer(candidate.pageURL) || null : null; safariCandidateMediaKindRef.current = safariCandidateNeedsTitleAlignment(candidate) ? "video" : null; safariCandidateTitleRef.current = safariCandidateNeedsTitleAlignment(candidate) ? candidate.title || null : null; setURL(candidate.url); setProbe(null); setSelectedChoice(null); setStatus("正在分析候选库项目。"); await analyzeMedia(candidate.url) })()} disabled={analyzing || downloading || batchQueue.running} />)}
           {!showAllMediaCandidates && filterMediaCandidates(mediaCandidates, mediaCandidateFilter).length > 3 ? <Button title={`展开其他 ${filterMediaCandidates(mediaCandidates, mediaCandidateFilter).length - 3} 条`} systemImage="chevron.down" action={() => setShowAllMediaCandidates(true)} disabled={analyzing || downloading} /> : null}
           {showAllMediaCandidates && filterMediaCandidates(mediaCandidates, mediaCandidateFilter).length > 3 ? <Button title="收起较早候选" systemImage="chevron.up" action={() => setShowAllMediaCandidates(false)} disabled={analyzing || downloading} /> : null}
         </Section> : null}

        <Section title="格式">
          {!probe ? <Text foregroundStyle="secondaryLabel">添加链接后将自动识别可下载格式。</Text> : (
            <>
              <VStack alignment="leading" spacing={3}>
                <Text font="headline" lineLimit={2}>{probe.title}</Text>
                {probe.uploader ? <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{probe.uploader}</Text> : null}
              </VStack>
              <Button title={selectedChoice?.label || "选择格式"} systemImage={selectedChoice?.kind === "audio" ? "music.note" : selectedChoice?.kind === "image" ? "photo" : "play.rectangle"} action={() => void chooseFormat()} disabled={downloading || analyzing || batchQueue.running} />
              <Button title={previewing ? "正在打开预览……" : "在线预览"} systemImage="play.circle" action={() => void previewSelectedChoice()} disabled={!selectedChoice?.previewURL || previewing || downloading || analyzing || batchQueue.running} />
            </>
          )}
        </Section>

        {!downloading ? (
          <Section header={<Text>任务</Text>} footer={<Text font="caption" foregroundStyle="secondaryLabel">{status}</Text>}>
            <Button title="开始下载" systemImage="arrow.down.circle.fill" action={() => void startDownload()} disabled={!url || (!tools?.ytDlpVersion && !canDownloadWithoutYtDlp(url, selectedChoice)) || installing || !selectedChoice || analyzing || batchQueue.running} />
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

return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
    <TabView selection={activeTab as any} tint="systemGreen" tabViewStyle="sidebarAdaptable">
      <Tab title="记录" systemImage="clock.arrow.circlepath" value={HISTORY_TAB}>
        <HistoryView />
      </Tab>

      <Tab title="发现" systemImage="binoculars" value={DISCOVER_TAB}>
        <DiscoverTab
          experimentalEnabled={preferences.experimentalDiscoveryEnabled}
          queueItemCount={batchQueue.items.length}
          onEnqueue={handleDiscoverEnqueue}
          onSwitchToDownload={() => activeTab.setValue(DOWNLOAD_TAB)}
          onClose={closeYoinks}
        />
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
              <Text font="caption" foregroundStyle="secondaryLabel">启动进入下载页时会自动分析剪贴板中的公开链接。自动下载默认关闭。格式默认见下方「批量下载」。</Text>
            </Section>
            <Section title="批量下载">
              <Button
                title={`统一格式：${AUTOMATIC_DOWNLOAD_FORMAT_LABELS[preferences.automaticDownloadFormatStrategy]}`}
                systemImage="slider.horizontal.3"
                action={() => void chooseAutomaticDownloadFormat()}
                disabled={downloading || analyzing}
              />
              {preferences.automaticDownloadFormatStrategy === "preferred-container" ? (
                <Button
                  title={`指定容器：${PREFERRED_CONTAINER_LABELS[preferences.preferredContainer]}`}
                  systemImage="film"
                  action={() => void choosePreferredContainer()}
                  disabled={downloading || analyzing}
                />
              ) : null}
              <Text font="caption" foregroundStyle="secondaryLabel">新建或空闲队列使用此默认；队列内「统一格式」只改本批，批量进行中改设置不影响当前批次。</Text>
            </Section>
            <Section title="本地存储">
              <Text font="caption" foregroundStyle="secondaryLabel">自动清理优先删除最早的 Yoinks 原文件和对应记录。</Text>
              <Toggle title="保留原文件" systemImage="internaldrive" value={preferences.retainOriginalFiles} onChanged={(value) => void changeRetention(value)} />
              <Text foregroundStyle="secondaryLabel">当前：{historySummary.availableCount} 个文件 · {formatBytes(historySummary.managedBytes)}</Text>
              <Button title={`本地文件上限：${preferences.maxManagedBytes == null ? "不限" : formatBytes(preferences.maxManagedBytes)}`} systemImage="externaldrive" action={() => void chooseManagedBytes()} />
              <Button title={`下载记录上限：${preferences.maxHistoryRecords == null ? "不限" : `${preferences.maxHistoryRecords} 条`}`} systemImage="list.number" action={() => void chooseHistoryLimit()} />
              <Text foregroundStyle="secondaryLabel">下载缓存：{downloadCacheBytes == null ? "…" : formatBytes(downloadCacheBytes)}（失败/中断任务的临时分片与工作文件）</Text>
              <Button title={cacheClearing ? "正在清理…" : "清理下载缓存"} systemImage="trash" action={() => void clearDownloadCacheNow()} disabled={downloading || analyzing || cacheClearing} />
              <Text font="caption" foregroundStyle="secondaryLabel">删除 tmp 下非正在运行任务的临时目录与取消标记，不影响已下载文件；正在下载的任务目录会被跳过。</Text>
            </Section>
            <Section title="工具与登录">
              <HStack spacing={10}>
                <Image systemName={statusIcon(Boolean(tools?.ytDlpVersion))} foregroundStyle={tools?.ytDlpVersion ? "green" : "orange"} />
                <Text frame={{ maxWidth: "infinity", alignment: "leading" }}>{toolLabel(tools)}</Text>
                {!tools?.ytDlpVersion ? <Button title={installing ? "安装中" : "安装"} action={() => void install()} disabled={installing || loadingTools} /> : null}
              </HStack>
              <Button title="检查下载引擎" systemImage="arrow.clockwise" action={() => void refreshTools()} disabled={loadingTools || downloading} />
              {supportedAuthPlatforms().map((platform) => {
                const session = platformSessions[platform]
                return (
                  <Button
                    key={platform}
                    title={session ? `${authPlatformLabel(platform)} · 已登录` : `登录${authPlatformLabel(platform)}`}
                    systemImage={session ? "checkmark.circle.fill" : "person.crop.circle.badge.plus"}
                    action={() => void loginForPlatform(platform)}
                    disabled={downloading || analyzing}
                  />
                )
              })}
              <Button
                title={importedCookieActive ? "Cookie 文件已导入" : "导入 Cookie 文件"}
                systemImage={importedCookieActive ? "checkmark.shield.fill" : "doc.badge.plus"}
                action={() => void handleImportCookie()}
                disabled={downloading || analyzing}
              />
              <Text font="caption" foregroundStyle="secondaryLabel">导入 Netscape 格式 cookies.txt（如浏览器扩展“Get cookies.txt”导出），适用于会员视频或 WebView 登录被阻断的场景。导入后探测和下载将优先使用。</Text>
              {loggedInSessions.length ? <Button title="清除登录状态" systemImage="person.crop.circle.badge.xmark" role="destructive" action={() => void clearPlatformAuth()} disabled={downloading || analyzing} /> : null}
              <Text font="caption" foregroundStyle="secondaryLabel">登录仅服务小红书、YouTube 等 yt-dlp 站点；抖音全程匿名 WebView，无需登录。</Text>
            </Section>
            <Section title="发现">
              <Toggle
                title="实验性发现功能"
                systemImage="binoculars"
                value={preferences.experimentalDiscoveryEnabled}
                onChanged={(value) => updatePreferences({ ...preferences, experimentalDiscoveryEnabled: value })}
              />
              <Text font="caption" foregroundStyle="secondaryLabel">开启后，发现页显示「关键词搜索」和「相关推荐」。播放列表/作者主页发现始终可用。</Text>
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