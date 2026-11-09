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

export const BLOCK_FIRST_SEEN_EXPLANATION = 'First seen is the earliest time any ZecBlock observer received the block. Our observers run their own Zcash nodes in several regions and record each block from the node’s block stream; the Helsinki node also checks its tip once a second. Before 5 November 2026, only the Helsinki node observed blocks. Outages can delay or prevent observation, and this is not the time the block first reached the network. Older blocks may have no observation.';

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
