/**
 * Crosslink RPC Integration
 *
 * Provides finality enrichment, validator roster, network stats,
 * and staking day calculations for the Crosslink feature net.
 * All methods gracefully return null when no crosslink RPC is configured.
 */

import { parseSafeZatoshi, sumZatoshis, zatToZec } from './format-numbers';
import { API_CONFIG } from './api-config';
import crosslinkNetwork from './crosslink-network.json';
import { STAKING_DAY_PERIOD, STAKING_DAY_WINDOW, STAKING_ACTIVATION_HEIGHT } from './config';

export type FinalityStatus = 'Finalized' | 'NotYetFinalized' | null;

export interface RosterMember {
  identity: string;
  stake_zats: number;
  stake_zec?: number;
}

export interface FinalityInfo {
  finalizedHeight: number | null;
  finalizedHash: string;
}

export interface StakingDayInfo {
  tipHeight: number;
  positionInPeriod: number;
  isStakingOpen: boolean;
  blocksRemaining: number;
  blocksUntilNextWindow: number;
  periodNumber: number;
  windowStart: number;
  windowEnd: number;
}

export interface CrosslinkNetworkStats {
  tipHeight: number;
  finalizedHeight: number | null;
  finalityGap: number | null;
  finalizerCount: number;
  totalStakeZats: number;
  totalStakeZec: number;
  stakingDay: StakingDayInfo;
  roster: RosterMember[];
}

function getRpcHeaders(): HeadersInit {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (API_CONFIG.CROSSLINK_RPC_COOKIE) {
    headers['Authorization'] = `Basic ${Buffer.from(API_CONFIG.CROSSLINK_RPC_COOKIE).toString('base64')}`;
  }

  return headers;
}

async function rpcCall(method: string, params: any[] = []): Promise<any> {
  if (!API_CONFIG.CROSSLINK_RPC_URL) return null;

  try {
    const response = await fetch(API_CONFIG.CROSSLINK_RPC_URL, {
      method: 'POST',
      headers: getRpcHeaders(),
      body: JSON.stringify({
        jsonrpc: '1.0',
        id: `crosslink-${method}`,
        method,
        params,
      }),
      next: { revalidate: 10 },
    });

    const data = await response.json();
    if (data.error) {
      console.error(`Crosslink RPC ${method} error:`, data.error);
      return null;
    }
    return data.result;
  } catch (error) {
    console.error(`Crosslink RPC ${method} error:`, error);
    return null;
  }
}

/**
 * Fetch finality status for a single block by hash.
 */
export async function getBlockFinality(blockHash: string): Promise<FinalityStatus> {
  const result = await rpcCall('get_tfl_block_finality_from_hash', [blockHash]);
  return (result as FinalityStatus) || null;
}

/**
 * Fetch finality status for multiple blocks in parallel.
 */
export async function getBlocksFinality(
  blocks: { hash: string }[]
): Promise<Map<string, FinalityStatus>> {
  const results = new Map<string, FinalityStatus>();

  if (!API_CONFIG.CROSSLINK_RPC_URL || blocks.length === 0) {
    return results;
  }

  const finalities = await Promise.all(
    blocks.map((block) => getBlockFinality(block.hash))
  );

  blocks.forEach((block, i) => {
    results.set(block.hash, finalities[i]);
  });

  return results;
}

/**
 * Get finalized block height and hash from TFL.
 */
export async function getFinalityInfo(): Promise<FinalityInfo | null> {
  const result = await rpcCall('get_tfl_final_block_height_and_hash');
  if (!result) return null;

  return {
    finalizedHeight: result.height ?? result[0] ?? null,
    finalizedHash: result.hash ?? result[1] ?? '',
  };
}

/**
 * Get the validator/finalizer roster with stake in zatoshis.
 */
export async function getRoster(): Promise<RosterMember[]> {
  const result = await rpcCall('get_tfl_roster_zats');
  if (!result || !Array.isArray(result)) return [];

  return result.map((member: any) => ({
    identity: member.identity || member.pub_key || member.public_key || '',
    stake_zats: parseSafeZatoshi(member.stake_zats ?? member.stake ?? 0),
    stake_zec: zatToZec(parseSafeZatoshi(member.stake_zats ?? member.stake ?? 0)),
  }));
}

/**
 * Get current block count (tip height).
 */
export async function getTipHeight(): Promise<number | null> {
  return await rpcCall('getblockcount');
}

/**
 * Compute staking day info from the current tip height.
 */
export function computeStakingDay(tipHeight: number): StakingDayInfo {
  const periodNumber = Math.floor(tipHeight / STAKING_DAY_PERIOD);
  const positionInPeriod = tipHeight % STAKING_DAY_PERIOD;
  const isStakingOpen = tipHeight >= STAKING_ACTIVATION_HEIGHT && positionInPeriod < STAKING_DAY_WINDOW;

  const windowStart = Math.max(STAKING_ACTIVATION_HEIGHT, periodNumber * STAKING_DAY_PERIOD);
  const windowEnd = windowStart + STAKING_DAY_WINDOW - 1;

  const blocksRemaining = isStakingOpen
    ? STAKING_DAY_WINDOW - positionInPeriod
    : 0;

  const blocksUntilNextWindow = isStakingOpen
    ? 0
    : tipHeight < STAKING_ACTIVATION_HEIGHT ? STAKING_ACTIVATION_HEIGHT - tipHeight : STAKING_DAY_PERIOD - positionInPeriod;

  return {
    tipHeight,
    positionInPeriod,
    isStakingOpen,
    blocksRemaining,
    blocksUntilNextWindow,
    periodNumber,
    windowStart,
    windowEnd,
  };
}

/**
 * Fetch all crosslink network stats in one call.
 * Aggregates tip, finality, roster, and staking day info.
 */
export async function getCrosslinkStats(): Promise<CrosslinkNetworkStats | null> {
  if (!API_CONFIG.CROSSLINK_RPC_URL) return null;

  const [tipHeight, finalityInfo, roster] = await Promise.all([
    getTipHeight(),
    getFinalityInfo(),
    getRoster(),
  ]);

  if (tipHeight === null) return null;

  const totalStakeZats = sumZatoshis(roster.map(member => member.stake_zats));
  const finalizedHeight = tipHeight >= crosslinkNetwork.crosslinkActivationHeight ? finalityInfo?.finalizedHeight ?? null : null;

  return {
    tipHeight,
    finalizedHeight,
    finalityGap: finalizedHeight == null ? null : tipHeight - finalizedHeight,
    finalizerCount: roster.length,
    totalStakeZats,
    totalStakeZec: zatToZec(totalStakeZats),
    stakingDay: computeStakingDay(tipHeight),
    roster: roster.sort((a, b) => b.stake_zats - a.stake_zats),
  };
}
