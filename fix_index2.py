import re

with open('/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripts/Yoinks/index.tsx', 'r') as f:
    content = f.read()

# 1. Fix the label maps to match actual types
content = content.replace(
    '''const AUTOMATIC_DOWNLOAD_FORMAT_LABELS: Record<AutomaticDownloadFormatStrategy, string> = {
  "highest-quality": "最高画质",
  "preferred-container": "指定容器格式",
  "smallest-file": "最小文件",
}''',
    '''const AUTOMATIC_DOWNLOAD_FORMAT_LABELS: Record<AutomaticDownloadFormatStrategy, string> = {
  "recommended": "推荐",
  "highest-video": "最高画质视频",
  "highest-audio": "最高质量音频",
  "preferred-container": "指定容器格式",
}'''
)

content = content.replace(
    '''const PREFERRED_CONTAINER_LABELS: Record<PreferredContainer, string> = {
  mp4: "MP4",
  mkv: "MKV",
  webm: "WebM",
  mov: "MOV",
}''',
    '''const PREFERRED_CONTAINER_LABELS: Record<PreferredContainer, string> = {
  mp4: "MP4",
  mkv: "MKV",
  avi: "AVI",
  wmv: "WMV",
}'''
)

# 2. Fix clearPlatformAuth import to clearPlatformLogin (but this is per-platform, so we'll handle in code)
# We'll change the import and the usage

# 3. Fix the unclosed fragment
content = content.replace(
    '{debugMode ? <>',
    '{debugMode ? <>'
)

# 4. Fix font="system" 
content = content.replace(
    '<Text font="system" foregroundStyle="label" selectable={true}>',
    '<Text font="body" foregroundStyle="label" selectable={true}>'
)

# 5. Remove the <a> tag in AboutView - replace with proper link handling
content = content.replace(
    '''<Text font="body" foregroundStyle="secondaryLabel">上游项目：<Text font="body"><a href="https://github.com/pablostanley/yoinks/tree/main">https://github.com/pablostanley/yoinks/tree/main</a></Text></Text>''',
    '''<Text font="body" foregroundStyle="secondaryLabel">上游项目： https://github.com/pablostanley/yoinks/tree/main</Text>'''
)

# Now find where the View function ends and add the missing components
# We need to add LogListView and isCertificateError inside View()

# First, let's find the end of the View function (before the return statement)
# The return statement with TabView
return_pos = content.find('return (\n    <TabView selection={activeTab as any} tint="systemGreen" tabViewStyle="sidebarAdaptable">')
if return_pos == -1:
    # Try alternative
    return_pos = content.find('return (\n    <TabView')
    if return_pos == -1:
        return_pos = content.find('<TabView selection={activeTab')

if return_pos == -1:
    print("Could not find return statement!")
    exit(1)

# Insert the missing components before the return
insertion = '''

  // LogListView - inline log viewer
  const LogListView = () => {
    const dismiss = Navigation.useDismiss()
    const [page, setPage] = useState<LogPageData | null>(null)
    const [filter, setFilter] = useState<LogFilter>("all")
    const [loading, setLoading] = useState(false)

    const loadPage = async (offset = 0) => {
      setLoading(true)
      try {
        const data = await readLogPage({ filter, offset, limit: 20 })
        setPage(data)
      } finally {
        setLoading(false)
      }
    }

    useEffect(() => {
      loadPage()
    }, [filter])

    return (
      <List navigationTitle="运行日志" navigationBarTitleDisplayMode="inline" toolbar={{ cancellationAction: <Button title="关闭" action={dismiss} /> }}>
        <Section>
          <HStack spacing={8}>
            <Text font="caption" foregroundStyle="secondaryLabel">筛选：</Text>
            {["all", "info", "warn", "error"].map((f) => (
              <Button key={f} title={f === "all" ? "全部" : f} action={() => { setFilter(f as LogFilter); loadPage(); }} disabled={filter === f} />
            ))}
          </HStack>
        </Section>
        <Section header={<Text>{page ? `显示 ${page.events.length} 条 / 共 ${page.totalMatching} 条` : "加载中..."}</Text>}>
          {page?.events.map((event) => (
            <Button key={event.timestamp + event.event} action={() => void Navigation.present({ element: <LogDetailView event={event} /> })}>
              <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" as any }}>
                <HStack spacing={6}>
                  <Text font="subheadline">{event.event}</Text>
                  <Text font="caption2" foregroundStyle={event.level === "error" ? "red" : event.level === "warn" ? "orange" : event.level === "debug" ? "gray" : "green"}>
                    {event.level.toUpperCase()}
                  </Text>
                  {event.taskId && <Text font="caption2" foregroundStyle="secondaryLabel">{event.taskId}</Text>}
                </HStack>
                <Text font="caption2" foregroundStyle="tertiaryLabel">{event.timestamp}</Text>
              </VStack>
            </Button>
          ))}
          {page?.hasMore && !loading && (
            <Button title="加载更早" systemImage="chevron.down" action={() => loadPage((page?.events.length || 0))} />
          )}
          {loading && <ProgressView />}
        </Section>
      </List>
    )
  }

  // Helper function to check for certificate errors
  const isCertificateError = (message: string): boolean => {
    return /certificate|SSL|TLS|untrusted|verify.*cert|self.signed|expired|hostname.*mismatch/i.test(message)
  }

'''

content = content[:return_pos] + insertion + content[return_pos:]

# Now fix the issues in the View function body:
# - Compute choiceCount and formatCount
# - Fix DownloadResult handling
# - Fix clearPlatformAuth usage
# - Fix the probe.completed log to use computed values

# Fix: change probe?.choiceCount to probe?.choices?.length
content = content.replace(
    'choiceCount: probeResult.choiceCount',
    'choiceCount: probeResult.choices.length'
)
content = content.replace(
    'formatCount: probeResult.formatCount',
    'formatCount: probeResult.choices.reduce((sum, c) => sum + (c.formatExpression ? 1 : 0), 0)'
)
content = content.replace(
    'choiceCount: probeResult.choiceCount, formatCount: probeResult.formatCount',
    'choiceCount: probeResult.choices.length, formatCount: probeResult.choices.length'
)

# Fix the startDownload function to handle DownloadResult (throws on error, no status)
# We need to find and replace the download handling logic
# The current code checks downloaded.status, but downloadMedia throws on error

# Find the startDownload function and fix it
# The issue is around line 800-900 in the new content
# Let's search for the pattern

# Replace the download handling logic
# The old code:
# if (downloaded.status === "completed") {
# } else if (downloaded.status === "cancelled") {
# } else {
#   const message = downloaded.message || "下载失败"
# }

# New code should use try/catch since downloadMedia throws on error

# This is complex - let's just write the fixed file directly
# Actually, let me try a targeted fix

# Find the startDownload function
start_download_pos = content.find('const startDownload = async (insecureTLS = false, automatic?: { sourceURL: string; choice: MediaChoice; probeTitle: string; toolStatus: ToolStatus | null }, retriedTransientAccess = false) => {')
if start_download_pos != -1:
    # Find the end of this function (before the next const or function)
    # Look for the closing brace at the right indentation level
    pass

# Given the complexity, let's just ensure the file is valid and run diagnostics
# The TypeScript errors will guide us

# Write back
with open('/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripts/Yoinks/index.tsx', 'w') as f:
    f.write(content)

print("Applied initial fixes")