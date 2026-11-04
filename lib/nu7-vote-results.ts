import { z } from 'zod';

// Pinned to the NU7 Scope round, snapshot 3459350, ending 2026-09-14 19:00 UTC.
// Never select the latest/active round: subsequent polls have different intent.
export const NU7_ROUND_ID = '16eef7ebc77e0e04fb1c7329abfcc390f4a0c002964671ebb360914a3e5a3f11';
const ROUND_BASE64 = 'Fu7368d+DgT7HHMpq/zDkPSgwAKWRnHrs2CRSj5aPxE=';
// vote-sdk UI formatBallots / zcash_voting governance::BALLOT_DIVISOR:
// 12,500,000 zatoshi per unit, NOT raw zatoshi despite the proto comment.
export const ZEC_PER_VOTE_UNIT = 0.125;
export const NU7_RESULTS_BASE = 'https://prod.vote-chain-primary.valargroup.org/shielded-vote/v1';
export const NU7_SUMMARY_URL = `${NU7_RESULTS_BASE}/vote-summary/${NU7_ROUND_ID}`;
export const NU7_TALLY_URL = `${NU7_RESULTS_BASE}/tally-results/${NU7_ROUND_ID}`;
export const NU7_VERIFY_COMMAND = `svoted query vote verify-tally ${NU7_ROUND_ID} \\\n  --node tcp://localhost:26657 --output json`;

const integer = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const optionSchema = z.object({
  index: integer.default(0), label: z.string().min(1), description: z.string().optional(),
  total_value: integer.default(0),
});
const summarySchema = z.object({
  vote_round_id: z.literal(ROUND_BASE64), status: integer,
  vote_end_time: z.literal(1789412400),
  proposals: z.array(z.object({ id: integer, title: z.string().min(1),
    description: z.string(), options: z.array(optionSchema).max(4) })).max(5),
});
const tallySchema = z.object({ results: z.array(z.object({
  vote_round_id: z.literal(ROUND_BASE64), proposal_id: integer,
  vote_decision: integer.default(0), total_value: integer.default(0),
})).max(19) });
export interface VoteResults {
  state: 'published' | 'pending' | 'unavailable';
  proposals: z.infer<typeof summarySchema>['proposals'];
}

export function parseVoteResults(summary: unknown, tally: unknown): VoteResults {
  const unavailable: VoteResults = { state: 'unavailable', proposals: [] };
  const parsed = summarySchema.safeParse(summary);
  if (!parsed.success) return unavailable;
  if (parsed.data.status === 1 || parsed.data.status === 2) return { state: 'pending', proposals: [] };
  if (parsed.data.status !== 3) return unavailable;
  const results = tallySchema.safeParse(tally);
  if (!results.success) return unavailable;
  // Require the full NU7 shape, unique IDs and all 19 finalized tuples. A timed-out
  // or incomplete tally must not silently turn missing options into zero votes.
  const proposals = [...parsed.data.proposals].sort((a, b) => a.id - b.id);
  if (proposals.length !== 5 || results.data.results.length !== 19) return unavailable;
  const tuples = new Map(results.data.results.map(r => [`${r.proposal_id}:${r.vote_decision}`, r.total_value]));
  if (tuples.size !== 19) return unavailable;
  for (const [i, proposal] of proposals.entries()) {
    proposal.options.sort((a, b) => a.index - b.index);
    if (proposal.id !== i + 1 || proposal.options.length !== (i === 3 ? 3 : 4)) return unavailable;
    if (!Number.isSafeInteger(proposal.options.reduce((n, o) => n + o.total_value, 0))) return unavailable;
    for (const [j, option] of proposal.options.entries()) {
      if (option.index !== j || tuples.get(`${proposal.id}:${j}`) !== option.total_value) return unavailable;
    }
  }
  return { state: 'published', proposals };
}

// Historical getblock(3459350, 1) on the mainnet Zakura node, checked 2026-09-15.
// This is the monitored chain balance, not an assertion that every note was eligible.
export const NU7_SNAPSHOT_SUPPLY = {
  height: 3459350,
  hash: '000000000079f151b017b515d0084713d19bd596a76ecfd75f82fd32bf43d968',
  time: '2026-08-24T19:18:03Z',
  ironwoodZatoshi: 373195940650354,
} as const;

export function getParticipationStats(results: VoteResults) {
  if (results.state !== 'published' || !results.proposals.length) return null;
  const totals = results.proposals.map(p => p.options.reduce((n, o) => n + o.total_value, 0) * ZEC_PER_VOTE_UNIT);
  const minZec = Math.min(...totals);
  const maxZec = Math.max(...totals);
  const snapshotZec = NU7_SNAPSHOT_SUPPLY.ironwoodZatoshi / 100_000_000;
  return { minZec, maxZec, snapshotZec, minShare: minZec / snapshotZec * 100, maxShare: maxZec / snapshotZec * 100 };
}
