import { Path, Script, type Cookie } from "scripting"
import { createTaskId } from "./logs"
import type { MediaPlatform } from "./media"

export type AuthPlatform = "douyin" | "xiaohongshu" | "youtube" | "bilibili"
export type LoginRetention = "temporary" | "persistent"

export type PlatformAuthSession = {
  platform: AuthPlatform
  retention: LoginRetention
  accountLabel: string
  webView: WebViewController
}

const ROOT_DIR = Path.join(FileManager.documentsDirectory, "Yoinks")
const TEMP_DIR = Path.join(ROOT_DIR, "tmp")

const PLATFORM_CONFIG: Record<AuthPlatform, { label: string; loginURL: string; domains: string[] }> = {
  douyin: {
    label: "抖音",
    loginURL: "https://www.douyin.com/",
    domains: ["douyin.com", "iesdouyin.com"],
  },
  xiaohongshu: {
    label: "小红书",
    loginURL: "https://www.xiaohongshu.com/",
    domains: ["xiaohongshu.com", "rednote.com"],
  },
  youtube: {
    label: "YouTube",
    loginURL: "https://www.youtube.com/",
    domains: ["youtube.com", "googlevideo.com", "youtu.be"],
  },
  bilibili: {
    label: "B站",
    loginURL: "https://www.bilibili.com/",
    domains: ["bilibili.com", "b23.tv", "bilivideo.com", "bilivideo.cn", "bili22.cn", "bili23.cn", "bili33.cn"],
  },
}

function domainMatches(domain: string, candidate: string): boolean {
  const normalized = domain.replace(/^\./, "").toLowerCase()
  return normalized === candidate || normalized.endsWith(`.${candidate}`)
}

function belongsToPlatform(cookie: Cookie, platform: AuthPlatform): boolean {
  return PLATFORM_CONFIG[platform].domains.some((domain) => domainMatches(cookie.domain, domain))
}

async function platformCookies(webView: WebViewController, platform: AuthPlatform): Promise<Cookie[]> {
  return (await webView.getAllCookies()).filter((cookie) => belongsToPlatform(cookie, platform))
}

function netscapeCookieLine(cookie: Cookie): string {
  const domain = `${cookie.isHTTPOnly ? "#HttpOnly_" : ""}${cookie.domain}`
  const includeSubdomains = cookie.domain.startsWith(".") ? "TRUE" : "FALSE"
  const secure = cookie.isSecure ? "TRUE" : "FALSE"
  const expires = cookie.isSessionOnly || !cookie.expiresDate ? "0" : String(Math.max(0, Math.floor(cookie.expiresDate.getTime() / 1000)))
  return [domain, includeSubdomains, cookie.path || "/", secure, expires, cookie.name, cookie.value].join("\t")
}

function fallbackAccountLabel(platform: AuthPlatform): string {
  try {
    return new URL(PLATFORM_CONFIG[platform].loginURL).hostname.replace(/^www\./, "")
  } catch {
    return PLATFORM_CONFIG[platform].loginURL
  }
}

function normalizeAccountLabel(value: unknown, fallback: string): string {
  const label = String(value || "").replace(/\s+/g, " ").trim()
  return label && label.length <= 100 ? label : fallback
}

async function readAccountLabel(webView: WebViewController, platform: AuthPlatform): Promise<string> {
  const fallback = fallbackAccountLabel(platform)
  try {
    const value = await webView.evaluateJavaScript<string>(`
      return [
        document.querySelector('meta[property="profile:username"]')?.content,
        document.querySelector('meta[name="author"]')?.content,
        document.querySelector('[data-account-name]')?.textContent,
        document.querySelector('[data-username]')?.textContent,
        document.querySelector('[data-user-name]')?.textContent,
        document.querySelector('[aria-label*="账号"]')?.textContent,
        document.querySelector('[aria-label*="Account"]')?.textContent,
        document.title,
      ].find((item) => typeof item === 'string' && item.trim()) || ''
    `)
    return normalizeAccountLabel(value, fallback)
  } catch {
    return fallback
  }
}

export function supportedAuthPlatforms(): AuthPlatform[] {
  return Object.keys(PLATFORM_CONFIG) as AuthPlatform[]
}

export function isAuthPlatform(platform: MediaPlatform): platform is AuthPlatform {
  return platform === "douyin" || platform === "xiaohongshu" || platform === "youtube" || platform === "bilibili"
}

export function authPlatformLabel(platform: AuthPlatform): string {
  return PLATFORM_CONFIG[platform].label
}

/**
 * yt-dlp 的错误文本会经 JSON 多层转义，非 ASCII 字符（如 ’ U+2019）到达分类器时
 * 可能仍是**字面量** `\u2019`（反斜杠 + u2019 共 6 个字符），而不是真正的字符。
 * 原有的 /sign in to confirm you['’]?re not a bot/ 因此漏判，把 YouTube 反机器人风控
 * 误判成"需要登录"。分类前先还原一次转义，使两种形式都能命中。
 */
export function unescapeForMatching(value: unknown): string {
  return String(value ?? "")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\[nrt]/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
}

/** 仅用于非 YouTube 站点的会话失效判定；YouTube 一律走 [[classifyAuthGate]] 的严格判定。 */
export function isFreshCookieError(message: string): boolean {
  return /fresh cookies|cookies? (?:are|is) needed|login required|sign in|required to login|not logged in|members-only|join this channel/i.test(unescapeForMatching(message))
}

/**
 * YouTube 会员专享（members-only）错误：唯一需要触发登录的场景（已入会账号 cookie 可下载）。
 * 与反机器人风控（isYouTubeBotCheckError）区分——bot 检测登录无效，不应引导登录。
 */
export function isYouTubeMembersOnlyError(message: string): boolean {
  return /members-only|join this channel|成为此频道的会员|会员专享|仅限会员|available to members/i.test(unescapeForMatching(message))
}

/** YouTube 反机器人风控（"Sign in to confirm you're not a bot"）：登录通常无效，应提示稍后重试/换网。 */
export function isYouTubeBotCheckError(message: string): boolean {
  return /sign\s*in\s*to\s*confirm\s*you['’]?re\s*not\s*a\s*bot|confirm you['’]?re not a bot|not a bot/i.test(unescapeForMatching(message))
}

/** 探测失败后的登录引导决策。 */
export type AuthGateDecision = "members-only" | "bot-check" | "fresh-cookie"

/**
 * 统一的登录引导判定——**只有确实需要账号时才允许提示登录**。
 *
 * - YouTube：仅 `members-only`（会员专享）需要账号；反机器人风控（`bot-check`）登录无效，
 *   应提示换网/稍后重试；其余一切失败（含 `Requested format is not available`、
 *   无 streamingData 等）都**不是**账号问题，返回 null 让调用方按普通失败处理。
 *   注：登录态下 YouTube 客户端策略会变化（不支持 cookie 的 client 被剔除），
 *   盲目引导登录反而会从"可换网恢复"变成"结构性无解"。
 * - 抖音：始终匿名，不引导登录。
 * - 其它站点：保持原有 fresh-cookie 语义（缺失/过期 Cookie 需要登录）。
 */
export function classifyAuthGate(platform: MediaPlatform, message: string): AuthGateDecision | null {
  if (platform === "youtube") {
    if (isYouTubeMembersOnlyError(message)) return "members-only"
    if (isYouTubeBotCheckError(message)) return "bot-check"
    return null
  }
  if (platform === "douyin") return null
  return isFreshCookieError(message) ? "fresh-cookie" : null
}

export async function beginPlatformLogin(platform: AuthPlatform, retention: LoginRetention): Promise<PlatformAuthSession> {
  const webView = new WebViewController(retention === "temporary" ? { ephemeral: true } : undefined)
  try {
    if (!(await webView.loadURL(PLATFORM_CONFIG[platform].loginURL))) throw new Error(`无法打开${PLATFORM_CONFIG[platform].label}登录页面`)
    await webView.present({ navigationTitle: `${PLATFORM_CONFIG[platform].label}登录` })
    const cookies = await platformCookies(webView, platform)
    if (!cookies.length) throw new Error(`未检测到${PLATFORM_CONFIG[platform].label}会话数据。请完成页面操作后关闭登录页面再重试。`)
    return { platform, retention, accountLabel: await readAccountLabel(webView, platform), webView }
  } catch (error) {
    webView.dispose()
    throw error
  }
}

export async function restorePersistentPlatformSession(platform: AuthPlatform): Promise<PlatformAuthSession | null> {
  const webView = new WebViewController()
  try {
    const cookies = await platformCookies(webView, platform)
    if (!cookies.length) {
      webView.dispose()
      return null
    }
    if (!(await webView.loadURL(PLATFORM_CONFIG[platform].loginURL))) throw new Error(`无法恢复${PLATFORM_CONFIG[platform].label}登录页面`)
    await webView.waitForLoad()
    return { platform, retention: "persistent", accountLabel: await readAccountLabel(webView, platform), webView }
  } catch (error) {
    webView.dispose()
    throw error
  }
}

export async function createTaskCookieFile(session: PlatformAuthSession): Promise<string> {
  const cookies = await platformCookies(session.webView, session.platform)
  if (!cookies.length) throw new Error(`${authPlatformLabel(session.platform)}登录状态已不可用，请重新登录。`)
  if (!(await FileManager.exists(TEMP_DIR))) await FileManager.createDirectory(TEMP_DIR, true)
  const path = Path.join(TEMP_DIR, `${createTaskId()}.${session.platform}.cookies.txt`)
  const content = ["# Netscape HTTP Cookie File", ...cookies.map(netscapeCookieLine), ""].join("\n")
  await FileManager.writeAsString(path, content)
  return path
}

export async function removeTaskCookieFile(path: string | null | undefined): Promise<boolean> {
  if (!path) return true
  try {
    if (await FileManager.exists(path)) await FileManager.remove(path)
    return !(await FileManager.exists(path))
  } catch {
    return false
  }
}

export function disposePlatformSession(session: PlatformAuthSession | null | undefined): void {
  try {
    session?.webView.dispose()
  } catch {}
}

export async function clearPlatformLogin(platform: AuthPlatform): Promise<number> {
  const webView = new WebViewController()
  try {
    const cookies = await platformCookies(webView, platform)
    await Promise.all(cookies.map((cookie) => webView.deleteCookie(cookie)))
    return cookies.length
  } finally {
    webView.dispose()
  }
}

// 导入外部 cookies.txt 文件（Netscape 格式），供探测/下载直接使用。
// 适用于 WebView 登录被设备验证阻断、或用户已有浏览器导出 cookie 的场景。
let importedCookiePath: string | null = null

export function getImportedCookiePath(): string | null {
  return importedCookiePath
}

export async function clearImportedCookie(): Promise<boolean> {
  const path = importedCookiePath
  if (!path) return true
  const removed = await removeTaskCookieFile(path)
  if (removed && importedCookiePath === path) importedCookiePath = null
  return removed
}

export async function importCookieFile(): Promise<string | null> {
  const paths = await DocumentPicker.pickFiles()
  if (!paths || !paths.length) return null
  const sourcePath = paths[0]
  if (!(await FileManager.exists(sourcePath))) throw new Error("选择的 Cookie 文件不存在。")
  if (!(await FileManager.exists(TEMP_DIR))) await FileManager.createDirectory(TEMP_DIR, true)
  // 先可靠清理旧的导入文件；失败时保留旧路径，避免丢失后续清理能力。
  if (!(await clearImportedCookie())) throw new Error("无法清理旧的 Cookie 文件，请稍后重试。")
  const destPath = Path.join(TEMP_DIR, `${createTaskId()}.imported.cookies.txt`)
  await FileManager.copyFile(sourcePath, destPath)
  importedCookiePath = destPath
  return destPath
}
