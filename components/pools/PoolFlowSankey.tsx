'use client';

import { useMemo, useState } from 'react';
import { getEntityLogoSrc } from '@/lib/entity-logos';
import { getPoolLogoSrc } from '@/lib/pool-logos';
import { IN_GROUPS, OUT_GROUPS, detailName, zat, type Group, type GroupKey, type PoolSourcesData, type SourceDetail } from './pool-sources';

// Width-proportional flow: named sources -> pool -> named destinations.
// Ribbon thickness is exact ZEC on the pool side; tiny flows get a visible
// minimum only where they meet their label. Color follows the source/destination
// group (fixed order); the value is always in text beside the node.

const W = 1000;
const NODE_W = 10;
const LEFT_X = 236;      // left node column (labels to its left)
const RIGHT_X = W - 236 - NODE_W;
const POOL_W = 26;
const POOL_X = W / 2 - POOL_W / 2;
const ROW = 34;          // minimum vertical slot per labelled node
const HEADING = 22;      // group heading height
const GROUP_GAP = 14;
const PAD = 14;
const PER_GROUP = 4;     // named nodes per group before "Other …"
const MIN_NAMED_SHARE = 0.005; // a named node needs at least 0.5% of its side
const MIN_NAMED_ZEC = 1;
const TITLE = 22;        // room for the column title

interface Node {
  id: string;
  group: GroupKey;
  groupLabel: string;
  label: string;
  sub: string | null;
  logo: string | null;
  pool: string | null;     // counterpart pool for migration nodes
  zec: number;
  txs: number | null;
  share: number;
  // layout
  y: number;          // top of slot
  slot: number;       // slot height
  thick: number;      // drawn node thickness
  poolY: number;      // ribbon top where it meets the pool
  poolThick: number;  // exact ribbon thickness at the pool
}

interface Side { nodes: Node[]; headings: { label: string; y: number; zec: number; share: number; group: GroupKey }[]; height: number; total: number }

const OTHER_NOUN: Partial<Record<GroupKey, string>> = {
  mining: 'Other miners', rewards: 'Other rewards', exchanges: 'Other exchanges', pools: 'Other pools',
};

function buildNodes(side: 'in' | 'out', groups: Group[], categories: PoolSourcesData['sources'], details: SourceDetail[] | null): Omit<Node, 'y' | 'slot' | 'thick' | 'poolY' | 'poolThick'>[] {
  const byCat = new Map((categories ?? []).map(c => [c.category, c]));
  const total = (categories ?? []).reduce((a, c) => a + zat(c.amountZat), 0);
  const out: Omit<Node, 'y' | 'slot' | 'thick' | 'poolY' | 'poolThick'>[] = [];
  for (const g of groups) {
    const groupZec = g.categories.reduce((a, c) => a + zat(byCat.get(c)?.amountZat), 0);
    if (groupZec <= 0) continue;
    // Only flows big enough to read get their own node; the rest fold into "Other …".
    const named = (details ?? []).filter(d => g.categories.includes(d.category) && d.detail !== ''
      // Pools are few and always worth naming.
      && (d.category === 'migration' || zat(d.amountZat) >= Math.max(MIN_NAMED_ZEC, total * MIN_NAMED_SHARE))).slice(0, PER_GROUP);
    let left = groupZec;
    for (const d of named) {
      const v = zat(d.amountZat);
      left -= v;
      out.push({ id: `${side}-${g.key}-${d.category}-${d.detail}`, group: g.key, groupLabel: g.label, label: detailName(d).split(' / ').pop() ?? detailName(d),
        sub: d.label || d.category === 'migration' ? null : d.detail,
        pool: d.category === 'migration' ? d.detail : null,
        logo: d.label ? (d.category === 'mining' ? getPoolLogoSrc(d.label) : d.category === 'exchange' ? getEntityLogoSrc(d.label) : undefined) ?? null : null, zec: v, txs: d.txCount, share: total > 0 ? v / total : 0 });
    }
    if (named.length === 0) {
      out.push({ id: `${side}-${g.key}-all`, group: g.key, groupLabel: g.label, label: g.label, sub: null, logo: null, pool: null, zec: groupZec,
        txs: g.categories.reduce((a, c) => a + (byCat.get(c)?.txCount ?? 0), 0), share: total > 0 ? groupZec / total : 0 });
    } else if (left > groupZec * 0.005) {
      out.push({ id: `${side}-${g.key}-other`, group: g.key, groupLabel: g.label, label: OTHER_NOUN[g.key] ?? `Other ${g.label.toLowerCase()}`,
        sub: null, logo: null, pool: null, zec: left, txs: null, share: total > 0 ? left / total : 0 });
    }
  }
  return out;
}

/** Stack one side: slots for labels on the outer column, exact ribbon bands on the pool. */
function layoutSide(raw: ReturnType<typeof buildNodes>, scale: number, poolTop: number): Side {
  const nodes: Node[] = [];
  const headings: Side['headings'] = [];
  const total = raw.reduce((a, n) => a + n.zec, 0);
  let y = PAD + TITLE;
  let poolY = poolTop;
  let current: GroupKey | null = null;
  for (const n of raw) {
    if (n.group !== current) {
      if (current !== null) y += GROUP_GAP;
      const members = raw.filter(r => r.group === n.group);
      // A heading only adds information when the group has several nodes.
      if (members.length > 1) {
        const groupZec = members.reduce((a, r) => a + r.zec, 0);
        headings.push({ label: n.groupLabel, y, zec: groupZec, share: total > 0 ? groupZec / total : 0, group: n.group });
        y += HEADING;
      }
      current = n.group;
    }
    const exact = n.zec * scale;
    const thick = Math.max(exact, 2);
    const slot = Math.max(thick, ROW);
    nodes.push({ ...n, y, slot, thick, poolY, poolThick: exact });
    y += slot;
    poolY += exact;
  }
  return { nodes, headings, height: y + PAD, total };
}

function ribbon(x0: number, y0: number, t0: number, x1: number, y1: number, t1: number): string {
  const mx = (x0 + x1) / 2;
  return `M ${x0} ${y0} C ${mx} ${y0}, ${mx} ${y1}, ${x1} ${y1} L ${x1} ${y1 + t1} C ${mx} ${y1 + t1}, ${mx} ${y0 + t0}, ${x0} ${y0 + t0} Z`;
}

/** Center line of a ribbon, for the moving particles. */
function centerLine(x0: number, y0: number, x1: number, y1: number): string {
  const mx = (x0 + x1) / 2;
  return `M ${x0} ${y0} C ${mx} ${y0}, ${mx} ${y1}, ${x1} ${y1}`;
}

/** Particle spacing: bigger flows read as denser streams. Share in [0, 1]. */
function dashFor(share: number): string {
  const gap = Math.round(46 - 34 * Math.sqrt(Math.min(1, share)));
  return `2 ${gap}`;
}

const fmt = (zec: number) => {
  const abs = Math.abs(zec);
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(1)}K`;
  if (abs > 0 && abs < 0.01) return '<0.01';
  return abs.toLocaleString('en-US', { maximumFractionDigits: abs < 10 ? 2 : 1 });
};
const pct = (s: number) => (s > 0 && s < 0.001 ? '<0.1%' : `${(s * 100).toFixed(s < 0.1 ? 1 : 0)}%`);

export function PoolFlowSankey({ data, poolName, poolColor, groupColor, poolColors, positive, negative, ink, muted }: {
  data: PoolSourcesData; poolName: string; poolColor: string; groupColor: Record<GroupKey, string>; poolColors: Record<string, string>;
  positive: string; negative: string;
  /** Explicit text colors: exports do not resolve currentColor inside SVG. */
  ink: string; muted: string;
}) {
  const [active, setActive] = useState<string | null>(null);
  const colorOf = (n: { group: GroupKey; pool: string | null }) => (n.pool && poolColors[n.pool]) || groupColor[n.group];

  const layout = useMemo(() => {
    const inRaw = buildNodes('in', IN_GROUPS, data.sources, data.sourceDetails);
    const outRaw = buildNodes('out', OUT_GROUPS, data.destinations, data.destinationDetails);
    const inTotal = inRaw.reduce((a, n) => a + n.zec, 0);
    const outTotal = outRaw.reduce((a, n) => a + n.zec, 0);
    const big = Math.max(inTotal, outTotal, 1e-9);
    // Value height: about 60% of the taller labelled column, so ribbons read as volume, not decoration.
    const labelled = Math.max(
      inRaw.length * ROW + new Set(inRaw.map(n => n.group)).size * (HEADING + GROUP_GAP),
      outRaw.length * ROW + new Set(outRaw.map(n => n.group)).size * (HEADING + GROUP_GAP),
      220,
    );
    const scale = (labelled * 0.62) / big;
    const poolH = big * scale;
    const left0 = layoutSide(inRaw, scale, 0);
    const right0 = layoutSide(outRaw, scale, 0);
    const height = Math.max(left0.height, right0.height, poolH + 2 * PAD + 40);
    const poolTop = (height - poolH) / 2;
    const left = layoutSide(inRaw, scale, poolTop + (poolH - inTotal * scale) / 2);
    const right = layoutSide(outRaw, scale, poolTop + (poolH - outTotal * scale) / 2);
    // Center each side's column vertically.
    const shift = (side: Side) => {
      const dy = (height - side.height) / 2;
      side.nodes.forEach(n => { n.y += dy; });
      side.headings.forEach(h => { h.y += dy; });
    };
    shift(left); shift(right);
    return { left, right, height, poolTop, poolH, inTotal, outTotal };
  }, [data]);

  const { left, right, height, poolTop, poolH, inTotal, outTotal } = layout;
  const activeNode = [...left.nodes, ...right.nodes].find(n => n.id === active) ?? null;
  const dim = (id: string) => (active == null || active === id ? 1 : 0.18);
  const net = inTotal - outTotal;

  const nodeCenter = (n: Node) => n.y + n.slot / 2;

  return (
    <div className="relative">
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${height}`} className="block w-full min-w-[720px]" role="img"
          aria-label={`Flow into and out of the ${poolName} pool: ${left.nodes.map(n => `${n.label} ${fmt(n.zec)} ZEC in`).join(', ')}; ${right.nodes.map(n => `${n.label} ${fmt(n.zec)} ZEC out`).join(', ')}`}
          onMouseLeave={() => setActive(null)}>
          <defs>
            {[...left.nodes, ...right.nodes].map(n => {
              const isIn = left.nodes.includes(n);
              return (
                <linearGradient key={n.id} id={`g-${n.id.replace(/[^a-z0-9]/gi, '')}`} x1={isIn ? 0 : 1} x2={isIn ? 1 : 0} y1={0} y2={0}>
                  <stop offset="0%" stopColor={colorOf(n)} stopOpacity={0.7} />
                  <stop offset="100%" stopColor={poolColor} stopOpacity={0.45} />
                </linearGradient>
              );
            })}
          </defs>

          {/* Ribbons */}
          {left.nodes.map(n => {
            const t0 = n.thick, y0 = nodeCenter(n) - t0 / 2;
            return (
              <path key={`r-${n.id}`} d={ribbon(LEFT_X + NODE_W, y0, t0, POOL_X, n.poolY, Math.max(n.poolThick, 0.6))}
                fill={`url(#g-${n.id.replace(/[^a-z0-9]/gi, '')})`} opacity={dim(n.id)} data-dim=""
                className="transition-opacity duration-200" onMouseEnter={() => setActive(n.id)} />
            );
          })}
          {right.nodes.map(n => {
            const t1 = n.thick, y1 = nodeCenter(n) - t1 / 2;
            return (
              <path key={`r-${n.id}`} d={ribbon(POOL_X + POOL_W, n.poolY, Math.max(n.poolThick, 0.6), RIGHT_X, y1, t1)}
                fill={`url(#g-${n.id.replace(/[^a-z0-9]/gi, '')})`} opacity={dim(n.id)} data-dim=""
                className="transition-opacity duration-200" onMouseEnter={() => setActive(n.id)} />
            );
          })}

          {/* Particles: travel toward the pool on the left and away from it on the right. */}
          <g className="sankey-particles" pointerEvents="none" data-gif-particles="">
            {left.nodes.map(n => (
              <path key={`p-${n.id}`} d={centerLine(LEFT_X + NODE_W, nodeCenter(n), POOL_X, n.poolY + n.poolThick / 2)}
                fill="none" stroke={colorOf(n)} strokeWidth={Math.min(3, 1.2 + n.thick / 14)} strokeLinecap="round"
                strokeDasharray={dashFor(n.share)} opacity={active == null || active === n.id ? 0.9 : 0.1}
                style={{ animationDuration: `${2.4 + (n.id.length % 5) * 0.25}s` }} />
            ))}
            {right.nodes.map(n => (
              <path key={`p-${n.id}`} d={centerLine(POOL_X + POOL_W, n.poolY + n.poolThick / 2, RIGHT_X, nodeCenter(n))}
                fill="none" stroke={colorOf(n)} strokeWidth={Math.min(3, 1.2 + n.thick / 14)} strokeLinecap="round"
                strokeDasharray={dashFor(n.share)} opacity={active == null || active === n.id ? 0.9 : 0.1}
                style={{ animationDuration: `${2.4 + (n.id.length % 5) * 0.25}s` }} />
            ))}
          </g>

          {/* Pool */}
          <rect x={POOL_X} y={poolTop} width={POOL_W} height={Math.max(poolH, 4)} rx={6} fill={poolColor} />
          <text x={W / 2} y={poolTop - 26} textAnchor="middle" className="font-mono" fill={ink} fontSize={15} fontWeight={600}>
            {poolName.toUpperCase()}
          </text>
          <text x={W / 2} y={poolTop - 9} textAnchor="middle" className="font-mono" fontSize={12}
            fill={net >= 0 ? positive : negative}>
            {net >= 0 ? '+' : '−'}{fmt(net)} ZEC net
          </text>

          {/* Columns: headings, nodes and labels */}
          {([['in', left], ['out', right]] as const).map(([side, s]) => {
            const isIn = side === 'in';
            const x = isIn ? LEFT_X : RIGHT_X;
            const labelX = isIn ? x - 12 : x + NODE_W + 12;
            const anchor = isIn ? 'end' : 'start';
            return (
              <g key={side}>
                <text x={isIn ? 12 : W - 12} y={PAD + 2} textAnchor={isIn ? 'start' : 'end'} className="font-mono" fill={muted} fontSize={12} letterSpacing={1.2}>
                  {isIn ? `COMES IN FROM` : `GOES OUT TO`}
                </text>
                {s.headings.map(h => (
                  <text key={`h-${h.group}`} x={labelX} y={h.y + 15} textAnchor={anchor} className="font-mono" fontSize={12} letterSpacing={0.8}
                    fill={groupColor[h.group]}>
                    {h.label.toUpperCase()} · {pct(h.share)}
                  </text>
                ))}
                {s.nodes.map(n => (
                  <g key={n.id} opacity={dim(n.id)} data-dim="" className="cursor-pointer transition-opacity duration-200"
                    onMouseEnter={() => setActive(n.id)} onFocus={() => setActive(n.id)} tabIndex={0}>
                    <rect x={x} y={nodeCenter(n) - n.thick / 2} width={NODE_W} height={n.thick} rx={2} fill={colorOf(n)} />
                    {n.logo && (
                      <image href={n.logo} x={isIn ? x - 30 : x + NODE_W + 12} y={nodeCenter(n) - 9} width={18} height={18}
                        preserveAspectRatio="xMidYMid meet" style={{ borderRadius: 4 }} />
                    )}
                    <text x={n.logo ? (isIn ? x - 38 : x + NODE_W + 38) : labelX} y={nodeCenter(n) + 4.5} textAnchor={anchor} className="font-mono" fontSize={13}>
                      <tspan fill={ink}>{n.label}</tspan><tspan fill={muted} dx={10}>{fmt(n.zec)}</tspan>
                    </text>
                    {/* generous hit target */}
                    <rect x={isIn ? 0 : x - 4} y={n.y} width={isIn ? x + NODE_W + 4 : W - x + 4} height={n.slot} fill="transparent" />
                  </g>
                ))}
              </g>
            );
          })}
        </svg>
      </div>

      {activeNode && (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-lg border border-cipher-border bg-cipher-surface-solid px-3 py-2 text-xs font-mono shadow-lg" role="status">
          <p className="text-primary">{activeNode.label}{activeNode.sub ? <span className="text-muted"> · {activeNode.sub.slice(0, 10)}…</span> : null}</p>
          <p className="text-secondary">
            {left.nodes.includes(activeNode) ? `into ${poolName}` : `out of ${poolName}`} · {activeNode.groupLabel}
          </p>
          <p className="tabular-nums text-primary">
            {fmt(activeNode.zec)} ZEC · {pct(activeNode.share)}{activeNode.txs != null ? ` · ${activeNode.txs.toLocaleString('en-US')} txs` : ''}
          </p>
        </div>
      )}
    </div>
  );
}
