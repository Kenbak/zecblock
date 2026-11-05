'use client';

import { useRef } from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import { usePoolCurrency } from './PoolCurrency';
import {
  MAX_SUPPLY_ZAT,
  isShieldedPoolKey,
  type ShieldedPoolKey,
  type SupplyPoolKey,
  type SupplySegmentInput,
  type TopLevelKey,
} from './supply-treemap-layout';
import { useSegmentLabelMode, type SegmentLabelMode } from './useSegmentLabelMode';

export interface SupplyTreemapProps {
  topLevel: SupplySegmentInput[];
  shieldedChildren: SupplySegmentInput[];
  hoveredKey: SupplyPoolKey | null;
  pinnedShielded: boolean;
  onHover: (key: SupplyPoolKey | null) => void;
  onTogglePinShielded: () => void;
}

function flexWeight(zat: number): number {
  return zat > 0 ? zat : 0;
}

function BandLabel({
  label,
  amount,
  capPct,
  mode,
  onDarkFill,
}: {
  label: string;
  amount: string;
  capPct: number;
  mode: SegmentLabelMode;
  onDarkFill: boolean;
}) {
  if (mode === 'none') return null;

  const titleClass = onDarkFill ? 'text-white' : 'text-cipher-bg-dark';
  const valueClass = titleClass;
  const pctClass = titleClass;

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-1 text-center">
      <span className={`truncate text-caption font-sans font-semibold sm:text-xs ${titleClass}`}>{label}</span>
      {mode === 'full' ? (
        <>
          <span className={`mt-0.5 text-caption font-mono tabular-nums sm:text-caption ${valueClass}`}>
            {amount}
          </span>
          <span className={`mt-0.5 text-caption font-mono tabular-nums ${pctClass}`}>{capPct.toFixed(1)}%</span>
        </>
      ) : null}
    </div>
  );
}

function segmentUsesLightLabel(segment: SupplySegmentInput, isDark: boolean): boolean {
  if (segment.hatch) return isDark;
  if (segment.key === 'public') return isDark;
  // Aggregate shielded uses gold fills with a dark label in either theme.
  return false;
}

function TopSegment({
  segment,
  active,
  dimmed,
  isDark,
  onHover,
  onClick,
  className,
  style,
}: {
  segment: SupplySegmentInput;
  active: boolean;
  dimmed: boolean;
  isDark: boolean;
  onHover: (key: SupplyPoolKey | null) => void;
  onClick?: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { formatSupplySegment } = usePoolCurrency();
  const amount = formatSupplySegment(segment);
  const ref = useRef<HTMLButtonElement>(null);
  const capPct = (segment.zat / MAX_SUPPLY_ZAT) * 100;
  const labelMode = useSegmentLabelMode(ref, capPct);
  const ringActive = isDark ? 'ring-white/40' : 'ring-black/25';
  const ringIdle = isDark ? 'ring-white/10' : 'ring-black/10';
  const onDarkFill = segmentUsesLightLabel(segment, isDark);

  return (
    <button
      ref={ref}
      type="button"
      className={`relative min-w-0 overflow-hidden rounded-md transition-opacity duration-150 ${dimmed ? 'opacity-70' : 'opacity-100'} ${className ?? ''}`}
      style={style}
      onMouseEnter={() => onHover(segment.key)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(segment.key)}
      onBlur={() => onHover(null)}
      onClick={onClick}
      aria-label={`${segment.label}, ${amount}, ${capPct.toFixed(1)} percent of cap`}
    >
      {segment.hatch ? (
        <div
          className="absolute inset-0 rounded-[5px]"
          style={{
            backgroundImage: isDark
              ? 'repeating-linear-gradient(135deg, rgba(148,163,184,0.14) 0 2px, transparent 2px 7px)'
              : 'repeating-linear-gradient(135deg, rgba(100,116,139,0.22) 0 2px, transparent 2px 7px)',
            backgroundColor: isDark ? 'rgba(148,163,184,0.06)' : 'rgba(148,163,184,0.14)',
          }}
        />
      ) : (
        <div
          className={`absolute inset-0 rounded-[5px] ring-1 ring-inset ${active ? ringActive : ringIdle}`}
          style={{
            backgroundColor: segment.color,
            opacity: segment.key === 'public' ? (isDark ? 0.32 : 0.28) : (isDark ? 0.9 : 1),
          }}
        />
      )}
      <BandLabel
        label={segment.label}
        amount={amount}
        capPct={capPct}
        mode={labelMode}
        onDarkFill={onDarkFill}
      />
    </button>
  );
}

function ShieldedPoolStack({
  segments,
  hoveredKey,
  pinnedShielded,
  isDark,
  onHover,
  onTogglePinShielded,
  className,
  style,
}: {
  segments: SupplySegmentInput[];
  hoveredKey: SupplyPoolKey | null;
  pinnedShielded: boolean;
  isDark: boolean;
  onHover: (key: SupplyPoolKey | null) => void;
  onTogglePinShielded: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const focusedPool = pinnedShielded && isShieldedPoolKey(hoveredKey) ? hoveredKey : null;
  const divider = isDark ? 'border-white/12' : 'border-black/10';
  const focusRing = isDark ? 'ring-white/50' : 'ring-black/25';

  return (
    <div
      className={`relative flex h-full min-w-0 flex-col overflow-hidden rounded-md ring-1 ring-inset transition-opacity duration-150 ring-cipher-border ${className ?? ''}`}
      style={style}
      onMouseEnter={() => onHover('shielded')}
      onMouseLeave={() => onHover(null)}
      onClick={onTogglePinShielded}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onTogglePinShielded();
        }
      }}
      aria-pressed={pinnedShielded}
      aria-label="Shielded pool composition. Press Enter or Space to hide the split."
    >
      {segments.map((child, index) => {
        const weight = flexWeight(child.zat);
        const isFocused = focusedPool === child.key;
        const isDimmed = focusedPool != null && !isFocused;

        return (
          <div
            key={child.key}
            className={`relative min-h-0 w-full transition-opacity duration-150 ${index > 0 ? `border-t ${divider}` : ''} ${isDimmed ? 'opacity-25' : 'opacity-100'} ${isFocused ? `ring-1 ring-inset ${focusRing} z-[1]` : ''}`}
            style={{ flex: `${weight} 1 0` }}
            onMouseEnter={() => {
              if (pinnedShielded) onHover(child.key);
            }}
            onMouseLeave={() => {
              if (pinnedShielded) onHover('shielded');
            }}
          >
            <div
              className="absolute inset-0"
              style={{ backgroundColor: child.color, opacity: isDark ? 0.9 : 1 }}
            />
          </div>
        );
      })}
    </div>
  );
}

export function SupplyTreemap({
  topLevel,
  shieldedChildren,
  hoveredKey,
  pinnedShielded,
  onHover,
  onTogglePinShielded,
}: SupplyTreemapProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const shieldedExpanded = pinnedShielded;

  const handleMapLeave = () => {
    onHover(null);
  };

  return (
    <div
      className="flex h-[132px] w-full gap-0.5 p-0.5 sm:h-[156px]"
      role="group"
      aria-label="Zcash supply map: public supply, shielded, and unmined portions of the 21 million cap"
      onMouseLeave={handleMapLeave}
    >
      {topLevel.filter(segment => segment.zat > 0).map((segment) => {
        const weight = flexWeight(segment.zat);
        const flexStyle = { flex: `${weight} 1 0` };
        const active = hoveredKey === segment.key;
        const dimmed =
          hoveredKey != null &&
          !active &&
          !(shieldedExpanded && segment.key === 'shielded') &&
          !(pinnedShielded && segment.key === 'shielded') &&
          !(pinnedShielded && isShieldedPoolKey(hoveredKey) && segment.key !== 'shielded');

        if (segment.key === 'shielded' && shieldedExpanded) {
          return (
            <ShieldedPoolStack
              key="shielded"
              segments={shieldedChildren}
              hoveredKey={hoveredKey}
              pinnedShielded={pinnedShielded}
              isDark={isDark}
              onHover={onHover}
              onTogglePinShielded={onTogglePinShielded}
              className={dimmed ? 'opacity-30' : 'opacity-100'}
              style={flexStyle}
            />
          );
        }

        if (segment.key === 'shielded') {
          return (
            <TopSegment
              key={segment.key}
              segment={segment}
              active={active || pinnedShielded}
              dimmed={dimmed}
              isDark={isDark}
              onHover={onHover}
              className="h-full min-w-0 cursor-pointer"
              style={flexStyle}
              onClick={onTogglePinShielded}
            />
          );
        }

        return (
          <TopSegment
            key={segment.key}
            segment={segment}
            active={active}
            dimmed={dimmed}
            isDark={isDark}
            onHover={onHover}
            className="h-full min-w-0"
            style={flexStyle}
          />
        );
      })}
    </div>
  );
}

export type { TopLevelKey, ShieldedPoolKey };
