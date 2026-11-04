'use client';

import { normalizeMigrationData, completedDayActivity } from './components/api-data';
import { readApiData } from '@/lib/api-client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getApiUrl } from '@/lib/api-config';
import { useTheme } from '@/contexts/ThemeContext';
import { getChartColors } from '@/lib/chart-theme';
import { NETWORK_LABEL } from '@/lib/config';
import { useCurrencyToggle } from '@/hooks/useCurrencyToggle';
import { zatToZec } from '@/lib/format-numbers';
import { useInViewport } from '@/hooks/useInViewport';
import { TurnstileHero } from './TurnstileHero';
import {
  MetricsRow,
  SupplyVerification,
  IronwoodInflowCard,
  MigrationActivity,
  PrivacyScore,
  MigrationTiers,
  WalletReadiness,
  Resources,
} from './components';
import type {
  Cohorts,
  MigrationActivityData,
  Overview,
  PrivacyRange,
  ScatterData,
} from './components';
import {
  decodeCompactScatter,
  loadAllScatter,
  mergeScatter,
  type CompactScatterResponse,
  type ScatterCursor,
} from './compact-scatter';
import { useUrlState } from '@/lib/use-url-state';

export type { Cohort, Cohorts, Overview, ScatterData, ScatterTx } from './components';

const zec = zatToZec;
function fmtZec(zat: number): string {
  const z = zec(zat);
  if (Math.abs(z) >= 1000) return Math.round(z).toLocaleString();
  return z.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Compact initial-activity payload from `/v1/migration/activity` — small,
 * pre-aggregated hourly/daily buckets (exact zatoshi integers, never a lossy
 * ZEC float) rather than the full per-tx `/scatter` payload. Feature-detected
 * (network/parse failure → simply not shown) so this stays resilient if the
 * endpoint is ever rolled back or rate-limited independently of the frontend.
 */
// How close to the viewport the scatter section (the ~10MB /v1/migration/scatter
// payload) needs to be before we fetch it. Generous lookahead so the chart is
// already loaded by the time a scrolling user actually reaches it.
const SCATTER_VIEWPORT_MARGIN = '800px';

export function MigrationClient({
  initialOverview,
  initialCohorts,
  initialActivityHourly,
  initialActivityDaily,
  initialDenominations: _initialDenominations,
  deploymentNetwork,
  fallbackActivationHeight,
}: {
  initialOverview: Overview | null;
  initialCohorts: Cohorts | null;
  initialActivityHourly: MigrationActivityData | null;
  initialActivityDaily: MigrationActivityData | null;
  initialDenominations: unknown;
  deploymentNetwork: 'mainnet' | 'testnet' | 'crosslink-testnet';
  fallbackActivationHeight: number;
}) {
  const [overview, setOverview] = useState<Overview | null>(initialOverview);
  const [cohorts, setCohorts] = useState<Cohorts | null>(initialCohorts);
  const [scatter, setScatter] = useState<ScatterData | null>(null);
  const [scatterRange, setScatterRange] = useUrlState<PrivacyRange>('scatter', '7d', ['24h', '7d', '30d', 'all']);
  const [activityHourly, setActivityHourly] = useState<MigrationActivityData | null>(initialActivityHourly);
  const [activityDaily, setActivityDaily] = useState<MigrationActivityData | null>(initialActivityDaily);
  const [activityAttempted, setActivityAttempted] = useState(
    Boolean(initialActivityHourly || initialActivityDaily),
  );
  const [scatterAttempted, setScatterAttempted] = useState(false);
  const scatterCursor = useRef<ScatterCursor | null>(null);
  const [loaded, setLoaded] = useState(!!initialOverview);
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const { mode: currencyMode, setMode: setCurrencyMode, price: zecPrice } = useCurrencyToggle();

  // Sentinel placed just above the scatter-consuming sections (Migration
  // Activity + Amount Privacy) — the ~10MB /v1/migration/scatter payload is
  // only fetched once this nears the viewport, instead of unconditionally
  // on mount. Every point is still preserved once it does load (no sampling).
  const [scatterSectionRef, scatterNearViewport] = useInViewport<HTMLDivElement>({
    rootMargin: SCATTER_VIEWPORT_MARGIN,
  });

  useEffect(() => {
    let cancelled = false;
    const base = getApiUrl();
    const fetchJson = (path: string) =>
      fetch(`${base}${path}`, { cache: 'no-store' })
        .then((r) => (r.ok ? readApiData(r) : null))
        .then(normalizeMigrationData)
        .catch(() => null);

    const loadOverview = () => {
      fetchJson('/v1/migration/overview').then((result) => {
        if (cancelled) return;
        if (result && result.network === deploymentNetwork) setOverview(result);
        setLoaded(true);
      });
    };

    // Cheap, compact aggregate (small hourly buckets, not per-tx rows) — safe
    // to fetch unconditionally alongside the overview so there's *something*
    // activity-shaped to show above the fold before the full scatter dataset
    // loads (see scatterNearViewport below). Feature-detected: a network/parse
    // failure just means "no summary available" rather than an error state.
    const loadActivity = () => {
      Promise.all([
        fetchJson('/v1/migration/activity?granularity=hour'),
        fetchJson('/v1/migration/activity?granularity=day'),
      ]).then(([hourly, daily]: [MigrationActivityData | null, MigrationActivityData | null]) => {
        if (cancelled) return;
        if (hourly && (!hourly.network || hourly.network === deploymentNetwork)) {
          setActivityHourly(hourly);
        }
        if (daily && (!daily.network || daily.network === deploymentNetwork)) {
          setActivityDaily(daily);
        }
        setActivityAttempted(true);
      });
    };

    const loadCohorts = () => {
      fetchJson('/v1/migration/cohorts').then((c) => {
        if (cancelled) return;
        if (c && c.network === deploymentNetwork) setCohorts(c);
      });
    };

    loadOverview();
    loadActivity();
    loadCohorts();
    const overviewId = setInterval(loadOverview, 10000);
    const activityId = setInterval(loadActivity, 30000);
    const cohortsId = setInterval(loadCohorts, 60000);
    return () => {
      cancelled = true;
      clearInterval(overviewId);
      clearInterval(activityId);
      clearInterval(cohortsId);
    };
  }, [deploymentNetwork]);

  const scatterRequestRange = scatterRange === 'all'
    ? 'all'
    : scatterRange === '30d'
      ? '30d'
      : '7d';

  // Load only the visible time window. Immutable history is fetched in
  // finalized chunks only when the user explicitly selects "All"; polling
  // then asks for rows after the last canonical tip instead of downloading
  // the complete history again.
  useEffect(() => {
    if (!scatterNearViewport) return;
    let cancelled = false;
    const base = getApiUrl();
    const controller = new AbortController();

    const loadInitial = async () => {
      setScatterAttempted(false);
      try {
        if (scatterRequestRange === 'all') {
          const loaded = await loadAllScatter(base, deploymentNetwork, controller.signal);
          if (cancelled) return;
          setScatter(loaded.data);
          scatterCursor.current = loaded.cursor;
        } else {
          const response = await fetch(
            `${base}/v1/migration/scatter/compact?range=${scatterRequestRange}`,
            { signal: controller.signal },
          );
          if (!response.ok) throw new Error(`Scatter request failed with HTTP ${response.status}`);
          const body = await readApiData(response) as CompactScatterResponse;
          if (!body || body.network !== deploymentNetwork) {
            throw new Error('Scatter response network mismatch');
          }
          if (cancelled) return;
          setScatter(decodeCompactScatter(body));
          scatterCursor.current = body.cursor;
        }
      } catch (error) {
        if (!cancelled && (error as Error).name !== 'AbortError') setScatter(null);
      } finally {
        if (!cancelled) setScatterAttempted(true);
      }
    };

    const loadTail = async () => {
      const cursor = scatterCursor.current;
      if (!cursor || !cursor.hash || document.visibilityState === 'hidden') return;
      try {
        const response = await fetch(
          `${base}/v1/migration/scatter/compact?afterHeight=${cursor.height}`
            + `&afterHash=${encodeURIComponent(cursor.hash)}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(`Scatter tail failed with HTTP ${response.status}`);
        const body = await readApiData(response) as CompactScatterResponse;
        if (!body || body.network !== deploymentNetwork) return;
        if (body.resetRequired) {
          await loadInitial();
          return;
        }
        const delta = decodeCompactScatter(body);
        if (!cancelled) {
          setScatter((current) => current ? mergeScatter(current, delta) : delta);
          scatterCursor.current = body.cursor;
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          console.warn('[ironwood] Scatter tail refresh failed');
        }
      }
    };

    setScatter(null);
    scatterCursor.current = null;
    void loadInitial();
    const scatterId = setInterval(() => { void loadTail(); }, 60_000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(scatterId);
    };
  }, [scatterNearViewport, deploymentNetwork, scatterRequestRange]);

  const activated = overview?.activated ?? false;
  const hasMigrations = (overview?.migration?.txCount ?? 0) > 0;
  const noData = loaded && (!overview || !overview.migration);

  const knownActivationHeight = overview?.activationHeight ?? fallbackActivationHeight;
  const knownTip = overview?.tipHeight || 0;

  const orchardToIronwoodZat = overview?.inflowSources?.fromOrchardZat ?? 0;
  const originalOrchard = (overview?.poolSizes.orchardZat ?? 0) + orchardToIronwoodZat;
  const migratedPct = originalOrchard > 0
    ? (orchardToIronwoodZat / originalOrchard) * 100
    : 0;
  const activitySummary = useMemo(() => {
    return completedDayActivity(activityHourly, Date.now() / 1000);
  }, [activityHourly]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          {/* No accent on "Ironwood" here: gold is this page's Ironwood-pool
              category color in the charts, badges and balance rows, so tinting
              the word in the title reads as a data label (or a link) instead
              of a heading. Color belongs to identity labels, not prose. */}
          <h1 className="type-page text-primary">
            Zcash Ironwood Migration Tracker
          </h1>
          <p className="text-sm text-secondary mt-2 max-w-3xl leading-relaxed">
            Live tracking of the NU6.3 Orchard-to-Ironwood migration — pool balances, supply verification, cohort privacy, and migration velocity.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Display currency" className="inline-flex gap-1 p-1 rounded-lg bg-glass-3">
            {(['zec', 'usd'] as const).map(unit => (
              <button key={unit} type="button" aria-pressed={currencyMode === unit}
                onClick={() => setCurrencyMode(unit)}
                className={`min-h-9 px-3 rounded-md text-xs font-mono uppercase transition-colors ${currencyMode === unit ? 'bg-cipher-bg text-primary shadow-sm ring-1 ring-glass-12' : 'text-muted hover:text-primary'}`}>
                {unit.toUpperCase()}
              </button>
            ))}
          </div>
          <span className="text-caption font-mono text-muted px-2" aria-label={`Network: ${NETWORK_LABEL}`}>
            {NETWORK_LABEL}
          </span>
        </div>
      </div>

      {!loaded && !initialOverview ? (
        <div className="mt-8 h-80 sm:h-[420px] rounded-2xl border border-cipher-border bg-cipher-surface flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 border-2 border-cipher-border border-t-cipher-yellow rounded-full animate-spin" />
            <span className="text-xs font-mono text-muted">Loading migration data…</span>
          </div>
        </div>
      ) : noData ? (
        <div className="mt-8 rounded-xl border border-cipher-border bg-cipher-surface p-6 text-center">
          <h2 className="text-sm font-semibold text-primary">Migration data unavailable</h2>
          <p className="text-xs text-muted mt-2">
            ZecBlock could not load Ironwood data for this network. Try again shortly.
          </p>
        </div>
      ) : (
        <>
          {!activated ? (
            /* Pre-activation: countdown only */
            <MetricsRow
              overview={overview}
              activated={false}
              hasMigrations={false}
              activationHeight={knownActivationHeight}
              tipHeight={knownTip}
              migratedPct={0}
              deploymentNetwork={deploymentNetwork}
              colors={colors}
            />
          ) : (
            /* Post-activation: full dashboard */
            <>
              <MetricsRow
                overview={overview}
                activated={activated}
                hasMigrations={hasMigrations}
                activationHeight={knownActivationHeight}
                tipHeight={knownTip}
                migratedPct={migratedPct}
                deploymentNetwork={deploymentNetwork}
                colors={colors}
                currencyMode={currencyMode}
                zecPrice={zecPrice}
              />
              <SupplyVerification overview={overview} colors={colors} currencyMode={currencyMode} zecPrice={zecPrice} />
              {overview && (
                <TurnstileHero
                  activated={activated}
                  migratedPct={migratedPct}
                  blockPulseKey={overview.tipHeight}
                  activationHeight={knownActivationHeight}
                  tipHeight={knownTip}
                  cohorts={cohorts?.cohorts ?? null}
                  originalOrchardZat={originalOrchard}
                  currencyMode={currencyMode}
                  zecPrice={zecPrice}
                />
              )}
              {hasMigrations && overview?.inflowSources && overview.poolSizes && (
                <IronwoodInflowCard
                  sources={overview.inflowSources}
                  pools={overview.poolSizes}
                  colors={colors}
                  currencyMode={currencyMode}
                  zecPrice={zecPrice}
                />
              )}
              {/* Sentinel for the scatter-viewport gate above — placed right
                  before the two sections that render scatter-derived charts
                  so the ~10MB dataset starts loading with a head start
                  (SCATTER_VIEWPORT_MARGIN) rather than only once these
                  sections are already on screen. */}
              <div ref={scatterSectionRef} aria-hidden="true" />
              {!scatter && activitySummary && (
                <p className="mt-6 text-xs font-mono text-muted" role="status" aria-live="polite">
                  {activitySummary.txCount24h.toLocaleString()} migrations in the last 24 complete UTC hours ({fmtZec(activitySummary.volumeZat24h)} ZEC) — transaction-level privacy detail loads as you scroll.
                </p>
              )}
              <MigrationActivity
                cohorts={cohorts}
                activityHourly={activityHourly}
                activityDaily={activityDaily}
                activityLoading={hasMigrations && !activityAttempted}
                activityUnavailable={
                  hasMigrations && activityAttempted && !activityHourly && !activityDaily
                }
                activated={activated}
                colors={colors}
                tipHeight={knownTip}
                currencyMode={currencyMode}
                zecPrice={zecPrice}
              />
              <PrivacyScore
                scatter={scatter}
                scatterLoading={hasMigrations && !scatterAttempted}
                scatterUnavailable={hasMigrations && scatterAttempted && !scatter}
                activated={activated}
                colors={colors}
                tipHeight={knownTip}
                range={scatterRange}
                onRangeChange={setScatterRange}
              />
              <MigrationTiers activated={activated} colors={colors} tipHeight={knownTip} currencyMode={currencyMode} zecPrice={zecPrice} />
              <WalletReadiness />
              <Resources />
            </>
          )}
        </>
      )}
    </div>
  );
}
