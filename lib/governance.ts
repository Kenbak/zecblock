import { z } from 'zod';
import { NU7_ROUND_ID, ZEC_PER_VOTE_UNIT } from './nu7-vote-results';
import { CURRENT_GRANT_ROUND, GRANT_ROUNDS, grantRoundForDiscussion, type GrantRound } from './grant-rounds';

export const GOVERNANCE_API = 'https://prod.vote-chain-primary.valargroup.org/shielded-vote/v1';
// Pin both identity and address: a new registry entry is not automatically trusted.
export const TRUSTED_ENDORSER = { id: 'zodl', address: 'sv17k5lukq3g49qkemf7e6cax2umweftm0k3mrkzq' };
/** The currently announced grants round (kept as GRANTS for existing callers). */
export const GRANTS = {
  slug: CURRENT_GRANT_ROUND.slug,
  title: CURRENT_GRANT_ROUND.title,
  description: CURRENT_GRANT_ROUND.description,
  opensOn: CURRENT_GRANT_ROUND.schedule.votingOpensOn,
  closesOn: CURRENT_GRANT_ROUND.schedule.votingClose.slice(0, 10),
  source: CURRENT_GRANT_ROUND.source,
  schedule: CURRENT_GRANT_ROUND.callForProposals,
} as const;

const integer = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const bytes32 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
// Leading size checks reject before Zod visits individual elements. These are
// admission limits, not claims about the number of votes/proposals upstream.
export const GOVERNANCE_LIMITS = { rounds: 2000, endorsers: 2000, proposals: 500, options: 100, results: 50_000 } as const;
const option = z.object({ index: integer.default(0), label: z.string().min(1).max(4000), description: z.string().max(20000).default(''), total_value: integer.default(0) });
const proposal = z.object({ id: integer, title: z.string().min(1).max(4000), description: z.string().max(50000).default(''), options: z.array(option).max(GOVERNANCE_LIMITS.options).min(1) });
export const roundSchema = z.object({
  vote_round_id: bytes32, title: z.string().min(1).max(4000), description: z.string().max(50000).default(''),
  status: integer, vote_end_time: integer, snapshot_height: integer, snapshot_blockhash: bytes32,
  discussion_url: z.string().default(''), proposals: z.array(proposal).max(GOVERNANCE_LIMITS.proposals).min(1),
  tally_timed_out: z.boolean().default(false),
});
export type Round = z.infer<typeof roundSchema>;
export type Proposal = z.infer<typeof proposal>;
export type VoteState = 'upcoming' | 'active' | 'tallying' | 'results' | 'failed' | 'unavailable';
export type Vote = { id: string; title: string; description: string; href: string; state: VoteState; round: Round; proposals: Proposal[]; zecPerUnit: number | null };
export type Catalog = { votes: Vote[]; checkedAt: number; directoryCheckedAt?: number; unavailable: boolean };
export const STATE_LABELS: Record<VoteState, string> = {
  upcoming: 'Preparing vote', active: 'Voting open', tallying: 'Tallying', results: 'Results published', failed: 'Vote unsuccessful', unavailable: 'Results unavailable',
};

export function roundHex(base64: string): string {
  return Array.from(atob(base64), c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}
export function isGrantsRound(round: Round, grants: GrantRound = CURRENT_GRANT_ROUND): boolean {
  // Exact official discussion identity; never associate a ballot by title alone.
  return grantRoundForDiscussion(round.discussion_url)?.slug === grants.slug;
}
export function grantRoundOf(round: Round): GrantRound | undefined {
  return grantRoundForDiscussion(round.discussion_url);
}
export { GRANT_ROUNDS };
export function roundHref(round: Round): string {
  const id = roundHex(round.vote_round_id);
  return `/governance/${id === NU7_ROUND_ID ? 'nu7' : id}`;
}

export function selectTrustedRounds(raw: unknown, registry: unknown, endorsements: unknown): Round[] {
  const directory = z.object({ rounds: z.array(z.unknown()).max(GOVERNANCE_LIMITS.rounds).default([]) }).parse(raw);
  const identity = z.object({ endorsers: z.array(z.object({ endorser_id: z.string(), address: z.string() })).max(GOVERNANCE_LIMITS.endorsers).default([]) }).parse(registry);
  const endorsed = z.object({ vote_round_ids: z.array(bytes32).max(GOVERNANCE_LIMITS.rounds).default([]) }).parse(endorsements);
  const trusted = identity.endorsers.some(e => e.endorser_id === TRUSTED_ENDORSER.id && e.address === TRUSTED_ENDORSER.address);
  const ids = new Set(trusted ? endorsed.vote_round_ids : []);
  const rounds: Round[] = [];
  for (const item of directory.rounds) {
    // Reject malformed trusted records rather than silently dropping an existing vote.
    const candidate = z.object({ vote_round_id: bytes32 }).safeParse(item);
    if (!candidate.success) continue;
    if (roundHex(candidate.data.vote_round_id) !== NU7_ROUND_ID && !ids.has(candidate.data.vote_round_id)) continue;
    const round = roundSchema.parse(item);
    if (rounds.some(r => r.vote_round_id === round.vote_round_id)) throw new Error('Duplicate round');
    const proposalIds = new Set(round.proposals.map(p => p.id));
    if (proposalIds.size !== round.proposals.length || round.proposals.some(p => new Set(p.options.map(o => o.index)).size !== p.options.length)) throw new Error('Duplicate ballot identifiers');
    rounds.push(round);
  }
  return rounds;
}

export function parseRoundVote(round: Round, summary: unknown, tally: unknown, now: number): Vote {
  const id = roundHex(round.vote_round_id);
  const vote: Vote = { id, title: id === NU7_ROUND_ID ? 'NU7 Coinholder Vote' : round.title, description: round.description,
    href: roundHref(round), state: 'unavailable', round, proposals: round.proposals,
    // The current svote v1 protocol uses BALLOT_DIVISOR = 12,500,000 zatoshi.
    // Revisit this adapter if the voting protocol changes its quantization.
    zecPerUnit: ZEC_PER_VOTE_UNIT };
  if (round.tally_timed_out || round.status === 5) return { ...vote, state: 'failed' };
  if (round.status === 4) return { ...vote, state: 'upcoming' };
  if (round.status === 1) return { ...vote, state: now >= round.vote_end_time * 1000 ? 'tallying' : 'active' };
  if (round.status === 2) return { ...vote, state: 'tallying' };
  if (round.status !== 3) return vote;
  const parsed = z.object({ vote_round_id: z.literal(round.vote_round_id), status: z.literal(3), vote_end_time: z.literal(round.vote_end_time), proposals: z.array(proposal).max(GOVERNANCE_LIMITS.proposals) }).safeParse(summary);
  const totals = z.object({ results: z.array(z.object({ vote_round_id: z.literal(round.vote_round_id), proposal_id: integer, vote_decision: integer.default(0), total_value: integer.default(0) })).max(GOVERNANCE_LIMITS.results) }).safeParse(tally);
  if (!parsed.success || !totals.success || parsed.data.proposals.length !== round.proposals.length) return vote;
  const expected = new Set(round.proposals.flatMap(p => p.options.map(o => `${p.id}:${o.index}`)));
  const tuples = new Map(totals.data.results.map(r => [`${r.proposal_id}:${r.vote_decision}`, r.total_value]));
  // The tally endpoint is sparse: an option with no votes may have no row.
  // Still reject duplicates and unknown options; below, an absent row must
  // agree with a zero total in the complete, finalized summary.
  if (tuples.size !== totals.data.results.length || [...tuples.keys()].some(key => !expected.has(key))) return vote;
  if (new Set(parsed.data.proposals.map(p => p.id)).size !== round.proposals.length) return vote;
  for (const p of parsed.data.proposals) {
    const registered = round.proposals.find(r => r.id === p.id);
    if (!registered || p.title !== registered.title || p.description !== registered.description || p.options.length !== registered.options.length || new Set(p.options.map(o => o.index)).size !== p.options.length) return vote;
    if (!Number.isSafeInteger(p.options.reduce((n, o) => n + o.total_value, 0))) return vote;
    for (const o of p.options) {
      const original = registered.options.find(r => r.index === o.index);
      if (!original || original.label !== o.label || original.description !== o.description || (tuples.get(`${p.id}:${o.index}`) ?? 0) !== o.total_value) return vote;
    }
  }
  return { ...vote, state: 'results', proposals: parsed.data.proposals };
}

export function catalogIsStale(catalog: Catalog, now: number): boolean {
  return catalog.unavailable || now - catalog.checkedAt > 10 * 60_000;
}
export function catalogDirectoryIsStale(catalog: Catalog, now: number): boolean {
  return catalog.unavailable || now - (catalog.directoryCheckedAt ?? catalog.checkedAt) > 10 * 60_000;
}
export type Announcement = {
  key: string; href: string; text: string;
  /** A registered snapshot block: the banner counts blocks down to it from the live tip. */
  snapshotHeight?: number;
  /** One short secondary line, e.g. eligibility preparation. */
  hint?: string;
};
const DAY = 86_400_000;
const fmtDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
export const SHIELD_HINT = 'Only ZEC shielded in Ironwood at this block can vote.';

/** Curated date-only notice: the seven days before the official voting date, as in Q3. */
export function grantAnnouncementWindow(grants: GrantRound = CURRENT_GRANT_ROUND) {
  const to = Date.parse(`${grants.schedule.votingOpensOn}T00:00:00Z`);
  return { from: to - 7 * DAY, to };
}

export function selectAnnouncement(catalog: Catalog, now: number): Announcement | null {
  // Current voting status comes from the directory. An unrelated historical
  // tally failing to refresh must not hide a freshly confirmed open vote.
  const active = !catalogDirectoryIsStale(catalog, now) && catalog.votes.filter(v => v.state === 'active' && v.round.vote_end_time * 1000 > now).sort((a, b) => a.round.vote_end_time - b.round.vote_end_time)[0];
  if (active) return { key: `${active.id}:active`, href: active.href, text: `${active.title}: voting is open` };
  // A registered grants round publishes its snapshot block: the one moment to count down to.
  const preparing = !catalogDirectoryIsStale(catalog, now) && catalog.votes.find(v => v.state === 'upcoming' && isGrantsRound(v.round));
  if (preparing) return { key: `${preparing.id}:snapshot`, href: preparing.href, text: `${CURRENT_GRANT_ROUND.quarter} grants vote snapshot · Block ${preparing.round.snapshot_height.toLocaleString('en-US')}`, snapshotHeight: preparing.round.snapshot_height, hint: SHIELD_HINT };
  // Date-only announcement: never invent an exact opening time or transition to active by the clock.
  const window = grantAnnouncementWindow();
  if (!catalog.votes.some(v => isGrantsRound(v.round)) && now >= window.from && now < window.to) {
    return { key: `${GRANTS.slug}:upcoming`, href: `/governance/${GRANTS.slug}`, text: `${CURRENT_GRANT_ROUND.quarter} grants voting opens ${fmtDay(CURRENT_GRANT_ROUND.schedule.votingOpensOn)} · Review the proposals` };
  }
  // Bound announcements by the on-chain closing time; refreshes cannot restart the window.
  const result = !catalogIsStale(catalog, now) && catalog.votes.filter(v => v.state === 'results' && now >= v.round.vote_end_time * 1000 && now < v.round.vote_end_time * 1000 + 5 * DAY).sort((a, b) => b.round.vote_end_time - a.round.vote_end_time)[0];
  if (result) return { key: `${result.id}:results`, href: result.href, text: `${result.title}: results are live · Explore and verify the tally` };
  return null;
}
