import { unstable_cache } from 'next/cache';
import { fetchWithDeadline } from './server-fetch';
import { readBoundedJson } from './bounded-json';
import { GOVERNANCE_API } from './governance';
import { readLiveRegistrations, type Probe } from './vote-registrations';

const VOTE_CHAIN_ORIGIN = new URL(GOVERNANCE_API).origin;
const PROBE_BUDGET_MS = 4_000;
const TOTAL_BUDGET_MS = 8_000;
// Count responses are one short error object; the tree state is a few fields.
const MAX_PROBE_BYTES = 16 * 1024;

const probe: Probe = async path => {
  const startedAt = Date.now();
  const response = await fetchWithDeadline(`${VOTE_CHAIN_ORIGIN}${path}`, { cache: 'no-store' }, PROBE_BUDGET_MS);
  // The count is carried by an HTTP 500 body, so read it whatever the status.
  return { status: response.status, body: await readBoundedJson(response, MAX_PROBE_BYTES, Math.max(1, startedAt + PROBE_BUDGET_MS - Date.now())) };
};

/**
 * Five-minute cache per round. A failed refresh throws, so Next keeps the last
 * established count; registrations only grow, so a retained value can only be
 * low, never invented. Callers treat a cold failure as "no figure".
 */
export function getLiveRegistrations(roundId: string, proposals: number, open: boolean): Promise<number | null> {
  return unstable_cache(async function refreshVoteRegistrations() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Vote registrations deadline exceeded')), TOTAL_BUDGET_MS); });
    try {
      const count = await Promise.race([readLiveRegistrations(roundId, proposals, probe, open), deadline]);
      if (count === null) throw new Error('Vote registrations not established');
      return count;
    } finally { clearTimeout(timer); }
  }, ['vote-registrations-v1', roundId, String(proposals), open ? 'open' : 'closed'], { revalidate: 300 })().catch(() => null);
}
