'use client';
import { LoadingRegion, Skeleton } from '@/components/ui/Skeleton';

import { useId, useState, useMemo, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { NodeGlobe } from '@/components/network/NodeGlobe';
import { NodePlanisphere } from '@/components/network/NodePlanisphere';
import { clientLabel } from '@/lib/network-colors';
import { useApiQuery } from '@/hooks/useApiQuery';
import { clusterNodeLocations, type NodeLocation } from '@/lib/node-map-locations';
export type { NodeLocation } from '@/lib/node-map-locations';

// ==========================================================================
// TYPES
// ==========================================================================

export interface NodeStats {
  censusVersion?: number;
  chainQualifiedCrawlerNodes?: number;
  localPeerOnlyNodes?: number;
  activeNodes: number;
  totalNodes: number;
  countries: number;
  cities: number;
  avgPingMs: number | null;
  torNodes: number | null;
  torClassificationAvailable?: boolean;
  torClassificationCheckedAt?: string | null;
  lastUpdated: string | null;
}

interface NodeTrends {
  change24h: number | null;
  change7d: number | null;
  change30d: number | null;
}

interface TopCountry {
  country: string;
  countryCode: string;
  nodeCount: number;
}

export interface NodeLocationsResponse {
  success: boolean;
  locations: NodeLocation[];
  timestamp: number;
}

export interface NodeStatsResponse {
  success: boolean;
  stats: NodeStats;
  trends?: NodeTrends;
  topCountries?: TopCountry[];
  timestamp: number;
}

interface NodeMapProps {
  initialFetchedAt?: number;
  initialLocations?: NodeLocationsResponse | null;
  initialStats?: NodeStatsResponse | null;
}

// ==========================================================================
// CONSTANTS
// ==========================================================================

// Color tiers based on node count (cipher-yellow intensity scale)
const NODE_TIERS = {
  high: { fill: '#F8BC21' },      // cipher-yellow (full)
  medium: { fill: '#D49A20' },    // mid yellow
  low: { fill: '#A07818' },       // deep yellow
  single: { fill: '#7A6030' },   // muted yellow
};
const EMPTY_LOCATIONS: NodeLocation[] = [];
const EMPTY_COUNTRIES: TopCountry[] = [];

function getNodeTier(count: number) {
  if (count >= 10) return NODE_TIERS.high;
  if (count >= 5) return NODE_TIERS.medium;
  if (count >= 2) return NODE_TIERS.low;
  return NODE_TIERS.single;
}

// ==========================================================================
// HELPERS
// ==========================================================================

function getFlagEmoji(countryCode: string): string {
  if (!countryCode || countryCode.length !== 2) return '';
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map((char) => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

// ==========================================================================
// COMPONENT
// ==========================================================================

export function NodeMap({ initialLocations, initialStats, initialFetchedAt }: NodeMapProps) {
  const locationsQuery = useApiQuery<NodeLocationsResponse>(
    '/v1/network/nodes',
    undefined,
    { refreshInterval: 300_000, initialFetchedAt, initialData: initialLocations ?? undefined },
  );
  const statsQuery = useApiQuery<NodeStatsResponse>(
    '/v1/network/nodes/stats',
    undefined,
    { refreshInterval: 300_000, initialFetchedAt, initialData: initialStats ?? undefined },
  );
  const locations = locationsQuery.data?.locations ?? EMPTY_LOCATIONS;
  const stats = statsQuery.data?.stats ?? null;
  const torClassificationAvailable = stats != null && stats.torNodes != null &&
    ((stats.censusVersion ?? 0) >= 3 ? stats.torClassificationAvailable === true : stats.torClassificationAvailable !== false);
  const trends = statsQuery.data?.trends ?? null;
  const topCountries = statsQuery.data?.topCountries ?? EMPTY_COUNTRIES;
  const loading = locationsQuery.loading || statsQuery.loading;
  const error = locationsQuery.error || statsQuery.error;
  const [hoveredNode, setHoveredNode] = useState<NodeLocation | null>(null);
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
  const [view, setView] = useState<'globe' | 'map'>('globe');
  const viewId = useId();

  function changeView(next: 'globe' | 'map') {
    setHoveredNode(null);
    setView(next);
  }

  function handleViewKey(event: KeyboardEvent<HTMLButtonElement>) {
    let next: 'globe' | 'map';
    if (event.key === 'Home') next = 'globe';
    else if (event.key === 'End') next = 'map';
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = view === 'globe' ? 'map' : 'globe';
    else return;
    event.preventDefault();
    changeView(next);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-node-view="${next}"]`)?.focus();
  }

  // Cluster nearby nodes
  const clusteredNodes = useMemo(() => clusterNodeLocations(locations), [locations]);

  // Count nodes for selected country (for the header display)
  const selectedCountryData = useMemo(() => {
    if (!selectedCountry) return null;
    const country = topCountries.find(c => c.countryCode === selectedCountry);
    return country || null;
  }, [selectedCountry, topCountries]);

  // ==========================================================================
  // RENDER
  // ==========================================================================

  if (loading && locations.length === 0) {
    return <LoadingRegion label="Loading node map" className="card p-0 overflow-hidden">
      <div className="px-4 sm:px-6 py-4 border-b border-cipher-border"><Skeleton className="h-6 w-48 mb-2" /><Skeleton className="h-4 w-80" /></div>
      <div className="relative w-full h-[440px]"><Skeleton className="absolute left-1/2 top-1/2 -translate-x-1/2 w-32 h-4" /></div>
      <div className="px-5 py-4 border-t border-cipher-border"><Skeleton className="h-4 w-64" /></div>
    </LoadingRegion>;
  }

  if (error && locations.length === 0) {
    return (
      <div className="bg-cipher-surface border border-cipher-border rounded-xl p-6">
        <div className="text-center py-12">
          <p className="text-secondary mb-2">Node map unavailable</p>
          <p className="text-xs text-muted font-mono">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="bg-cipher-surface border border-cipher-border rounded-xl overflow-hidden"
      data-node-map-ready={locations.length > 0 ? 'true' : 'false'}
    >
      {/* Header */}
      <div className="px-4 sm:px-6 py-4 border-b border-cipher-border">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl bg-brand-gold/10 flex items-center justify-center flex-shrink-0">
              <svg className="w-4 h-4 sm:w-5 sm:h-5 text-cipher-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-semibold text-primary">Network Node Map</h2>
              <p className="text-caption sm:text-xs text-muted">Observed active IPs · discovery coverage can change</p>
            </div>
          </div>

          {stats && (
            <div className="flex items-center gap-5 sm:gap-6">
              <div className="text-center">
                <div className="flex items-baseline justify-center gap-1">
                  <span className="font-semibold text-primary font-mono text-lg sm:text-xl">{stats.activeNodes}</span>

                </div>
                <div className="text-caption text-muted uppercase tracking-wider">Observed IPs</div>
              </div>
              <div className="text-center">
                <div className="font-semibold text-primary font-mono text-lg sm:text-xl">{stats.countries}</div>
                <div className="text-caption text-muted uppercase tracking-wider">Countries</div>
              </div>
              <div className="text-center">
                <div className="font-semibold text-cipher-purple font-mono text-lg sm:text-xl">{torClassificationAvailable ? stats.torNodes : '—'}</div>
                <div className="text-caption text-muted uppercase tracking-wider" title="Known Tor exit IPs and hidden-service classifications, not all Tor users">Tor classified</div>
                {!torClassificationAvailable && <div className="text-caption text-muted mt-1">Tor classification unavailable</div>}
              </div>
            </div>
          )}
        </div>
      </div>

      {stats?.chainQualifiedCrawlerNodes != null && stats.localPeerOnlyNodes != null && <p className="px-4 sm:px-6 py-3 text-caption text-muted">{stats.chainQualifiedCrawlerNodes} crawler-verified IPs · {stats.localPeerOnlyNodes} additional local-peer IPs. Local peers are connections reported by this explorer’s node.</p>}
      {error && <p role="status" className="px-4 sm:px-6 py-3 border-t border-cipher-border text-caption text-warning">Refresh failed. Previously received observations remain visible and may be stale.</p>}

      {/* Mount only the active view so the globe stops drawing when hidden. */}
      <div className="relative overflow-hidden bg-cipher-bg">
        <div role="tablist" aria-label="Node map view"
          className="absolute top-3 right-3 z-10 inline-flex rounded-md border border-cipher-border bg-cipher-surface-solid/90 backdrop-blur-sm p-1">
          {(['globe', 'map'] as const).map(option => <button key={option} type="button" role="tab"
            id={`${viewId}-${option}-tab`} aria-controls={`${viewId}-${option}-panel`}
            aria-selected={view === option} tabIndex={view === option ? 0 : -1} data-node-view={option}
            onClick={() => changeView(option)} onKeyDown={handleViewKey}
            className={`h-9 rounded-sm px-3 text-caption font-mono transition-colors focus-visible:outline-2 focus-visible:outline-cipher-gold ${view === option ? 'bg-brand-gold/10 text-cipher-gold' : 'text-muted hover:text-primary hover:bg-cipher-hover'}`}>
            {option === 'globe' ? 'Globe' : 'Map'}
          </button>)}
        </div>
        {/* Active filter indicator */}
        {selectedCountryData && (
          <button
            onClick={() => setSelectedCountry(null)}
            className="absolute top-3 left-3 z-10 flex items-center gap-2 backdrop-blur-sm border border-cipher-gold/30 rounded-lg px-3 py-1.5 text-xs font-mono transition hover:border-cipher-gold/60 bg-cipher-surface-solid"
          >
            <span>{getFlagEmoji(selectedCountryData.countryCode)}</span>
            <span className="text-cipher-gold font-semibold">{selectedCountryData.country}</span>
            <span className="text-muted">({selectedCountryData.nodeCount})</span>
            <span className="text-muted hover:text-primary ml-1">✕</span>
          </button>
        )}

        <div role="tabpanel" id={`${viewId}-globe-panel`} aria-labelledby={`${viewId}-globe-tab`} hidden={view !== 'globe'}>
          {view === 'globe' && <NodeGlobe
            locations={clusteredNodes}
            selectedCountry={selectedCountry}
            onHover={setHoveredNode}
          />}
        </div>
        <div role="tabpanel" id={`${viewId}-map-panel`} aria-labelledby={`${viewId}-map-tab`} hidden={view !== 'map'}>
          {view === 'map' && <NodePlanisphere
            locations={clusteredNodes}
            selectedCountry={selectedCountry}
            onHover={setHoveredNode}
          />}
        </div>

        {/* A marker is a geographic group, not the country total. */}
        {hoveredNode && (
          <div className="absolute top-3 left-3 backdrop-blur-sm border border-cipher-gold/20 rounded-lg px-4 py-3 shadow-2xl z-20 pointer-events-none bg-cipher-surface-solid">
            <div className="flex items-center gap-2">
              <span className="text-lg">{getFlagEmoji(hoveredNode.countryCode)}</span>
              <span className="font-semibold text-primary text-sm">{hoveredNode.country}</span>
            </div>
            <div className="flex items-center gap-3 text-xs mt-1.5">
              <span className="font-mono font-semibold" style={{ color: getNodeTier(hoveredNode.nodeCount).fill }}>
                {hoveredNode.nodeCount} observed IP{hoveredNode.nodeCount !== 1 ? 's' : ''}
              </span>
              {hoveredNode.avgPingMs != null && hoveredNode.avgPingMs > 0 && (
                <span className="text-muted font-mono">{hoveredNode.avgPingMs.toFixed(0)}ms</span>
              )}
            </div>
            <p className="text-caption text-muted mt-1">Geographic group · approximate location</p>
            {(hoveredNode.topClient || hoveredNode.topIsp) && (
              <div className="flex items-center gap-2 text-caption font-mono text-muted mt-1">
                {hoveredNode.topClient && (
                  <span>Mostly {clientLabel(hoveredNode.topClient)}</span>
                )}
                {hoveredNode.topClient && hoveredNode.topIsp && hoveredNode.topIsp !== 'Unresolved' && (
                  <span className="text-muted">&middot;</span>
                )}
                {hoveredNode.topIsp && hoveredNode.topIsp !== 'Unresolved' && (
                  <span className="truncate max-w-[160px]">{hoveredNode.topIsp}</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* CTA — full client breakdown, topology graph & health scoring live on /network/nodes.
          One muted sentence, one hover state — this card already has its own color
          language (tier dots, trend deltas); the link shouldn't add another. */}
      <Link
        href="/network/nodes"
        className="flex items-center justify-between gap-2 border-t border-cipher-border px-4 py-3 sm:px-6 text-xs font-mono text-muted hover:text-primary transition-colors group"
      >
        <span>Client breakdown, network topology &amp; health scoring</span>
        <svg
          className="w-3.5 h-3.5 flex-shrink-0 group-hover:translate-x-0.5 transition-transform"
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </Link>

      {/* Trends */}
      {trends && (
        <div className="px-4 sm:px-6 py-3 border-t border-cipher-border">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-caption text-muted uppercase tracking-wider font-mono">Observed count change</span>
            {[
              { label: '24h', value: trends.change24h },
              { label: '7d', value: trends.change7d },
              { label: '30d', value: trends.change30d },
            ].map(({ label, value }) => (
              value !== null && value !== undefined ? (
                <div key={label} className="flex items-center gap-1">
                  <span className="text-caption text-muted font-mono">{label}</span>
                  <span className="text-xs font-mono text-secondary">
                    {value > 0 ? '+' : ''}{value}%
                  </span>
                </div>
              ) : (stats?.censusVersion ?? 0) >= 3 ? (
                <span key={label} className="text-caption text-muted font-mono">{label} unavailable</span>
              ) : null
            ))}
          </div>
          {(stats?.censusVersion ?? 0) >= 3 && Object.values(trends).some(value => value == null) && <p className="text-caption text-muted mt-2">Changes require a comparable observation after chain verification was introduced.</p>}
        </div>
      )}

      {/* Top Countries */}
      {topCountries.length > 0 && (
        <div className="px-4 sm:px-6 py-4 border-t border-cipher-border">
          <div className="flex flex-wrap gap-2 items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-secondary">Top Countries</h3>
            {stats?.lastUpdated && (
              <span className="text-caption text-muted font-mono">
                Last observed: {new Date(stats.lastUpdated).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 sm:gap-2">
            {topCountries.slice(0, 10).map((country) => {
              const isActive = selectedCountry === country.countryCode;
              return (
                <button
                  key={country.countryCode}
                  onClick={() => setSelectedCountry(isActive ? null : country.countryCode)}
                  className={`flex items-center gap-1.5 sm:gap-2 rounded-lg px-2 sm:px-3 py-1 sm:py-1.5 transition ${
                    isActive
                      ? 'bg-brand-gold/10 border border-cipher-gold/30 ring-1 ring-cipher-gold/20'
                      : 'bg-cipher-bg/50 border border-transparent hover:bg-cipher-bg hover:border-cipher-border'
                  }`}
                >
                  <span className="text-sm sm:text-base">{getFlagEmoji(country.countryCode)}</span>
                  <span className={`text-caption sm:text-xs ${isActive ? 'text-primary font-semibold' : 'text-secondary'}`}>{country.country}</span>
                  <span className="text-caption sm:text-xs font-mono font-semibold" style={{ color: getNodeTier(country.nodeCount).fill }}>
                    {country.nodeCount}
                  </span>
                </button>
              );
            })}
            {(() => {
              const top10Sum = topCountries.slice(0, 10).reduce((s, c) => s + c.nodeCount, 0);
              const othersCount = (stats?.activeNodes || 0) - top10Sum;
              return othersCount > 0 ? (
                <span className="flex items-center gap-1.5 rounded-lg px-2 sm:px-3 py-1 sm:py-1.5 bg-cipher-bg/50 border border-transparent">
                  <span className="text-caption sm:text-xs text-muted">Other / unknown</span>
                  <span className="text-caption sm:text-xs font-mono font-semibold text-muted">{othersCount}</span>
                </span>
              ) : null;
            })()}
          </div>
          <p className="text-caption text-muted mt-3">Map markers include located IPs only. Map and totals can reflect different observation times.</p>
        </div>
      )}
    </div>
  );
}

export default NodeMap;
