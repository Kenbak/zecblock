import { CURRENT_GRANT_ROUND, GRANT_ROUNDS, grantTotals } from './grant-rounds';
import { estimateBlockArrival, type UpgradeSnapshot } from './network-upgrades';
import { HISTORICAL_UPGRADES } from './upgrade-history-data';
import { NU7_VOTE } from './nu7-vote-config';

/**
 * Zcash block calendar: the important heights and dates of mainnet, past and
 * future. An event is anchored either to a block (its height is exact and its
 * date is observed or estimated) or to an official UTC instant/date (its date
 * is exact and its height is observed or estimated). Estimates are always
 * labelled; nothing estimated is presented as scheduled by consensus.
 */
export type CalendarKind = 'upgrade' | 'halving' | 'vote' | 'poll' | 'snapshot' | 'deadline' | 'milestone';

export const CALENDAR_KINDS: Record<CalendarKind, { label: string; plural: string }> = {
  upgrade: { label: 'Network upgrade', plural: 'Upgrades' },
  halving: { label: 'Halving', plural: 'Halvings' },
  vote: { label: 'Coinholder vote', plural: 'Votes' },
  poll: { label: 'Miner poll', plural: 'Miner polls' },
  snapshot: { label: 'Vote snapshot', plural: 'Snapshots' },
  deadline: { label: 'Deadline', plural: 'Deadlines' },
  milestone: { label: 'Milestone', plural: 'Milestones' },
};

type Anchor =
  /** Consensus or chain-observed height; `time` is the mined header time when known (seconds). */
  | { height: number; time?: number; estimatedTime?: number }
  /** Official UTC instant (ISO with time) or a date-only official day (YYYY-MM-DD). */
  | { at: string; height?: number };

export type CalendarSource = {
  id: string; kind: CalendarKind; title: string; detail: string;
  anchor: Anchor; href?: string; external?: boolean;
};

export type CalendarEvent = CalendarSource & {
  height: number | null;
  heightEstimated: boolean;
  /** Milliseconds since epoch; null when unknown. */
  time: number | null;
  timeEstimated: boolean;
  /** A date-only official day: no hour is claimed. */
  dateOnly: boolean;
  status: 'past' | 'upcoming';
  /** 'block': defined by a height. 'dated': defined by an official date or UTC time. */
  anchorKind: 'block' | 'dated';
};

const DAY = 86_400_000;
/**
 * Real blocks for dated events that already happened: the first block (by
 * height) with a header time at or after the deadline, or the first block of
 * the UTC day for date-only events. Read from indexed mainnet headers on
 * 2026-11-15; immutable below the reorg window. Later events resolve at runtime.
 */
export const RESOLVED_EVENT_BLOCKS: Record<string, number> = {
  'nu7-vote-open': 3_460_284, 'nu7-vote-close': 3_483_412,
  'retroactive-grants-q3-2026-submissions': 3_447_909, 'retroactive-grants-q3-2026-review': 3_485_752,
  'retroactive-grants-q3-2026-vote-open': 3_485_943, 'retroactive-grants-q3-2026-vote-close': 3_500_662,
  'retroactive-grants-q4-2026-submissions': 3_569_925,
  'devfund-poll-proposals': 3_553_223,
};
/** Q3 2026's registered snapshot (round 2cba66eb…) and its mined header time. */
const KNOWN_GRANT_SNAPSHOTS: Record<string, { height: number; time: number }> = { 'retroactive-grants-q3-2026': { height: 3_485_940, time: 1789602914 } };
const upgradeTimes: Record<string, number> = {
  overwinter: 1529977051, sapling: 1540779337, blossom: 1576101005, heartwood: 1594896968, canopy: 1605702856,
  nu5: 1654019405, nu6: 1732359779, nu61: 1764014202, nu62: 1780459388, nu63: 1785247643,
};

/** Mainnet milestone definitions. Heights/timestamps were read from mined headers. */
export type RegisteredRound = { snapshotHeight?: number; voteEnd?: number };
export function calendarSources(options: { nu7Height?: number | null; halvingHeight?: number | null; halvingEstimatedAt?: number | null; registered?: Record<string, RegisteredRound>; resolved?: Record<string, number> } = {}): CalendarSource[] {
  const sources: CalendarSource[] = [
    { id: 'genesis', kind: 'milestone', title: 'Genesis block', detail: 'Zcash mainnet launches with the Sprout shielded pool.', anchor: { height: 0, time: 1477641360 }, href: '/block/0' },
    ...HISTORICAL_UPGRADES.map(upgrade => ({
      id: upgrade.id, kind: 'upgrade' as const,
      title: upgrade.id === 'nu63' ? 'NU6.3 · Ironwood' : upgrade.label, detail: upgrade.summary,
      anchor: { height: upgrade.heights.mainnet, time: upgradeTimes[upgrade.id] }, href: `/network/upgrades#${upgrade.id}`,
    })),
    { id: 'halving-1', kind: 'halving', title: 'First halving', detail: 'Block subsidy halves from 6.25 to 3.125 ZEC, alongside Canopy.', anchor: { height: 1_046_400, time: 1605702856 }, href: '/block/1046400' },
    { id: 'halving-2', kind: 'halving', title: 'Second halving', detail: 'Block subsidy halves from 3.125 to 1.5625 ZEC, alongside NU6.', anchor: { height: 2_726_400, time: 1732359779 }, href: '/block/2726400' },
    { id: 'nu7-snapshot', kind: 'snapshot', title: 'NU7 vote: snapshot', detail: 'Ironwood balances at this block set voting weight for the NU7 poll.', anchor: { height: NU7_VOTE.snapshotHeight, time: Date.parse(NU7_VOTE.snapshotTime) / 1000 }, href: `/block/${NU7_VOTE.snapshotHeight}` },
    { id: 'nu7-vote-open', kind: 'vote', title: 'NU7 vote: voting opens', detail: 'Coinholders vote on NU7 scope: issuance, Sprout, block time and readiness.', anchor: { at: NU7_VOTE.voteStartTime }, href: '/governance/nu7' },
    { id: 'nu7-vote-close', kind: 'vote', title: 'NU7 vote: voting closes', detail: 'Results published with independent tally verification.', anchor: { at: NU7_VOTE.voteEndTime }, href: '/governance/nu7' },
  ];
  // ZCG / Dev Fund poll, announced by the five organizations that coordinate the voting chain.
  const devFund = 'https://forum.zcashcommunity.com/t/zcg-and-the-dev-fund-timeline-for-proposals-and-polling/58906';
  sources.push(
    { id: 'devfund-poll-proposals', kind: 'deadline', title: 'Dev Fund poll: proposals close', detail: 'Deadline for proposals on ZCG’s share of the Dev Fund (23:59 UTC).', anchor: { at: '2026-11-08T23:59:00Z' }, href: devFund, external: true },
    { id: 'devfund-poll-open', kind: 'vote', title: 'Dev Fund poll: voting opens', detail: 'Coinholder and community-panel polls on ZCG’s share of the Dev Fund. Rough consensus would lead to NU7.1.', anchor: { at: '2026-11-16' }, href: devFund, external: true },
    { id: 'devfund-poll-close', kind: 'vote', title: 'Dev Fund poll: voting closes', detail: 'Polls close at 23:59 UTC; results follow shortly after.', anchor: { at: '2026-11-30T23:59:00Z' }, href: devFund, external: true },
    // NU7.1 miner sentiment poll (Zcash Foundation pilot). Heights are authoritative.
    { id: 'miner-poll-open', kind: 'poll', title: 'NU7.1 miner poll: voting opens', detail: 'Miners signal on the five NU7.1 questions with a ballot in each block they mine.', anchor: { height: 3_591_200 }, href: '/governance/nu7-1-miner-poll' },
    { id: 'miner-poll-close', kind: 'poll', title: 'NU7.1 miner poll: voting closes', detail: 'Last block that counts; the result is final 100 blocks later.', anchor: { height: 3_629_650 }, href: '/governance/nu7-1-miner-poll' },
    // ZIP 2009 deployment: nodes report the lower fee to wallets from this block (wallet fee policy, not a consensus rule).
    { id: 'zip2009-fee', kind: 'milestone', title: 'Standard fee drops to 1,000 zatoshis', detail: 'Wallets move together from 5,000 to 1,000 zatoshis per logical action (ZIP 2009).', anchor: { height: 3_590_000 }, href: 'https://zips.z.cash/zip-2009', external: true },
    // ZIP 237 / ZIP 259: NSM begins reissuing part of the reserve on top of block rewards.
    { id: 'nsm-reissuance', kind: 'milestone', title: 'NSM reissuance begins', detail: 'Blocks start reissuing a small, predictable part of the NSM reserve on top of the normal reward (ZIP 237).', anchor: { height: 8_939_664 }, href: '/network#nu7-accounting' },
  );
  if (options.nu7Height) sources.push({ id: 'nu7', kind: 'upgrade', title: 'NU7', detail: '25-second blocks, the Network Sustainability Mechanism and updated transaction rules.', anchor: { height: options.nu7Height, ...(options.nu7Height === 3_543_405 ? { time: 1793932442 } : {}) }, href: '/network/upgrades#nu7' });
  if (options.halvingHeight) sources.push({ id: 'halving-3', kind: 'halving', title: 'Third halving', detail: 'Block subsidy halves again. Height from the serving node’s current upgrade schedule.', anchor: { height: options.halvingHeight, ...(options.halvingEstimatedAt ? { estimatedTime: options.halvingEstimatedAt } : {}) }, href: `/block/${options.halvingHeight}` });

  for (const round of GRANT_ROUNDS) {
    const s = round.schedule;
    const current = round.slug === CURRENT_GRANT_ROUND.slug;
    const href = `/governance/${round.slug}`;
    const name = `${round.quarter} grants`;
    const count = round.proposals.length ? `${grantTotals(round).count} proposals` : 'Proposals';
    const registered = options.registered?.[round.slug];
    sources.push(
      { id: `${round.slug}-submissions`, kind: 'deadline', title: `${name}: submissions close`, detail: 'Last day to submit a retroactive grant proposal. Proposals are then locked.', anchor: { at: s.submissionsClose }, href },
      { id: `${round.slug}-review`, kind: 'deadline', title: `${name}: review closes`, detail: `${count} end their 30-day community review.`, anchor: { at: s.reviewClose }, href },
      { id: `${round.slug}-vote-open`, kind: 'vote', title: `${name}: voting opens`, detail: current ? 'Coinholders vote on each proposal. Opening hour to be confirmed.' : 'Coinholders vote on each proposal.', anchor: { at: s.votingOpensOn }, href },
      // A registered ballot's on-chain deadline is authoritative over the announced schedule.
      { id: `${round.slug}-vote-close`, kind: 'vote', title: `${name}: voting closes`, detail: 'Voting ends; results follow once the tally is published.', anchor: { at: registered?.voteEnd ? new Date(registered.voteEnd).toISOString() : s.votingClose }, href },
    );
    const known = KNOWN_GRANT_SNAPSHOTS[round.slug];
    const snapshot = registered?.snapshotHeight && registered.snapshotHeight !== known?.height ? { height: registered.snapshotHeight } : known;
    if (snapshot) sources.push({ id: `${round.slug}-snapshot`, kind: 'snapshot', title: `${name}: vote snapshot`, detail: 'Only ZEC shielded in Ironwood at this block can vote.', anchor: snapshot, href: `/block/${snapshot.height}` });
  }
  // Attach real blocks to dated events that have happened.
  const resolved = { ...RESOLVED_EVENT_BLOCKS, ...options.resolved };
  for (const source of sources) {
    const height = resolved[source.id];
    if (height !== undefined && 'at' in source.anchor) source.anchor = { ...source.anchor, height };
  }
  return sources;
}


function estimateHeightAt(snapshot: UpgradeSnapshot | null, time: number): number | null {
  if (!snapshot || snapshot.tipTimestamp === null) return null;
  const seconds = time / 1000 - snapshot.tipTimestamp;
  if (seconds <= 0) return null;
  const spacing = snapshot.schedule.eras.findLast(era => era.height <= snapshot.height)?.seconds;
  if (!spacing) return null;
  return snapshot.height + Math.round(seconds / spacing);
}

export function resolveCalendar(sources: CalendarSource[], snapshot: UpgradeSnapshot | null, now: number): CalendarEvent[] {
  const tip = snapshot?.height ?? null;
  return sources.map((source): CalendarEvent => {
    if ('height' in source.anchor && !('at' in source.anchor)) {
      const { height, time, estimatedTime } = source.anchor;
      const reached = tip !== null && height <= tip;
      if (time !== undefined) return { ...source, anchorKind: 'block', height, heightEstimated: false, time: time * 1000, timeEstimated: false, dateOnly: false, status: reached || tip === null ? 'past' : 'upcoming' };
      const estimate = !reached && estimatedTime === undefined && snapshot?.tipTimestamp != null ? estimateBlockArrival(snapshot, height) : null;
      const estimatedMs = estimatedTime ?? (estimate && snapshot?.tipTimestamp != null ? (snapshot.tipTimestamp + estimate.seconds) * 1000 : null);
      return { ...source, anchorKind: 'block', height, heightEstimated: false, time: reached ? null : estimatedMs, timeEstimated: true, dateOnly: false, status: reached ? 'past' : 'upcoming' };
    }
    const { at, height } = source.anchor as { at: string; height?: number };
    const dateOnly = at.length === 10;
    const time = Date.parse(dateOnly ? `${at}T00:00:00Z` : at);
    const past = dateOnly ? now >= time + DAY : now >= time;
    const estimated = height ?? (past ? null : estimateHeightAt(snapshot, dateOnly ? time + DAY / 2 : time));
    return { ...source, anchorKind: 'dated', height: estimated, heightEstimated: height === undefined && estimated !== null, time, timeEstimated: false, dateOnly, status: past ? 'past' : 'upcoming' };
  }).sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || (a.height ?? 0) - (b.height ?? 0));
}

/**
 * Events expected near a future block: exact-height events at that block, or
 * dated events whose estimated block is within `window` blocks of it.
 */
export function eventsNearBlock(events: CalendarEvent[], height: number, window: number): CalendarEvent[] {
  return events.filter(event => event.status === 'upcoming' && event.height !== null
    && (event.heightEstimated ? Math.abs(event.height - height) <= window : event.height === height));
}

export function formatCalendarDate(event: Pick<CalendarEvent, 'time' | 'dateOnly' | 'timeEstimated'>, withTime = true): string {
  if (event.time === null) return 'Date to be estimated';
  const date = new Date(event.time);
  const day = date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  if (event.dateOnly || !withTime) return `${event.timeEstimated ? '≈ ' : ''}${day}`;
  const time = date.toLocaleTimeString('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${event.timeEstimated ? '≈ ' : ''}${day} · ${time} UTC`;
}

export type HeightAnchor = { height: number; time: number };

/**
 * Anchors for mapping a moment to an approximate block: every event with an
 * exact height and mined time, plus the current tip. Sorted by time.
 */
export function heightAnchors(events: CalendarEvent[], tip: number | null, tipTime: number | null): HeightAnchor[] {
  const anchors = events
    .filter(e => e.height !== null && !e.heightEstimated && e.time !== null && !e.timeEstimated && !e.dateOnly)
    .map(e => ({ height: e.height!, time: e.time! }));
  if (tip !== null && tipTime !== null) anchors.push({ height: tip, time: tipTime * 1000 });
  const unique = new Map(anchors.map(a => [a.height, a]));
  return [...unique.values()].sort((a, b) => a.time - b.time);
}

/**
 * Approximate block at a moment: linear between mined anchors, and projected
 * forward from the tip at the current target spacing. Always an estimate.
 */
export function estimateHeightAtTime(anchors: HeightAnchor[], time: number, spacingSeconds: number | null): number | null {
  if (anchors.length === 0) return null;
  const first = anchors[0];
  if (time <= first.time) return first.height === 0 && time < first.time ? null : first.height;
  const last = anchors[anchors.length - 1];
  if (time >= last.time) return spacingSeconds ? last.height + Math.floor((time - last.time) / 1000 / spacingSeconds) : null;
  for (let i = 1; i < anchors.length; i++) {
    const b = anchors[i];
    if (time <= b.time) {
      const a = anchors[i - 1];
      return Math.round(a.height + (b.height - a.height) * (time - a.time) / (b.time - a.time));
    }
  }
  return null;
}

/** UTC calendar day key, YYYY-MM-DD. */
export const dayKey = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Countdown for a date-only event: "Today", "Tomorrow" or "N days"; never an invented hour. */
export function daysUntilLabel(time: number, now: number): string {
  const days = Math.max(0, Math.ceil((time - now) / 86_400_000));
  return days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `${days} days`;
}
