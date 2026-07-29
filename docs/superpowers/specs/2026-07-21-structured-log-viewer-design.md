# Yoinks Structured Log Viewer Design

## Objective

Replace Yoinks's raw JSONL text log page with a structured, privacy-preserving event viewer that supports routine diagnosis without exposing credentials or oversized output.

## Scope

- Add a persistent, default-off `调试模式` toggle in the main screen's `下载设置` section.
- Record no new current or task-history events while debug mode is off; hide the log viewer, copy, and folder actions.
- Preserve existing logs when debug mode is turned off, and resume appending after it is turned back on.
- Parse the existing `logs/latest.jsonl` format into typed events.
- Show the latest 200 non-debug events by default, newest first.
- Provide incremental loading of 200 older events per action.
- Filter the visible list by `all`, `info`, `warn`, or `error`; debug events remain hidden.
- Show per-event level, event name, local timestamp, and a concise summary.
- Open a detail page for the selected event with its task ID and fully sanitized detail fields.
- Add refresh and destructive current-log clearing with confirmation.
- Show current log record count, size, and last write timestamp.
- Retain the existing JSONL persistence and redaction rules.

## Debug Mode

- Debug mode is disabled by default and its setting persists across app launches.
- The main screen exposes it as a binary toggle under `下载设置`.
- While disabled, `logEvent()` is a no-op: it does not create directories, current logs, or task-history files.
- The main-screen log viewer, copy, and folder commands are hidden while disabled.
- Disabling debug mode preserves existing current and history logs; enabling it resumes new event recording and exposes the viewer.

## Retention

- Keep `latest.jsonl` independently bounded at 512 KB, retaining the newest complete JSONL entries.
- Keep `logs/history` at or below 4 MB in total.
- After each task-log write, calculate history size and delete complete date directories from oldest to newest until total size is within the cap.
- `clearLogs()` only clears `latest.jsonl`; it preserves `logs/history` and writes no replacement event to the cleared current log.

## UI

The log page uses a standard iOS list layout:

- `筛选与维护` section: level selector, refresh command, and destructive `清空运行日志` command.
- `状态` section: debug status, visible/available record count, `latest.jsonl` size, and last write time.
- `最近事件` section: newest-first event rows and a `加载更多` command when more matching records exist.
- An event row carries a semantic level icon/color, event name, timestamp, and a one-line sanitized summary.
- The detail page presents the level, timestamp, task ID when present, and sanitized key/value details. It may copy the sanitized event JSON, but never reads the raw source independently.

## Data Flow

`services/logs.ts` remains the owner of persistent debug-mode state, parsing, pagination, size metadata, and retention. It returns already-sanitized events parsed from the existing current JSONL file; malformed lines are skipped rather than breaking the viewer.

`index.tsx` owns selection state, filters, pagination state, confirmation UI, and navigation. It does not parse raw JSONL itself.

## Privacy and Error Handling

- Existing log-time redaction remains unchanged.
- The viewer does not display raw malformed lines, tokens, cookies, authorization headers, or unredacted URLs.
- Missing or empty logs render an empty state.
- Read failures are presented as a concise error state and do not crash navigation.
- Clearing requires explicit confirmation and affects only the current log file.

## Verification

- TypeScript diagnostics for `services/logs.ts` and `index.tsx`.
- Focused service checks for persistent debug-mode gating, parsing malformed/current JSONL, level filtering, pagination, metadata, current-log clearing, and 4 MB history pruning.
- `scripting-ts run index.tsx` startup check; its normal foreground lifecycle may remain active until dismissed.
- Device check: refresh, each filter, detail navigation, load-more, and clear confirmation against real logs.

## Non-goals

- Browsing historical task logs in the UI.
- Searching log text.
- Changing download, authentication, media playback, or existing event schemas.
