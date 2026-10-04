"use client";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { SlidersIcon } from "@/components/icons/common";
import { getMiningSoftwareEmoji } from "@/lib/coinbase-client";
import { SOFTWARE_LABELS, type MiningSoftware } from "@/lib/mining-software";
import pools from "@/lib/generated/mining-pools.json";
export const BLOCK_FILTER_KEYS = [
  "software", "pool", "order", "from", "to", "min_height", "max_height",
  "min_interval", "max_interval", "min_size", "max_size",
  "min_fees", "max_fees", "min_txs", "max_txs",
] as const;
export type BlockFilterValues = Partial<
  Record<(typeof BLOCK_FILTER_KEYS)[number], string>
>;
const field =
  "h-10 min-w-0 rounded-md border border-cipher-border bg-cipher-surface px-3 py-0 text-xs text-primary [color-scheme:light] dark:[color-scheme:dark]";
const toolbarField =
  "h-8 min-w-0 rounded-full border border-cipher-border bg-transparent px-3 py-0 text-xs text-secondary transition-colors hover:bg-cipher-hover hover:text-primary [color-scheme:light] dark:[color-scheme:dark]";
const softwareOptions = ["all", "zebra", "zakura", "unknown"] as const;

export function BlockFilters({ values }: { values: BlockFilterValues }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const software = values.software || "all";
  const activeCount = BLOCK_FILTER_KEYS.filter((key) => key !== "order" && values[key] && values[key] !== "all").length;
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        toggleRef.current?.focus();
      } else if (formRef.current?.contains(event.target as Node)) return;
      setExpanded(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [expanded]);
  const hasFilters = BLOCK_FILTER_KEYS.some((key) => {
    const value = values[key];
    return value && value !== "all" && !(key === "order" && value === "newest");
  });
  function navigate(next: BlockFilterValues) {
    const params = new URLSearchParams();
    for (const key of BLOCK_FILTER_KEYS) {
      const value = next[key];
      if (value && value !== "all" && !(key === "order" && value === "newest")) {
        params.set(key, value);
      }
    }
    startTransition(() => router.push(params.size ? `/blocks?${params}` : "/blocks", { scroll: false }));
  }
  return (
    <form
      ref={formRef}
      action="/blocks"
      className="relative"
      aria-label="Block filters"
      aria-busy={pending}
      onInput={(event) => {
        for (const input of event.currentTarget.querySelectorAll("input")) input.setCustomValidity("");
      }}
      onSubmit={(event) => {
        event.preventDefault();
        const next = Object.fromEntries(new FormData(event.currentTarget)) as BlockFilterValues;
        for (const key of ['min_size', 'max_size'] as const) {
          if (next[key]) next[key] = String(Math.round(Number(next[key]) * 1000));
        }
        for (const metric of ['height', 'interval', 'size', 'fees', 'txs'] as const) {
          const min = next[`min_${metric}`];
          const max = next[`max_${metric}`];
          if (min && max && Number(min) > Number(max)) {
            const input = event.currentTarget.elements.namedItem(`max_${metric}`) as HTMLInputElement;
            input.setCustomValidity("Maximum must be at least the minimum.");
            input.reportValidity();
            return;
          }
        }
        if (next.from && next.to && next.from > next.to) {
          const input = event.currentTarget.elements.namedItem('to') as HTMLInputElement;
          input.setCustomValidity("End date must be on or after the start date.");
          input.reportValidity();
          return;
        }
        setExpanded(false);
        navigate(next);
      }}
    >
      <fieldset disabled={pending} className="min-w-0 disabled:opacity-60">
        <legend className="sr-only">Filter blocks</legend>
        <input type="hidden" name="order" value={values.order || "newest"} />
        <div className="flex items-center sm:justify-end">
          <button ref={toggleRef} type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(!expanded)} className={`${toolbarField} inline-flex items-center gap-1.5 hover:text-primary ${activeCount ? 'border-brand-gold/50' : ''}`}>
            <span aria-hidden="true"><SlidersIcon /></span> Filters
            {activeCount > 0 && <span className="rounded bg-brand-gold/15 px-1.5 text-primary">{activeCount}</span>}
          </button>
          {pending && <span role="status" className="sr-only">Updating blocks…</span>}
        </div>
        <div id={panelId} hidden={!expanded} className="absolute left-0 top-full z-30 mt-2 w-[min(44rem,calc(100vw-2rem))] max-h-[70dvh] overflow-y-auto rounded-xl border border-cipher-border bg-cipher-surface p-4 text-left shadow-xl sm:left-auto sm:right-0">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-sm font-medium text-primary">Filter blocks</span>
            <button type="button" aria-label="Close filters" onClick={() => setExpanded(false)} className="rounded p-1 text-muted hover:text-primary"><span aria-hidden="true">×</span></button>
          </div>
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-xs text-muted">
              Software
              <select name="software" defaultValue={software} className={`${field} w-full`}>
                {softwareOptions.map((key) => (
                  <option key={key} value={key}>{key === "all" ? "All software" : [getMiningSoftwareEmoji(key), SOFTWARE_LABELS[key]].filter(Boolean).join(" ")}</option>
                ))}
                {(["other", "conflicting", "missing"] as MiningSoftware[])
                  .filter((key) => key === software)
                  .map((key) => <option key={key} value={key}>{SOFTWARE_LABELS[key]}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-xs text-muted">
              Pool
              <select name="pool" defaultValue={values.pool || "all"} className={`${field} w-full`}>
                <option value="all">All pools</option>
                {pools.map((name) => <option key={name}>{name}</option>)}
                <option value="unattributed">Unattributed</option>
              </select>
            </label>
          </div>
          <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            <fieldset className="min-w-0">
              <legend className="mb-2 text-xs text-secondary">Date (UTC)</legend>
              <div className="grid grid-cols-2 gap-2">
                <label className="min-w-0 text-xs text-muted">From<input type="date" name="from" defaultValue={values.from} className={`${field} mt-1 w-full`} /></label>
                <label className="min-w-0 text-xs text-muted">Through<input type="date" name="to" defaultValue={values.to} className={`${field} mt-1 w-full`} /></label>
              </div>
            </fieldset>
            {([
              ['height', 'Block height', '1'],
              ['interval', 'Block interval (seconds)', '1'],
              ['size', 'Size (KB · 1 KB = 1,000 bytes)', '0.001'],
              ['fees', 'Total fees (ZEC)', '0.00000001'],
              ['txs', 'Transactions (including coinbase)', '1'],
            ] as const).map(([metric, label, step]) => (
              <fieldset key={metric} className="min-w-0">
                <legend className="mb-2 text-xs text-secondary">{label}</legend>
                <div className="grid grid-cols-2 gap-2">
                  {(['min', 'max'] as const).map((bound) => {
                    const key = `${bound}_${metric}` as keyof BlockFilterValues;
                    const value = values[key];
                    return <label key={bound} className="min-w-0 text-xs text-muted">
                      {bound === 'min' ? 'Minimum' : 'Maximum'}
                      <input type={metric === "fees" ? "text" : "number"} inputMode={metric === "fees" || metric === "size" ? "decimal" : "numeric"} pattern={metric === "fees" ? "[0-9]+(\\.[0-9]{1,8})?" : undefined} name={key} aria-label={`${label}: ${bound === 'min' ? 'minimum' : 'maximum'}`} min="0" step={step} defaultValue={value && metric === 'size' ? Number(value) / 1000 : value} placeholder="Any" className={`${field} mt-1 w-full`} />
                    </label>;
                  })}
                </div>
              </fieldset>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-cipher-border pt-3">
            <p className="text-xs text-muted">Inclusive ranges · Interval uses block timestamps.</p>
            <div className="flex items-center gap-3">
              {hasFilters && <Link href="/blocks" scroll={false} className="py-2 text-xs text-muted underline underline-offset-4 hover:text-primary">Reset</Link>}
              <button type="submit" className="rounded-md bg-brand-gold px-4 py-2 text-xs font-medium text-black">Apply filters</button>
            </div>
          </div>
        </div>
      </fieldset>
    </form>
  );
}
