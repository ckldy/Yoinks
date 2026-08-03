import { Color, DynamicShapeStyle, LinearGradient } from "scripting"

/**
 * Yoinks UI 主题系统
 * 设计语言参照 PornHub（HANIME_THEME）+ BMW Companion（ACCENT/CARD）。
 * 品牌色为绿色系（systemGreen），深浅色模式各提供一套卡片表面。
 */

function accentGradient(tint: Color, surface: Color): LinearGradient {
  return {
    colors: [tint, surface],
    startPoint: "topLeading",
    endPoint: "bottomTrailing",
  }
}

export const YOINKS_THEME = {
  /** 品牌色：Yoinks 绿色系 */
  accent: "systemGreen" as const,
  /** 强调色徽标（BMW Companion 风格的主题蓝绿） */
  accentHex: "#34C759" as const,
  /** 卡片基准表面（BMW Companion CARD） */
  card: "secondarySystemBackground" as const,

  layout: {
    compact: 8,
    row: 12,
    section: 16,
    heroRadius: 24,
    cardRadius: 18,
    controlRadius: 14,
    tileRadius: 16,
  },

  chrome: {
    appBackground: {
      light: "systemGroupedBackground",
      dark: "systemGroupedBackground",
    } as DynamicShapeStyle,
  },

  surface: {
    /** Hero 主卡：品牌绿渐变强调卡 */
    accentCardBackground: {
      light: accentGradient("rgba(52,199,89,0.18)", "rgba(255,255,255,0.98)"),
      dark: accentGradient("rgba(52,199,89,0.30)", "rgba(26,38,30,0.98)"),
    } as DynamicShapeStyle,
    /** Hero 次卡：弱绿渐变卡 */
    softAccentCardBackground: {
      light: accentGradient("rgba(52,199,89,0.10)", "rgba(255,255,255,0.98)"),
      dark: accentGradient("rgba(52,199,89,0.18)", "rgba(30,36,32,0.98)"),
    } as DynamicShapeStyle,
    /** 统计瓦片表面 */
    statCardBackground: {
      light: "rgba(255,255,255,0.82)",
      dark: "rgba(255,255,255,0.11)",
    } as DynamicShapeStyle,
    /** 胶囊按钮表面 */
    actionPillBackground: {
      light: "rgba(255,255,255,0.76)",
      dark: "rgba(255,255,255,0.13)",
    } as DynamicShapeStyle,
    /** 状态/空态卡表面 */
    stateCardBackground: {
      light: "rgba(255,255,255,0.92)",
      dark: "rgba(255,255,255,0.09)",
    } as DynamicShapeStyle,
  },
}

/** 状态语义色（BMW Companion 风格） */
export const STATUS_COLORS = {
  ok: "#30D158",
  warn: "#FF9F0A",
  danger: "#FF453A",
  idle: "#8E8E93",
  info: "#0A84FF",
} as const
