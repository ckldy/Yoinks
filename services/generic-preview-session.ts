export type GenericPreviewSession = {
  hostname: string
  webView: WebViewController
}

function normalizedHostname(value: string): string {
  return value.trim().replace(/^\.+/, "").toLowerCase()
}

function hasSafeDomainShape(hostname: string): boolean {
  if (hostname.length > 253 || !hostname.includes(".")) return false
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) return false
  return hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
}

export function previewLoginHostname(sourceURL: string): string | null {
  try {
    const url = new URL(sourceURL)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    const hostname = normalizedHostname(url.hostname)
    return hasSafeDomainShape(hostname) ? hostname : null
  } catch {
    return null
  }
}

export function cookieDomainMatchesPreviewHost(cookieDomain: string, hostname: string): boolean {
  const cookieHost = normalizedHostname(cookieDomain)
  const sourceHost = normalizedHostname(hostname)
  if (!hasSafeDomainShape(cookieHost) || !hasSafeDomainShape(sourceHost)) return false
  return cookieHost === sourceHost || sourceHost.endsWith(`.${cookieHost}`) || cookieHost.endsWith(`.${sourceHost}`)
}

export async function beginGenericPreviewLogin(sourceURL: string): Promise<GenericPreviewSession | null> {
  const hostname = previewLoginHostname(sourceURL)
  if (!hostname) return null
  const webView = new WebViewController({ ephemeral: true })
  try {
    if (!(await webView.loadURL(sourceURL))) throw new Error("无法打开登录页面")
    await webView.present({ navigationTitle: "登录后进行预览" })
    const hasRelatedCookie = (await webView.getAllCookies()).some((cookie) => cookieDomainMatchesPreviewHost(cookie.domain, hostname))
    if (!hasRelatedCookie) {
      webView.dispose()
      return null
    }
    return { hostname, webView }
  } catch (error) {
    webView.dispose()
    throw error
  }
}

export function disposeGenericPreviewSession(session: GenericPreviewSession | null | undefined): void {
  try {
    session?.webView.dispose()
  } catch {}
}
