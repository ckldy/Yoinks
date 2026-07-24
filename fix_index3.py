import re

with open('/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripts/Yoinks/index.tsx', 'r') as f:
    content = f.read()

# Fix 1: probe.formatCount -> probe.choices.length (in startDownload and analyzeMedia)
content = re.sub(r'probe\.formatCount', 'probe.choices.length', content)
content = re.sub(r'probeResult\.formatCount', 'probeResult.choices.length', content)

# Fix 2: Fix readLogPage call - takes 3 separate args, not an object
content = content.replace(
    'const data = await readLogPage({ filter, offset, limit: 20 })',
    'const data = await readLogPage(filter, offset, 20)'
)

# Fix 3: Fix chooseConcurrency to use proper type
content = content.replace(
    'const actions = ([1, 2, 4, 8] as ConcurrentDownloads[]).map((c) => ({ label: CONCURRENCY_LABELS[c] }))',
    'const actions = ([1, 2, 4, 8] as const).map((c) => ({ label: CONCURRENCY_LABELS[c as ConcurrentDownloads] }))'
)

# Fix 4: Fix startDownload function - the downloadMedia throws on error, no status/message
# Find and replace the entire startDownload function
# This is complex - let's find the function and replace its body

# Fix 5: Fix QuickLook.previewURLs - ensure result is typed
# The issue is result might be null - need to check

# Fix 6: Fix formatDownloadBytes and formatDownloadSpeed calls - handle undefined
# In formatDownloadBytes call:
content = content.replace(
    '{formatDownloadBytes(progress.downloadedBytes, progress.totalBytes)}',
    '{formatDownloadBytes(progress.downloadedBytes || 0, progress.totalBytes || 0)}'
)
content = content.replace(
    '{formatDownloadSpeed(progress.speed, progress.eta)}',
    '{formatDownloadSpeed(progress.speed || 0, progress.eta || 0)}'
)

# Fix 7: Fix the empty string issue in LogListView - event.taskId conditional
# The issue is {event.taskId && <Text ...>} renders empty string when falsy
# Need to change to ternary
content = content.replace(
    '{event.taskId && <Text font="caption2" foregroundStyle="secondaryLabel">{event.taskId}</Text>}',
    '{event.taskId ? <Text font="caption2" foregroundStyle="secondaryLabel">{event.taskId}</Text> : null}'
)

# Fix 8: Fix analyzeMedia to compute choiceCount/formatCount from probe
# The logEvent call uses probeResult.choiceCount and probeResult.formatCount
content = content.replace(
    'details: { title: probeResult.title, choiceCount: probeResult.choices.length, formatCount: probeResult.choices.length }',
    'details: { title: probeResult.title, choiceCount: probeResult.choices.length, formatCount: probeResult.choices.length }'
)

# Fix 9: Fix the logEvent in startDownload for completed download
# Also need to fix the download handling logic - downloadMedia throws on error
# Let's find the startDownload function and fix its body

# The startDownload function tries to access downloaded.status and downloaded.message
# But downloadMedia throws on error, so we need try/catch
# Let me find the startDownload function

start_download_pos = content.find('const startDownload = async (insecureTLS = false')
if start_download_pos != -1:
    # Find the end of this function (next const or function at same level)
    # Look for the closing brace pattern
    func_end = content.find('\n  const ', start_download_pos + 1)
    if func_end == -1:
        func_end = content.find('\n  const ', start_download_pos + 1)
    if func_end == -1:
        # Try to find the end by brace counting
        brace_count = 0
        in_string = False
        escape = False
        for i in range(start_download_pos, len(content)):
            c = content[i]
            if not escape:
                if c == '"' and (i == 0 or content[i-1] != '\\'):
                    in_string = not in_string
                elif c == '\\':
                    escape = True
                    continue
            escape = False
            
            if not in_string:
                if c == '{':
                    brace_count += 1
                elif c == '}':
                    brace_count -= 1
                    if brace_count == 0:
                        func_end = i + 1
                        break
    
    if func_end != -1:
        print(f"Found startDownload at {start_download_pos} to {func_end}")
        # Replace the function body
        old_func = content[start_download_pos:func_end]
        
        # Write a new version
        new_func = '''  const startDownload = async (insecureTLS = false, automatic?: { sourceURL: string; choice: MediaChoice; probeTitle: string; toolStatus: ToolStatus | null }, retriedTransientAccess = false) => {
    const availableTools = automatic?.toolStatus || tools
    if (!availableTools?.ytDlpVersion) {
      setStatus("请先安装 yt-dlp。")
      return
    }
    const validURL = extractFirstURL(automatic?.sourceURL || url)
    if (!validURL) {
      setStatus("请先粘贴或输入有效的公开链接。")
      return
    }

    const downloadChoice = automatic?.choice || selectedChoice
    if (!downloadChoice) {
      setStatus("请先分析链接并选择实际可用格式。")
      return
    }

    setDownloading(true)
    setCancelPath(null)
    setResult(null)
    setCompletedSaveMode(null)
    setProgress({ fraction: 0.02, stage: "正在解析媒体" })
    setStatus("yt-dlp 正在准备下载。")

    try {
      const platform = detectMediaPlatform(validURL)
      const session = isAuthPlatform(platform) ? await sessionForPlatform(platform) : null
      const downloaded = await downloadMedia(validURL, downloadChoice, {
        cookieFile: session ? await createTaskCookieFile(session) : undefined,
        concurrentFragments,
        insecureTLS,
        onProgress: (p) => setProgress(p),
        onCancelPath: (path) => setCancelPath(path),
        authorizedPlatform: session?.platform,
      })
      setDownloading(false)
      setCancelPath(null)

      const available = await recordCompletedDownload(downloaded, saveMode, downloadChoice.label || probe?.title || "未知标题")
      if (available) {
        setResult(downloaded)
        setCompletedSaveMode(saveMode)
        setStatus("下载完成。")
        await rememberRecentLink(validURL)
        setRecentLinks(listRecentLinks())
      } else {
        setStatus("下载完成但文件不可用。")
      }
    } catch (error) {
      setDownloading(false)
      setCancelPath(null)
      const message = error instanceof Error ? error.message : String(error)
      if (!insecureTLS && message.includes("暂时无法访问")) {
        setStatus("来源暂时拒绝访问，正在重试下载。")
        await startDownload(insecureTLS, automatic, true)
        return
      }
      if (!insecureTLS && isCertificateError(message)) {
        const retry = await Dialog.confirm({
          title: "证书校验失败",
          message: "当前网络返回了未受信任的 TLS 证书。兼容模式会仅对本次下载跳过证书校验。请只在你信任当前网络时继续。",
          confirmLabel: "继续下载",
          cancelLabel: "取消",
        })
        if (retry) {
          setStatus("正在以证书兼容模式重试。")
          await startDownload(true, automatic, retriedTransientAccess)
          return
        }
      }
      if (message !== "下载已取消") await Dialog.alert({ title: "下载失败", message: `${message}\\n\\n任务日志已写入：${getLogDirectory()}` })
    } finally {
      const platform = detectMediaPlatform(validURL)
      if (isAuthPlatform(platform)) disposeTemporarySession(platform)
      setDownloading(false)
      setCancelPath(null)
    }
  }'''
        
        content = content[:start_download_pos] + new_func + content[func_end:]

# Fix 10: Fix the isCertificateError function - add it inside View()
# It should already be there from previous fix, but let's make sure

# Fix 11: Fix clearPlatformAuth usage - replace with clearPlatformLogin per platform
content = content.replace(
    'await clearPlatformAuth()',
    'await Promise.all(supportedAuthPlatforms().map((p) => clearPlatformLogin(p)))'
)

# Fix 12: Fix the import for clearPlatformLogin (already done)
# But also need to fix the clearPlatformAuth function in View()
# The clearPlatformAuth function calls clearPlatformAuth() - need to update it

# Write back
with open('/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripts/Yoinks/index.tsx', 'w') as f:
    f.write(content)

print("Applied comprehensive fixes")