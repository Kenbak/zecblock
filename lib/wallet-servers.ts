export interface WalletServerObservation {
  checkedAt: string;
  reachable: boolean;
  error?: 'timeout' | 'connection_failed' | 'invalid_response';
  height?: number;
  /** Tip block hash in display (explorer) byte order. */
  hash?: string;
  /** One request on an open connection from ZecBlock's server, in milliseconds. */
  responseMs?: number;
  /** The reported tip hash against ZecBlock's block at that height. */
  chain?: 'canonical' | 'different' | 'unknown';
  /** Blocks relative to ZecBlock's indexed tip; null when the index was unavailable. */
  tipDelta?: number | null;
  chainName?: string | null;
  vendor?: string | null;
  version?: string | null;
  nodeSubversion?: string | null;
}
export interface WalletServerEndpoint {
  id: string;
  host: string;
  port: number;
  scope: 'global' | 'area' | 'region';
  label: string;
  /**
   * Where to draw the name. A single-region name has the city-level position
   * its operator publishes. `approximate` marks an area name drawn near the
   * middle of its area because the operator publishes no positions.
   */
  location: { lat: number; lon: number; approximate: boolean } | null;
  latest: WalletServerObservation | null;
}
export interface WalletServerOperator {
  id: string;
  name: string;
  operator: string;
  operatorUrl: string;
  statusUrl: string;
  /** Local brand asset path; null when the operator publishes no mark. */
  logo: string | null;
  endpoints: WalletServerEndpoint[];
}
export interface WalletServerData {
  network: string;
  available: boolean;
  checkedAt: string | null;
  refreshSeconds: number;
  staleAfterSeconds: number;
  lagThresholdBlocks: number;
  expectedChainName: string | null;
  reference: { source: string; height: number | null };
  operators: WalletServerOperator[];
}
export type WalletServerStatus = 'serving' | 'lagging' | 'tip_differs' | 'wrong_network' | 'unreachable' | 'stale' | 'not_checked';

type Thresholds = Pick<WalletServerData, 'staleAfterSeconds' | 'lagThresholdBlocks' | 'expectedChainName'>;

/**
 * Retained answers expire in the browser even when the API or the page's own
 * refresh fails, so an old success can never render as a current one.
 */
export function walletServerStatus(latest: WalletServerObservation | null, thresholds: Thresholds, now: number): WalletServerStatus {
  if (!latest) return 'not_checked';
  const checkedAt = Date.parse(latest.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt > now + 30_000) return 'not_checked';
  if (now - checkedAt >= thresholds.staleAfterSeconds * 1000) return 'stale';
  if (!latest.reachable) return 'unreachable';
  if (thresholds.expectedChainName && latest.chainName !== thresholds.expectedChainName) return 'wrong_network';
  if (latest.chain === 'different') return 'tip_differs';
  if (typeof latest.tipDelta === 'number' && latest.tipDelta <= -thresholds.lagThresholdBlocks) return 'lagging';
  return 'serving';
}

/** One line placing a server's reported tip against ZecBlock's index. */
export function indexComparisonLabel(latest: WalletServerObservation): string {
  const delta = typeof latest.tipDelta === 'number' ? latest.tipDelta : null;
  const blocks = delta === null ? '' : `${Math.abs(delta).toLocaleString('en-US')} ${Math.abs(delta) === 1 ? 'block' : 'blocks'}`;
  if (latest.chain === 'different') return 'Different block at this height';
  if (latest.chain === 'canonical') return delta === null || delta === 0 ? 'Same tip block' : `${blocks} behind, same chain`;
  if (delta !== null && delta > 0) return `${blocks} ahead, not compared yet`;
  return 'Not compared';
}
