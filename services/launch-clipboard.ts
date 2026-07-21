const SKIPPED_CLIPBOARD_URL_KEY = "yoinks.skipped-clipboard-url"

export function rememberSkippedClipboardURL(url: string) {
  Storage.set(SKIPPED_CLIPBOARD_URL_KEY, url)
}

export function consumeSkippedClipboardURL(url: string): boolean {
  const skipped = Storage.get<string>(SKIPPED_CLIPBOARD_URL_KEY)
  Storage.remove(SKIPPED_CLIPBOARD_URL_KEY)
  return skipped === url
}
