'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useApiQuery } from '@/hooks/useApiQuery';
import { quoteIsFresh, type PriceQuote } from '@/lib/valuation';
import { formatPoolAmount, type PoolCurrency } from '@/lib/pool-display';
import { isMainnet } from '@/lib/config';
import { PeriodPillTags } from '@/components/ui/PeriodPillTags';

const PoolCurrencyContext = createContext({
  currency: 'zec' as PoolCurrency,
  setCurrency: (() => {}) as (currency: PoolCurrency) => void,
  price: null as number | null,
  timestamp: null as number | null,
});

export function PoolCurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrency] = useState<PoolCurrency>('zec');
  const [now, setNow] = useState(0);
  const { data: quote } = useApiQuery<PriceQuote>('/v1/network/price', undefined, { enabled: isMainnet, refreshInterval: 30_000 });
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [quote]);
  const fresh = isMainnet && quoteIsFresh(quote ?? null, now);
  return <PoolCurrencyContext.Provider value={{ currency, setCurrency, price: fresh ? quote!.price : null, timestamp: fresh ? quote!.sourceUpdatedAt ?? quote!.timestamp : null }}>{children}</PoolCurrencyContext.Provider>;
}

export function usePoolCurrency() {
  const context = useContext(PoolCurrencyContext);
  return { ...context, format: (zec: number, unit = true) => formatPoolAmount(zec, context.currency, context.price, unit) };
}

export function PoolCurrencyToggle() {
  const { currency, setCurrency, price } = usePoolCurrency();
  if (!isMainnet) return null;
  return <div data-html2canvas-ignore="true" className="shrink-0">
    <PeriodPillTags aria-label="Pool balance currency" value={currency} onChange={setCurrency} options={[
      { key: 'zec', label: 'ZEC', title: 'Pool balances in ZEC' },
      { key: 'usd', label: 'USD', disabled: price == null && currency !== 'usd',
        title: price == null ? 'A fresh ZEC price is currently unavailable' : 'Value pool balances at the current ZEC price' },
    ]} />
  </div>;
}

export function PoolCurrencyNote() {
  const { currency, price, timestamp } = usePoolCurrency();
  if (currency !== 'usd') return null;
  return <p className="mt-3 text-caption leading-relaxed text-muted" role="status">
    {price == null ? 'USD amounts are unavailable while the current ZEC quote refreshes. Switch to ZEC to see balances.' : <>
      USD at the current price of <span className="text-secondary">{price.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })} / ZEC</span>
      {timestamp != null && <> · quote {new Date(timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC</>}. This rate also applies to historical balances; these are not historical dollar values.
    </>}
  </p>;
}
