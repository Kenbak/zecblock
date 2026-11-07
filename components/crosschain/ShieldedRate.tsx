"use client";
import { useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import { ChartTooltip as Tooltip } from "@/components/charts/ChartTooltip";
import { ChartCard } from "@/components/network/ChartCard";
import { objectRowsCsv } from "@/components/charts/PanelShareControl";
import { PeriodPillTags } from "@/components/ui/PeriodPillTags";
import { useTheme } from "@/contexts/ThemeContext";
import { getChartColors } from "@/lib/chart-theme";
import { useApiQuery } from "@/hooks/useApiQuery";
import { CHAINS } from "./model";

type Breakdown = {
  shieldedOnArrival: string | null;
  shieldedAfter: string | null;
  held: string | null;
  exchange: string | null;
  bridge: string | null;
  transferred: string | null;
};
type Slice = {
  swaps: number;
  coveredSwaps: number;
  swapCoverage: number | null;
  uncovered: { noZecTx: number; txNotIndexed: number; unmatched: number };
  coveredZat: string | null;
  shieldedZat: string | null;
  shieldedRate: number | null;
  breakdownZat: Breakdown;
  shieldedArrivals: number;
};
export type Shielding = {
  period: string;
  summary: Slice;
  daily: (Slice & { date: string })[];
  byChain: (Slice & { chain: string })[];
  timeToShield: { samples: number; medianMinutes: number | null; p90Minutes: number | null };
  coverage: { sourceSwaps: number; classifiedSwaps: number; pendingClassification: number; lastClassifiedAt: string | null };
};

const PERIODS = ["30d", "90d", "1y", "all"] as const;
type Period = (typeof PERIODS)[number];
const PERIOD_LABEL: Record<Period, string> = { "30d": "30D", "90d": "90D", "1y": "1Y", all: "All" };

// Exact zatoshi strings → ZEC numbers for rendering only.
const zec = (zat: string | null | undefined) => (zat == null ? null : Number(BigInt(zat)) / 1e8);
const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const fmtZec = (v: number | null) =>
  v == null ? "—" : `${v.toLocaleString(undefined, { maximumFractionDigits: v < 10 ? 2 : 0 })} ZEC`;
const minutes = (m: number | null) =>
  m == null ? "—" : m < 90 ? `${Math.round(m)} min` : m < 2880 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} d`;

function initialPeriod(p: string): Period {
  return (PERIODS as readonly string[]).includes(p) ? (p as Period) : p === "24h" || p === "7d" ? "30d" : "90d";
}

export function ShieldedRate({ dashboardPeriod }: { dashboardPeriod: string }) {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const [period, setPeriod] = useState<Period>(initialPeriod(dashboardPeriod));
  const { data, loading, error } = useApiQuery<Shielding>(
    "/v1/crosschain/shielding",
    { period },
    { refreshInterval: 300000 },
  );
  // Order validated for CVD separation of adjacent stacked segments.
  const SERIES = [
    { key: "Shielded", color: colors.shielding, note: "On arrival or first spend" },
    { key: "Bridged", color: colors.orchard, note: "Spent to a labelled bridge" },
    { key: "Held", color: colors.gold, note: "Unspent transparent output" },
    { key: "Exchange", color: colors.distinctive, note: "Spent to a labelled exchange" },
    { key: "Transferred", color: colors.residual, note: "Spent elsewhere, unclassified" },
  ] as const;

  const controls = (
    <PeriodPillTags
      aria-label="Shielded rate period"
      value={period}
      onChange={setPeriod}
      options={PERIODS.map((p) => ({ key: p, label: PERIOD_LABEL[p] }))}
    />
  );

  if (!data) {
    return (
      <ChartCard title="Shielded rate" controls={controls} height={120}>
        <p className="text-sm text-muted" role={loading ? "status" : "alert"}>
          {loading
            ? "Loading shielding classification…"
            : `Shielding index unavailable${error ? `: ${error}` : ""}. No rate is inferred.`}
        </p>
      </ChartCard>
    );
  }

  const s = data.summary;
  const parts = (b: Breakdown) => ({
    Shielded: (zec(b.shieldedOnArrival) ?? 0) + (zec(b.shieldedAfter) ?? 0),
    Bridged: zec(b.bridge) ?? 0,
    Held: zec(b.held) ?? 0,
    Exchange: zec(b.exchange) ?? 0,
    Transferred: zec(b.transferred) ?? 0,
  });
  const points = data.daily
    .filter((d) => d.coveredSwaps > 0)
    .map((d) => ({
      date: d.date,
      ...parts(d.breakdownZat),
      rate: d.shieldedRate,
      covered: d.coveredSwaps,
      swaps: d.swaps,
    }));
  const total = parts(s.breakdownZat);
  const covered = zec(s.coveredZat) ?? 0;
  const uncovered = s.swaps - s.coveredSwaps;

  return (
    <ChartCard
      title="Shielded rate"
      controls={controls}
      height={300}
      share={{
        title: `Share of NEAR Intents-delivered ZEC that gets shielded (${period})`,
        fileName: `zecblock-crosschain-shielded-rate-${period}`,
        csv: () =>
          objectRowsCsv(
            data.daily.map((d) => ({
              date: d.date,
              swaps: d.swaps,
              covered_swaps: d.coveredSwaps,
              covered_zat: d.coveredZat,
              shielded_zat: d.shieldedZat,
              shielded_rate: d.shieldedRate,
              held_zat: d.breakdownZat.held,
              exchange_zat: d.breakdownZat.exchange,
              bridge_zat: d.breakdownZat.bridge,
              transferred_zat: d.breakdownZat.transferred,
            })),
          ),
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3 mb-4">
        <div>
          <p className="text-caption text-muted">Shielded</p>
          <p className="font-mono text-2xl tabular-nums">{pct(s.shieldedRate)}</p>
          <p className="text-caption text-muted mt-0.5">
            {fmtZec(zec(s.shieldedZat))} of {fmtZec(covered)} delivered
          </p>
        </div>
        <div>
          <p className="text-caption text-muted">Coverage</p>
          <p className="font-mono text-2xl tabular-nums">{pct(s.swapCoverage)}</p>
          <p className="text-caption text-muted mt-0.5">
            {s.coveredSwaps.toLocaleString()} of {s.swaps.toLocaleString()} swaps traceable on chain
          </p>
        </div>
        <div>
          <p className="text-caption text-muted">Time to shield</p>
          <p className="font-mono text-2xl tabular-nums">{minutes(data.timeToShield.medianMinutes)}</p>
          <p className="text-caption text-muted mt-0.5">
            Median · p90 {minutes(data.timeToShield.p90Minutes)} · {data.timeToShield.samples.toLocaleString()} samples
          </p>
        </div>
      </div>

      {covered > 0 && (
        <div className="mb-4">
          <div className="flex h-3 gap-[2px] overflow-hidden rounded" role="img"
            aria-label={SERIES.map((x) => `${x.key} ${pct(total[x.key] / covered)}`).join(", ")}>
            {SERIES.map((x) =>
              total[x.key] > 0 ? (
                <span key={x.key} title={`${x.key}: ${fmtZec(total[x.key])} (${pct(total[x.key] / covered)})`}
                  style={{ width: `${(100 * total[x.key]) / covered}%`, minWidth: 3, backgroundColor: x.color }} />
              ) : null,
            )}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted mt-2">
            {SERIES.map((x) => (
              <li key={x.key} title={x.note}>
                <span style={{ color: x.color }} aria-hidden="true">■</span>{" "}
                <span className="text-secondary">{x.key}</span>{" "}
                <span className="tabular-nums">{pct(total[x.key] / covered)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {points.length > 0 ? (
        <ResponsiveContainer width="100%" height={220} minWidth={0}>
          <BarChart data={points} stackOffset="expand" margin={{ left: 0, right: 8 }} barCategoryGap={1}>
            <CartesianGrid stroke={colors.grid} strokeDasharray="2 6" vertical={false} />
            <XAxis dataKey="date" minTickGap={45} tick={{ fill: colors.axis, fontSize: 12 }} />
            <YAxis tickFormatter={(v: number) => `${Math.round(v * 100)}%`} width={44} tick={{ fill: colors.axis, fontSize: 12 }} />
            <Tooltip
              cursor={{ fill: colors.barCursor }}
              formatter={(v: unknown, name: unknown) => [fmtZec(Number(v)), String(name)]}
              labelFormatter={(label: unknown, payload?: readonly { payload?: { rate: number | null; covered: number; swaps: number } }[]) => {
                const p = payload?.[0]?.payload;
                return p ? `${label} · ${pct(p.rate)} shielded · ${p.covered}/${p.swaps} swaps covered` : String(label);
              }}
            />
            {SERIES.map((x, i) => (
              <Bar key={x.key} dataKey={x.key} stackId="a" fill={x.color} isAnimationActive={false}
                radius={i === SERIES.length - 1 ? [4, 4, 0, 0] : undefined} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <p className="text-sm text-muted">No covered swaps in this period.</p>
      )}

      {data.byChain.length > 0 && (
        <details className="border-t border-cipher-border pt-3 mt-4">
          <summary className="text-xs text-secondary cursor-pointer">By source chain</summary>
          <table className="w-full text-xs mt-3">
            <thead className="text-muted">
              <tr><th className="text-left font-normal">Chain</th><th className="text-right font-normal">Shielded</th><th className="text-right font-normal">Covered ZEC</th><th className="text-right font-normal">Coverage</th></tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {data.byChain.map((c) => (
                <tr key={c.chain}>
                  <td className="text-secondary font-sans py-0.5">{CHAINS[c.chain] || c.chain}</td>
                  <td className="text-right">{pct(c.shieldedRate)}</td>
                  <td className="text-right">{fmtZec(zec(c.coveredZat))}</td>
                  <td className="text-right">{c.coveredSwaps}/{c.swaps}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <p className="text-xs text-muted mt-4">
        Successful NEAR Intents swaps into ZEC. A swap counts as shielded when its ZEC lands in a shielded pool
        directly or its delivered transparent output is next spent by a shielding transaction (one hop, same rules
        as the Turnstile). The rate covers traceable ZEC only: {uncovered.toLocaleString()} swap{uncovered === 1 ? "" : "s"} in
        this period {uncovered === 1 ? "is" : "are"} excluded — {s.uncovered.noZecTx.toLocaleString()} with no Zcash transaction
        reported by the provider, {s.uncovered.txNotIndexed.toLocaleString()} not yet indexed, {s.uncovered.unmatched.toLocaleString()} not
        tied to the recipient. Held ZEC can still be shielded later, so recent days may rise.
        {data.coverage.pendingClassification > 0
          ? ` ${data.coverage.pendingClassification.toLocaleString()} newer swaps await classification.`
          : ""}
      </p>
    </ChartCard>
  );
}
