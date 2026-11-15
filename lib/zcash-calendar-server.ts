import 'server-only';
import { unstable_cache } from 'next/cache';
import { after } from 'next/server';
import { getApiUrlForNetwork } from './api-config';
import { readApiData } from './api-client';
import { fetchWithDeadline } from './server-fetch';
import { getGovernanceCatalog } from './governance-data';
import { GRANT_ROUNDS } from './grant-rounds';
import { isGrantsRound } from './governance';
import { loadUpgradeTrackers } from './upgrade-trackers-server';
import { RESOLVED_EVENT_BLOCKS, calendarSources, resolveCalendar, type CalendarEvent, type RegisteredRound } from './zcash-calendar';
import type { UpgradeSnapshot } from './network-upgrades';

const api = () => `${getApiUrlForNetwork('mainnet')}/v1/blocks`;
type BlockRow = { height: number; timestamp: number };

async function blocks(query: string): Promise<BlockRow[]> {
  const response = await fetchWithDeadline(`${api()}?${query}`, { next: { revalidate: 86_400 } }, 4_000);
  if (!response.ok) throw new Error(`blocks ${response.status}`);
  const rows = await readApiData(response) as BlockRow[] | null;
  return Array.isArray(rows) ? rows.filter(r => Number.isSafeInteger(r?.height) && Number.isSafeInteger(r?.timestamp)) : [];
}

/**
 * First block (by height) whose header time is at or after `at`; for a
 * date-only day, the first block of that UTC day. Bounded to a few requests.
 */
async function firstBlockAt(at: string, nu7Height: number | null): Promise<number | null> {
  const day = at.slice(0, 10);
  const [first] = await blocks(`from=${day}&to=${day}&order=oldest&limit=1`);
  if (!first) return null;
  if (at.length === 10) return first.height;
  const target = Date.parse(at) / 1000;
  if (first.timestamp >= target) return first.height;
  const spacing = nu7Height !== null && first.height >= nu7Height ? 25 : 75;
  let from = first.height + Math.max(0, Math.floor((target - first.timestamp) / spacing) - 60);
  for (let attempt = 0; attempt < 5; attempt++) {
    const rows = await blocks(`from=${day}&to=${day}&order=oldest&limit=100&min_height=${from}`);
    if (rows.length === 0) return null;
    if (rows[0].timestamp >= target && rows[0].height > first.height) { from = Math.max(first.height, from - 300); continue; }
    const hit = rows.find(row => row.timestamp >= target);
    if (hit) return hit.height;
    from = rows[rows.length - 1].height + 1;
  }
  return null;
}

const resolveEventBlock = (id: string, at: string, nu7Height: number | null) => unstable_cache(
  async () => firstBlockAt(at, nu7Height),
  ['calendar-event-block-v1', id, at],
  // Old headers are immutable; a short-lived null retries soon.
  { revalidate: 7 * 86_400 },
)();

async function loadHalving(): Promise<{ height: number; estimatedAt: number | null } | null> {
  try {
    const response = await fetchWithDeadline(`${getApiUrlForNetwork('mainnet')}/v1/network/halving`, { next: { revalidate: 300 } });
    if (!response.ok) return null;
    const data = await readApiData(response) as { halvingStatus?: string; halvingBlock?: unknown; estimatedDate?: unknown } | null;
    const height = data?.halvingBlock;
    if (data?.halvingStatus !== 'available' || typeof height !== 'number' || !Number.isSafeInteger(height) || height <= 0) return null;
    // The API estimate uses measured indexed block cadence, so prefer it over target spacing.
    const estimatedAt = typeof data.estimatedDate === 'string' ? Date.parse(data.estimatedDate) : NaN;
    return { height, estimatedAt: Number.isFinite(estimatedAt) ? estimatedAt : null };
  } catch { return null; }
}

export type CalendarPayload = {
  events: CalendarEvent[];
  tip: number | null;
  tipTime: number | null;
  spacing: number | null;
  eras: { height: number; seconds: number }[];
  generatedAt: number;
};

export async function loadCalendar(): Promise<CalendarPayload> {
  const [{ snapshot }, halving, catalog] = await Promise.all([loadUpgradeTrackers('mainnet'), loadHalving(), getGovernanceCatalog()]);
  const registered: Record<string, RegisteredRound> = {};
  for (const round of GRANT_ROUNDS) {
    const matches = catalog.votes.filter(vote => isGrantsRound(vote.round, round));
    if (matches.length === 1) registered[round.slug] = { snapshotHeight: matches[0].round.snapshot_height, voteEnd: matches[0].round.vote_end_time * 1000 };
  }
  const now = Date.now();
  const nu7Height = snapshot?.schedule.nu7Height ?? null;
  const base = { nu7Height, halvingHeight: halving?.height ?? null, halvingEstimatedAt: halving?.estimatedAt ?? null, registered };
  // Dated events that have passed but have no pinned block resolve from indexed headers.
  const pending = calendarSources(base).filter(s => 'at' in s.anchor && s.anchor.height === undefined && !RESOLVED_EVENT_BLOCKS[s.id] && Date.parse(s.anchor.at) + (s.anchor.at.length === 10 ? 86_400_000 : 0) < now - 600_000);
  const resolved: Record<string, number> = {};
  if (pending.length) {
    const work = Promise.allSettled(pending.map(async s => {
      const at = (s.anchor as { at: string }).at;
      const height = await resolveEventBlock(s.id, at, nu7Height);
      if (height !== null) resolved[s.id] = height;
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([work.then(() => true), new Promise<false>(r => { timer = setTimeout(() => r(false), 1_500); })]);
    clearTimeout(timer);
    if (!finished) after(async () => { await work; });
  }
  const events = resolveCalendar(calendarSources({ ...base, resolved }), snapshot, now);
  return {
    events, tip: snapshot?.height ?? null, tipTime: snapshot?.tipTimestamp ?? null,
    spacing: currentSpacing(snapshot), eras: snapshot?.schedule.eras ?? [], generatedAt: now,
  };
}

function currentSpacing(snapshot: UpgradeSnapshot | null) {
  return snapshot ? snapshot.schedule.eras.findLast(era => era.height <= snapshot.height)?.seconds ?? null : null;
}
