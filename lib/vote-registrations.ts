/**
 * Live voting-registration count for a round that has no pinned figure yet.
 *
 * zvote-1 has no endpoint that returns delegation counts, and its REST gateway
 * cannot decode the chain's custom transactions, so a normal transaction search
 * fails. Asking for an out-of-range page of one-row pages instead makes the node
 * report its page range, which is the number of matching transactions.
 *
 * That is an error path, so every step fails closed: an unrecognized response,
 * an ambiguous count, or totals that do not fit the round's commitment tree
 * (for example a node whose transaction index was pruned) yield no figure.
 */
export const REGISTRATION_EVENTS = ['delegate_vote', 'delegate_and_cast_vote_batch', 'cast_vote', 'cast_vote_batch'] as const;
export type RegistrationEvent = typeof REGISTRATION_EVENTS[number];
export type ProbeResponse = { status: number; body: unknown };
export type Probe = (path: string) => Promise<ProbeResponse>;
/** An exact count, or a closed interval when the node cannot tell zero from one. */
type Interval = { lo: number; hi: number };

const OUT_OF_RANGE_PAGE = 9_999_999;
const RANGE_MESSAGE = new RegExp(`^failed to search for txs: page should be within \\[1, (\\d{1,9})\\] range, given ${OUT_OF_RANGE_PAGE}$`);
const ROUND_ID = /^[a-f0-9]{64}$/;

const searchPath = (event: RegistrationEvent, roundId: string, paging: string) =>
  `/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(`${event}.vote_round_id='${roundId}'`)}&${paging}`;
export const countPath = (event: RegistrationEvent, roundId: string) => searchPath(event, roundId, `page=${OUT_OF_RANGE_PAGE}&limit=1`);
export const firstRowPath = (event: RegistrationEvent, roundId: string) => searchPath(event, roundId, 'pagination.limit=1&pagination.count_total=true');
export const treePath = (roundId: string) => `/shielded-vote/v1/commitment-tree/${roundId}/latest`;

const message = (body: unknown) => (body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string') ? (body as { message: string }).message : null;

/** One-row pages: the reported last page is the match count, except that zero matches also report one page. */
export function parseEventCount({ status, body }: ProbeResponse): Interval | null {
  if (status !== 500) return null;
  const match = RANGE_MESSAGE.exec(message(body) ?? '');
  if (!match) return null;
  const pages = Number(match[1]);
  if (!Number.isSafeInteger(pages) || pages < 1) return null;
  return pages === 1 ? { lo: 0, hi: 1 } : { lo: pages, hi: pages };
}

/** Settles zero versus one: an empty search succeeds, a single undecodable match fails to parse. */
export function parseZeroOrOne({ status, body }: ProbeResponse): 0 | 1 | null {
  if (status === 200 && body && typeof body === 'object') {
    const total = (body as { total?: unknown }).total;
    return total === '0' || total === 0 ? 0 : total === '1' || total === 1 ? 1 : null;
  }
  return status === 500 && /tx parse error$/.test(message(body) ?? '') ? 1 : null;
}

export function parseTreeLeaves({ status, body }: ProbeResponse): number | null {
  if (status !== 200 || !body || typeof body !== 'object') return null;
  const tree = (body as { tree?: unknown }).tree;
  if (!tree || typeof tree !== 'object') return null;
  // Protobuf omits a zero next_index on an empty tree.
  const raw = (tree as { next_index?: unknown }).next_index ?? 0;
  const leaves = typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : raw;
  return typeof leaves === 'number' && Number.isSafeInteger(leaves) && leaves >= 0 ? leaves : null;
}

/**
 * Leaves each message appends to the round tree: delegation 1, cast vote 2,
 * either batch 1 + its votes (between one vote and one per proposal).
 * `slack` absorbs submissions landing between the separate reads of an open round.
 */
export function fitsTree(counts: Record<RegistrationEvent, Interval>, leaves: number, proposals: number, slack: number): boolean {
  const lo = counts.delegate_vote.lo + 2 * counts.cast_vote.lo + 2 * (counts.cast_vote_batch.lo + counts.delegate_and_cast_vote_batch.lo);
  const hi = counts.delegate_vote.hi + 2 * counts.cast_vote.hi + (1 + proposals) * (counts.cast_vote_batch.hi + counts.delegate_and_cast_vote_batch.hi);
  return lo - slack <= leaves && leaves <= hi + slack;
}

/** Registrations (delegations, standalone or combined with votes) for one round, or null when not established. */
export async function readLiveRegistrations(roundId: string, proposals: number, probe: Probe, open: boolean): Promise<number | null> {
  if (!ROUND_ID.test(roundId) || !Number.isSafeInteger(proposals) || proposals < 1) return null;
  const [tree, ...ranges] = await Promise.all([probe(treePath(roundId)), ...REGISTRATION_EVENTS.map(event => probe(countPath(event, roundId)))]);
  const leaves = parseTreeLeaves(tree);
  if (leaves === null) return null;
  const counts = {} as Record<RegistrationEvent, Interval>;
  for (const [i, event] of REGISTRATION_EVENTS.entries()) {
    let count = parseEventCount(ranges[i]);
    if (!count) return null;
    // Only delegations are displayed, so only they need an exact value.
    if (count.lo !== count.hi && (event === 'delegate_vote' || event === 'delegate_and_cast_vote_batch')) {
      const settled = parseZeroOrOne(await probe(firstRowPath(event, roundId)));
      if (settled === null) return null;
      count = { lo: settled, hi: settled };
    }
    counts[event] = count;
  }
  if (!fitsTree(counts, leaves, proposals, open ? 4 * (1 + proposals) : 0)) return null;
  return counts.delegate_vote.lo + counts.delegate_and_cast_vote_batch.lo;
}
