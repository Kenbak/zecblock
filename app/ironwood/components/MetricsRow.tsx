'use client';

import { useEffect, useState } from 'react';
import { fmtValue, type CurrencyMode } from '@/hooks/useCurrencyToggle';
import type { ChartColors, Overview } from './types';
import { KpiCell, KpiRow } from './ui';

function CountdownUnit({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="flex flex-col items-center">
      <div className="w-16 sm:w-20 h-16 sm:h-20 rounded-xl border border-cipher-border/50 bg-glass-3 flex items-center justify-center">
        <span className="text-2xl sm:text-3xl font-semibold font-mono text-primary">
          {value === null ? '—' : String(value).padStart(2, '0')}
        </span>
      </div>
      <span className="text-caption font-mono text-muted mt-1.5 uppercase tracking-wider">{label}</span>
    </div>
  );
}

export function MetricsRow({
  overview,
  activated,
  hasMigrations,
  activationHeight,
  tipHeight,
  migratedPct,
  deploymentNetwork,
  colors,
  currencyMode = 'zec',
  zecPrice = null,
}: {
  overview: Overview | null;
  activated: boolean;
  hasMigrations: boolean;
  activationHeight: number;
  tipHeight: number;
  migratedPct: number;
  deploymentNetwork: string;
  colors: ChartColors;
  currencyMode?: CurrencyMode;
  zecPrice?: number | null;
}) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (activated) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [activated]);

  const blocksLeft = Math.max(0, activationHeight - tipHeight);
  const blockTime = overview?.avgBlockTimeSecs;
  const etaSecs = blockTime != null && blockTime > 0 ? blocksLeft * blockTime : null;
  const progressPct = tipHeight > 0 && activationHeight > 0
    ? Math.min(100, (tipHeight / activationHeight) * 100)
    : 0;

  const days = etaSecs === null ? null : Math.floor(etaSecs / 86400);
  const hours = etaSecs === null ? null : Math.floor((etaSecs % 86400) / 3600);
  const minutes = etaSecs === null ? null : Math.floor((etaSecs % 3600) / 60);

  const targetDate = etaSecs === null ? null : new Date(Date.now() + etaSecs * 1000);
  const networkLabel = deploymentNetwork === 'mainnet' ? 'Mainnet' : 'Testnet';

  if (!activated && blocksLeft > 0) {
    return (
      <div className="mt-4 rounded-xl border border-cipher-border bg-gradient-to-b from-cipher-surface to-cipher-elevated p-6 sm:p-8 relative overflow-hidden">
        <div
          className="absolute inset-0 opacity-15 pointer-events-none"
          style={{ background: `radial-gradient(ellipse at 50% 0%, ${colors.ironwoodPool}22 0%, transparent 60%)` }}
        />
        <div className="relative z-10">
          {/* Badge */}
          <div className="flex items-center justify-center mb-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-cipher-border/50 bg-glass-3 px-4 py-1.5">
              <span className="w-2 h-2 rounded-full animate-pulse bg-cipher-ironwood" />
              <span className="text-caption font-mono text-muted uppercase tracking-widest">
                NU6.3 Ironwood {networkLabel}
              </span>
            </div>
          </div>

          {/* Countdown */}
          <div className="flex items-center justify-center gap-3 sm:gap-5">
            <CountdownUnit value={days} label="days" />
            <span className="text-2xl sm:text-3xl font-semibold text-muted -mt-6">:</span>
            <CountdownUnit value={hours} label="hours" />
            <span className="text-2xl sm:text-3xl font-semibold text-muted -mt-6">:</span>
            <CountdownUnit value={minutes} label="min" />
          </div>

          {/* Blocks remaining */}
          <div className="text-center mt-6">
            <div className="text-3xl sm:text-4xl font-semibold font-mono tracking-tight text-cipher-ironwood">
              {blocksLeft.toLocaleString()}
            </div>
            <div className="text-xs font-mono text-muted mt-1">blocks remaining</div>
          </div>

          {/* Progress bar */}
          <div className="mt-6 max-w-2xl mx-auto">
            <div className="h-2.5 rounded-full bg-glass-6 overflow-hidden border border-cipher-border/30">
              <div
                className="h-full rounded-full transition-[width,background-color] duration-1000 relative"
                style={{
                  width: `${progressPct.toFixed(2)}%`,
                  background: `linear-gradient(90deg, ${colors.orchardPool}, ${colors.ironwoodPool})`,
                }}
              >
                <div className="absolute inset-0 bg-gradient-to-r from-transparent to-white/20 animate-pulse" />
              </div>
            </div>
            <div className="flex justify-between mt-1.5 text-caption font-mono text-muted">
              <span>block {tipHeight.toLocaleString()}</span>
              <span className="text-cipher-ironwood">{activationHeight.toLocaleString()}</span>
            </div>
          </div>

          {/* ETA */}
          <div className="text-center mt-4 text-sm font-mono text-secondary">
            {targetDate === null ? 'Estimate unavailable' : 'est.'} {targetDate?.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            <span className="text-muted mx-1.5">·</span>
            {targetDate?.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false })} {targetDate && 'UTC · based on recent observed block times'}
          </div>

          {/* Brand footer */}
          <div className="mt-6 flex items-center justify-center gap-2.5 border-t border-cipher-border/20 pt-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/zecblock-mark.svg" alt="" width={20} height={20} className="h-5 w-5 object-contain" />
            <span className="text-caption font-semibold font-mono text-cipher-gold-bright tracking-tight">ZecBlock</span>
            <span className="text-caption font-mono text-muted">zecblock.com</span>
          </div>

        </div>
      </div>
    );
  }

  const blocksSince = (tipHeight - activationHeight) || 0;
  const velocityValue = overview?.migration?.velocityZatPerHour != null
    ? `${fmtValue(overview.migration.velocityZatPerHour, currencyMode, zecPrice)}/hr`
    : '—';
  const txValue = overview?.migration?.txCount != null
    ? overview.migration.txCount.toLocaleString()
    : '—';
  const todayZat = overview?.migration?.migratedTodayZat ?? 0;
  const todayValue = todayZat > 0 ? `+${fmtValue(todayZat, currencyMode, zecPrice)}` : '—';

  const orchardPct = hasMigrations ? `${migratedPct.toFixed(1)}%` : '0%';

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-cipher-border bg-cipher-card">
      <div className="flex items-center gap-2 border-b border-cipher-border-subtle px-4 py-2.5 sm:px-5">
        <span className="h-2 w-2 rounded-full bg-cipher-green animate-pulse" />
        <span className="text-caption font-mono uppercase tracking-wider text-secondary">Ironwood live</span>
      </div>

      {/* Mobile — hero + full-width rows */}
      <div className="sm:hidden">
        <a href="#supply" className="block border-b border-cipher-border-subtle px-4 py-4 transition-colors active:bg-cipher-hover">
          <div className="font-mono text-caption uppercase tracking-wider text-muted">Migrated today</div>
          <div
            className="mt-1 text-2xl font-semibold font-mono tabular-nums tracking-tight text-cipher-ironwood"
          >
            {todayValue}
          </div>
          <div className="mt-0.5 font-mono text-caption text-muted">Into Ironwood pool</div>
        </a>
        <div className="divide-y divide-cipher-border-subtle">
          <KpiRow
            label="Orchard → Ironwood"
            value={orchardPct}
            hint="Pool supply migrated"
            scrollTo="#supply"
            toneColor={colors.ironwoodPool}
          />
          <KpiRow
            label="Migration speed · lifetime avg"
            value={velocityValue}
            hint="First to latest observed inflow"
            scrollTo="#migration-activity"
            toneColor={colors.ironwoodPool}
          />
          <KpiRow
            label="Transactions"
            value={txValue}
            hint="Since activation"
            scrollTo="#migration-activity"
          />
          <KpiRow
            label="Since activation"
            value={`${blocksSince.toLocaleString()} blocks`}
            hint={`Block #${activationHeight.toLocaleString()}`}
            href={`/block/${activationHeight}`}
          />
        </div>
      </div>

      {/* Desktop — 5-column strip */}
      <div className="hidden divide-x divide-cipher-border-subtle sm:grid sm:grid-cols-5">
        <KpiCell
          label="Since activation"
          value={`${blocksSince.toLocaleString()} blocks`}
          hint={`Block #${activationHeight.toLocaleString()}`}
          href={`/block/${activationHeight}`}
        />
        <KpiCell
          label="Migrated today"
          value={todayValue}
          hint="Into Ironwood pool"
          scrollTo="#supply"
          toneColor={colors.ironwoodPool}
        />
        <KpiCell
          label="Orchard → Ironwood"
          value={orchardPct}
          hint="Pool supply"
          scrollTo="#supply"
          toneColor={colors.ironwoodPool}
        />
        <KpiCell
          label="Migration speed · lifetime avg"
          value={velocityValue}
          hint="Activity chart"
          scrollTo="#migration-activity"
          toneColor={colors.ironwoodPool}
        />
        <KpiCell
          label="Transactions"
          value={txValue}
          hint="Activity chart"
          scrollTo="#migration-activity"
        />
      </div>
    </div>
  );
}
