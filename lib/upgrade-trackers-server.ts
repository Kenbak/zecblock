import 'server-only';
import { getApiUrlForNetwork } from './api-config';
import { readApiData } from './api-client';
import { fetchWithDeadline } from './server-fetch';
import type { AppNetwork } from './network';
import { readUpgradeSnapshot } from './network-upgrades';
import { buildUpgradeTrackers } from './upgrade-trackers';

export async function loadUpgradeTrackers(network: AppNetwork) {
  if (network === 'crosslink-testnet') return { trackers: [], snapshot: null };
  let snapshot = null;
  try {
    // 60s ≈ 2–3 blocks at NU7's 25-second spacing; 300s let "NU7 blocks so far" lag ~12 blocks.
    const response = await fetchWithDeadline(`${getApiUrlForNetwork(network)}/v1/network/stats`, { next: { revalidate: 60 } });
    if (response.ok) snapshot = readUpgradeSnapshot(await readApiData(response), network);
  } catch { /* The tracker directory remains useful when node observations are unavailable. */ }
  return { trackers: buildUpgradeTrackers(snapshot, network), snapshot };
}
