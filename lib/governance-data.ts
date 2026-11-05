import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { after } from 'next/server';
import { createHash } from 'node:crypto';
import { TRUSTED_ENDORSER, selectTrustedRounds, parseRoundVote, roundHex, type Catalog, type Round } from './governance';
import { fetchGovernanceJson, governanceFailureDetails, GovernanceDataError } from './governance-upstream';

const getDirectory = unstable_cache(async function refreshGovernanceDirectory() {
  const payloads = await Promise.all([
    fetchGovernanceJson('rounds'), fetchGovernanceJson('endorsers'), fetchGovernanceJson(`endorsed-rounds/${TRUSTED_ENDORSER.id}`),
  ]);
  try {
    return { rounds: selectTrustedRounds(...payloads as [unknown, unknown, unknown]), checkedAt: Date.now() };
  } catch { throw new GovernanceDataError('directory', 'invalid-directory'); }
}, ['governance-directory-v4'], { revalidate: 60 });

const ballotIdentity = (round: Round) => createHash('sha256').update(JSON.stringify(round)).digest('hex');

function getPublishedVote(round: Round) {
  const id = roundHex(round.vote_round_id);
  // Include the complete registered ballot in the identity without serializing
  // proposal text into Next's cache invocation keys or revalidation logs.
  const ballot = ballotIdentity(round);
  return unstable_cache(async function refreshPublishedVote() {
    const [summary, tally] = await Promise.all([fetchGovernanceJson(`vote-summary/${id}`), fetchGovernanceJson(`tally-results/${id}`)]);
    const vote = parseRoundVote(round, summary, tally, Date.now());
    if (vote.state !== 'results') throw new GovernanceDataError(`published-vote/${id}`, 'inconsistent-tally');
    return { vote, checkedAt: Date.now() };
  }, ['governance-published-vote-v4', id, ballot], { revalidate: 300 })();
}

async function assembleCatalog(): Promise<Catalog> {
  // Keep these cache scopes siblings: Next bypasses reads of unstable_cache
  // nested inside another unstable_cache, defeating the finalized-vote TTL.
  const { rounds, checkedAt: directoryCheckedAt } = await getDirectory();
  let checkedAt = directoryCheckedAt;
  const votes: Catalog['votes'] = [];
  // Bounded batches; future directories must not fan out hundreds of requests at once.
  for (let i = 0; i < rounds.length; i += 4) {
    votes.push(...await Promise.all(rounds.slice(i, i + 4).map(async round => {
      if (round.status !== 3 || round.tally_timed_out) return parseRoundVote(round, null, null, Date.now());
      try {
        const published = await getPublishedVote(round);
        checkedAt = Math.min(checkedAt, published.checkedAt);
        return published.vote;
      } catch (error) {
        console.warn('[governance] Published vote unavailable', { roundId: roundHex(round.vote_round_id), ...governanceFailureDetails(error) });
        // A cache backend miss need not erase an already validated local tally.
        // Only reuse it for the identical registered round, preserving its age.
        const previous = lastCatalog?.votes.find(vote => vote.id === roundHex(round.vote_round_id) && vote.state === 'results' && ballotIdentity(vote.round) === ballotIdentity(round));
        if (previous && lastCatalog) {
          checkedAt = Math.min(checkedAt, lastCatalog.checkedAt);
          return previous;
        }
        return parseRoundVote(round, null, null, Date.now());
      }
    })));
  }
  return { votes: votes.sort((a, b) => b.round.vote_end_time - a.round.vote_end_time), checkedAt, directoryCheckedAt, unavailable: false };
}

const unavailable = (): Catalog => ({ votes: [], checkedAt: 0, unavailable: true });
let lastCatalog: Catalog | undefined;
let pendingCatalog: Promise<Catalog> | undefined;
let retryAfter = 0;

function loadCatalog(): Promise<Catalog> {
  if (pendingCatalog) return pendingCatalog;
  if (Date.now() < retryAfter) return Promise.resolve(lastCatalog ?? unavailable());
  const work = assembleCatalog().then(catalog => {
    lastCatalog = catalog;
    return catalog;
  }).catch(error => {
    console.warn('[governance] Directory unavailable', governanceFailureDetails(error));
    retryAfter = Date.now() + 30_000;
    return lastCatalog ?? unavailable();
  }).finally(() => { if (pendingCatalog === work) pendingCatalog = undefined; });
  pendingCatalog = work;
  return work;
}

// Static generation/ISR must await Next's bounded revalidation so an arbitrary
// foreground timer cannot replace an existing page with an unavailable shell.
export const getGovernanceCatalog = cache(loadCatalog);

// This dynamic banner endpoint does not need to delay the page for a cold
// voting provider. Let Next retain the warmup after returning its safe fallback.
export const getGovernanceAnnouncementCatalog = cache(async (): Promise<Catalog> => {
  const work = loadCatalog();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([work, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1_000); })]);
  clearTimeout(timer);
  if (result) return result;
  after(async () => { await work; });
  return lastCatalog ?? unavailable();
});
