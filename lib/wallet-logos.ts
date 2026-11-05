export interface WalletLogoAsset {
  id: string;
  src: string;
}

const ZODL = { id: 'zodl', src: '/brands/zodl.png' };
const VIZOR = { id: 'vizor', src: '/brands/vizor.png' };
const CAKE = { id: 'cake', src: '/brands/wallets/cake.png' };
const BRAVE = { id: 'brave', src: '/brands/wallets/brave.svg' };
const NOZY = { id: 'nozy', src: '/brands/wallets/nozy.png' };
const ZKOOL = { id: 'zkool', src: '/brands/wallets/zkool.png' };
const YWALLET = { id: 'ywallet', src: '/brands/wallets/ywallet.png' };
const EDGE = { id: 'edge', src: '/brands/wallets/edge.png' };

/**
 * Explicit identities already named by the wallet-implementation API.
 * No substring matching: a shared SDK family must never borrow one member's
 * brand, and historical/probable/deprecated qualifiers remain visible in UI.
 */
const IMPLEMENTATION_LOGOS: Readonly<Record<string, readonly WalletLogoAsset[]>> = {
  'zodl / vizor (ironwood sends)': [ZODL, VIZOR],
  'zodl / vizor (zip-318 migration)': [ZODL, VIZOR],
  'cake wallet (probable)': [CAKE],
  brave: [BRAVE],
  nozy: [NOZY],
  'zkool (historical)': [ZKOOL],
  'ywallet (deprecated)': [YWALLET],
};

export function getWalletImplementationLogos(name: string): readonly WalletLogoAsset[] {
  const key = name.trim().toLowerCase();
  return Object.hasOwn(IMPLEMENTATION_LOGOS, key) ? IMPLEMENTATION_LOGOS[key] : [];
}

/** Reviewed wallet names from the migration-readiness directory, separate from inferred signals. */
const READINESS_LOGOS: Readonly<Record<string, readonly WalletLogoAsset[]>> = {
  vizor: [VIZOR],
  zodl: [ZODL],
  'cake wallet': [CAKE],
  zkool: [ZKOOL],
  edge: [EDGE],
  'brave wallet': [BRAVE],
};

export function getWalletReadinessLogos(name: string): readonly WalletLogoAsset[] {
  const key = name.trim().toLowerCase();
  return Object.hasOwn(READINESS_LOGOS, key) ? READINESS_LOGOS[key] : [];
}
