'use client';
import { VisualizationSkeleton } from '@/components/ui/Skeleton';

import { lazy, Suspense, useRef, useState } from 'react';
import { Tabs } from '@/components/ui/Tabs';
import { NodeGeoLayerMap } from './NodeGeoLayerMap';

const TopologyGraph = lazy(() =>
  import('./TopologyGraph').then((m) => ({ default: m.TopologyGraph }))
);

type MapTab = 'topology' | 'client' | 'infra';

const TABS: { id: MapTab; label: string }[] = [
  { id: 'topology', label: 'Topology' },
  { id: 'client', label: 'Geography · clients' },
  { id: 'infra', label: 'Geography · hosting' },
];

const TAB_DESCRIPTIONS: Record<MapTab, string> = {
  topology: 'Observed active nodes and advertised addresses. Links show gossip relationships, not confirmed remote connections; positions are topological, not geographic.',
  client: 'World map colored by the dominant client implementation observed in each region.',
  infra: 'World map colored by the dominant hosting provider (ISP/ASN) observed in each region.',
};

/**
 * Single "Node Map" surface for the /network/nodes deep-dive: one component,
 * three lenses onto the same observed network, instead of stacking separate
 * hero visualizations. Non-active lenses aren't mounted, so the 3D WebGL
 * scene only loads when actually selected.
 */
export function NodeMapExplorer() {
  const [tab, setTab] = useState<MapTab>('client');
  const topologyMounted = useRef(false);
  if (tab === 'topology') topologyMounted.current = true;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4 mb-4">
        <h2 className="font-mono text-sm font-semibold text-primary">Gossip &amp; geography</h2>
        <Tabs tabs={TABS} active={tab} onChange={setTab} className="border-b-0" />
      </div>
      <p className="text-caption text-muted mb-4">{TAB_DESCRIPTIONS[tab]}</p>

      {/* Keep topology mounted (hidden) once loaded so the WebGL scene and
          computed force layout survive tab switches — avoids a full refetch +
          a new force simulation every time the user switches back. */}
      {topologyMounted.current && (
        <div style={{ display: tab === 'topology' ? 'block' : 'none' }}>
          <Suspense fallback={
            <VisualizationSkeleton className="h-[360px] sm:h-[500px]" />
          }>
            <TopologyGraph active={tab === 'topology'} />
          </Suspense>
        </div>
      )}

      {tab === 'client' && <NodeGeoLayerMap mode="client" />}
      {tab === 'infra' && <NodeGeoLayerMap mode="infra" />}
    </div>
  );
}
