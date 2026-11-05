import Link from "next/link";
import { EXPLORERS } from "./model";

export type VenueTransaction = {
  side: "in" | "out";
  txid: string | null;
  address: string | null;
  affiliate: boolean;
  coins: { asset: string; chain: string; token: string; amountBaseUnits: string; decimals: number; amount: string }[];
};
export interface VenueProviderRecord {
  id: string;
  actionType: string;
  refundKind: "partial" | "full" | null;
  observedStatus: string;
  createdAt: string;
  streaming: boolean;
  zecAmount: string | null;
  zecAmountZat: string | null;
  zecAmountBasis: string | null;
  sourceAddress: string | null;
  inputs: VenueTransaction[];
  outputs: VenueTransaction[];
}

function TransactionLeg({ leg }: { leg: VenueTransaction }) {
  const nativeZec = leg.coins.some(coin => coin.asset === "ZEC.ZEC");
  const chains = [...new Set(leg.coins.map(coin => coin.chain))];
  const chain = chains.length === 1 ? chains[0] : null;
  const externalHash = leg.txid && chain && ["eth", "arb", "base", "avax", "bsc", "op", "pol"].includes(chain) ? `0x${leg.txid}` : leg.txid;
  const externalUrl = chain && chain !== "zec" && EXPLORERS[chain] && externalHash ? EXPLORERS[chain] + encodeURIComponent(externalHash) : null;
  return <li className="space-y-1 min-w-0">
    <p className="text-muted">{leg.side === "in" ? "Input" : "Output"}{leg.affiliate ? " · affiliate" : ""}</p>
    {leg.coins.map((coin, index) => <p key={`${coin.asset}-${index}`} className="font-mono break-all">
      {coin.amount} {coin.token} <span className="text-muted">({coin.asset}; {coin.amountBaseUnits} in 1e{coin.decimals} units)</span>
    </p>)}
    <p className="break-all">Address: <span className="font-mono">{leg.address || "Not reported"}</span></p>
    <p className="break-all">Transaction: {leg.txid
      ? nativeZec ? <Link className="text-cipher-gold hover:underline font-mono" href={`/tx/${leg.txid}`} prefetch={false}>{leg.txid}</Link>
        : externalUrl ? <a className="text-cipher-gold hover:underline font-mono" href={externalUrl} target="_blank" rel="noopener noreferrer">{leg.txid}</a> : <span className="font-mono">{leg.txid}</span>
      : <span className="text-muted">Not reported</span>}</p>
  </li>;
}

export function VenueTransferDetails({ record }: { record: VenueProviderRecord }) {
  return <div className="mt-4 pt-4 border-t border-cipher-border space-y-4 text-xs">
    <dl className="grid sm:grid-cols-2 gap-3">
      <div><dt className="text-muted">Provider action ID</dt><dd className="font-mono break-all mt-1">{record.id}</dd></div>
      <div><dt className="text-muted">Reported source address</dt><dd className="font-mono break-all mt-1">{record.sourceAddress || "Not reported"}</dd></div>
      <div><dt className="text-muted">Reported state</dt><dd className="mt-1">{record.refundKind === "partial" ? "Partial refund" : record.actionType === "refund" ? "Refund" : record.observedStatus}{record.streaming ? " · streaming swap" : ""}</dd></div>
      <div><dt className="text-muted">Provider action time (UTC)</dt><dd className="font-mono mt-1">{record.createdAt.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}</dd></div>
      <div><dt className="text-muted">Native ZEC amount</dt><dd className="font-mono break-all mt-1">{record.zecAmount == null ? "Unavailable for this state" : `${record.zecAmount} ZEC (${record.zecAmountZat} zat)`}</dd></div>
      <div><dt className="text-muted">ZEC amount basis</dt><dd className="break-words mt-1">{record.zecAmountBasis === "sum-of-reported-native-zec-payouts" ? "Sum of reported Zcash payouts" : record.zecAmountBasis === "midgard-reported-native-zec-input" ? "Provider-reported Zcash input" : "No single external ZEC amount"}</dd></div>
    </dl>
    {record.refundKind === "partial" ? <p className="text-muted">The summary shows the returned source asset. Related payout legs remain listed below; this refund is not another successful swap.</p> : null}
    <p className="text-muted">Every reported input and output appears below. Successful streaming swaps can include partial refunds; affiliate outputs are marked. Provider observations are not independent proof of chain finality.</p>
    <ul className="space-y-4">{[...record.inputs, ...record.outputs].map((leg, index) => <TransactionLeg key={`${leg.side}-${index}`} leg={leg} />)}</ul>
  </div>;
}
