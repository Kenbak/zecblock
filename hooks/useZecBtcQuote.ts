'use client';

import { useEffect, useState } from 'react';
import type { ZecBtcSnapshot } from '@/lib/zec-btc';

type Quote = ZecBtcSnapshot['quote'];

/** The optional ticker reads only the current quote, never the chart history. */
export function useZecBtcQuote(enabled: boolean) {
  const [quote, setQuote] = useState<Quote>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let pending = false;
    let controller: AbortController | undefined;
    async function refresh() {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      controller = new AbortController();
      const deadline = setTimeout(() => controller?.abort(), 20_000);
      try {
        const response = await fetch('/api/market/zec-btc/quote', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Quote unavailable');
        const data: Pick<ZecBtcSnapshot, 'quote' | 'source'> = await response.json();
        if (!data.quote || !Number.isFinite(data.quote.btcPerZec) || data.quote.btcPerZec <= 0) throw new Error('Invalid quote');
        if (!disposed) { setQuote(data.quote); setFailed(false); }
      } catch {
        if (!disposed) setFailed(true);
      } finally {
        clearTimeout(deadline);
        pending = false;
        if (!disposed) setNow(Date.now());
      }
    }
    setNow(Date.now());
    void refresh();
    const interval = setInterval(() => { setNow(Date.now()); void refresh(); }, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);

  const delayed = failed || Boolean(quote && (quote.delayed || !quote.observedAt
    || !Number.isFinite(quote.observedAt) || !Number.isFinite(quote.fetchedAt)
    || now - quote.observedAt > 300_000 || quote.observedAt > now + 60_000
    || now - quote.fetchedAt > 60_000 || quote.fetchedAt > now + 60_000));
  return { quote, delayed };
}
