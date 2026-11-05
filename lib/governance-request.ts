import { createRefreshCache } from './refresh-cache';
import { GRANTS, TRUSTED_ENDORSER, isGrantsRound, roundHref, roundHex, selectTrustedRounds } from './governance';
import { NU7_ROUND_ID } from './nu7-vote-results';
import { fetchGovernanceJson } from './governance-upstream';

// The root loading boundary can flush a 200 before page-level notFound().
// Resolve only governance identity here, before streaming, to preserve 404/503.
const getDirectory = createRefreshCache({
  load: async () => {
    const payloads = await Promise.all(['rounds', 'endorsers', `endorsed-rounds/${TRUSTED_ENDORSER.id}`].map(fetchGovernanceJson));
    return { rounds: selectTrustedRounds(...payloads as [unknown, unknown, unknown]), checkedAt: Date.now() };
  },
  maxAgeMs: 60_000,
  retryAfterMs: 30_000,
});

export type GovernanceRequest = { status: 200 | 404 | 503 } | { status: 308; location: string };
export async function resolveGovernanceRequest(pathname: string, network: string): Promise<GovernanceRequest> {
  if (network !== 'mainnet') return { status: 404 };
  const path = pathname.replace(/\/$/, '');
  if (path === '/governance' || path === '/governance/nu7') return { status: 200 };
  const slug = path.slice('/governance/'.length);
  if (slug === NU7_ROUND_ID) return { status: 308, location: '/governance/nu7' };
  if (slug !== GRANTS.slug && !/^[a-f0-9]{64}$/.test(slug)) return { status: 404 };
  try {
    const directory = await getDirectory('trusted');
    if (Date.now() - directory.checkedAt > 10 * 60_000) return { status: slug === GRANTS.slug ? 200 : 503 };
    if (slug === GRANTS.slug) {
      const matches = directory.rounds.filter(isGrantsRound);
      return matches.length === 1 ? { status: 308, location: roundHref(matches[0]) } : { status: 200 };
    }
    return { status: directory.rounds.some(round => roundHex(round.vote_round_id) === slug) ? 200 : 404 };
  } catch { return { status: slug === GRANTS.slug ? 200 : 503 }; }
}
