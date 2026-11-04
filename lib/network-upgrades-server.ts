import { cache } from 'react';
import { getApiUrl, getNetwork } from './seo';
import { readApiData } from './api-client';
import { fetchWithDeadline } from './server-fetch';
import { readUpgradeSnapshot } from './network-upgrades';

/** Only future-block routes need this extra SSR request. Share it with metadata. */
export const getUpgradeStats = cache(async () => {
  try {
    const response = await fetchWithDeadline(`${getApiUrl()}/v1/network/stats`, { next: { revalidate: 30 } });
    if (!response.ok) return null;
    const stats = await readApiData(response);
    if (!readUpgradeSnapshot(stats, getNetwork())) return null;
    // Keep client props small while retaining the node's network/source fields.
    return { blockchain: { height: stats.blockchain.height, latestBlockTime: stats.blockchain.latestBlockTime }, mining: { schedule: stats.mining.schedule, avgBlockTime: stats.mining.avgBlockTime } };
  } catch { return null; }
});
