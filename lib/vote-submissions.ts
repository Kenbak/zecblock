/**
 * Voting-chain submission counts for finalized rounds, keyed by lowercase hex round ID.
 *
 * Before voting, a wallet registers its notes on zvote-1 in bundles of up to
 * five notes; each bundle is one delegation. Delegations are therefore an upper
 * limit on wallets, never a count of people, and no exact voter count exists.
 *
 * Counted on 2026-11-18 from zvote-1 transaction events filtered by
 * `vote_round_id` (delegate_vote, cast_vote, reveal_share and the batch
 * variants). A finalized round accepts no further submissions, so these are
 * pinned, not polled. `treeLeaves` is `next_index` of the round's commitment
 * tree and `revealedShares` the sum of `ballot_count` in the vote summary; both
 * are public API values the counts must reconcile with.
 */
export type RoundSubmissions = {
  /** Delegation messages: one per registered note bundle. */
  delegations: number;
  /** Encrypted vote commitments, one per registration per question answered. */
  votes?: number;
  revealedShares: number;
  treeLeaves: number;
  observedOn: string;
};

export const ROUND_SUBMISSIONS: Record<string, RoundSubmissions> = {
  // NU7 Scope. Unbatched messages only: 1,429 + 2 × 6,677 = 14,783 leaves.
  '16eef7ebc77e0e04fb1c7329abfcc390f4a0c002964671ebb360914a3e5a3f11': {
    delegations: 1429, votes: 6677, revealedShares: 104092, treeLeaves: 14783, observedOn: '2026-11-18',
  },
  // Q3 2026 retroactive grants. 90 standalone delegations + 811 combined
  // delegate-and-vote batches. Batches hide the per-vote count, so none is pinned.
  '2cba66eb16c7581a1692cb0b033785da0131059f645a0d2fb4dc2a5131505e01': {
    delegations: 901, revealedShares: 145620, treeLeaves: 36236, observedOn: '2026-11-18',
  },
};

export function roundSubmissions(roundId: string): RoundSubmissions | null {
  return Object.hasOwn(ROUND_SUBMISSIONS, roundId) ? ROUND_SUBMISSIONS[roundId] : null;
}
