/** Collector receipt time is separate from the miner-provided header timestamp. */
export function BlockFirstSeen({ value }: { value?: string | null }) {
  const date = value ? new Date(value) : null;
  const iso = date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  return (
    <div className="text-xs font-mono text-secondary">
      <span className="block text-caption text-muted uppercase">First seen by ZecBlock (UTC)</span>
      {iso ? <time dateTime={iso}>{iso.replace('T', ' ').replace('Z', ' UTC')}</time> : 'Not recorded'}
    </div>
  );
}

export const BLOCK_FIRST_SEEN_EXPLANATION = 'First seen records when ZecBlock received our local node’s tip response, polled every second. RPC latency, outages and missed tips can delay or prevent observation; this is not the node’s peer-arrival time. Older blocks may have no observation.';

/** Signed first-seen minus header time, e.g. "+12s", "+1m 38s", "−4s". Header time has whole-second precision. */
export function formatObservationLag(seconds: number): string {
  const whole = Math.round(seconds);
  const abs = Math.abs(whole);
  const text = abs < 60 ? `${abs}s` : `${Math.floor(abs / 60)}m ${abs % 60}s`;
  return `${whole < 0 ? '−' : '+'}${text}`;
}

/** Compact second line for the block Timestamp fact; renders nothing for unobserved blocks. */
export function BlockSeenLine({ firstSeenAt, headerTimestamp }: { firstSeenAt?: string | null; headerTimestamp: number }) {
  const seen = firstSeenAt ? new Date(firstSeenAt) : null;
  if (!seen || !Number.isFinite(seen.getTime()) || !Number.isFinite(headerTimestamp)) return null;
  const lag = seen.getTime() / 1000 - headerTimestamp;
  const time = seen.toISOString().slice(11, 19);
  return (
    <span className="block mt-1 text-xs text-muted whitespace-nowrap">
      Seen by ZecBlock <time dateTime={seen.toISOString()} className="font-mono">{time} UTC</time>{' '}
      <span className="font-mono tabular-nums text-secondary">({formatObservationLag(lag)})</span>
    </span>
  );
}
