import { getPrivacyColors } from './privacy-palette';
import type { MiningSoftware } from './mining-software';

export function getMiningSoftwareColors(theme: 'dark' | 'light'): Record<MiningSoftware, string> {
  const colors = getChartColors(theme);
  return {
    zebra: colors.axis,
    zakura: colors.zakura,
    other: colors.orchard,
    unknown: colors.referenceLine,
    conflicting: colors.distinctive,
    missing: colors.deshielding,
  };
}

/** Assay information palette. Match semantic roles in app/globals.css. */
export function getChartColors(theme: 'dark' | 'light') {
  const dark = theme === 'dark';
  const privacy = getPrivacyColors(theme);
  const gold = dark ? '#F8BC21' : '#DB9E00';
  const iris = dark ? '#B6A0E0' : '#7040B5';
  const sage = dark ? '#91AC90' : '#14734B';
  const steel = dark ? '#A1A9AD' : '#687587';
  const stone = dark ? '#7F897A' : '#526073';
  const hoverFill = dark ? 'rgba(156,164,176,0.07)' : 'rgba(89,97,109,0.06)';
  const hoverStroke = dark ? '#565D68' : '#A3ADBA';
  return {
    hoverFill,
    hoverStroke,
    grid: dark ? '#2C3037' : '#CED3DB',
    axis: dark ? '#9CA4B0' : '#59616D',
    tooltipBg: dark ? '#111316' : '#FFFFFF',
    tooltipBorder: dark ? '#2C3037' : '#CED3DB',
    tooltipText: dark ? '#F1F3F5' : '#171A20',
    ironwood: privacy.ironwood,
    orchard: iris,
    sapling: sage,
    zakura: dark ? '#E8A1C4' : '#A63871',
    sprout: stone,
    transparent: steel,
    shielded: privacy.shielded,
    shielding: dark ? '#65C79A' : '#14734B',
    deshielding: dark ? '#E2A66E' : '#A34F12',
    coinbase: steel,
    gold,
    yellow: gold,
    purple: iris,
    orchardPool: iris,
    ironwoodPool: privacy.ironwood,
    verifiedRing: dark ? '#65C79A' : '#14734B',
    denominated: gold,
    distinctive: dark ? '#D58D86' : '#B13D38',
    // Source identity stays consistent across composition and inflow views.
    inflowOrchard: iris,
    inflowTransparent: steel,
    inflowSapling: sage,
    inflowCoinbase: stone,
    // Residual "moved on" bucket; darker in dark mode so it separates from iris
    // under CVD (validated with shielding/iris/gold/distinctive neighbours).
    residual: dark ? '#5E6670' : steel,
    referenceLine: dark ? '#565D68' : '#A3ADBA',
    cursor: dark ? '#9CA4B0' : '#59616D',
    gridStroke: dark ? '#20242A' : '#E4E7EC',
    barCursor: hoverFill,
    barCursorGold: hoverFill,
  };
}

/** Default and custom chart tooltips use the same surface, spacing and type. */
export function getChartTooltipStyle(colors: ReturnType<typeof getChartColors>) {
  return {
    background: colors.tooltipBg,
    backgroundColor: colors.tooltipBg,
    border: `1px solid ${colors.tooltipBorder}`,
    borderRadius: 8,
    padding: '12px 16px',
    color: colors.tooltipText,
    fontFamily: 'var(--font-geist-mono), monospace',
    fontSize: 12,
    lineHeight: 1.5,
    boxShadow: 'none',
  };
}

/** Responsive categorical date axes leave room for the final label. */
export const CHART_DATE_AXIS = {
  interval: 'preserveStartEnd' as const,
  minTickGap: 48,
  padding: { left: 12, right: 24 },
};
