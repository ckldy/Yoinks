const SKIPPED_CLIPBOARD_URL_KEY = "yoinks.skipped-clipboard-url"

export type LaunchClipboardInspectionState = {
  checked: boolean
  suppressed: boolean
  hasURL: boolean
  analyzing: boolean
  downloading: boolean
  batchRunning: boolean
}

/** Launch clipboard inspection is intentionally limited to one idle, empty Download tab. */
export function shouldInspectLaunchClipboard(state: LaunchClipboardInspectionState): boolean {
  return !state.checked
    && !state.suppressed
    && !state.hasURL
    && !state.analyzing
    && !state.downloading
    && !state.batchRunning
}

export function rememberSkippedClipboardURL(url: string) {
  Storage.set(SKIPPED_CLIPBOARD_URL_KEY, url)
}

export function consumeSkippedClipboardURL(url: string): boolean {
  const skipped = Storage.get<string>(SKIPPED_CLIPBOARD_URL_KEY)
  Storage.remove(SKIPPED_CLIPBOARD_URL_KEY)
  return skipped === url
}
