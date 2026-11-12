// This isolated prototype publishes mainnet records only. No domain detection,
// production API configuration or runtime secrets enter the browser bundle.
export const CURRENCY = 'ZEC';
export const NETWORK: AppNetwork = 'mainnet';
export const NETWORK_LABEL = 'MAINNET';
export const isMainnet = true;
export const isTestnet = false;
export const isCrosslink = false;
export function getNetworkLabel() { return 'MAINNET'; }
export function getConfiguredNetwork(): AppNetwork { return 'mainnet'; }
// Type-only compatibility for shared modules that are type-checked but never bundled here.
export type AppNetwork = 'mainnet' | 'testnet' | 'crosslink-testnet';
export function normalizeApiBaseUrl(value: string) { return value; }
