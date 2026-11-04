export interface BridgeData {
  direction: 'entry' | 'exit';
  sourceChain: string;
  sourceToken: string;
  sourceAmount: number | null;
  destChain: string;
  destToken: string;
  destAmount: number | null;
  otherChain: string;
  otherToken: string;
  otherAmount: number;
  otherAmountUsd: number;
  otherTxHash: string | null;
  explorerUrl: string | null;
  swapTimestamp: string;
  zecAmount?: number;
  zecAddress?: string | null;
  /** Cross-chain venue that reported the swap; absent on older responses (NEAR). */
  venue?: 'near' | 'maya' | 'thorchain';
}

export interface TransactionData {
  txid: string;
  status?: 'confirmed' | 'stale' | 'unknown';
  isCanonical?: boolean;
  blockHeight: number;
  blockHash: string;
  timestamp: number;
  confirmations: number;
  inputs: any[];
  outputs: any[];
  totalInput: number;
  totalInputZat?: string | null;
  totalOutput: number;
  totalOutputZat?: string | null;
  fee: number;
  feeZat?: string | null;
  size: number;
  version: number;
  locktime: number;
  expiryHeight: number | null;
  saplingSpendCount: number;
  saplingOutputCount: number;
  hasShieldedData: boolean;
  isCoinbase?: boolean;
  orchardActions?: number;
  ironwoodActions?: number;
  valueBalance?: number;
  valueBalanceZat?: string | null;
  valueBalanceSapling?: number;
  valueBalanceSaplingZat?: string | null;
  valueBalanceOrchard?: number;
  valueBalanceOrchardZat?: string | null;
  valueBalanceIronwood?: number;
  valueBalanceIronwoodZat?: string | null;
  bindingSig?: string;
  bindingSigSapling?: string;
  finality?: string | null;
  bridge?: BridgeData | null;
  bridges?: BridgeData[];
  stakingAction?: {
    type: string;
    bondKey: string | null;
    delegatee: string | null;
    amountZats: number | null;
    amountZat?: string | null;
    amountZec: number | null;
  } | null;
  coinbaseHex?: string | null;
  coinbaseText?: string | null;
  zip318?: {
    compliant: boolean;
    checks: number;
    denomination: boolean;
    matchedDenomination: number | null;
    correctActions: boolean;
    orchardActions: number;
    ironwoodActions: number;
    anchorCompliant: boolean;
  } | null;
}

export type TxType =
  | 'COINBASE'
  | 'MIGRATION'
  | 'IRONWOOD'
  | 'ORCHARD'
  | 'SHIELDED'
  | 'SHIELDING'
  | 'UNSHIELDING'
  | 'MIXED'
  | 'REGULAR';

export type LookupState = 'available' | 'missing' | 'unavailable' | null;

export type ActiveTab = 'summary' | 'io' | 'raw';

export interface TxClassification {
  isCoinbase: boolean;
  hasIronwood: boolean;
  hasOrchard: boolean;
  hasSapling: boolean;
  hasTransparentInputs: boolean;
  hasTransparentOutputs: boolean;
  hasTransparent: boolean;
  hasShielded: boolean;
  hasSaplingSpends: boolean;
  hasSaplingOutputs: boolean;
  valueBalance: number;
  isShielding: boolean;
  isUnshielding: boolean;
  migrationSourcePool: 'Orchard' | 'Sapling' | null;
  isMigration: boolean;
  txType: TxType;
  allBridges: BridgeData[];
  bridgeOutputAddresses: Map<string, BridgeData>;
}

export interface RawTxData {
  hex: string;
  decoded: any;
}
