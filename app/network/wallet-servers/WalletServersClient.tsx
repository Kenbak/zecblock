'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApiQuery } from '@/hooks/useApiQuery';
import { indexComparisonLabel, walletServerStatus } from '@/lib/wallet-servers';
import type { WalletServerData, WalletServerEndpoint, WalletServerObservation, WalletServerOperator, WalletServerStatus } from '@/lib/wallet-servers';
import { DOT_RADIUS, MAP_WIDTH, project, useWorldLandDots } from '@/lib/world-dot-map';

const STATES: Record<WalletServerStatus, { label: string; color: string }> = {
  serving: { label: 'Answering', color: 'text-cipher-green' },
  lagging: { label: 'Behind the tip', color: 'text-cipher-yellow' },
  tip_differs: { label: 'Different tip block', color: 'text-cipher-yellow' },
  wrong_network: { label: 'Unexpected network', color: 'text-danger' },
  unreachable: { label: 'No answer', color: 'text-danger' },
  stale: { label: 'Check expired', color: 'text-muted' },
  not_checked: { label: 'Not checked yet', color: 'text-muted' },
};
const ERRORS: Record<string, string> = {
  timeout: 'No reply within 5 seconds',
  connection_failed: 'Connection failed',
  invalid_response: 'Unreadable reply',
};
const SCOPES: Record<WalletServerEndpoint['scope'], string> = { global: 'Global', area: 'Area', region: 'Region' };
// The band of the world map that holds every inhabited region: no polar rows.
const MAP_TOP = 40;
const MAP_BAND = 380;

function timestamp(value: string | null | undefined) {
  const time = value ? new Date(value) : null;
  return time && Number.isFinite(time.getTime()) ? `${time.toISOString().replace('T', ' ').slice(0, 19)} UTC` : 'Not available';
}
function software(latest: WalletServerObservation) {
  return [latest.vendor ? `${latest.vendor}${latest.version ? ` ${latest.version}` : ''}` : null, latest.nodeSubversion].filter(Boolean).join(' on ');
}
// Expired and failed checks keep their status but never show old numbers as current.
function currentAnswer(endpoint: WalletServerEndpoint, status: WalletServerStatus) {
  return endpoint.latest && endpoint.latest.reachable && !['stale', 'not_checked'].includes(status) ? endpoint.latest : null;
}

/** The operator's own mark, or a neutral initial when it publishes none. */
function OperatorMark({ operator, size }: { operator: WalletServerOperator; size: number }) {
  return operator.logo?.startsWith('/brands/wallet-servers/')
    ? <Image src={operator.logo} alt="" width={size} height={size} unoptimized className="shrink-0 rounded-md" style={{ width: size, height: size }} />
    : <span aria-hidden="true" className="shrink-0 grid place-items-center rounded-md border border-cipher-border font-mono text-muted uppercase" style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}>{operator.name.slice(0, 1)}</span>;
}

function RegionMap({ data, now }: { data: WalletServerData; now: number }) {
  const worldDots = useWorldLandDots();
  const markers = data.operators.flatMap((operator) => operator.endpoints.flatMap((endpoint) => endpoint.location
    ? [{ endpoint, operator, ...project(endpoint.location.lat, endpoint.location.lon), status: walletServerStatus(endpoint.latest, data, now) }] : []));
  if (!markers.length) return null;
  return <section aria-labelledby="server-map-heading" id="server-map" className="card card-static p-0! overflow-hidden mb-6 scroll-mt-36">
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 p-5 sm:p-6">
      <div>
        <h2 id="server-map-heading" className="font-mono text-base text-primary">Where the servers are</h2>
        <ul className="flex flex-wrap gap-x-6 gap-y-2 mt-3 text-caption text-secondary" aria-label="Operators on the map">
          {data.operators.filter((operator) => markers.some((marker) => marker.operator === operator)).map((operator) => {
            const areas = markers.some((marker) => marker.operator === operator && marker.endpoint.location?.approximate);
            return <li key={operator.id} className="flex items-center gap-2">
              <OperatorMark operator={operator} size={20} />
              <a href={`#${operator.id}`} className="hover:text-primary">{operator.name}</a>
              <span className="text-muted">{areas ? '○ areas' : '● locations'}</span>
            </li>;
          })}
        </ul>
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-caption text-muted" aria-label="Status colours">
        {(['serving', 'lagging', 'unreachable', 'stale'] as const).map((status) => <li key={status} className="flex items-center gap-2">
          <span aria-hidden="true" className={`w-2 h-2 rounded-full bg-current ${STATES[status].color}`} />{status === 'lagging' ? 'Behind or different' : STATES[status].label}
        </li>)}
      </ul>
    </div>
    <svg viewBox={`0 ${MAP_TOP} ${MAP_WIDTH} ${MAP_BAND}`} className="block w-full h-auto" role="group" aria-label="World map of wallet server locations and areas, coloured by the latest check">
      {worldDots.filter((dot) => dot.y >= MAP_TOP && dot.y <= MAP_TOP + MAP_BAND).map((dot, i) => <circle key={i} cx={dot.x} cy={dot.y} r={DOT_RADIUS} fill="var(--color-map-dot)" />)}
      {markers.map(({ endpoint, operator, x, y, status }) => {
        const answer = currentAnswer(endpoint, status);
        // A label reads away from a neighbour to its east: London clears Frankfurt, the US west coast clears Virginia.
        const crowded = markers.some((other) => other.endpoint !== endpoint && other.x > x && other.x - x < 160 && Math.abs(other.y - y) < 24);
        const area = endpoint.location?.approximate === true;
        const summary = `${endpoint.label}${area ? ' area' : ''}, ${operator.name}: ${STATES[status].label}${answer?.height != null ? `, height ${answer.height.toLocaleString('en-US')}` : ''}`;
        return <a key={endpoint.id} href={`#${endpoint.id}`} aria-label={summary} className={`${STATES[status].color} focus-visible:outline-none group`}>
          <title>{summary}</title>
          <circle cx={x} cy={y} r={15} fill="currentColor" opacity={0.18} className={status === 'serving' ? 'motion-safe:animate-pulse' : undefined} />
          {area
            // A ring: this name serves an area, and its position is only the middle of that area.
            ? <circle cx={x} cy={y} r={7} fill="none" stroke="currentColor" strokeWidth={3} className="group-hover:stroke-[5] group-focus-visible:stroke-[5]" />
            : <circle cx={x} cy={y} r={6} fill="currentColor" stroke="var(--color-text-primary)" strokeWidth={1.5} className="group-hover:stroke-[3] group-focus-visible:stroke-[3]" />}
          <text x={crowded ? x - 14 : x + 14} y={y} textAnchor={crowded ? 'end' : 'start'} dominantBaseline="central" fontSize={13}
            fontFamily="var(--font-geist-mono), monospace" fill="var(--color-text-secondary)" className="hidden md:block select-none">{area ? `${operator.name} · ${endpoint.label}` : endpoint.label}</text>
        </a>;
      })}
    </svg>
    <p className="text-caption text-muted p-5 sm:p-6">Dots are fixed locations published by the operator. Rings are area names from an operator that publishes no locations, drawn near the middle of the area they serve. Global names route each caller to a nearby machine. Every name is listed below.</p>
  </section>;
}

function EndpointTile({ endpoint, data, now, showSoftware }: { endpoint: WalletServerEndpoint; data: WalletServerData; now: number; showSoftware: boolean }) {
  const latest = endpoint.latest;
  const status = walletServerStatus(latest, data, now);
  const state = STATES[status];
  const answer = currentAnswer(endpoint, status);
  return <li id={endpoint.id} className="rounded-lg border border-cipher-border p-4 scroll-mt-36 target:border-cipher-gold">
    <div className="flex items-center justify-between gap-3">
      <span className={`flex items-center gap-2 text-caption ${state.color}`}><span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />{state.label}</span>
      <span className="type-label font-mono uppercase text-muted">{SCOPES[endpoint.scope]}</span>
    </div>
    <h3 className="font-mono text-sm text-primary mt-3">{endpoint.label}</h3>
    <p className="font-mono text-caption text-muted break-all">{`${endpoint.host}:${endpoint.port}`}</p>
    {answer?.height != null ? <dl className="mt-4 space-y-1.5 text-caption">
      <div className="flex justify-between gap-3"><dt className="text-muted">Height</dt><dd className="font-mono tabular-nums">
        {answer.chain === 'canonical'
          ? <Link href={`/block/${answer.height}`} prefetch={false} className="text-primary hover:underline">{answer.height.toLocaleString('en-US')}</Link>
          : <span className="text-primary">{answer.height.toLocaleString('en-US')}</span>}
      </dd></div>
      <div className="flex justify-between gap-3"><dt className="text-muted">Our index</dt><dd className={`text-right ${answer.chain === 'different' ? 'text-cipher-yellow' : 'text-secondary'}`}>{indexComparisonLabel(answer)}</dd></div>
      {answer.responseMs != null ? <div className="flex justify-between gap-3"><dt className="text-muted">From our server</dt><dd className="font-mono tabular-nums text-secondary">{`${answer.responseMs.toLocaleString('en-US')} ms`}</dd></div> : null}
      {showSoftware && software(answer) ? <div className="flex justify-between gap-3"><dt className="text-muted">Software</dt><dd className="text-right text-secondary">{software(answer)}</dd></div> : null}
    </dl> : <p className="mt-4 text-caption text-muted">{status === 'unreachable' && latest?.error ? ERRORS[latest.error] ?? 'Check failed' : 'No current answer to show.'}</p>}
  </li>;
}

function OperatorSection({ operator, data, now }: { operator: WalletServerOperator; data: WalletServerData; now: number }) {
  const statuses = operator.endpoints.map((endpoint) => walletServerStatus(endpoint.latest, data, now));
  const answering = statuses.filter((status) => status === 'serving').length;
  const reported = new Map<string, number>();
  operator.endpoints.forEach((endpoint, index) => {
    const answer = currentAnswer(endpoint, statuses[index]);
    const name = answer ? software(answer) : '';
    if (name) reported.set(name, (reported.get(name) ?? 0) + 1);
  });
  // One line for the operator when every name reports the same software; per name when a rollout is mixed.
  const mixed = reported.size > 1;
  return <section id={operator.id} aria-labelledby={`${operator.id}-heading`} className="card card-static p-0! overflow-hidden scroll-mt-36">
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 p-5 sm:p-6 border-b border-cipher-border">
      <div className="flex items-start gap-3">
        <OperatorMark operator={operator} size={36} />
        <div>
        <h2 id={`${operator.id}-heading`} className="font-mono text-base text-primary">{operator.name}</h2>
        <p className="text-caption text-muted mt-1">Operated by <a href={operator.operatorUrl} target="_blank" rel="noopener noreferrer" className="text-secondary hover:text-primary underline underline-offset-4">{operator.operator}</a>
          {reported.size === 1 ? <><span className="mx-2" aria-hidden="true">·</span>{`Reports ${[...reported.keys()][0]}`}</> : null}</p>
        </div>
      </div>
      <p className="text-caption text-muted">
        <span className="font-mono text-secondary tabular-nums">{data.available ? `${answering} of ${operator.endpoints.length}` : `${operator.endpoints.length}`}</span> {data.available ? 'names answering' : 'registered names'}
        <span className="mx-2" aria-hidden="true">·</span>
        <a href={operator.statusUrl} target="_blank" rel="noopener noreferrer" className="text-secondary hover:text-primary underline underline-offset-4">Operator status page ↗</a>
      </p>
    </div>
    <ul className="grid gap-3 p-5 sm:p-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {operator.endpoints.map((endpoint) => <EndpointTile key={endpoint.id} endpoint={endpoint} data={data} now={now} showSoftware={mixed} />)}
    </ul>
  </section>;
}

export default function WalletServersClient({ initialData, initialNow, network }: { initialData: WalletServerData | null; initialNow: number; network: string }) {
  const [now, setNow] = useState(initialNow);
  const query = useApiQuery<WalletServerData>('/v1/network/wallet-servers', undefined, {
    initialData: initialData ?? undefined, initialFetchedAt: initialNow, refreshInterval: 60_000,
  });
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 15_000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, []);
  const data = query.data?.network === network && Array.isArray(query.data.operators) ? query.data : null;
  const endpoints = data?.operators.flatMap((operator) => operator.endpoints) ?? [];
  const statuses = data ? endpoints.map((endpoint) => walletServerStatus(endpoint.latest, data, now)) : [];
  const live = Boolean(data?.available) && statuses.some((status) => !['stale', 'not_checked'].includes(status));
  const answering = statuses.filter((status) => status === 'serving').length;
  const matching = data ? endpoints.filter((endpoint, index) => !['stale', 'not_checked', 'unreachable'].includes(statuses[index]) && endpoint.latest?.chain === 'canonical').length : 0;
  const summary = [
    { label: 'Server names checked', value: data ? endpoints.length.toLocaleString('en-US') : '—', note: data ? `${data.operators.length} ${data.operators.length === 1 ? 'operator' : 'operators'}` : 'Registry unavailable' },
    { label: 'Answering now', value: live ? answering.toLocaleString('en-US') : '—', note: data ? `Fewer than ${data.lagThresholdBlocks} blocks behind our index` : 'Close to our index height' },
    { label: 'Tip matches our index', value: live ? matching.toLocaleString('en-US') : '—', note: live && data?.reference.height != null ? `Index height ${data.reference.height.toLocaleString('en-US')}` : 'Same block at the same height' },
  ];
  return <>
    <dl className="grid sm:grid-cols-3 border border-cipher-border rounded-lg divide-y sm:divide-y-0 sm:divide-x divide-cipher-border mb-4">
      {summary.map((item) => <div key={item.label} className="grid grid-cols-[1fr_auto] items-center gap-x-3 sm:block p-5 sm:p-6">
        <dt className="type-label text-muted sm:mb-3">{item.label}</dt><dd className="type-metric font-mono text-primary tabular-nums">{item.value}</dd><p className="col-span-2 text-caption text-muted mt-2">{item.note}</p>
      </div>)}
    </dl>
    <p className="text-caption text-muted mb-8">{live ? `Last checked ${timestamp(data?.checkedAt)} from one ZecBlock server. Checks repeat about once a minute while this page is open.` : 'Checks run from one ZecBlock server, about once a minute while this page is open.'}</p>
    {!live || query.error ? <p role="status" className="mb-5 text-sm text-cipher-yellow">{live ? 'Could not refresh the checks. Results shown expire after 5 minutes.' : 'Checks are currently unavailable. No server is being reported as answering.'}</p> : null}
    {data ? <RegionMap data={data} now={now} /> : null}
    <div id="server-checks" className="space-y-6 scroll-mt-36">
      {data?.operators.length ? data.operators.map((operator) => <OperatorSection key={operator.id} operator={operator} data={data} now={now} />)
        : <div className="card p-6 text-sm text-muted">{query.loading ? 'Loading the server registry…' : 'The server registry could not be loaded. Please try again shortly.'}</div>}
    </div>
  </>;
}
