import type { ConcurrentDownloads, SaveMode } from "./media"

const PREFERENCES_KEY = "yoinks.preferences"
const LEGACY_SAVE_MODE_KEY = "yoinks.default-save-mode"

export type PreviewAutoplayMode = "muted" | "audible"
export type AutomaticDownloadFormatStrategy = "recommended" | "highest-video" | "highest-audio" | "preferred-container"
export type PreferredContainer = "mp4" | "mkv" | "avi" | "wmv"

export type YoinksPreferences = {
  defaultSaveMode: SaveMode
  concurrentFragments: ConcurrentDownloads
  previewAutoplayMode: PreviewAutoplayMode
  automaticDownloadEnabled: boolean
  automaticDownloadFormatStrategy: AutomaticDownloadFormatStrategy
  preferredContainer: PreferredContainer
  retainOriginalFiles: boolean
  maxManagedBytes: number | null
  maxHistoryRecords: number | null
}

export const DEFAULT_PREFERENCES: YoinksPreferences = {
  defaultSaveMode: "ask",
  concurrentFragments: 2,
  previewAutoplayMode: "muted",
  automaticDownloadEnabled: false,
  automaticDownloadFormatStrategy: "recommended",
  preferredContainer: "mp4",
  retainOriginalFiles: true,
  maxManagedBytes: 2 * 1024 * 1024 * 1024,
  maxHistoryRecords: 100,
}

function isSaveMode(value: unknown): value is SaveMode {
  return value === "ask" || value === "photos" || value === "files"
}

function isConcurrency(value: unknown): value is ConcurrentDownloads {
  return value === 1 || value === 2 || value === 4 || value === 8
}

function isPreviewAutoplayMode(value: unknown): value is PreviewAutoplayMode {
  return value === "muted" || value === "audible"
}

function isAutomaticDownloadFormatStrategy(value: unknown): value is AutomaticDownloadFormatStrategy {
  return value === "recommended" || value === "highest-video" || value === "highest-audio" || value === "preferred-container"
}

function isPreferredContainer(value: unknown): value is PreferredContainer {
  return value === "mp4" || value === "mkv" || value === "avi" || value === "wmv"
}

function isLimit(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0)
}

export function normalizePreferences(value: unknown): YoinksPreferences {
  const source = typeof value === "object" && value != null ? value as Partial<YoinksPreferences> : {}
  return {
    defaultSaveMode: isSaveMode(source.defaultSaveMode) ? source.defaultSaveMode : DEFAULT_PREFERENCES.defaultSaveMode,
    concurrentFragments: isConcurrency(source.concurrentFragments) ? source.concurrentFragments : DEFAULT_PREFERENCES.concurrentFragments,
    previewAutoplayMode: isPreviewAutoplayMode(source.previewAutoplayMode) ? source.previewAutoplayMode : DEFAULT_PREFERENCES.previewAutoplayMode,
    automaticDownloadEnabled: typeof source.automaticDownloadEnabled === "boolean" ? source.automaticDownloadEnabled : DEFAULT_PREFERENCES.automaticDownloadEnabled,
    automaticDownloadFormatStrategy: isAutomaticDownloadFormatStrategy(source.automaticDownloadFormatStrategy) ? source.automaticDownloadFormatStrategy : DEFAULT_PREFERENCES.automaticDownloadFormatStrategy,
    preferredContainer: isPreferredContainer(source.preferredContainer) ? source.preferredContainer : DEFAULT_PREFERENCES.preferredContainer,
    retainOriginalFiles: typeof source.retainOriginalFiles === "boolean" ? source.retainOriginalFiles : DEFAULT_PREFERENCES.retainOriginalFiles,
    maxManagedBytes: isLimit(source.maxManagedBytes) ? source.maxManagedBytes : DEFAULT_PREFERENCES.maxManagedBytes,
    maxHistoryRecords: source.maxHistoryRecords === null ? null : isLimit(source.maxHistoryRecords) ? Math.floor(source.maxHistoryRecords) : DEFAULT_PREFERENCES.maxHistoryRecords,
  }
}

export function getPreferences(): YoinksPreferences {
  const current = Storage.get<unknown>(PREFERENCES_KEY)
  if (current != null) return normalizePreferences(current)
  const legacySaveMode = Storage.get<unknown>(LEGACY_SAVE_MODE_KEY)
  const migrated = normalizePreferences({ defaultSaveMode: legacySaveMode })
  Storage.set(PREFERENCES_KEY, migrated)
  return migrated
}

export function setPreferences(next: YoinksPreferences): YoinksPreferences {
  const normalized = normalizePreferences(next)
  Storage.set(PREFERENCES_KEY, normalized)
  Storage.set(LEGACY_SAVE_MODE_KEY, normalized.defaultSaveMode)
  return normalized
}
