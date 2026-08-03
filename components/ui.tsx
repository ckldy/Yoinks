import { Button, HStack, Image, Spacer, Text, VStack } from "scripting"
import { YOINKS_THEME } from "./theme"

/**
 * Yoinks 共享 UI 组件
 * 参照 BMW Companion（StatusPill / MetricCard）+ PornHub（HeroCard / ActionPill / StatTile / EmptyState）。
 * 全部使用 SwiftUI 原生组件（Image/Text/Button + clipShape 连续圆角 + 语义色）。
 */

export type StatusPillProps = {
  icon: string
  title: string
  color: string
}

/** 胶囊状态标签（BMW Companion StatusPill） */
export function StatusPill({ icon, title, color }: StatusPillProps) {
  return (
    <HStack
      spacing={5}
      padding={{ horizontal: 9, vertical: 5 }}
      background={`${color}18` as any}
      clipShape={{ type: "capsule", style: "continuous" }}
    >
      <Image systemName={icon} font="caption" foregroundStyle={color as any} />
      <Text font="caption" fontWeight="semibold" foregroundStyle={color as any}>{title}</Text>
    </HStack>
  )
}

export type MetricCardProps = {
  icon: string
  title: string
  value: string
  subtitle: string
  tint?: string
}

/** 统计卡片（BMW Companion MetricCard） */
export function MetricCard({ icon, title, value, subtitle, tint = YOINKS_THEME.accentHex }: MetricCardProps) {
  return (
    <VStack
      alignment="leading"
      spacing={9}
      padding={14}
      frame={{ minHeight: 108, maxWidth: Infinity, alignment: "leading" }}
      background={YOINKS_THEME.card}
      clipShape={{ type: "rect", cornerRadius: 18, style: "continuous" }}
    >
      <HStack>
        <Image systemName={icon} font="body" foregroundStyle={tint as any} />
        <Spacer />
        <Text font="caption2" foregroundStyle="tertiaryLabel">{title}</Text>
      </HStack>
      <Text font="title2" fontWeight="bold" foregroundStyle="label" lineLimit={1} minScaleFactor={0.7}>
        {value}
      </Text>
      <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={2}>{subtitle}</Text>
    </VStack>
  )
}


export type HeroCardProps = {
  eyebrow?: string
  title: string
  subtitle: string
  actions?: JSX.Element | JSX.Element[]
  tone?: "primary" | "soft"
}

/** Hero 渐变卡（PornHub HanimeHeroCard） */
export function HeroCard({ eyebrow, title, subtitle, actions, tone = "primary" }: HeroCardProps) {
  const surface = tone === "soft" ? YOINKS_THEME.surface.softAccentCardBackground : YOINKS_THEME.surface.accentCardBackground
  return (
    <VStack
      alignment="leading"
      spacing={YOINKS_THEME.layout.row}
      padding={YOINKS_THEME.layout.section}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={{
        style: surface,
        shape: { type: "rect", cornerRadius: YOINKS_THEME.layout.heroRadius },
      }}
    >
      <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        {eyebrow ? (
          <Text font="caption" fontWeight="semibold" foregroundStyle={YOINKS_THEME.accent as any} lineLimit={1}>
            {eyebrow}
          </Text>
        ) : null}
        <Text font="title2" fontWeight="bold" lineLimit={2} multilineTextAlignment="leading">
          {title}
        </Text>
        <Text font="subheadline" foregroundStyle="secondaryLabel" lineLimit={3} multilineTextAlignment="leading">
          {subtitle}
        </Text>
      </VStack>
      {actions ? (
        <HStack spacing={YOINKS_THEME.layout.compact} frame={{ maxWidth: "infinity" }}>
          {actions}
        </HStack>
      ) : null}
    </VStack>
  )
}

export type StatTileProps = {
  title: string
  value: string
  icon?: string
}

/** 统计瓦片（PornHub HanimeStatTile） */
export function StatTile({ title, value, icon }: StatTileProps) {
  return (
    <VStack
      alignment="leading"
      spacing={icon ? 4 : 2}
      frame={{ maxWidth: "infinity", minHeight: 62, alignment: "leading" }}
      padding={{ horizontal: 12, vertical: 11 }}
      background={YOINKS_THEME.surface.statCardBackground}
      clipShape={{ type: "rect", cornerRadius: YOINKS_THEME.layout.tileRadius }}
    >
      {icon ? <Image systemName={icon} font="caption" tint={YOINKS_THEME.accent as any} /> : null}
      <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{title}</Text>
      <Text font="headline" lineLimit={1}>{value}</Text>
    </VStack>
  )
}

export type ActionPillProps = {
  title: string
  systemImage: string
  action: () => void
  disabled?: boolean
  tone?: "primary" | "secondary" | "danger"
}

/** 胶囊动作按钮（PornHub HanimeActionPill） */
export function ActionPill({ title, systemImage, action, disabled = false, tone = "primary" }: ActionPillProps) {
  return (
    <Button action={action} disabled={disabled} buttonStyle="plain" frame={{ maxWidth: "infinity" }}>
      <ActionPillContent title={title} systemImage={systemImage} tone={tone} />
    </Button>
  )
}

export function ActionPillContent({
  title,
  systemImage,
  tone = "primary",
}: {
  title: string
  systemImage: string
  tone?: "primary" | "secondary" | "danger"
}) {
  const foregroundStyle = tone === "danger" ? "systemRed" : tone === "secondary" ? "label" : YOINKS_THEME.accent

  return (
    <HStack
      spacing={6}
      frame={{ maxWidth: "infinity", minHeight: 42, alignment: "center" }}
      padding={{ horizontal: 12, vertical: 9 }}
      background={YOINKS_THEME.surface.actionPillBackground}
      clipShape={{ type: "rect", cornerRadius: YOINKS_THEME.layout.controlRadius }}
    >
      <Image systemName={systemImage} font="caption" foregroundStyle={foregroundStyle as any} />
      <Text font="subheadline" fontWeight="semibold" foregroundStyle={foregroundStyle as any} lineLimit={1}>
        {title}
      </Text>
    </HStack>
  )
}

export type EmptyStateProps = {
  icon: string
  title: string
  message: string
  actionTitle?: string
  action?: () => void
}

/** 空态卡片（PornHub EmptyState） */
export function EmptyState({ icon, title, message, actionTitle, action }: EmptyStateProps) {
  return (
    <VStack
      spacing={12}
      padding={{ horizontal: 24, vertical: 24 }}
      frame={{ maxWidth: "infinity", minHeight: 176 }}
      background={YOINKS_THEME.surface.stateCardBackground}
      clipShape={{ type: "rect", cornerRadius: YOINKS_THEME.layout.heroRadius }}
    >
      <Image
        systemName={icon}
        font={28}
        foregroundStyle={YOINKS_THEME.accent as any}
        frame={{ width: 52, height: 52 }}
      />
      <VStack spacing={5}>
        <Text font="subheadline" fontWeight="semibold" multilineTextAlignment="center">{title}</Text>
        <Text font="caption" foregroundStyle="secondaryLabel" multilineTextAlignment="center" lineLimit={4}>
          {message}
        </Text>
      </VStack>
      {action && actionTitle ? (
        <Button action={action} buttonStyle="plain">
          <HStack
            spacing={6}
            padding={{ horizontal: 14, vertical: 10 }}
            background={YOINKS_THEME.surface.actionPillBackground}
            clipShape={{ type: "rect", cornerRadius: YOINKS_THEME.layout.controlRadius }}
          >
            <Text font="subheadline" fontWeight="semibold" foregroundStyle={YOINKS_THEME.accent as any}>{actionTitle}</Text>
            <Image systemName="arrow.right" font="caption" foregroundStyle={YOINKS_THEME.accent as any} />
          </HStack>
        </Button>
      ) : null}
    </VStack>
  )
}

/** 圆形图标徽章（列表行图标容器） */
export function IconBadge({
  systemName,
  tint = YOINKS_THEME.accentHex,
  size = 34,
}: {
  systemName: string
  tint?: string
  size?: number
}) {
  return (
    <VStack
      alignment="center"
      spacing={0}
      frame={{ width: size, height: size }}
      background={`${tint}1F` as any}
      clipShape={{ type: "rect", cornerRadius: size * 0.3, style: "continuous" }}
    >
      <Image systemName={systemName} font="subheadline" foregroundStyle={tint as any} />
    </VStack>
  )
}
