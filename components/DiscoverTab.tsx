import {
  Button,
  HStack,
  Image,
  List,
  NavigationStack,
  Section,
  Text,
  VStack,
  modifiers,
  useEffect,
  useState,
} from "scripting"
import type { EnqueueResult } from "../services/batch-queue"
import { BATCH_QUEUE_MAX, extractFirstURL } from "../services/media"
import { discover, discoveryKindLabel, discoveryPlatformLabel, type DiscoveryItem, type DiscoveryKind, type DiscoveryPlatform, ALL_DISCOVERY_PLATFORMS } from "../services/discovery"

const MAX_ITEMS_OPTIONS = [10, 20, 30, 40, 50]
const RELATED_SUPPORTED_PLATFORMS: DiscoveryPlatform[] = ["bilibili", "youtube"]

function ThumbnailView(props: { url?: string }) {
  if (!props.url) {
    return (
      <Image
        systemName="photo"
        foregroundStyle="secondaryLabel"
        modifiers={modifiers().frame({ width: 80, height: 45 }).clipShape({ type: "rect", cornerRadius: 6 })}
      />
    )
  }
  return (
    <Image
      imageUrl={props.url}
      resizable
      aspectRatio={{ value: 16 / 9, contentMode: "fill" }}
      modifiers={modifiers().frame({ width: 80, height: 45 }).clipShape({ type: "rect", cornerRadius: 6 })}
    />
  )
}

const KIND_OPTIONS: { kind: DiscoveryKind; label: string; experimental: boolean }[] = [
  { kind: "playlist", label: "播放列表 / 合集 / 频道", experimental: false },
  { kind: "author", label: "作者主页", experimental: false },
  { kind: "search", label: "关键词搜索", experimental: true },
  { kind: "related", label: "相关推荐", experimental: true },
]

function formatDuration(seconds?: number): string {
  if (typeof seconds !== "number" || seconds <= 0) return ""
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  if (mins < 60) return `${mins}:${String(secs).padStart(2, "0")}`
  const hours = Math.floor(mins / 60)
  const remainingMins = mins % 60
  return `${hours}:${String(remainingMins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
}

export type DiscoverTabProps = {
  experimentalEnabled: boolean
  queueItemCount: number
  onEnqueue: (urls: string[]) => EnqueueResult
  onSwitchToDownload: () => void
  onClose: () => void
}

export function DiscoverTab(props: DiscoverTabProps) {
  const [kind, setKind] = useState<DiscoveryKind>("playlist")
  const [platform, setPlatform] = useState<DiscoveryPlatform>("bilibili")
  const [input, setInput] = useState("")
  const [maxItems, setMaxItems] = useState(20)
  const [items, setItems] = useState<DiscoveryItem[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState("")
  const [page, setPage] = useState(1)
  const [totalAvailable, setTotalAvailable] = useState(0)

  const isPlatformRelevant = kind === "search" || kind === "related"

  useEffect(() => {
    setItems([])
    setSelectedIds(new Set())
    setStatus("")
    setPage(1)
    setTotalAvailable(0)
    // 相关推荐只支持 B站/YouTube，切换时避免停留在不支持的平台
    if (kind === "related" && !RELATED_SUPPORTED_PLATFORMS.includes(platform)) {
      setPlatform("bilibili")
    }
  }, [kind])

  const availableKinds = KIND_OPTIONS.filter((option) => !option.experimental || props.experimentalEnabled)

  const isInputValid = () => {
    if (kind === "search") return input.trim().length > 0
    try {
      const url = new URL(input.trim())
      return url.protocol === "http:" || url.protocol === "https:"
    } catch {
      return false
    }
  }

  const startDiscovery = async () => {
    if (!isInputValid()) {
      setStatus(kind === "search" ? "请输入搜索关键词" : "请输入有效的公开 http 或 https 链接")
      return
    }
    await runDiscovery(1)
  }

  const runDiscovery = async (targetPage: number) => {
    setLoading(true)
    setStatus("发现中...")
    setItems([])
    setSelectedIds(new Set())
    try {
      const result = await discover({
        kind,
        platform: isPlatformRelevant ? platform : undefined,
        sourceURL: input.trim(),
        query: input.trim(),
        maxItems,
        experimentalEnabled: props.experimentalEnabled,
        page: targetPage,
      })
      setItems(result.items)
      setSelectedIds(new Set(result.items.map((item) => item.id)))
      setPage(targetPage)
      setTotalAvailable(result.totalAvailable || result.items.length)
      const pages = result.totalPages ?? Math.ceil((result.totalAvailable || result.items.length) / maxItems)
      setStatus(result.items.length === 0 ? "未找到可展开的视频" : `发现 ${result.items.length} 条视频 · 第 ${targetPage}/${pages} 页`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatus(message)
    } finally {
      setLoading(false)
    }
  }

  const toggleSelection = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  const selectAll = () => setSelectedIds(new Set(items.map((item) => item.id)))
  const deselectAll = () => setSelectedIds(new Set())

  const selectedItems = items.filter((item) => selectedIds.has(item.id))
  const selectedURLs = selectedItems.map((item) => item.url)
  const remainingCapacity = Math.max(0, BATCH_QUEUE_MAX - props.queueItemCount)

  const addToQueue = () => {
    if (selectedURLs.length === 0) {
      setStatus("请先选择至少一条视频")
      return
    }
    if (selectedURLs.length > remainingCapacity) {
      setStatus(`批量队列最多 ${BATCH_QUEUE_MAX} 条，当前还可加入 ${remainingCapacity} 条`)
      return
    }
    const result = props.onEnqueue(selectedURLs)
    if (result.added > 0) {
      setStatus(`已加入 ${result.added} 条到批量队列`)
      setItems([])
      setSelectedIds(new Set())
      props.onSwitchToDownload()
    } else if (result.rejectedFull > 0) {
      setStatus(`批量队列已满，无法加入`)
    } else {
      setStatus("这些链接已在队列中")
    }
  }

  const clearResults = () => {
    setItems([])
    setSelectedIds(new Set())
    setStatus("")
    setPage(1)
    setTotalAvailable(0)
  }

  const canPaginate = () => {
    if (kind === "related") return false
    if (kind === "search" && platform !== "bilibili" && platform !== "youtube") return false
    try {
      const pathname = new URL(input.trim()).pathname.toLowerCase()
      // 单视频页面没有分批概念
      if (/\/video\/(bv\w+|av\d+)/i.test(pathname)) return false
    } catch {
      // 搜索模式：已在上方过滤支持的 platform；非 URL 输入（搜索词）继续走后续判断
    }
    // 只有在明确还有更多内容时才显示「换一批」，避免单页/无结果时仍出现按钮
    return totalAvailable > items.length || items.length >= maxItems
  }

  const totalPages = Math.max(1, Math.ceil(totalAvailable / maxItems))
  const canLoadNext = canPaginate() && !loading

  const loadNextBatch = async () => {
    if (!canPaginate()) return
    let nextPage = page + 1
    if (totalPages > 1 && nextPage > totalPages) {
      nextPage = 1
    }
    setLoading(true)
    setStatus("加载下一批...")
    try {
      const result = await discover({
        kind,
        platform: isPlatformRelevant ? platform : undefined,
        sourceURL: input.trim(),
        query: input.trim(),
        maxItems,
        experimentalEnabled: props.experimentalEnabled,
        page: nextPage,
      })
      if (result.items.length === 0) {
        // 当前已是最后一批，循环回第一批
        if (nextPage !== 1) {
          await runDiscovery(1)
          return
        }
        setStatus("没有更多视频了")
        return
      }
      setItems(result.items)
      setSelectedIds(new Set(result.items.map((item) => item.id)))
      setPage(nextPage)
      // 不覆盖已有的更大 totalAvailable：flat 模式翻页时 yt-dlp 可能不返回 playlist_count，
      // 此时 Python 回退到 len(items)（当前页条数），导致总批次错误地变小。
      const nextTotal = result.totalAvailable || result.items.length
      if (nextTotal > totalAvailable) setTotalAvailable(nextTotal)
      const pages = result.totalPages ?? Math.max(1, Math.ceil(Math.max(totalAvailable, nextTotal) / maxItems))
      setStatus(`第 ${nextPage}/${pages} 批 · ${result.items.length} 条视频`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatus(message)
    } finally {
      setLoading(false)
    }
  }

  const chooseKind = async () => {
    const actions = availableKinds.map((option) => ({ label: option.label }))
    const choice = await Dialog.actionSheet({ title: "选择发现类型", actions, cancelButton: true })
    if (choice != null && choice >= 0 && choice < availableKinds.length) {
      setKind(availableKinds[choice].kind)
      setInput("")
    }
  }

  const choosePlatform = async () => {
    const platformOptions = kind === "related" ? RELATED_SUPPORTED_PLATFORMS : ALL_DISCOVERY_PLATFORMS
    const actions = platformOptions.map((p) => ({ label: discoveryPlatformLabel(p) }))
    const choice = await Dialog.actionSheet({ title: "选择平台", actions, cancelButton: true })
    if (choice != null && choice >= 0 && choice < platformOptions.length) {
      setPlatform(platformOptions[choice])
    }
  }

  const chooseMaxItems = async () => {
    const actions = MAX_ITEMS_OPTIONS.map((n) => ({ label: `${n} 条` }))
    const choice = await Dialog.actionSheet({ title: "数量上限", actions, cancelButton: true })
    if (choice != null && choice >= 0 && choice < MAX_ITEMS_OPTIONS.length) {
      setMaxItems(MAX_ITEMS_OPTIONS[choice])
    }
  }

  const inputLabel =
    kind === "search" ? "搜索关键词" :
    kind === "related" ? "原视频链接" :
    "视频 / 播放列表 / 作者主页链接"
  const isSearch = kind === "search"

  const pasteInput = async () => {
    const clip = await Pasteboard.getString()
    if (isSearch) {
      if (!clip || !clip.trim()) {
        setStatus("剪贴板中没有内容。")
        return
      }
      setInput(clip.trim())
      return
    }
    const valid = extractFirstURL(clip)
    if (!valid) {
      setStatus("剪贴板中未发现有效的 http/https 链接。")
      return
    }
    setInput(valid)
  }

  const enterInput = async () => {
    const raw = await Dialog.prompt({
      title: `手动输入${isSearch ? "关键词" : "链接"}`,
      message: isSearch ? "请输入搜索关键词。" : "请粘贴或输入公开的 http/https 链接，会自动识别其中第一个有效链接。",
      placeholder: isSearch ? "关键词" : "https://...",
      confirmLabel: "确定",
      cancelLabel: "取消",
    })
    if (!raw) return
    if (isSearch) {
      setInput(raw.trim())
      return
    }
    const valid = extractFirstURL(raw)
    if (!valid) {
      setStatus("输入中未发现有效的 http/https 链接。")
      return
    }
    setInput(valid)
  }

  return (
    <NavigationStack>
      <List
        navigationTitle="发现"
        navigationBarTitleDisplayMode="large"
        toolbar={{ cancellationAction: <Button title="关闭" action={() => props.onClose()} /> }}
      >
        <Section header={<Text>发现类型</Text>}>
          <Button title={discoveryKindLabel(kind)} action={() => void chooseKind()} />
        {isPlatformRelevant && (
          <Button title={discoveryPlatformLabel(platform)} systemImage="globe" action={() => void choosePlatform()} />
        )}
        {!props.experimentalEnabled && (
          <Text font="caption" foregroundStyle="secondaryLabel">
            开启设置中的「实验性发现功能」后可使用搜索和相关推荐。
          </Text>
        )}
      </Section>

      <Section header={<Text>{inputLabel}</Text>}>
        <VStack alignment="leading" spacing={5}>
          <Text foregroundStyle={input ? "label" : "secondaryLabel"} lineLimit={3}>
            {input || (isSearch ? "请输入关键词。" : "从剪贴板粘贴或手动输入公开链接。")}
          </Text>
        </VStack>
        <Button title="从剪贴板粘贴" systemImage="doc.on.clipboard" action={() => void pasteInput()} />
        <Button title="手动输入" systemImage="keyboard" action={() => void enterInput()} />
        {input ? <Button title="清除" systemImage="xmark.circle" role="destructive" action={() => setInput("")} /> : null}
      </Section>

      <Section header={<Text>选项</Text>}>
        <Button title={`数量上限：${maxItems} 条`} action={() => void chooseMaxItems()} />
      </Section>

      <Section>
        <Button
          title={loading ? "发现中..." : "开始发现"}
          systemImage="magnifyingglass"
          action={() => void startDiscovery()}
          disabled={loading || !isInputValid()}
        />
        {status ? <Text foregroundStyle="secondaryLabel">{status}</Text> : null}
      </Section>

      {items.length > 0 && (
        <Section
          header={
            <HStack>
              <Text>共 {items.length} 条 · 已选 {selectedItems.length}</Text>
              <Button
                title={selectedItems.length === items.length ? "取消全选" : "全选"}
                action={() => (selectedItems.length === items.length ? deselectAll() : selectAll())}
              />
            </HStack>
          }
        >
          {items.map((item) => (
            <Button
              key={item.id}
              action={() => toggleSelection(item.id)}
            >
              <HStack spacing={10} alignment="center">
                <Image
                  systemName={selectedIds.has(item.id) ? "checkmark.circle.fill" : "circle"}
                  foregroundStyle={selectedIds.has(item.id) ? "green" : "secondaryLabel"}
                  frame={{ width: 22 }}
                />
                <ThumbnailView url={item.thumbnail} />
                <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <Text lineLimit={2}>{item.title}</Text>
                  <HStack spacing={8}>
                    {item.uploader ? (
                      <HStack spacing={2}>
                        <Image
                          systemName="person.fill"
                          foregroundStyle="secondaryLabel"
                          imageScale="small"
                          frame={{ width: 10 }}
                        />
                        <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>
                          {item.uploader}
                        </Text>
                      </HStack>
                    ) : null}
                    {typeof item.duration === "number" && item.duration > 0 ? (
                      <HStack spacing={2}>
                        <Image
                          systemName="clock.fill"
                          foregroundStyle="secondaryLabel"
                          imageScale="small"
                          frame={{ width: 10 }}
                        />
                        <Text font="caption" foregroundStyle="secondaryLabel">
                          {formatDuration(item.duration)}
                        </Text>
                      </HStack>
                    ) : null}
                  </HStack>
                </VStack>
              </HStack>
            </Button>
          ))}
        </Section>
      )}

      {items.length > 0 && (
        <Section>
          <Button
            title={`加入批量队列（${selectedItems.length}）`}
            systemImage="arrow.down.circle"
            action={() => addToQueue()}
            disabled={selectedItems.length === 0 || selectedItems.length > remainingCapacity}
          />
          {canLoadNext && (
            <Button
              title={loading ? "加载中..." : `换一批（第 ${page} / ${totalPages} 批）`}
              systemImage="arrow.clockwise"
              action={() => void loadNextBatch()}
              disabled={loading}
            />
          )}
          <Button title="清空结果" systemImage="trash" role="destructive" action={() => clearResults()} />
        </Section>
      )}
      </List>
    </NavigationStack>
  )
}
