import { formatUSD, formatZec } from "./format";
import type { VenueProviderRecord } from "./VenueTransferDetails";
export const IS_DEMO = process.env.NEXT_PUBLIC_CROSSCHAIN_DEMO === "1";
export type Amount = string | null;
export type Unit = "usd" | "zec";
export const PERIODS = ["24h", "7d", "30d", "90d", "1y", "all"] as const;
export const STATUSES = [
  "SUCCESS",
  "FAILED",
  "REFUNDED",
  "PROCESSING",
  "INCOMPLETE_DEPOSIT",
];
export const CHAINS: Record<string, string> = {
  zec: "Zcash",
  eth: "Ethereum",
  btc: "Bitcoin",
  sol: "Solana",
  near: "NEAR",
  maya: "Maya",
  thor: "THORChain",
  base: "Base",
  arb: "Arbitrum",
  tron: "Tron",
  bsc: "BNB Chain",
  ltc: "Litecoin",
  doge: "Dogecoin",
  xrp: "XRP",
  pol: "Polygon",
  op: "Optimism",
  avax: "Avalanche",
  aptos: "Aptos",
  sui: "Sui",
  ton: "TON",
  monad: "Monad",
  bch: "Bitcoin Cash",
  dash: "Dash",
};
export const EXPLORERS: Record<string, string> = {
  zec: "/tx/",
  eth: "https://etherscan.io/tx/",
  btc: "https://mempool.space/tx/",
  sol: "https://solscan.io/tx/",
  near: "https://nearblocks.io/txns/",
  base: "https://basescan.org/tx/",
  arb: "https://arbiscan.io/tx/",
  tron: "https://tronscan.org/#/transaction/",
  bsc: "https://bscscan.com/tx/",
  ltc: "https://blockchair.com/litecoin/transaction/",
  doge: "https://dogechain.info/tx/",
  xrp: "https://xrpscan.com/tx/",
  pol: "https://polygonscan.com/tx/",
  op: "https://optimistic.etherscan.io/tx/",
  avax: "https://snowscan.xyz/tx/",
  sui: "https://suiscan.xyz/mainnet/tx/",
};
export function value(amount: Amount | number | undefined, unit: Unit) {
  return amount == null
    ? "Unavailable"
    : unit === "zec"
      ? formatZec(Number(amount))
      : formatUSD(Number(amount));
}
export function date(value: string | null) {
  return value
    ? new Date(value).toISOString().replace("T", " ").slice(0, 16) + " UTC"
    : "Unknown";
}
export function href(
  params: Record<string, string>,
  patch: Record<string, string | undefined> = {},
) {
  const q = new URLSearchParams(params);
  for (const [k, v] of Object.entries(patch)) {
    if (v) q.set(k, v);
    else q.delete(k);
  }
  return `/crosschain${q.size ? "?" + q.toString() : ""}`;
}
export interface Trend {
  bucket: string;
  swaps: number | null;
  inflow_usd: Amount;
  outflow_usd: Amount;
  inflow_zec: Amount;
  outflow_zec: Amount;
}
export interface Route {
  source_chain: string;
  source_token: string;
  dest_chain: string;
  dest_token: string;
  source_asset: string | null;
  dest_asset: string | null;
  direction: string;
  swaps: number;
  volume_usd: Amount;
  volume_zec: Amount;
  median_usd: Amount;
  median_zec: Amount;
}
export interface Analytics {
  period: string;
  granularity: "hour" | "day";
  start: string;
  end: string;
  coverage: {
    source: string;
    records: number;
    earliest: string | null;
    latest: string | null;
    missingZecHash: number;
    internalSwaps: number;
    syncedThrough: string | null;
    continuousThrough: string | null;
    stale: boolean;
    statusesAvailable: string[];
    historyTraversalComplete: boolean;
    backfill: { direction: string; complete: boolean; pages: number }[];
    note: string;
  };
  summary: {
    swaps: number;
    volume_usd: Amount;
    volume_zec: Amount;
    inflow_usd: Amount;
    outflow_usd: Amount;
    inflow_zec: Amount;
    outflow_zec: Amount;
    average_usd: Amount;
    average_zec: Amount;
    median_usd: Amount;
    median_zec: Amount;
    missing_usd: number;
    missing_zec: number;
    sender_addresses: number;
  };
  trends: Trend[];
  flows: {
    chain: string;
    swaps: number;
    buy_swaps: number;
    sell_swaps: number;
    inflow_usd: Amount;
    outflow_usd: Amount;
    inflow_zec: Amount;
    outflow_zec: Amount;
  }[];
  tokenFlows?: (Analytics["flows"][number] & {
    token: string;
    asset: string | null;
  })[];
  chainHistory?: {
    bucket: string;
    chain: string;
    swaps: number;
    missing_zec: number;
    net_zec: Amount;
  }[];
  chainOutcomes?: { chain: string; status: string; count: number }[];
  routes: Route[];
  routeRankings?: Record<"swaps" | Unit, Route[]>;
  distribution: {
    bucket: number;
    swaps: number;
    volume_usd: Amount;
    volume_zec: Amount;
  }[];
  statuses: { status: string; count: number }[];
  latency: {
    direction: string;
    chain: string;
    samples: number;
    median_minutes: number;
    p90_minutes: number;
  }[];
  referrals: {
    referral: string | null;
    observed: number;
    successful: number;
    refunded: number;
    failed: number;
    volume_usd: Amount;
  }[];
  latencyDefinition: string;
  volumeDefinition: string;
}
export interface Swap {
  venue?: "maya" | "thorchain";
  refundKind?: "partial" | "full" | null;
  providerRecord?: VenueProviderRecord;
  id: string;
  depositAddress: string;
  depositMemo: string | null;
  status: string;
  direction: string;
  createdAt: string;
  sourceChain: string;
  sourceToken: string;
  destChain: string;
  destToken: string;
  sourceAmount: Amount;
  destAmount: Amount;
  amountUsd: Amount;
  zecAmount: Amount;
  sourceTxHashes: string[];
  destTxHashes: string[];
  nearTxHashes: string[];
  sourceAsset: string | null;
  destAsset: string | null;
  amountInRaw: Amount;
  amountOutRaw: Amount;
  intentHashes: string | null;
  senders: string[];
  recipient: string | null;
  refundTo: string | null;
  refundType: string | null;
  referral: string | null;
  appFees: { fee: number; recipient: string }[] | null;
  refundReason: string | null;
  refundFee: Amount;
  depositType: string | null;
  recipientType: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  statusObservedAt: string | null;
}
export interface SwapPage {
  source: string;
  swaps: Swap[];
  nextCursor: string | null;
}
