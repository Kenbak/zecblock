/**
 * API Configuration
 *
 * Determines which backend to use based on network:
 * - Mainnet: PostgreSQL API (fast, indexed) on api.mainnet.cipherscan.app
 * - Testnet: PostgreSQL API (fast, indexed) on api.testnet.zecblock.com
 * - Crosslink Testnet: PostgreSQL API + crosslink finality enrichment
 *
 * Network is auto-detected from the domain:
 * - cipherscan.app → mainnet
 * - testnet.zecblock.com → testnet
 * - crosslink.zecblock.com → crosslink-testnet
 * - localhost → testnet (default)
 */
import {
  getConfiguredNetwork,
  normalizeApiBaseUrl,
  type AppNetwork,
} from '@/lib/network';

export type Network = AppNetwork;

/**
 * Detect network from domain (client-side safe)
 */
function detectNetwork(): Network {
  // Explicit env override wins on both server and client (NEXT_PUBLIC_* is
  // inlined into the client bundle by Next.js). This is how a developer runs
  // the crosslink build against localhost.
  const configured = getConfiguredNetwork();
  if (configured) return configured;

  // Server-side without env fallback → testnet.
  if (typeof window === 'undefined') return 'testnet';

  // Client-side: detect from hostname.
  const hostname = window.location.hostname;
  if (['zecblock.com', 'www.zecblock.com', 'cipherscan.app'].includes(hostname) || hostname.includes('mainnet')) return 'mainnet';
  if (hostname.includes('crosslink')) return 'crosslink-testnet';
  return 'testnet';
}

export const NETWORK = detectNetwork();

const DEFAULT_API_URLS: Record<Network, string> = {
  'mainnet': 'https://api.zecblock.com',
  'testnet': 'https://api.testnet.zecblock.com',
  'crosslink-testnet': normalizeApiBaseUrl(
    process.env.NEXT_PUBLIC_CROSSLINK_API_URL || 'https://api.crosslink.zecblock.com',
  ),
};

export function getApiUrlForNetwork(network: Network): string {
  // Protected previews route only browser mainnet reads through their GET
  // bridge. SSR keeps the explicit server API origin and service credentials.
  if (typeof window !== 'undefined' && network === 'mainnet' && process.env.NEXT_PUBLIC_ASK_STAGING === 'true') {
    return '/api/staging-data';
  }
  const configuredUrl = typeof window === 'undefined'
    ? process.env.CIPHERSCAN_API_URL || process.env.NEXT_PUBLIC_API_URL
    : process.env.NEXT_PUBLIC_API_URL;

  return normalizeApiBaseUrl(configuredUrl || DEFAULT_API_URLS[network]);
}

/**
 * Server-only base URL for another public network's API. The deployment's own
 * API override applies only to its own network.
 */
export function getPeerNetworkApiUrl(network: 'mainnet' | 'testnet'): string {
  if (network === NETWORK) return getApiUrlForNetwork(network);
  const override = network === 'mainnet' ? process.env.MAINNET_API_URL : process.env.TESTNET_API_URL;
  return normalizeApiBaseUrl(override || DEFAULT_API_URLS[network]);
}

export const API_CONFIG = {
  // Direct RPC for fallback - server-side only
  RPC_URL: process.env.ZCASH_RPC_URL || 'http://localhost:18232',
  RPC_COOKIE: process.env.ZCASH_RPC_COOKIE,

  // Crosslink zebra-crosslink RPC (only set when running against a crosslink node)
  CROSSLINK_RPC_URL: process.env.CROSSLINK_RPC_URL || null,
  CROSSLINK_RPC_COOKIE: process.env.CROSSLINK_RPC_COOKIE || null,

};

/**
 * Get the appropriate API URL based on network (client-side safe)
 */
export function getApiUrl(): string {
  return getApiUrlForNetwork(NETWORK);
}

/**
 * Whether crosslink finality data is available (server-side only)
 */
export function hasCrosslinkRpc(): boolean {
  return !!API_CONFIG.CROSSLINK_RPC_URL;
}

/**
 * Whether this deployment targets a crosslink network (client-side safe)
 */
export function isCrosslinkNetwork(): boolean {
  return NETWORK === 'crosslink-testnet';
}
