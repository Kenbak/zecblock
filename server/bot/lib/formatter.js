'use strict';

/**
 * CipherScan Data Bot — Post Formatter
 *
 * Composes post text for each content type.
 * All posts are self-contained (no "click to see more" dependency on links).
 * Links provide provenance only.
 */

const BASE_URL = 'https://zecblock.com';

function fmtZec(zat) {
  const zec = zat / 1e8;
  if (zec >= 1_000_000) return `${(zec / 1_000_000).toFixed(2)}M ZEC`;
  if (zec >= 1_000) return `${(zec / 1_000).toFixed(1)}K ZEC`;
  return `${zec.toFixed(2)} ZEC`;
}

function fmtPct(pct) {
  return `${pct.toFixed(1)}%`;
}

function fmtBlockTime(seconds) {
  return `${seconds.toFixed(1)}s`;
}

function fmtHeight(h) {
  return h.toLocaleString();
}

// ─── Daily Digest ────────────────────────────────────────────────────────────

function formatDailyDigest({
  chainTip,
  shielded,
  flows,
  ironwood,
  compliance,
  crossChain,
}) {
  const shieldStr = fmtZec(flows.netShielded).replace(' ZEC', '');
  const deshieldStr = fmtZec(flows.netDeshielded).replace(' ZEC', '');
  const poolStr = fmtZec(ironwood.poolSizeZat).replace(' ZEC', '');
  const shieldedStr = fmtZec(shielded.totalZat).replace(' ZEC', '');

  const lines = [
    `📊 Zcash Daily — Block ${Number(chainTip.height).toLocaleString()}`,
    ``,
    `🛡 Shielded: ${shieldedStr} ZEC`,
    `🟢 +${shieldStr} in / 🔴 -${deshieldStr} out`,
    ``,
    `🌲 Ironwood: ${poolStr} ZEC`,
    `Orchard → Ironwood: ${fmtPct(ironwood.orchardToIronwoodPct)}`,
    `ZIP-318 compliance: ${fmtPct(compliance.pct)}`,
  ];

  if (crossChain && (crossChain.inflowUsd > 0 || crossChain.outflowUsd > 0)) {
    lines.push(``);
    lines.push(`🔄 Cross-chain: ${fmtUsd(crossChain.inflowUsd)} in / ${fmtUsd(crossChain.outflowUsd)} out`);
  }

  lines.push(``);
  lines.push(BASE_URL);

  return lines.join('\n');
}

function fmtUsd(usd) {
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(2)}B`;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${Math.round(usd)}`;
}

function fmtTopPct(percentileRank) {
  const top = 100 - percentileRank;
  if (top >= 1) return `Top ${top.toFixed(1)}%`;
  if (top >= 0.01) return `Top ${top.toFixed(2)}%`;
  return 'Top <0.01%';
}

// ─── Large Flow Alert ────────────────────────────────────────────────────────

function formatLargeFlowAlert({ direction, amountZat, pool, blockHeight, txid, percentileRank, priceUsd }) {
  const verb = direction === 'shield' ? 'shielded' : 'deshielded';
  const prep = direction === 'shield' ? 'into' : 'from';
  const zec = amountZat / 1e8;
  let amountStr = fmtZec(amountZat);
  if (priceUsd) {
    const usd = zec * priceUsd;
    const usdStr = fmtUsd(usd);
    amountStr += ` (${usdStr})`;
  }
  const lines = [
    `🐳 Whale Alert`,
    ``,
    `${amountStr} ${verb} ${prep} ${pool}.`,
    `${fmtTopPct(percentileRank)} of 90-day flows.`,
    ``,
    `${BASE_URL}/tx/${txid}`,
  ];
  return lines.join('\n');
}

// ─── Ironwood Milestone ──────────────────────────────────────────────────────

function formatIronwoodMilestone({ type, value, context }) {
  let detail;
  switch (type) {
    case 'volume':
      detail = `Ironwood just crossed ${fmtZec(value * 1e8)}.`;
      break;
    case 'count':
      // NB: this counts all transactions touching Ironwood (has_ironwood = true),
      // not just inbound migrations — an Ironwood-to-Ironwood spend counts too.
      // Keep this wording aligned with the card subtitle in card-renderer.js.
      detail = `${value.toLocaleString()} Ironwood transactions completed.`;
      break;
    case 'supply_pct':
      detail = `${value}% of Orchard migrated to Ironwood.`;
      break;
    case 'compliance':
      detail = `ZIP-318 compliance sustained above ${value}%.`;
      break;
    case 'usd_value':
      detail = `Ironwood pool value just crossed ${fmtUsd(value)}.`;
      break;
    default:
      detail = `Ironwood milestone reached.`;
  }
  if (context) detail += ` ${context}`;

  const lines = [
    `🌲 Milestone`,
    ``,
    detail,
    ``,
    `${BASE_URL}/ironwood`,
  ];
  return lines.join('\n');
}

// ─── Reorg Alert ─────────────────────────────────────────────────────────────

function formatReorgAlert({ depth, forkHeight, canonicalTip }) {
  const lines = [
    `⚠️ Chain reorganization detected`,
    ``,
    `Depth: ${depth} blocks`,
    `Fork height: ${fmtHeight(forkHeight)}`,
    `Canonical tip: ${fmtHeight(canonicalTip)}`,
    ``,
    `Monitoring for stability.`,
  ];
  return lines.join('\n');
}

// ─── Chain Stall ─────────────────────────────────────────────────────────────

// targetSeconds is the node-scheduled spacing at the tip (75 before NU7, 25
// after); the line is omitted when it is unknown rather than guessed.
function formatChainStall({ lastBlockTime, gapSeconds, targetSeconds = null }) {
  const minutes = Math.floor(gapSeconds / 60);
  const lines = [
    `⚠️ Block production gap: ${minutes} minutes`,
    ``,
    `Last block: ${new Date(lastBlockTime * 1000).toISOString()}`,
    ...(Number.isSafeInteger(targetSeconds) && targetSeconds > 0 ? [`Expected: ~${targetSeconds} seconds between blocks`] : []),
    ``,
    `Monitoring. Will update on recovery.`,
  ];
  return lines.join('\n');
}

function formatChainRecovery({ blockHeight, gapMinutes }) {
  return [
    `✅ Block production resumed at height ${fmtHeight(blockHeight)}`,
    ``,
    `Gap was ~${gapMinutes} minutes. Chain is healthy.`,
  ].join('\n');
}

// ─── Cross-chain Whale Alert ──────────────────────────────────────────────

function formatCrossChainAlert({ direction, amountUsd, amountZec, sourceChain, destChain, zecTxid }) {
  const isInflow = direction === 'inflow';
  const chain = isInflow ? sourceChain.toUpperCase() : destChain.toUpperCase();
  const emoji = isInflow ? '🟢' : '🔴';
  const title = isInflow ? `${emoji} Whale Inflow` : `${emoji} Whale Outflow`;
  const flow = isInflow ? `${chain} → ZEC` : `ZEC → ${chain}`;
  let amountStr = `$${Math.round(amountUsd).toLocaleString()}`;
  if (amountZec && amountZec > 0) {
    amountStr += ` (${amountZec.toLocaleString(undefined, { maximumFractionDigits: 1 })} ZEC)`;
  }
  const lines = [
    title,
    ``,
    `${amountStr} bridged (${flow})`,
  ];
  if (zecTxid) {
    lines.push(``);
    lines.push(`${BASE_URL}/tx/${zecTxid}`);
  }
  return lines.join('\n');
}

// ─── Pool Migration Alert ─────────────────────────────────────────────────

function formatMigrationAlert({ amountZat, fromPool, toPool, txid, priceUsd }) {
  const zec = amountZat / 1e8;
  let amountStr = fmtZec(amountZat);
  if (priceUsd) {
    const usd = zec * priceUsd;
    const usdStr = fmtUsd(usd);
    amountStr += ` (${usdStr})`;
  }
  const lines = [
    `🔄 Migration Alert`,
    ``,
    `${amountStr} migrated from ${fromPool} → ${toPool}.`,
    ``,
    `${BASE_URL}/tx/${txid}`,
  ];
  return lines.join('\n');
}

// ─── Network Pulse Anomaly Alert ──────────────────────────────────────────

// Units per anomaly metric (mirrors server/jobs/detect-anomalies.js)
const PULSE_METRIC_UNITS = {
  tx_count_total: 'txs',
  tx_count_shielded: 'txs',
  shielded_pct: '%',
  shield_volume_zat: 'ZEC',
  deshield_volume_zat: 'ZEC',
  crosschain_inflow_usd: 'USD',
  crosschain_outflow_usd: 'USD',
  daily_fees_zat: 'ZEC',
  exchange_deposit_zat: 'ZEC',
  mvrv: 'ratio',
  migration_volume_zat: 'ZEC',
  miner_exchange_ratio: 'ratio',
};

function fmtMetricValue(metric, value) {
  const unit = PULSE_METRIC_UNITS[metric];
  if (unit === 'ZEC') return fmtZec(value);
  if (unit === 'USD') return fmtUsd(value);
  if (unit === '%') return `${value.toFixed(1)}%`;
  if (unit === 'ratio') return value.toFixed(2);
  return `${Math.round(value).toLocaleString()} txs`;
}

function formatPulseAlert({ metric, description, value, zscore, mean, direction }) {
  const valueStr = fmtMetricValue(metric, value);
  const meanStr = fmtMetricValue(metric, mean);
  const rel = direction === 'up' ? 'above' : 'below';
  const sigma = Math.abs(zscore).toFixed(1);

  const lines = [
    `📊 Network Pulse`,
    ``,
    `${description}: ${valueStr} — ${sigma}σ ${rel} the 90-day average (${meanStr}).`,
    ``,
    `${BASE_URL}/pulse`,
  ];
  return lines.join('\n');
}

// ─── Privacy Risk Alert ───────────────────────────────────────────────────

function formatPrivacyRiskAlert({ highLinkages, batchClusters }) {
  let detail = '';
  if (highLinkages.highCount > 0) {
    detail = `${highLinkages.highCount} high-confidence linkage patterns detected on Zcash in 24h.`;
  } else if (batchClusters.clusterCount > 0) {
    detail = `${batchClusters.clusterCount} batch deshielding clusters detected on Zcash in 24h.`;
  }

  const lines = [
    `🔍 Privacy Alert`,
    ``,
    detail,
    ``,
    `Use standard denominations. Learn more:`,
    `${BASE_URL}/privacy-risks`,
  ];
  return lines.join('\n');
}

module.exports = {
  formatDailyDigest,
  formatLargeFlowAlert,
  formatIronwoodMilestone,
  formatMigrationAlert,
  formatReorgAlert,
  formatChainStall,
  formatChainRecovery,
  formatCrossChainAlert,
  formatPrivacyRiskAlert,
  formatPulseAlert,
  fmtMetricValue,
  PULSE_METRIC_UNITS,
  fmtZec,
  fmtPct,
  fmtHeight,
  fmtTopPct,
};
