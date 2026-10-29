// This isolated prototype publishes mainnet records only. No domain detection,
// production API configuration or runtime secrets enter the browser bundle.
export const CURRENCY = 'ZEC';
export const NETWORK = 'mainnet';
export const NETWORK_LABEL = 'MAINNET';
export const isMainnet = true;
export const isTestnet = false;
export const isCrosslink = false;
export function getNetworkLabel() { return 'MAINNET'; }
export function getConfiguredNetwork() { return 'mainnet'; }
