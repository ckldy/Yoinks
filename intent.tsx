import { Intent, Script } from "scripting"
import { extractFirstURL } from "./services/media"

function incomingURL(): string | null {
  const direct = Intent.urlsParameter?.map(extractFirstURL).find((value): value is string => Boolean(value))
  if (direct) return direct
  const fromText = Intent.textsParameter?.map(extractFirstURL).find((value): value is string => Boolean(value))
  if (fromText) return fromText
  const shortcut = Intent.shortcutParameter
  return typeof shortcut?.value === "string" ? extractFirstURL(shortcut.value) : null
}

async function run() {
  const url = incomingURL()
  if (!url) {
    Script.exit(Intent.text("未找到有效的公开 http 或 https 链接。"))
    return
  }

  await Script.run({ name: "Yoinks", queryParameters: { url }, singleMode: true })
  Script.exit(Intent.text("已在 Yoinks 中打开链接。"))
}

void run()
