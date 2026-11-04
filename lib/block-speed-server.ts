import 'server-only';
import { readApiData } from '@/lib/api-client';
import { getPeerNetworkApiUrl } from '@/lib/api-config';
import { fetchWithDeadline } from '@/lib/server-fetch';
import { buildSpeedStory, readBlockSpeed, type BlockSpeedPayload, type SpeedStory } from '@/lib/block-speed';

async function loadNetwork(network: 'mainnet' | 'testnet'): Promise<BlockSpeedPayload | null> {
  try {
    const response = await fetchWithDeadline(`${getPeerNetworkApiUrl(network)}/v1/network/block-speed`, { next: { revalidate: 300 } });
    if (!response.ok) return null;
    return readBlockSpeed(await readApiData(response), network === 'mainnet' ? 'main' : 'test');
  } catch {
    // Callers render an explicit unavailable state for the missing network.
    return null;
  }
}

export type BlockSpeedSnapshot = { host: BlockSpeedPayload | null; story: SpeedStory | null };

/** The host network's story; mainnet also reads testnet's measured NU7 pace as supporting evidence. */
export async function loadBlockSpeedSnapshot(network: 'mainnet' | 'testnet'): Promise<BlockSpeedSnapshot> {
  const [host, peer] = await Promise.all([loadNetwork(network), network === 'mainnet' ? loadNetwork('testnet') : null]);
  return { host, story: buildSpeedStory(host, peer) };
}
