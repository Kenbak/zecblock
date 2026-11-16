'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import {
  CHAIN_REFS, ZCASH_LOGO, SIM_DEFAULT_SECONDS, SIM_ERAS, SIM_MAX_SECONDS, SIM_MIN_SECONDS, SIM_PRESETS, DEPTH_OPTIONS, DEFAULT_DEPTH, OBSERVED_NU7_ORPHANS,
  clampSeconds, clampDepth, formatDuration, formatShare, shareAtLeast, simulate, type SimResult, type SimZone,
} from '@/lib/block-time-sim';

const ZONE_COPY: Record<SimZone, { label: string; detail: string; className: string }> = {
  measured: { label: 'Measured range', detail: 'Zcash has run at 150s, 75s and 25s; the math matched each one.', className: 'border-cipher-gold/40 text-cipher-gold' },
  extrapolated: { label: 'Beyond measured data', detail: 'Timing math still applies. Orphan risk is an estimate.', className: 'border-cipher-border text-secondary' },
  beyond: { label: 'Far beyond Zcash data', detail: 'Timing math only. Orphan risk is unknown at this speed.', className: 'border-cipher-border text-muted' },
};


const ICON_PATHS = {
  wallet: 'M3 7a2 2 0 0 1 2-2h12v4M3 7v10a2 2 0 0 0 2 2h14V9H5a2 2 0 0 1-2-2Zm13 6h.01',
  check: 'M20 6 9 17l-5-5',
  pause: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm-2-14v8m4-8v8',
  hourglass: 'M6 2h12M6 22h12M7 2c0 5 10 5 10 10S7 17 7 22M17 2c0 5-10 5-10 10s10 5 10 10',
  fork: 'M6 3v6a6 6 0 0 0 6 6m0 0a6 6 0 0 0 6-6V3m-6 12v6',
  cube: 'm12 2 9 5v10l-9 5-9-5V7l9-5Zm0 10 9-5m-9 5L3 7m9 5v10',
  disk: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6m-16 6c0 1.7 3.6 3 8 3s8-1.3 8-3',
} as const;
type IconName = keyof typeof ICON_PATHS;

function Icon({ name, className = 'w-4 h-4' }: { name: IconName; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICON_PATHS[name]} /></svg>;
}

/** Local logo, or the chain's initial when none is bundled. */
function ChainLogo({ name, src }: { name: string; src: string | null }) {
  if (!src) return <span className="inline-flex w-5 h-5 shrink-0 items-center justify-center rounded-full bg-cipher-hover text-[10px] font-mono text-secondary" aria-hidden="true">{name[0]}</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" width={20} height={20} className="w-5 h-5 shrink-0 rounded-full" />;
}

function Metric({ icon, label, value, detail, compare }: { icon: IconName; label: string; value: string; detail?: string; compare?: string }) {
  return <div className="p-4 sm:p-5">
    <div className="flex items-center gap-2 type-label text-muted uppercase"><Icon name={icon} className="w-4 h-4 text-cipher-gold" />{label}</div>
    <div className="type-metric type-metric-compact text-primary mt-2">{value}</div>
    {detail && <div className="text-caption text-secondary mt-1">{detail}</div>}
    {compare && <div className="text-caption text-muted mt-1">{compare}</div>}
  </div>;
}

function orphanText(r: SimResult): { value: string; detail: string } {
  const o = r.orphans;
  if (o.kind === 'measured') return { value: `${(o.rate * 100).toFixed(2)}%`, detail: `Measured by 10 observers · ~${Math.round(r.orphansPerDay!)} a day` };
  if (o.kind === 'estimate') return { value: `~${(o.rate * 100).toFixed(1)}%`, detail: `Estimate · ~${Math.round(r.orphansPerDay!)} a day, if it scales with block rate` };
  if (o.reason === 'unobserved') return { value: 'No comparable data', detail: `Only measured at 25s: ${(OBSERVED_NU7_ORPHANS.orphaned / (OBSERVED_NU7_ORPHANS.canonical + OBSERVED_NU7_ORPHANS.orphaned) * 100).toFixed(2)}%` };
  return { value: 'Unknown', detail: 'No Zcash data this fast' };
}

/** Share of gaps ≥ 2 min against block time: model curve, measured eras, current setting. */
function EvidenceChart({ seconds }: { seconds: number }) {
  const W = 520; const H = 250; const L = 44; const R = 16; const T = 14; const B = 36;
  const x = (s: number) => L + (s - SIM_MIN_SECONDS) / (SIM_MAX_SECONDS - SIM_MIN_SECONDS) * (W - L - R);
  const y = (share: number) => T + (1 - share / 0.5) * (H - T - B);
  const curve = Array.from({ length: 146 }, (_, i) => SIM_MIN_SECONDS + i).map((s, i) => `${i ? 'L' : 'M'}${x(s).toFixed(1)},${y(shareAtLeast(s, 120)).toFixed(1)}`).join('');
  return <figure>
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto max-w-[560px]" role="img" aria-labelledby="evidence-title evidence-desc">
      <title id="evidence-title">Share of block gaps lasting 2 minutes or more</title>
      <desc id="evidence-desc">Random-arrival model curve with measured Zcash eras: {SIM_ERAS.map(e => `${e.targetSeconds}s measured ${(e.shareAtLeast120 * 100).toFixed(1)}%`).join(', ')}.</desc>
      <rect x={x(SIM_MIN_SECONDS)} y={T} width={x(25) - x(SIM_MIN_SECONDS)} height={H - T - B} className="fill-cipher-hover" opacity={0.6} />
      {[0, 0.1, 0.2, 0.3, 0.4, 0.5].map(v => <g key={v}>
        <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="stroke-cipher-border" strokeWidth={1} />
        <text x={L - 8} y={y(v) + 4} textAnchor="end" className="fill-current text-muted" fontSize={12}>{v * 100}%</text>
      </g>)}
      {[5, 25, 50, 75, 100, 125, 150].map(s => <text key={s} x={x(s)} y={H - B + 18} textAnchor="middle" className="fill-current text-muted" fontSize={12}>{s}s</text>)}
      <path d={curve} fill="none" className="stroke-current text-secondary" strokeWidth={2} />
      <line x1={x(seconds)} x2={x(seconds)} y1={T} y2={H - B} className="stroke-cipher-gold" strokeWidth={1.5} strokeDasharray="4 4" />
      <circle cx={x(seconds)} cy={y(shareAtLeast(seconds, 120))} r={5} className="fill-cipher-gold" />
      {SIM_ERAS.map(e => <g key={e.targetSeconds}>
        <circle cx={x(e.meanSeconds)} cy={y(e.shareAtLeast120)} r={6} fill="none" className="stroke-current text-primary" strokeWidth={2} />
        {/* The curve rises to the right: labels sit where it is not, below-right at 25s/75s and left of 150s. */}
        <text x={x(e.meanSeconds) + (e.targetSeconds === 150 ? -12 : 10)} y={y(e.shareAtLeast120) + (e.targetSeconds === 150 ? -10 : e.targetSeconds === 25 ? -12 : 20)} textAnchor={e.targetSeconds === 150 ? 'end' : 'start'} className="fill-current text-primary" fontSize={12}>{e.targetSeconds}s</text>
      </g>)}
    </svg>
    <figcaption className="text-caption text-muted mt-2">Line: random-arrival model. Circles: measured mainnet eras. Gold: your setting. Shaded: faster than any measured era.</figcaption>
  </figure>;
}

function ChainList({ seconds }: { seconds: number }) {
  const rows = [...CHAIN_REFS.map(c => ({ ...c, zcash: false })), { name: 'Zcash', logo: ZCASH_LOGO, blockSeconds: seconds, blockLabel: `${seconds}s`, wait: null, consensus: 'Proof of work', zcash: true }]
    .sort((a, b) => b.blockSeconds - a.blockSeconds);
  const lo = Math.log10(0.1); const hi = Math.log10(600);
  const pct = (s: number) => Math.max(2, (Math.log10(s) - lo) / (hi - lo) * 100);
  return <ul className="space-y-3">
    {rows.map(r => <li key={r.name}>
      <div className="flex justify-between gap-3 text-sm">
        <span className={`flex items-center gap-2 ${r.zcash ? 'text-cipher-gold font-medium' : 'text-primary'}`}><ChainLogo name={r.name} src={r.logo} />{r.name}{r.zcash ? ' · your setting' : ''}<span className="text-caption text-muted font-normal hidden sm:inline">{r.consensus}</span></span>
        <span className="font-mono tabular-nums text-secondary">{r.blockLabel}</span>
      </div>
      <div className="h-1.5 mt-1.5 ml-7 rounded bg-cipher-hover"><div className={`h-1.5 rounded ${r.zcash ? 'bg-cipher-gold' : 'bg-[var(--color-text-muted)]'}`} style={{ width: `${pct(r.blockSeconds)}%` }} /></div>
    </li>)}
  </ul>;
}

function WaitList({ result }: { result: SimResult }) {
  const rows = [
    ...CHAIN_REFS.filter(c => c.wait).map(c => ({ name: c.name, logo: c.logo, seconds: c.wait!.seconds, rule: c.wait!.rule, zcash: false })),
    { name: 'Zcash', logo: ZCASH_LOGO, seconds: result.spendableMean, rule: `${result.depth} confirmations, your choice above`, zcash: true },
  ].sort((a, b) => b.seconds - a.seconds);
  const max = Math.max(...rows.map(r => r.seconds));
  return <ul className="space-y-3">
    {rows.map(r => <li key={r.name}>
      <div className="flex justify-between gap-3 text-sm">
        <span className={`flex items-center gap-2 ${r.zcash ? 'text-cipher-gold font-medium' : 'text-primary'}`}><ChainLogo name={r.name} src={r.logo} />{r.name}{r.zcash ? ` at ${result.seconds}s` : ''}</span>
        <span className="font-mono tabular-nums text-secondary">{formatDuration(r.seconds)}</span>
      </div>
      <div className="h-1.5 mt-1.5 ml-7 rounded bg-cipher-hover"><div className={`h-1.5 rounded ${r.zcash ? 'bg-cipher-gold' : 'bg-[var(--color-text-muted)]'}`} style={{ width: `${Math.max(1, r.seconds / max * 100)}%` }} /></div>
      <div className="text-caption text-muted mt-1 ml-7">{r.rule}</div>
    </li>)}
  </ul>;
}

export default function SimulatorClient() {
  const [seconds, setSeconds] = useState(SIM_DEFAULT_SECONDS);
  const [depth, setDepth] = useState(DEFAULT_DEPTH);
  const [copied, setCopied] = useState(false);
  const result = useMemo(() => simulate(seconds, depth), [seconds, depth]);
  const today = useMemo(() => simulate(SIM_DEFAULT_SECONDS, depth), [depth]);
  const zone = ZONE_COPY[result.zone];
  const orphans = orphanText(result);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('t') != null) setSeconds(clampSeconds(params.get('t')));
    if (params.get('c') != null) setDepth(clampDepth(params.get('c')));
  }, []);

  const syncUrl = (t: number, c: number) => {
    const url = new URL(window.location.href);
    if (t === SIM_DEFAULT_SECONDS) url.searchParams.delete('t'); else url.searchParams.set('t', String(t));
    if (c === DEFAULT_DEPTH) url.searchParams.delete('c'); else url.searchParams.set('c', String(c));
    window.history.replaceState(null, '', url);
  };
  const update = (value: number) => { const next = clampSeconds(value); setSeconds(next); syncUrl(next, depth); };
  const updateDepth = (value: number) => { const next = clampDepth(value); setDepth(next); syncUrl(seconds, next); };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  const vsToday = (value: number) => seconds === SIM_DEFAULT_SECONDS ? undefined : `Today at 25s: ${formatDuration(value)}`;

  return <div className="space-y-8">
    <Card className="card-static p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <label htmlFor="block-time" className="type-label text-muted uppercase">Block time</label>
          <output htmlFor="block-time" className="block type-metric text-primary mt-1">{seconds}s</output>
        </div>
        <div className={`rounded-md border px-3 py-2 text-caption max-w-xs ${zone.className}`}>
          <span className="font-mono">{zone.label}</span>
          <span className="block text-muted mt-0.5">{zone.detail}</span>
        </div>
      </div>
      <input id="block-time" type="range" min={SIM_MIN_SECONDS} max={SIM_MAX_SECONDS} step={1} value={seconds}
        aria-valuetext={`${seconds} seconds`} onChange={e => update(Number(e.target.value))}
        className="block w-full h-6 mt-4 cursor-pointer accent-cipher-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold" />
      <div className="mt-1 flex justify-between text-caption font-mono text-muted"><span>{SIM_MIN_SECONDS}s</span><span>{SIM_MAX_SECONDS}s</span></div>
      <div className="mt-4 flex flex-wrap gap-2">
        {SIM_PRESETS.map(p => <button key={p.seconds} type="button" onClick={() => update(p.seconds)} aria-pressed={seconds === p.seconds}
          title={p.detail}
          className={`rounded-md border px-3 py-1.5 text-caption font-mono transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold ${seconds === p.seconds ? 'border-cipher-gold text-cipher-gold' : 'border-cipher-border text-secondary hover:bg-cipher-hover'}`}>
          {p.label} <span className="text-muted">· {p.detail}</span>
        </button>)}
      </div>
      <div className="mt-5 pt-4 border-t border-cipher-border">
        <div className="type-label text-muted uppercase mb-2" id="depth-label">Confirmations before funds count as received</div>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="depth-label">
          {DEPTH_OPTIONS.map(o => <button key={o.blocks} type="button" onClick={() => updateDepth(o.blocks)} aria-pressed={depth === o.blocks}
            className={`rounded-md border px-3 py-1.5 text-caption font-mono transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold ${depth === o.blocks ? 'border-cipher-gold text-cipher-gold' : 'border-cipher-border text-secondary hover:bg-cipher-hover'}`}>
            {o.label} <span className="text-muted">· {o.detail}</span>
          </button>)}
        </div>
        <p className="text-caption text-muted mt-2">Wallets and services pick their own depth.</p>
      </div>
    </Card>

    <section aria-labelledby="feel-heading">
      <h2 id="feel-heading" className="type-section text-primary mb-3">What users would feel</h2>
      <Card className="card-static p-0 overflow-hidden">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-cipher-border">
          <Metric icon="wallet" label={`${depth} confirmations`} value={formatDuration(result.spendableMean)} detail={`9 times in 10 within ${formatDuration(result.spendableP90)}`} compare={vsToday(today.spendableMean)} />
          <Metric icon="check" label="First confirmation" value={formatDuration(result.firstConfirmationMean)} detail="On average, from sending" compare={vsToday(today.firstConfirmationMean)} />
          <Metric icon="pause" label="Gaps of 2+ minutes" value={formatShare(result.shareAtLeast120)} detail={`Gaps of 1+ minute: ${formatShare(result.shareAtLeast60)}`} compare={seconds === SIM_DEFAULT_SECONDS ? undefined : `Today: ${formatShare(today.shareAtLeast120)}`} />
          <Metric icon="hourglass" label="Longest wait, typical day" value={formatDuration(result.typicalDailyLongest)} detail="The slowest block gap in a day" compare={vsToday(today.typicalDailyLongest)} />
        </div>
      </Card>
    </section>

    <section aria-labelledby="cost-heading">
      <h2 id="cost-heading" className="type-section text-primary mb-3">What it would cost</h2>
      <Card className="card-static p-0 overflow-hidden">
        <div className="grid sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-cipher-border">
          <Metric icon="fork" label="Orphaned blocks" value={orphans.value} detail={orphans.detail} />
          <Metric icon="cube" label="Blocks per day" value={Math.round(result.blocksPerDay).toLocaleString('en-US')} detail="More headers for nodes and light wallets to process" compare={seconds === SIM_DEFAULT_SECONDS ? undefined : `Today: ${today.blocksPerDay.toLocaleString('en-US')}`} />
          <Metric icon="disk" label="Empty-block data" value={`${(result.emptyBlockBytesPerDay / 1e6).toFixed(1)} MB/day`} detail="Headers and coinbase alone, before any transactions" compare={seconds === SIM_DEFAULT_SECONDS ? undefined : `Today: ${(today.emptyBlockBytesPerDay / 1e6).toFixed(1)} MB/day`} />
        </div>
      </Card>
    </section>

    <section aria-labelledby="evidence-heading">
      <h2 id="evidence-heading" className="type-section text-primary mb-2">Why the math is trustworthy</h2>
      <p className="text-sm text-muted mb-4 max-w-3xl">Share of block gaps lasting 2 minutes or more. The same random-arrival model matched every speed Zcash has run at, within about a percentage point.</p>
      <Card className="card-static p-4 sm:p-6">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)] lg:items-center">
          <table className="w-full text-sm">
            <caption className="sr-only">Gaps of 2 minutes or more: model against measured</caption>
            <thead><tr className="type-label text-muted uppercase text-left"><th className="py-2 font-normal">Era</th><th className="py-2 font-normal text-right">Model</th><th className="py-2 font-normal text-right">Measured</th></tr></thead>
            <tbody className="divide-y divide-cipher-border">
              {SIM_ERAS.map(e => <tr key={e.targetSeconds}>
                <td className="py-2.5"><span className="font-mono text-primary">{e.targetSeconds}s</span> <span className="text-caption text-muted">{e.label}</span></td>
                <td className="py-2.5 text-right font-mono tabular-nums text-secondary">{(shareAtLeast(e.meanSeconds, 120) * 100).toFixed(e.targetSeconds === 25 ? 2 : 1)}%</td>
                <td className="py-2.5 text-right font-mono tabular-nums text-cipher-gold">{(e.shareAtLeast120 * 100).toFixed(e.targetSeconds === 25 ? 2 : 1)}%</td>
              </tr>)}
            </tbody>
          </table>
          <EvidenceChart seconds={seconds} />
        </div>
      </Card>
    </section>

    <section aria-labelledby="chains-heading">
      <h2 id="chains-heading" className="type-section text-primary mb-2">Compared with other chains</h2>
      <p className="text-sm text-muted mb-4 max-w-3xl">Protocol block targets. Chains settle differently, so only clear, documented waits are compared.</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="card-static p-4 sm:p-6"><h3 className="type-label text-muted uppercase mb-4">Block time (log scale)</h3><ChainList seconds={seconds} /></Card>
        <Card className="card-static p-4 sm:p-6"><h3 className="type-label text-muted uppercase mb-4">Usual wait until done</h3><WaitList result={result} /></Card>
      </div>
    </section>

    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={copyLink} className="rounded-md border border-cipher-border px-3 py-2 text-caption font-mono text-secondary hover:bg-cipher-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold">
        {copied ? 'Link copied' : `Copy link to ${seconds}s · ${depth} blocks`}
      </button>
      <span className="text-caption text-muted">Shares this exact setting.</span>
    </div>
  </div>;
}
