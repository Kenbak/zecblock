import { getConfiguredNetwork } from '@/lib/network';
import crosslinkNetwork from './crosslink-network.json';

// Auto-detect network based on domain or env variable
function detectNetwork(): 'mainnet' | 'testnet' | 'crosslink' {
  // First check explicit env variable
  const configured = getConfiguredNetwork();
  if (configured === 'mainnet' || configured === 'testnet') return configured;
  if (configured === 'crosslink-testnet') return 'crosslink';

  // Auto-detect from domain (client-side only)
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    if (hostname.includes('crosslink')) return 'crosslink';
    if (hostname.includes('testnet.')) return 'testnet';
    if (['zecblock.com', 'www.zecblock.com', 'cipherscan.app', 'www.cipherscan.app'].includes(hostname)) return 'mainnet';
  }

  // Default to testnet for local dev
  return 'testnet';
}

// Network configuration
export const NETWORK = detectNetwork();

export const isMainnet = NETWORK === 'mainnet';
export const isTestnet = NETWORK === 'testnet';
export const isCrosslink = NETWORK === 'crosslink';

// Currency display
export const CURRENCY = isCrosslink ? 'CTAZ' : isMainnet ? 'ZEC' : 'TAZ';

// Network display
export const NETWORK_LABEL = isCrosslink ? 'CROSSLINK' : isMainnet ? 'MAINNET' : 'TESTNET';

// RPC config (server-side only)
export const RPC_CONFIG = {
  url: process.env.ZCASH_RPC_URL || (isMainnet ? 'http://localhost:8232' : 'http://localhost:18232'),
  cookie: process.env.ZCASH_RPC_COOKIE || '',
};

// Network colors
export const NETWORK_COLOR = isCrosslink ? 'text-cipher-purple' : isMainnet ? 'text-cipher-yellow' : 'text-gray-400';

// Domain URLs
export const MAINNET_URL = 'https://zecblock.com';
export const TESTNET_URL = 'https://testnet.zecblock.com';
export const CROSSLINK_URL = 'https://crosslink.zecblock.com';

// Crosslink staking constants (from zebra-consensus)
export const STAKING_DAY_PERIOD = crosslinkNetwork.stakingPeriod;
export const STAKING_DAY_WINDOW = crosslinkNetwork.stakingWindow;
export const STAKING_ACTION_DELAY_BLOCKS = crosslinkNetwork.stakingActionDelay;

// Known network upgrade activation heights
export interface NetworkUpgrade {
  name: string;
  zip: string;
  description: string;
  link?: string;
  linkText?: string;
  badge?: string;
}

export const NETWORK_UPGRADES: Record<number, NetworkUpgrade> = {
  3428143: {
    name: 'Ironwood (NU6.3)',
    zip: 'ZIP-258',
    description: 'Activates the Ironwood shielded pool with enhanced cryptographic foundations. ZEC holders can migrate from Orchard to Ironwood via ZIP-318 turnstile transactions.',
    link: '/ironwood',
  },
  3459350: {
    name: 'NU7 Coinholder Vote — Snapshot',
    zip: '',
    description: 'Eligibility snapshot for the NU7 coinholder vote. Spendable Ironwood funds at this height qualify to vote on issuance smoothing, Sprout deprecation, 25-second blocks, and upgrade schedule.',
    link: '/governance/nu7',
    linkText: 'View vote details →',
    badge: 'SNAPSHOT',
  },
  4134000: {
    name: 'Ironwood (NU6.3)',
    zip: 'ZIP-258',
    description: 'Activates the Ironwood shielded pool with enhanced cryptographic foundations. ZEC holders can migrate from Orchard to Ironwood via ZIP-318 turnstile transactions.',
    link: '/ironwood',
  },
};

export const STAKING_ACTIVATION_HEIGHT = crosslinkNetwork.stakingActivationHeight;
