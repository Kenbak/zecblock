/**
 * Decrypted output from a shielded transaction
 */
export interface DecryptedOutput {
  /** The decrypted memo text */
  memo: string;
  /** Amount in ZEC */
  amount: number;
}

/**
 * Compact block from Lightwalletd
 */
export interface CompactBlock {
  height: string;
  hash: string;
  time: number;
  vtx: CompactTransaction[];
}

/**
 * Compact transaction with Orchard actions
 */
export interface CompactTransaction {
  hash: string;
  actions?: CompactAction[];
  /** Sapling outputs: ignored in mixed scans; unsupported on their own. */
  outputs?: CompactOutput[];
}

/**
 * Orchard compact action
 */
export interface CompactAction {
  pool?: 'orchard' | 'ironwood';
  nullifier: string;
  cmx: string;
  ephemeralKey: string;
  ciphertext: string;
}

/**
 * Sapling compact output
 */
export interface CompactOutput {
  cmu: string;
  ephemeralKey: string;
  ciphertext: string;
}

/**
 * Matching transaction from compact block filtering
 */
export interface MatchingTransaction {
  txid: string;
  height: number;
  timestamp: number;
}

/**
 * Progress callback for batch filtering
 */
export interface FilterProgress {
  blocksProcessed: number;
  totalBlocks: number;
  matchesFound: number;
}

/**
 * Viewing key types
 */
export type ViewingKeyType = 'ufvk-mainnet' | 'ufvk-testnet' | 'unknown';

