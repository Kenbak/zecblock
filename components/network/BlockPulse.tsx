'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useApiQuery } from '@/hooks/useApiQuery';

type RecentBlock = { height: number; timestamp: number };
type RecentSummary = { blocks?: RecentBlock[] };

const WINDOW_SECONDS = 20 * 60;

const validBlock = (block: RecentBlock) => Number.isSafeInteger(block?.height) && block.height >= 0
  && Number.isSafeInteger(block?.timestamp) && block.timestamp > 0;

function ago(seconds: number) {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s ago`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s ago`;
}

/**
 * The last 20 minutes of canonical blocks on a live time axis. Each tick is a
 * block at its header time, so the gaps are the block intervals. Blocks at or
 * after the NU7 height are gold; the newest tick pulses when it arrives.
 */
export function BlockPulse({ nu7Height, targetSeconds }: { nu7Height: number | null; targetSeconds: number | null }) {
  // A 10-second poll keeps the strip independent of the socket provider; ticks drift every second.
  const { data, error } = useApiQuery<RecentSummary>('/v1/network/blocks/recent-summary', { limit: '50' }, { refreshInterval: 10_000 });
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  const blocks = (data?.blocks ?? []).filter(validBlock).sort((a, b) => a.height - b.height);
  const latest = blocks.at(-1);
  // Header times can sit slightly ahead of local clocks; never draw a block in the future.
  const clock = Math.max(now, latest?.timestamp ?? 0);
  const visible = blocks.filter(block => clock - block.timestamp <= WINDOW_SECONDS);
  const nu7Blocks = nu7Height == null ? 0 : visible.filter(block => block.height >= nu7Height).length;
  const expected = targetSeconds ? Math.round(WINDOW_SECONDS / targetSeconds) : null;
  const x = (timestamp: number) => 100 - (clock - timestamp) / WINDOW_SECONDS * 100;

  return <div className="block-pulse" aria-live="polite">
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 mb-3">
      <p className="text-sm text-secondary">
        <span className="font-mono tabular-nums text-primary">{visible.length}</span> blocks in the last 20 minutes
        {expected != null && <span className="text-muted"> · target pace {expected}</span>}
        {nu7Blocks > 0 && <span className="text-cipher-gold"> · {nu7Blocks} with NU7</span>}
      </p>
      {latest && <p className="text-caption font-mono text-muted tabular-nums">
        Latest <Link href={`/block/${latest.height}`} prefetch={false} className="text-secondary hover:text-primary">#{latest.height.toLocaleString('en-US')}</Link> · {ago(clock - latest.timestamp)}
      </p>}
    </div>
    <div className="block-pulse-track" role="img"
      aria-label={`${visible.length} blocks in the last 20 minutes${latest ? `, latest block ${latest.height}` : ''}`}>
      {visible.map(block => {
        const nu7 = nu7Height != null && block.height >= nu7Height;
        const newest = block.height === latest?.height;
        return <Link key={block.height} href={`/block/${block.height}`} prefetch={false} title={`Block #${block.height.toLocaleString('en-US')}`}
          className={`block-pulse-tick ${nu7 ? 'block-pulse-tick-nu7' : ''} ${newest ? 'block-pulse-tick-new' : ''}`}
          style={{ left: `${x(block.timestamp)}%` }} tabIndex={-1} />;
      })}
      {nu7Height != null && blocks.some(block => block.height === nu7Height) && (() => {
        const activation = blocks.find(block => block.height === nu7Height)!;
        return clock - activation.timestamp <= WINDOW_SECONDS
          ? <span className="block-pulse-marker" style={{ left: `${x(activation.timestamp)}%` }}>NU7</span> : null;
      })()}
    </div>
    <div className="flex justify-between mt-2 text-caption font-mono text-muted">
      <span>20 min ago</span><span>now</span>
    </div>
    {error && !data && <p role="status" className="text-caption text-muted mt-2">Recent blocks are unavailable.</p>}
  </div>;
}
