import 'server-only';
import { getApiUrlForNetwork } from '@/lib/api-config';
import { loadBlockSpeedSnapshot } from '@/lib/block-speed-server';
import {
  chainHeightCard, chainSizeCard, dailyTransactionsCard, dormantSupplyCard, feesCard, findFactCard, halvingCard, hashrateCard,
  issuedSupplyCard, miningPoolsCard, miningSoftwareCard, mvrvCard, netShieldingCard, nodesCard, orphanRateCard, shieldedByPoolCard,
  shieldedSupplyCard, shieldedTransactionsCard, SWAP_VENUES, swapSourcesCard, swapVenuesCard, venueCard,
  type CardNetwork, type FactCard, type SwapVenue,
} from '@/lib/fact-cards';
import { blocksCard, countdownCard, nsmCard, readinessCard, type Nu7Card } from '@/lib/nu7-cards';
import { fetchWithDeadline } from '@/lib/server-fetch';
import { loadUpgradeTrackers } from '@/lib/upgrade-trackers-server';

const SWAP_TIMEOUT_MS = 20_000;

/** Raw API body, or null on any failure. Builders treat null as unavailable. */
async function api(network: CardNetwork, path: string, timeoutMs = 8_000): Promise<unknown> {
  try {
    const response = await fetchWithDeadline(`${getApiUrlForNetwork(network)}${path}`, { next: { revalidate: 60 } }, timeoutMs);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** Legacy `/api/...` bodies have no v1 envelope; NU7 builders expect the inner data. */
const inner = (body: unknown) => (body && typeof body === 'object' && 'data' in body ? (body as { data: unknown }).data : body);

function fromNu7(card: Nu7Card | null): FactCard | null {
  if (!card) return null;
  const visual = card.visual?.kind === 'bars'
    ? { kind: 'bars' as const, unit: card.visual.unit, bars: card.visual.bars.map(bar => ({ value: bar.value, highlight: bar.nu7, projected: bar.projected })) }
    : card.visual;
  return { ...card, visual };
}

async function venues(network: CardNetwork) {
  const ids = Object.keys(SWAP_VENUES) as SwapVenue[];
  // Swap analytics aggregate a month of records; they get a longer budget than headline reads.
  const bodies = await Promise.all(ids.map(id => api(network, SWAP_VENUES[id].path, SWAP_TIMEOUT_MS)));
  return Object.fromEntries(ids.map((id, i) => [id, bodies[i]])) as Record<SwapVenue, unknown>;
}

/** Builds one card for a network it supports; null when the card or its data is unavailable. */
export async function loadFactCard(id: string, network: CardNetwork): Promise<FactCard | null> {
  const def = findFactCard(id);
  if (!def || !def.networks.includes(network)) return null;
  switch (id) {
    case 'shielded-supply': return shieldedSupplyCard(network, await api(network, '/v1/shielded-pools/overview'));
    case 'shielded-transactions': return shieldedTransactionsCard(network, await api(network, '/v1/privacy/stats?days=30'));
    case 'issued-supply': return issuedSupplyCard(network, await api(network, '/v1/network/supply'));
    case 'halving': return halvingCard(network, await api(network, '/v1/network/halving'));
    case 'chain-height': return chainHeightCard(network, await api(network, '/v1/network/info'));
    case 'nodes': return nodesCard(network, await api(network, '/v1/network/nodes/stats'));
    case 'fees': {
      const [fees, price] = await Promise.all([api(network, '/v1/network/fee-distribution?period=7d'), api(network, '/v1/network/price')]);
      return feesCard(network, fees, price);
    }
    case 'hashrate': return hashrateCard(network, await api(network, '/v1/mining/hashrate-history?period=30d'));
    case 'mining-pools': return miningPoolsCard(network, await api(network, '/v1/mining/pool-distribution?period=7d'));
    case 'net-shielding': return netShieldingCard(network, await api(network, '/v1/shielded-pools/flows?period=30d'));
    case 'shielded-by-pool': return shieldedByPoolCard(network, await api(network, '/v1/shielded-pools/activity?period=30d'));
    case 'daily-transactions': return dailyTransactionsCard(network, await api(network, '/v1/shielded-pools/activity?period=30d'));
    case 'dormant-supply': return dormantSupplyCard(await api(network, '/v1/valuation/hodl-waves?period=30d'));
    case 'mvrv': return mvrvCard(await api(network, '/v1/valuation/snapshot'));
    case 'chain-size': return chainSizeCard(network, await api(network, '/v1/network/chain-size-history?period=30d'));
    case 'mining-software': return miningSoftwareCard(network, await api(network, '/v1/mining/software?period=7d'));
    case 'orphan-rate': return orphanRateCard(network, await api(network, '/v1/mining/orphan-rates/daily'));
    case 'swap-sources': return swapSourcesCard(await api(network, SWAP_VENUES['near-intents'].path, SWAP_TIMEOUT_MS));
    case 'swap-venues': return swapVenuesCard(await venues(network));
    case 'near-intents': case 'maya': case 'thorchain':
      return venueCard(id, await api(network, SWAP_VENUES[id].path, SWAP_TIMEOUT_MS));
    case 'nu7-countdown': return fromNu7(countdownCard(network, (await loadUpgradeTrackers(network)).snapshot));
    case 'nu7-blocks': return fromNu7(blocksCard((await loadBlockSpeedSnapshot(network)).story));
    case 'nu7-nsm': return fromNu7(nsmCard(network, inner(await api(network, '/v1/network/accounting/history?period=all')) as Parameters<typeof nsmCard>[1]));
    case 'nu7-readiness': return fromNu7(readinessCard(network, inner(await api(network, '/v1/network/nodes/upgrade-readiness')) as Parameters<typeof readinessCard>[1]));
    default: return null;
  }
}
