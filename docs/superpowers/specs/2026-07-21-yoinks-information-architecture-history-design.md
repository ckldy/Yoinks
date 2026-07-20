# Yoinks Information Architecture, History, and Storage Management Design

**Date:** 2026-07-21
**Status:** Approved design, pending written-spec review

## Goal

Reorganize Yoinks around the normal media-download workflow and add persistent download history with managed local storage. The app must retain its existing format-probe-first download workflow and platform authentication behavior while separating high-frequency downloading from low-frequency configuration and diagnostics.

The reference project is local `Media Downloader`. This design adopts its information architecture, not its direct-download strategy or its platform-specific download behavior.

## Scope

### Included

- Replace the current single long main list with three tabs: History, Download, and Settings.
- Persist successful download records and make them actionable after the current session ends.
- Preserve downloaded source files by default.
- Enforce default managed-storage limits of 2 GB and 100 records.
- Remove the oldest managed local file and its associated record when either storage limit is exceeded, until both limits are satisfied.
- Add user-adjustable storage and record limits, including unlimited values.
- Preserve current download formats, online preview, platform login, TLS compatibility retry, FFmpeg merge, verification, structured logs, and default save behavior.

### Excluded

- New media platforms or extractors.
- Changing yt-dlp command construction or login/Cookie strategy.
- Replacing structured diagnostic logs with a text download log.
- Deleting photos saved to the Photos library or files exported outside Yoinks.
- Cloud synchronization or cross-device history.

## User Experience

### Tabs

The app uses a `TabView` with these pages:

1. History
2. Download
3. Settings

The Download tab is the initial tab.

### Download

Download is the primary working surface. It contains only:

- Current source link and platform recognition.
- Paste and manual-link actions, collected in an add-action menu.
- Media probe state and the selected downloadable format.
- Online preview for formats that provide a preview URL.
- Default save mode.
- Current task state: ready, analyzing, downloading, saving, completed, or failed.
- Download progress and cancellation while active.
- The recent completed task's play and share actions when the chosen save mode is automatic.

The flow remains:

`link -> automatic probe -> choose format -> optional online preview -> download -> merge if needed -> verify -> save action -> record history -> enforce storage limits`

The current `ask` save mode continues to show its completion action sheet. It does not add duplicate play controls to the result area.

### History

Each row represents one successful completed download and displays:

- Title or file name.
- Media type and selected format label.
- Download time and managed source-file size.
- Local-file state: available or cleaned/missing.

Available files expose an action sheet with:

- Play using system Quick Look.
- Share.
- Save to Photos when supported by file type.
- Export to Files.
- Open source link.
- Copy source link.
- Re-download, which sends the source link to Download and begins the ordinary probe-first flow.
- Delete record and local source file after confirmation.

Cleaned or externally missing files keep their metadata record and expose:

- Re-download.
- Open source link.
- Copy source link.
- Delete record.

The History page also provides a confirmed destructive action to remove all records and managed local source files.

### Settings

Settings contains four groups:

- Download preferences: default save mode and fragment concurrency.
- Local storage: retain original files toggle, managed-file capacity limit, history record limit, and a summary of current managed storage.
- Tools and account: yt-dlp status/install, platform login state management.
- Diagnostics: debug toggle and links to the existing structured log page, log copy, and log directory.

The default local-storage policy is:

- Retain original files: enabled.
- Maximum managed source-file size: 2 GB.
- Maximum history record count: 100.

Each limit can be changed to a bounded value or unlimited.

## Data Model

### Preferences

`services/preferences.ts` owns a small persisted preferences object:

```ts
type YoinksPreferences = {
  defaultSaveMode: SaveMode
  concurrentFragments: ConcurrentDownloads
  retainOriginalFiles: boolean
  maxManagedBytes: number | null
  maxHistoryRecords: number | null
}
```

The defaults are `ask`, 2 fragments, `true`, `2 * 1024 * 1024 * 1024`, and `100`.

The service must migrate the existing `Storage` key `yoinks.default-save-mode` into `defaultSaveMode` when no preferences object exists. Existing valid user selection always wins over the new default.

### History Records

`services/history.ts` owns an array of JSON-serializable records stored through `Storage`:

```ts
type DownloadHistoryRecord = {
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
```

The service does not store binary content and does not handle UI. It exposes functions to:

- List records newest first.
- Add a successful record.
- Check whether a local path still exists.
- Delete a record, optionally deleting its managed source file.
- Clear all records and managed source files.
- Measure available managed files.
- Prune oldest available records until both configured limits are met.

`filePath` always refers to the original file in Yoinks' download directory. Saving to Photos or exporting to Files creates an external copy and never changes the managed path.

## Completion and Pruning

A record is created only after all of these have succeeded:

1. Download.
2. Optional FFmpeg merge.
3. Media verification.
4. The requested save action, including automatic save/export or the selected `ask` action.

If the requested save action fails or export is cancelled, no history record is added. The original file remains in the Yoinks download directory, matching the existing behavior, but it is not presented as a successful managed record.

After adding a record, history pruning runs immediately when `retainOriginalFiles` is enabled.

- Ignore records whose files no longer exist when computing managed size.
- If either the byte limit or record limit is exceeded, inspect records from oldest to newest.
- Delete each available managed source file before removing its record.
- Remove a record only after its file removal succeeds, or when the file has already gone missing.
- If a file cannot be deleted, retain its record, emit a structured warning log, and continue checking later eligible records. The pruning result reports remaining overage rather than claiming success.
- Never delete a file outside the Yoinks download directory.
- Never touch a Photos-library asset or an externally exported Files copy.

If retention is disabled, new successful records are still kept as metadata but their source file is deleted after the user-visible save operation. Such records immediately appear as cleaned and can be re-downloaded.

## Failure Handling

- Any download, merge, verification, save, history-write, or prune failure is logged with the existing structured logging service.
- A history-write failure does not falsely report that the original download failed. The user-facing result remains the completed save result and the error is surfaced as a warning that the task was not added to History.
- On app launch, invalid persisted preference or history data falls back safely: invalid preference values use defaults; malformed history payload produces an empty history and a warning log where possible.
- Before any history file action, verify that the file still exists. Missing files must not trigger Quick Look, Share Sheet, Photo save, or Files export.
- Audio records do not offer Save to Photos because the current media service does not support it.

## Code Boundaries

- `index.tsx`: tab layout, user interactions, navigation, current download orchestration, and state refresh.
- `services/preferences.ts`: validated preference reads, writes, defaults, and legacy migration.
- `services/history.ts`: records, file-safe actions, statistics, pruning, and storage limit enforcement.
- `services/media.ts`: preserve current download and save responsibilities; extend `DownloadResult` only if an accurate source-file byte count is needed by History.
- `services/logs.ts`: remains the single structured diagnostic implementation.

## Verification

### Deterministic

- Project TypeScript diagnostics report zero errors.
- Focused history service checks cover:
  - preference migration from `yoinks.default-save-mode`;
  - invalid preference/history values;
  - newest-first listing;
  - available and missing file states;
  - byte-limit pruning;
  - record-limit pruning;
  - both limits together;
  - deletion failure retaining its record;
  - clear-all behavior;
  - rejecting deletion paths outside the Yoinks download directory.

### Device Validation

- Launch with no history and verify all three tabs and settings grouping.
- Download a video with automatic Photos save; verify history entry, play, share, exported copy, and source link actions.
- Download audio while Photos is configured; verify fallback to Files and correct history metadata.
- Download with `ask`; select each terminal outcome and verify records appear only after successful completion.
- Reduce limits below current storage; verify oldest managed source files and records are pruned.
- Remove a managed file externally; verify its record becomes cleaned and re-download remains available.
- Confirm login retry, TLS compatibility retry, FFmpeg merge, and existing structured log paths still function.

## Acceptance Criteria

- Users can complete the normal format-probe-first download flow without visiting settings or diagnostics.
- Successful downloads persist in History across script launches.
- History operations are safe against missing or external paths.
- Retention defaults to 2 GB and 100 records, deletes oldest managed source files first, and never deletes external copies.
- Existing default save mode persists through migration.
- Existing media-download, login, TLS retry, merge, verification, and structured logging behavior is retained.
