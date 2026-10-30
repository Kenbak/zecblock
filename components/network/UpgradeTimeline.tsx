'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useApiQuery } from '@/hooks/useApiQuery';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { UpgradeImpact } from './UpgradeImpact';
import { Nu7ShareCards } from './Nu7ShareCards';
import { buildUpgradeChanges } from '@/lib/upgrade-changes';
import type { AppNetwork } from '@/lib/network';
import { readUpgradeSnapshot, type UpgradeSnapshot } from '@/lib/network-upgrades';
import { buildUpgradeHistory, type UpgradeMilestone } from '@/lib/upgrade-history';
import { buildUpgradeTrackers, type UpgradeTracker } from '@/lib/upgrade-trackers';

const NODE_WIDTH = 136;

function CheckIcon() {
  return <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>;
}

function ClockIcon() {
  return <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <circle cx="12" cy="12" r="9" /><path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 2" />
  </svg>;
}

function ArrowIcon({ external = false }: { external?: boolean }) {
  return <svg aria-hidden="true" className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d={external ? 'M7 17 17 7M7 7h10v10' : 'M5 12h14m-6-6 6 6-6 6'} />
  </svg>;
}
const STATUS: Record<UpgradeTracker['status'], string> = {
  active: 'Activated', scheduled: 'Scheduled', announced: 'Announced', historical: 'Recorded upgrade', unavailable: 'Schedule unavailable',
};

const HEADLINES: Record<string, string> = {
  nu7: '25-second blocks and the Network Sustainability Mechanism.',
  nu63: 'A new shielded pool, with a path out of Orchard.',
  nu62: 'Orchard returns with corrected proof rules.',
};

const TOOL_LABELS: Record<string, string> = {
  '/network#issuance': 'Issuance & halvings',
  '/mining': 'Miner economics',
  '/pools': 'Pool supply & flows',
  '/tools/decode': 'Decode a transaction',
  '/decrypt': 'Read a memo',
  '/ironwood': 'Ironwood migration',
  '/turnstile': 'Follow pool flows',
  '/network/block-speed': 'View block speed',
  '/network#nu7-accounting': 'Explore NSM',
};

function toolKey(href: string) {
  return href.startsWith('/network#') ? href : href.split(/[?#]/)[0];
}

const PREVIEW_TOOLS: Record<string, string[]> = {
  nu7: ['/network/block-speed', '/network#nu7-accounting'],
  nu63: ['/ironwood'], nu62: ['/turnstile'],
  sapling: ['/pools'], nu5: ['/pools'], blossom: ['/network/block-speed'],
};

function UpgradeDetails({ milestone, tracker, remaining, stale, network }: {
  milestone: UpgradeMilestone; tracker?: UpgradeTracker; remaining: number | null; stale: boolean; network: AppNetwork;
}) {
  const date = tracker?.estimatedDate ? new Date(`${tracker.estimatedDate}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null;
  const changes = buildUpgradeChanges(milestone.id, network, milestone.status === 'active');
  const coveredTools = new Set(PREVIEW_TOOLS[milestone.id] ?? []);
  const tools = changes.flatMap(change => change.links).filter(link => {
    const key = toolKey(link.href);
    if (coveredTools.has(key)) return false;
    coveredTools.add(key);
    return true;
  });
  const zipNumber = Number(milestone.sourceUrl.match(/zip-(\d+)$/)?.[1]);
  return <div id="upgrade-timeline-detail" className="mt-8" aria-live="polite">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="type-section text-primary">{milestone.label}{milestone.id === 'nu63' ? ' · Ironwood' : ''}</h2>
          <Badge color={milestone.status === 'active' ? 'green' : 'gold'} variant="subtle"
            icon={milestone.status === 'active' ? <CheckIcon />
              : milestone.status === 'scheduled' ? <ClockIcon /> : undefined}>
            {STATUS[milestone.status]}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-caption text-muted">
          {milestone.height != null && (milestone.status === 'active' || milestone.status === 'historical'
            ? <Link href={`/block/${milestone.height}`} prefetch={false} className="font-mono hover:text-primary">Block #{milestone.height.toLocaleString('en-US')} ↗</Link>
            : <span className="font-mono">Block #{milestone.height.toLocaleString('en-US')}</span>)}
          {date && <span>Estimated {date}</span>}
          {milestone.id === 'nu7' && remaining != null && <span className="font-mono">{remaining > 0 ? `${remaining.toLocaleString('en-US')} blocks remaining` : 'Active on this network'}{stale ? ' · last available observation' : ''}</span>}
        </div>
      </div>
      <a href={milestone.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 py-2 text-caption text-muted underline underline-offset-4 hover:text-primary"
        aria-label={`Read the full ${milestone.label} upgrade specification${zipNumber ? `, ZIP ${zipNumber}` : ''}`}>
        <span>{zipNumber ? `ZIP ${zipNumber}` : 'Specification'}</span>
        <ArrowIcon external />
      </a>
    </div>
    <p className="text-sm text-secondary leading-relaxed mt-3 max-w-3xl">{HEADLINES[milestone.id] ?? milestone.summary}</p>
    <UpgradeImpact upgradeId={milestone.id} network={network} active={milestone.status === 'active'} />
    {milestone.id === 'nu7' && <Nu7ShareCards cards={milestone.status === 'active' ? ['blocks', 'nsm', 'readiness', 'countdown'] : ['countdown', 'blocks', 'readiness']} />}
    <div role="group" aria-label={`${milestone.label} major changes`} className="mt-7">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="text-sm font-medium text-primary">Improvements</h3>
        <span className="text-caption font-mono text-muted">{changes.length} changes</span>
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 mt-4">
        {changes.map(change => <li key={change.id} className="flex items-start gap-3 text-sm text-secondary">
          <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted" />
          <span>{change.title}</span>
        </li>)}
      </ul>
    </div>
    {tools.length > 0 && <div role="group" aria-label="More related tools" className="flex flex-wrap gap-x-5 gap-y-2 mt-6">
      {tools.map(tool => <Link key={toolKey(tool.href)} href={tool.href} className="inline-flex items-center gap-1 py-1 text-caption text-muted underline underline-offset-4 hover:text-primary">
        <span>{TOOL_LABELS[toolKey(tool.href)] ?? tool.label}</span><ArrowIcon />
      </Link>)}
    </div>}
  </div>;
}

/** An ordered upgrade sequence; spacing represents milestones, not elapsed time. */
export function UpgradeTimeline({ network, initialSnapshot }: { network: AppNetwork; initialSnapshot: UpgradeSnapshot | null }) {
  const rail = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState('nu7');
  const { data, error } = useApiQuery<unknown>('/v1/network/stats', {}, { refreshInterval: 15_000 });
  const snapshot = readUpgradeSnapshot(data, network) ?? initialSnapshot;
  const milestones = buildUpgradeHistory(snapshot, network);
  const trackers = buildUpgradeTrackers(snapshot, network);
  const selected = milestones.find(item => item.id === selectedId) ?? milestones.at(-1);
  const selectedIndex = milestones.findIndex(item => item.id === selectedId);
  const lastIndex = milestones.length - 1;
  const currentIndex = snapshot ? milestones.findLastIndex(item => item.status === 'active') : -1;
  const current = milestones[currentIndex];
  const next = milestones[currentIndex + 1];
  const fraction = current?.height != null && next?.height != null && next.status === 'scheduled' && snapshot
    ? Math.min(1, Math.max(0, (snapshot.height - current.height) / (next.height - current.height))) : 0;
  const progress = currentIndex < 0 ? 0 : Math.min(1, (currentIndex + fraction) / Math.max(1, lastIndex));
  const railWidth = milestones.length * NODE_WIDTH;
  const pendingNu7 = milestones.at(-1);
  const remaining = pendingNu7?.height != null && snapshot?.schedule.nu7Height != null ? Math.max(0, pendingNu7.height - snapshot.height) : null;

  function selectUpgrade(id: string) {
    const url = new URL(window.location.href);
    url.hash = id;
    window.history.replaceState(window.history.state, '', url);
    setSelectedId(id);
  }

  useEffect(() => {
    const selectFromHash = () => {
      const id = window.location.hash.slice(1);
      if (buildUpgradeHistory(null, network).some(item => item.id === id)) setSelectedId(id);
    };
    selectFromHash();
    window.addEventListener('hashchange', selectFromHash);
    return () => window.removeEventListener('hashchange', selectFromHash);
  }, [network]);

  useEffect(() => {
    const element = rail.current;
    if (!element || selectedIndex < 0) return;
    const centerSelection = () => { element.scrollLeft = selectedIndex * NODE_WIDTH - (element.clientWidth - NODE_WIDTH) / 2; };
    centerSelection();
    const observer = new ResizeObserver(centerSelection);
    observer.observe(element);
    return () => observer.disconnect();
  }, [selectedIndex]);

  function scrollHistory(direction: number) {
    rail.current?.scrollBy({ left: direction * NODE_WIDTH * 3, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  if (!selected) return null;
  return <section aria-label="Interactive network upgrade timeline">
    <Card className="card-static p-0 overflow-hidden">
    <div className="flex items-center justify-between gap-3 flex-wrap p-4 sm:px-6 sm:pt-5 sm:pb-3">
      <p className="type-label text-muted uppercase">Upgrade timeline</p>
      <div className="flex items-center gap-3 flex-wrap">
      <p className="text-caption font-mono text-muted" aria-live="polite">
        {snapshot ? <>{current && <span className="text-secondary">Current: {current.label}<span className="text-muted"> · </span></span>}<Link href={`/block/${snapshot.height}`} prefetch={false} className="hover:text-primary">#{snapshot.height.toLocaleString('en-US')}</Link>{error ? ' · last available' : ''}</> : 'Node observation unavailable'}
      </p>
      <div className="flex gap-1">
        <button type="button" aria-label="Earlier upgrades" onClick={() => scrollHistory(-1)} className="btn-icon-only h-8 w-8 text-muted hover:text-primary">←</button>
        <button type="button" aria-label="Later upgrades" onClick={() => scrollHistory(1)} className="btn-icon-only h-8 w-8 text-muted hover:text-primary">→</button>
      </div>
      </div>
    </div>
    <div ref={rail} role="region" className="overflow-x-auto overscroll-x-contain no-scrollbar" tabIndex={0} aria-label="Upgrade sequence, scroll horizontally for earlier upgrades">
      <div className="relative h-[116px]" style={{ width: railWidth, minWidth: '100%' }}>
        <div aria-hidden="true" className="absolute top-7 h-px bg-cipher-border" style={{ left: NODE_WIDTH / 2, right: NODE_WIDTH / 2 }}>
          {snapshot && <div className="h-full bg-cipher-gold transition-[width] duration-700 motion-reduce:transition-none" style={{ width: `${progress * 100}%` }} />}
        </div>
        <div className="flex relative z-10">
          {milestones.map(item => <button key={item.id} id={item.id} type="button" aria-pressed={selected.id === item.id} aria-controls="upgrade-timeline-detail"
            onClick={() => selectUpgrade(item.id)}
            className="network-section group flex shrink-0 flex-col items-center px-2 pt-4 pb-4 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cipher-gold"
            style={{ width: NODE_WIDTH }}>
            <span aria-hidden="true" className={`flex h-6 w-6 items-center justify-center rounded-full border bg-cipher-surface-solid transition-colors ${selected.id === item.id ? 'border-cipher-gold ring-4 ring-cipher-gold/10' : 'border-cipher-border group-hover:border-secondary'}`}>
              <span className={`h-2 w-2 rounded-full ${item.status === 'active' ? 'bg-cipher-gold' : selected.id === item.id ? 'border border-cipher-gold' : 'bg-muted'}`} />
            </span>
            <span className={`mt-3 text-sm font-mono font-medium ${selected.id === item.id ? 'text-cipher-gold' : 'text-secondary group-hover:text-primary'}`}>{item.label}</span>
            <span className="text-caption font-mono text-muted mt-1">{item.height != null ? `#${item.height.toLocaleString('en-US')}` : 'Unscheduled'}</span>
          </button>)}
        </div>
      </div>
    </div>
    </Card>
    <UpgradeDetails milestone={selected} tracker={trackers.find(item => item.id === selected.id)} remaining={remaining} stale={Boolean(error)} network={network} />
  </section>;
}
