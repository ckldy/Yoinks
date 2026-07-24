import { Path } from "scripting"
import type { MediaKind, SaveMode } from "./media"
import type { YoinksPreferences } from "./preferences"

const HISTORY_KEY = "yoinks.download-history"
const DOWNLOAD_DIRECTORY = Path.join(FileManager.documentsDirectory, "Yoinks", "Downloads")

export type DownloadHistoryRecord = {
  id: string
  createdAt: string
  taskId: string
  title: string
  sourceURL: string
  filePath: string
  fileName: string
  fileSizeBytes: number
  mediaKind: MediaKind
  formatLabel: string
  saveMode: SaveMode
}

export type HistoryStorageSummary = {
  availableCount: number
  totalRecords: number
  managedBytes: number
}

export type PruneResult = HistoryStorageSummary & {
  deletedRecords: number
  deletedFiles: number
  failedPaths: string[]
}

function isManagedFilePath(filePath: string): boolean {
  return filePath.startsWith(`${DOWNLOAD_DIRECTORY}/`) && !filePath.split("/").includes("..")
}

function isHistoryRecord(value: unknown): value is DownloadHistoryRecord {
  if (typeof value !== "object" || value == null) return false
  const item = value as Partial<DownloadHistoryRecord>
  return typeof item.id === "string"
    && typeof item.createdAt === "string"
    && typeof item.taskId === "string"
    && typeof item.title === "string"
    && typeof item.sourceURL === "string"
    && typeof item.filePath === "string"
    && typeof item.fileName === "string"
    && typeof item.fileSizeBytes === "number"
    && (item.mediaKind === "video" || item.mediaKind === "audio" || item.mediaKind === "image")
    && typeof item.formatLabel === "string"
    && (item.saveMode === "ask" || item.saveMode === "photos" || item.saveMode === "files")
}

function readRecords(): DownloadHistoryRecord[] {
  const value = Storage.get<unknown>(HISTORY_KEY)
  if (!Array.isArray(value)) return []
  return value.filter(isHistoryRecord)
}

function writeRecords(records: DownloadHistoryRecord[]) {
  Storage.set(HISTORY_KEY, records)
}

function sortNewest(records: DownloadHistoryRecord[]): DownloadHistoryRecord[] {
  return [...records].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

function sortOldest(records: DownloadHistoryRecord[]): DownloadHistoryRecord[] {
  return [...records].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

async function availableRecords(records = readRecords()): Promise<DownloadHistoryRecord[]> {
  const available: DownloadHistoryRecord[] = []
  for (const record of records) {
    if (isManagedFilePath(record.filePath) && await FileManager.exists(record.filePath)) available.push(record)
  }
  return available
}

export async function listHistoryRecords(): Promise<DownloadHistoryRecord[]> {
  return sortNewest(readRecords())
}

export async function isHistoryFileAvailable(record: DownloadHistoryRecord): Promise<boolean> {
  return isManagedFilePath(record.filePath) && await FileManager.exists(record.filePath)
}

export async function getHistoryStorageSummary(): Promise<HistoryStorageSummary> {
  const records = readRecords()
  const available = await availableRecords(records)
  return {
    totalRecords: records.length,
    availableCount: available.length,
    managedBytes: available.reduce((total, record) => total + Math.max(0, record.fileSizeBytes), 0),
  }
}

export async function addHistoryRecord(record: DownloadHistoryRecord): Promise<void> {
  const records = readRecords().filter((item) => item.id !== record.id && item.filePath !== record.filePath)
  records.push(record)
  writeRecords(records)
}

export async function removeHistoryManagedFile(record: DownloadHistoryRecord): Promise<boolean> {
  if (!isManagedFilePath(record.filePath) || !(await FileManager.exists(record.filePath))) return false
  await FileManager.remove(record.filePath)
  return true
}

export async function deleteHistoryRecord(record: DownloadHistoryRecord, removeManagedFile: boolean): Promise<boolean> {
  const deletedFile = removeManagedFile ? await removeHistoryManagedFile(record) : false
  writeRecords(readRecords().filter((item) => item.id !== record.id))
  return deletedFile
}

export async function clearHistoryRecordsAndFiles(): Promise<{ deletedRecords: number; deletedFiles: number; failedPaths: string[] }> {
  const records = readRecords()
  let deletedFiles = 0
  const failedPaths: string[] = []
  for (const record of records) {
    try {
      if (isManagedFilePath(record.filePath) && await FileManager.exists(record.filePath)) {
        await FileManager.remove(record.filePath)
        deletedFiles += 1
      }
    } catch {
      failedPaths.push(record.filePath)
    }
  }
  const retained = records.filter((record) => failedPaths.includes(record.filePath))
  writeRecords(retained)
  return { deletedRecords: records.length - retained.length, deletedFiles, failedPaths }
}

export async function pruneHistoryStorage(preferences: YoinksPreferences): Promise<PruneResult> {
  let records = readRecords()
  let summary = await getHistoryStorageSummary()
  let deletedRecords = 0
  let deletedFiles = 0
  const failedPaths: string[] = []
  const exceedsLimit = () => (
    (preferences.maxManagedBytes != null && summary.managedBytes > preferences.maxManagedBytes)
    || (preferences.maxHistoryRecords != null && summary.totalRecords > preferences.maxHistoryRecords)
  )

  for (const record of sortOldest(records)) {
    if (!exceedsLimit()) break
    try {
      if (isManagedFilePath(record.filePath) && await FileManager.exists(record.filePath)) {
        await FileManager.remove(record.filePath)
        deletedFiles += 1
      }
      records = records.filter((item) => item.id !== record.id)
      writeRecords(records)
      deletedRecords += 1
      summary = await getHistoryStorageSummary()
    } catch {
      failedPaths.push(record.filePath)
    }
  }

  return { ...summary, deletedRecords, deletedFiles, failedPaths }
}
