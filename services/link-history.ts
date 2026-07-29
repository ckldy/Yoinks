const RECENT_LINKS_KEY = "yoinks.recent-links"
const RECENT_LINK_LIMIT = 10

export type RecentLinkRecord = {
  url: string
  usedAt: string
}

function isRecentLinkRecord(value: unknown): value is RecentLinkRecord {
  if (typeof value !== "object" || value == null) return false
  const record = value as Partial<RecentLinkRecord>
  return typeof record.url === "string" && typeof record.usedAt === "string" && Boolean(record.url)
}

function readRecentLinks(): RecentLinkRecord[] {
  const value = Storage.get<unknown>(RECENT_LINKS_KEY)
  if (!Array.isArray(value)) return []
  return value.filter(isRecentLinkRecord)
}

export function listRecentLinks(): RecentLinkRecord[] {
  return [...readRecentLinks()].sort((a, b) => Date.parse(b.usedAt) - Date.parse(a.usedAt))
}

export function rememberRecentLink(url: string): RecentLinkRecord[] {
  const record: RecentLinkRecord = { url, usedAt: new Date().toISOString() }
  const next = [record, ...readRecentLinks().filter((item) => item.url !== url)].slice(0, RECENT_LINK_LIMIT)
  Storage.set(RECENT_LINKS_KEY, next)
  return next
}
