import { Path, Script, type Cookie } from "scripting"
import { createTaskId } from "./logs"
import type { MediaPlatform } from "./media"

export type AuthPlatform = "xiaohongshu"
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
  // 抖音走匿名 WebView 直链下载，不提供用户登录 Cookie 路径。
  xiaohongshu: {
    label: "小红书",
    loginURL: "https://www.xiaohongshu.com/",
    domains: ["xiaohongshu.com", "rednote.com"],
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
  return platform === "xiaohongshu"
}

export function authPlatformLabel(platform: AuthPlatform): string {
  return PLATFORM_CONFIG[platform].label
}

export function isFreshCookieError(message: string): boolean {
  return /fresh cookies|cookies? (?:are|is) needed|login required|sign in|required to login|not logged in/i.test(message)
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

export async function removeTaskCookieFile(path: string | null | undefined): Promise<void> {
  if (!path) return
  try {
    if (await FileManager.exists(path)) await FileManager.remove(path)
  } catch {}
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
