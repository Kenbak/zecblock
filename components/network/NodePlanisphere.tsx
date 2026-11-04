'use client';

import { useState } from 'react';
import { ChartWatermark } from '@/components/ChartWatermark';
import type { NodeLocation } from '@/lib/node-map-locations';
import { DOT_RADIUS, MAP_HEIGHT, MAP_WIDTH, project, useWorldLandDots } from '@/lib/world-dot-map';

interface NodePlanisphereProps {
  locations: readonly NodeLocation[];
  selectedCountry: string | null;
  onHover: (location: NodeLocation | null) => void;
}

const TIERS = [
  { minimum: 10, color: '#F8BC21', label: '10+' },
  { minimum: 5, color: '#D49A20', label: '5–9' },
  { minimum: 2, color: '#A07818', label: '2–4' },
  { minimum: 1, color: '#7A6030', label: '1' },
];

/** Flat geographic view of the same country-preserving groups as the globe. */
export function NodePlanisphere({ locations, selectedCountry, onHover }: NodePlanisphereProps) {
  const worldDots = useWorldLandDots();
  const [hoveredNode, setHoveredNode] = useState<NodeLocation | null>(null);

  function hover(location: NodeLocation | null) {
    setHoveredNode(location);
    onHover(location);
  }

  return <div className="relative" data-node-planisphere="true">
    <svg viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} className="relative w-full h-auto"
      style={{ maxHeight: '520px' }} onMouseLeave={() => hover(null)}
      aria-label="World map of observed Zcash node IPs grouped by approximate geographic location">
      {worldDots.map((dot, i) => <circle key={`wd-${i}`} cx={dot.x} cy={dot.y}
        r={DOT_RADIUS} fill="var(--color-map-dot)" />)}
      {[...locations].sort((a, b) => b.nodeCount - a.nodeCount).map((node, i) => {
        const pos = project(node.lat, node.lon);
        const hovered = hoveredNode === node;
        const dimmed = selectedCountry != null && selectedCountry !== node.countryCode;
        const color = TIERS.find(tier => node.nodeCount >= tier.minimum)?.color ?? TIERS[3].color;
        const radius = Math.max(10, Math.min(22, 8 + Math.sqrt(node.nodeCount) * 3.5));
        return <g key={`nc-${i}`} className="cursor-pointer focus-visible:outline-none" tabIndex={0}
          role="img" aria-label={`${node.country}: ${node.nodeCount} observed IP${node.nodeCount === 1 ? '' : 's'} in an approximate geographic group`}
          onMouseEnter={() => hover(node)} onMouseLeave={() => hover(null)}
          onFocus={() => hover(node)} onBlur={() => hover(null)} onClick={() => hover(node)}
          style={{ opacity: dimmed ? 0.15 : 1, transition: 'opacity 150ms ease' }}>
          <circle cx={pos.x} cy={pos.y} r={hovered ? radius + 2 : radius}
            fill={color} opacity={hovered ? 1 : 0.85}
            stroke={hovered ? '#ffffff' : 'rgba(255,255,255,0.15)'} strokeWidth={hovered ? 2 : 0.5}
            style={{ filter: !dimmed && node.nodeCount >= 10 ? 'drop-shadow(0 0 4px #F8BC21)' : undefined }} />
          <text x={pos.x} y={pos.y + 0.5} textAnchor="middle" dominantBaseline="central"
            fill="#08090F" fontSize={12} fontWeight="600" fontFamily="var(--font-geist-mono), monospace"
            className="pointer-events-none select-none">{node.nodeCount}</text>
        </g>;
      })}
    </svg>
    <ChartWatermark size="map" />
    <div className="absolute bottom-3 left-3 flex gap-3 rounded-md border border-cipher-border bg-cipher-surface-solid/90 backdrop-blur-sm px-3 py-2.5 text-caption font-mono text-muted pointer-events-none"
      aria-label="Observed IPs per geographic group">
      {TIERS.map(tier => <span key={tier.label} className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tier.color }} />{tier.label}
      </span>)}
    </div>
  </div>;
}
