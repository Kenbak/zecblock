"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { ChartTooltip } from "@/components/charts/ChartTooltip";
import { ShareableCard } from "@/components/ShareableCard";
import { getApiUrl } from "@/lib/api-config";
import { ApiError, readApiData } from "@/lib/api-client";
import { getMiningSoftwareEmoji } from "@/lib/coinbase-client";
import { SOFTWARE_LABELS, type MiningSoftware } from "@/lib/mining-software";
import { getChartColors, getChartTooltipStyle, getMiningSoftwareColors } from "@/lib/chart-theme";
import { useTheme } from "@/contexts/ThemeContext";
import { useUrlState } from '@/lib/use-url-state';

type Category = {
  software: MiningSoftware;
  label: string;
  blocks: number;
  share: number | null;
  firstObserved: number | null;
};
type History = {
  period: string;
  bucket: "day" | "week";
  from: string | null;
  to: string;
  totalBlocks: number;
  categories: Category[];
  history: {
    date: string;
    total: number;
    counts: Record<MiningSoftware, number> | null;
  }[];
  coverage: {
    firstHeight: number | null;
    lastHeight: number | null;
    lastTimestamp: number | null;
    coinbaseAvailableBlocks: number;
  };
};
const PERIODS = [
  ["7d", "7D"],
  ["30d", "30D"],
  ["90d", "90D"],
  ["1y", "1Y"],
  ["all", "All"],
  ["since-zebra", "Since first Zebra marker"],
  ["since-zakura", "Since first Zakura marker"],
  ["custom", "Custom"],
] as const;
// A custom range needs its dates, so only preset periods are shareable.
const SHAREABLE_PERIODS: string[] = PERIODS.map(([key]) => key).filter((key) => key !== "custom");
const inputClass =
  "rounded-md border border-cipher-border bg-cipher-surface px-3 py-2 text-xs text-primary";
const utcDate = (timestamp: number) =>
  new Date(timestamp * 1000).toISOString().slice(0, 10);

export function MiningSoftwareSection() {
  const { theme } = useTheme();
  const colors = getChartColors(theme);
  const palette = getMiningSoftwareColors(theme);
  const [period, setPeriod] = useUrlState<string>("software", "30d", SHAREABLE_PERIODS);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [bucket, setBucket] = useState("auto");
  const [data, setData] = useState<History | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (period === "custom" && !range) {
      setLoading(false);
      setData(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    const params = new URLSearchParams({
      period,
      bucket,
      ...(period === "custom" ? range : {}),
    });
    fetch(`${getApiUrl()}/v1/mining/software?${params}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        return readApiData<History>(response);
      })
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error instanceof ApiError && error.status === 400 ? error.message : "Software history is unavailable. This view requires the completed coinbase-marker history index.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [period, bucket, range]);
  const chart =
    data?.history.map((point) => ({
      date: point.date,
      total: point.total,
      ...Object.fromEntries(
        Object.keys(SOFTWARE_LABELS).map((key) => [
          key,
          point.total && point.counts
            ? (point.counts[key as MiningSoftware] / point.total) * 100
            : null,
        ]),
      ),
    })) ?? [];
  const blockHref = (software: MiningSoftware) =>
    `/blocks?${new URLSearchParams({ software, ...(data?.from ? { from: data.from, to: data.to } : {}) })}`;
  return (
    <section id="software" className="scroll-mt-36 mb-12">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-primary">
            Mining software tags
          </h2>
          <p className="mt-1 text-sm text-muted">
            Share of blocks carrying a software tag, rather than a census of
            the software miners run.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="software-period">
            Software history period
          </label>
          <select
            id="software-period"
            value={period}
            onChange={(event) => setPeriod(event.target.value)}
            className={inputClass}
          >
            {PERIODS.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="software-bucket">
            History resolution
          </label>
          <select
            id="software-bucket"
            value={bucket}
            onChange={(event) => setBucket(event.target.value)}
            className={inputClass}
          >
            <option value="auto">Auto resolution</option>
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
          </select>
        </div>
      </div>
      {period === "custom" && (
        <form
          className="mb-4 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setRange({
              from: String(form.get("from")),
              to: String(form.get("to")),
            });
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted">
            From (UTC)
            <input
              name="from"
              type="date"
              required
              defaultValue={range?.from}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Through (UTC)
            <input
              name="to"
              type="date"
              required
              min={range?.from}
              defaultValue={range?.to}
              className={inputClass}
            />
          </label>
          <button type="submit" className={inputClass}>
            Apply range
          </button>
        </form>
      )}
      <ShareableCard
        title="Share of observed blocks"
        branding="compact"
        compact
        exportDisabled={!data?.totalBlocks}
        shareText="Mining software markers on ZecBlock. Self-reported observations, not authenticated client identity. https://zecblock.com/mining#software"
        fileName="zecblock-mining-software.png"
        footerNote={
          data
            ? `${data.from ?? "No first observation"} – ${data.to} · ${data.bucket === "day" ? "Daily" : "Weekly"} · UTC`
            : "Software marker history"
        }
      >
        <p className="mb-4 text-xs text-muted">
          Software tags are self-reported. Blocks without a tag stay in the total.
        </p>
        <details className="mb-4 text-xs text-muted">
          <summary className="cursor-pointer hover:text-primary">
            Why can older blocks have no software tag?
          </summary>
          <p className="mt-2 max-w-3xl leading-relaxed">
            Software tags are optional. Zebra added automatic 🦓 tagging in its{" "}
            <a
              href="https://zfnd.org/zebra-6-0-0-rc-0-release/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-secondary underline underline-offset-4"
            >
              July 2026 release candidate
            </a>
            ; earlier tags also exist. A gap means no recognized tag was found,
            not that Zebra or zcashd was unused. Available coinbase data does not
            necessarily include a software tag.
          </p>
        </details>
        {loading ? (
          <div
            role="status"
            className="flex h-56 items-center justify-center text-sm text-muted"
          >
            Loading software history…
          </div>
        ) : error ? (
          <div role="status" className="py-12 text-sm text-muted">
            {error}
          </div>
        ) : !data?.totalBlocks ? (
          <p className="py-12 text-sm text-muted">
            {period === "custom" && !range
              ? "Choose a date range to compare software markers."
              : "No indexed blocks in this range."}
          </p>
        ) : (
          <>
            <div className="mb-5 grid grid-cols-2 gap-4 border-b border-cipher-border pb-4 sm:grid-cols-3">
              <div>
                <span className="text-xs text-muted">Observed blocks</span>
                <p className="mt-1 font-mono text-xl tabular-nums">
                  {data.totalBlocks.toLocaleString()}
                </p>
              </div>
              <div>
                <span className="text-xs text-muted">
                  Tag data available
                </span>
                <p className="mt-1 font-mono text-xl tabular-nums">
                  {(
                    (data.coverage.coinbaseAvailableBlocks / data.totalBlocks) *
                    100
                  ).toFixed(1)}
                  %
                </p>
              </div>
              <div>
                <span className="text-xs text-muted">Latest indexed block</span>
                <p className="mt-1 font-mono text-sm">
                  {data.coverage.lastHeight?.toLocaleString() ?? "—"}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {data.coverage.lastTimestamp
                    ? utcDate(data.coverage.lastTimestamp)
                    : "—"}
                </p>
              </div>
            </div>
            <div
              className="h-56"
              aria-label={`${data.bucket === "day" ? "Daily" : "Weekly"} software-marker share of blocks, including unknown observations`}
            >
              <ResponsiveContainer
                width="100%"
                height="100%"
                initialDimension={{ width: 800, height: 224 }}
              >
                <BarChart
                  data={chart}
                  margin={{ top: 8, right: 4, left: 0, bottom: 0 }}
                  barCategoryGap={0}
                >
                  <CartesianGrid
                    vertical={false}
                    stroke={colors.grid}
                    strokeDasharray="3 5"
                  />
                  <XAxis
                    dataKey="date"
                    minTickGap={55}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 12, fill: colors.axis }}
                    tickFormatter={(value) =>
                      new Date(`${value}T00:00:00Z`).toLocaleDateString(
                        "en-GB",
                        { day: "numeric", month: "short", timeZone: "UTC" },
                      )
                    }
                  />
                  <YAxis
                    domain={[0, 100]}
                    ticks={[0, 25, 50, 75, 100]}
                    width={42}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 12, fill: colors.axis }}
                    tickFormatter={(value) => `${value}%`}
                  />
                  <ChartTooltip
                    contentStyle={getChartTooltipStyle(colors)}
                    labelFormatter={(label) =>
                      `${label} · ${data.bucket === "week" ? "week starting" : "UTC day"}`
                    }
                    formatter={(value, name) => [
                      `${Number(value).toFixed(2)}%`,
                      SOFTWARE_LABELS[name as MiningSoftware] ?? name,
                    ]}
                  />
                  {data.categories.filter((category) => category.blocks > 0).map((category) => category.software).map(
                    (software) => (
                      <Bar
                        key={software}
                        dataKey={software}
                        stackId="software"
                        fill={palette[software]}
                        isAnimationActive={false}
                      />
                    ),
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">
                  Block-weighted shares for the selected date range
                </caption>
                <thead className="text-muted">
                  <tr>
                    <th className="py-2 font-normal">Software marker</th>
                    <th className="py-2 text-right font-normal">Blocks</th>
                    <th className="py-2 text-right font-normal">Share</th>
                    <th className="hidden py-2 text-right font-normal sm:table-cell">
                      First observed marker (all history)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.categories.filter((category) => category.blocks > 0).map((category) => (
                    <tr
                      key={category.software}
                      className="border-t border-cipher-border/50"
                    >
                      <th className="py-2.5 font-normal">
                        <Link
                          href={blockHref(category.software)}
                          className="inline-flex items-center gap-2 hover:underline"
                        >
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{
                              backgroundColor: palette[category.software],
                            }}
                          />
                          <span aria-hidden>{getMiningSoftwareEmoji(category.software)}</span>{category.label} <span aria-hidden>↗</span>
                        </Link>
                      </th>
                      <td className="text-right font-mono tabular-nums">
                        {category.blocks.toLocaleString()}
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {category.share === null
                          ? "—"
                          : `${(category.share * 100).toFixed(2)}%`}
                      </td>
                      <td className="hidden text-right font-mono text-muted sm:table-cell">
                        {["zebra", "zakura", "other"].includes(
                          category.software,
                        ) && category.firstObserved !== null
                          ? utcDate(category.firstObserved)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <details className="my-4 text-xs leading-relaxed text-muted">
          <summary className="cursor-pointer py-1">
            How to read this chart
          </summary>
          <div className="mt-2 space-y-2">
            <p>
              Shares use block counts across the selected range, including
              blocks without software tags and any unavailable tag data. They are neither node
              counts nor measured hashrate. Empty chart buckets indicate no
              indexed blocks.
            </p>
            <p>
              Zebra’s automatic marker arrived in July 2026. Earlier unmarked
              blocks may still have used Zebra. “Since first marker” starts on
              its first observed UTC day in this index, not the software’s
              launch date.
            </p>
            <p>
              The zcashd category requires an explicit version tag. Multiple software
              tags and unavailable tag data are tracked separately; an empty
              optional tag simply means no software tag. Mining-pool
              attribution and software markers are independent observations.
            </p>
            {data && (
              <p>
                Canonical coverage: indexed heights{" "}
                {data.coverage.firstHeight?.toLocaleString() ?? "—"}–
                {data.coverage.lastHeight?.toLocaleString() ?? "—"}. Replaced
                and removed blocks update the counts. Boundary weeks include
                only the selected days.
              </p>
            )}
            <a
              className="underline underline-offset-4"
              href="https://zfnd.org/zebra-6-0-0-rc-0-release/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Zebra marker release notes ↗
            </a>
          </div>
        </details>
      </ShareableCard>
    </section>
  );
}
