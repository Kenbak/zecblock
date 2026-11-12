'use strict';

// Shared wording helpers for bot copy and cards. Every rounding direction is
// chosen so a displayed figure never overstates the underlying value.
const number = (n, digits = 0) => n.toLocaleString('en-US', { maximumFractionDigits: digits });
// toPrecision removes binary noise first: 512.05 * 100 is 51204.999… in floats.
const floorTo = (n, digits) => Math.floor(Number((n * 10 ** digits).toPrecision(12))) / 10 ** digits;

// Truncated to cents of a ZEC with integer zatoshi arithmetic; whole amounts drop the ".00".
function zecText(zat) {
  const zec = Math.floor(Number(zat) / 1e6) / 100;
  return zec.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(zec) ? 0 : 2, maximumFractionDigits: 2 });
}

// Round-number levels read as written: 4M, 4.25M, 250K.
const levelText = zec => zecShort(zec).replace(/(\.\d*?)0+([MK])$/, '$1$2').replace(/\.([MK])$/, '$1');

// Pool balances: 3,999,999 ZEC must read 3.99M, never 4.00M.
function zecShort(zec) {
  if (zec >= 1e6) return `${floorTo(zec / 1e6, 2).toFixed(2)}M`;
  if (zec >= 1e3) return `${floorTo(zec / 1e3, 1).toFixed(1)}K`;
  return number(floorTo(zec, 2), 2);
}

function usdShort(usd) {
  if (usd >= 1e9) return `$${floorTo(usd / 1e9, 2).toFixed(2)}B`;
  if (usd >= 1e6) return `$${floorTo(usd / 1e6, 2).toFixed(2)}M`;
  if (usd >= 1e3) return `$${number(Math.floor(usd / 1e3))}K`;
  return `$${number(Math.floor(usd))}`;
}

// Percentile tails round up so "top x%" never claims more rarity than measured.
function tailText(pct) {
  return String(Math.max(0.01, Math.ceil(pct * 100) / 100));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayText(date) {
  const [, m, d] = date.slice(0, 10).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}
const dayYear = date => `${dayText(date)}, ${date.slice(0, 4)}`;
function rangeText(start, endInclusive) {
  return start.slice(5, 7) === endInclusive.slice(5, 7)
    ? `${dayText(start)} – ${Number(endInclusive.slice(8, 10))}, ${endInclusive.slice(0, 4)}`
    : `${dayText(start)} – ${dayText(endInclusive)}, ${endInclusive.slice(0, 4)}`;
}
function timeText(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const iso = new Date(seconds * 1000).toISOString();
  return `${dayYear(iso)} · ${iso.slice(11, 16)} UTC`;
}

const CHAINS = {
  zec: 'Zcash', eth: 'Ethereum', btc: 'Bitcoin', sol: 'Solana', near: 'NEAR', base: 'Base', arb: 'Arbitrum',
  op: 'Optimism', pol: 'Polygon', bsc: 'BNB Chain', avax: 'Avalanche', tron: 'Tron', trx: 'Tron', doge: 'Dogecoin',
  ltc: 'Litecoin', bch: 'Bitcoin Cash', xrp: 'XRP Ledger', ton: 'TON', sui: 'Sui', aptos: 'Aptos', cardano: 'Cardano',
  stellar: 'Stellar', starknet: 'Starknet', gnosis: 'Gnosis', bera: 'Berachain',
  dash: 'Dash', kuji: 'Kujira', gaia: 'Cosmos Hub', xrd: 'Radix', maya: 'MAYAChain', thor: 'THORChain',
};
// Venues are the protocols that executed a swap, distinct from the chains it crossed.
const VENUES = { near: 'NEAR Intents', maya: 'Maya', thorchain: 'THORChain' };
const chainName = code => CHAINS[code.toLowerCase()] || code.toUpperCase();

const POOLS = { sapling: 'Sapling', orchard: 'Orchard', ironwood: 'Ironwood' };
const ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const shortTxid = txid => `${txid.slice(0, 8)}…${txid.slice(-4)}`;
const signedPct = pct => `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;

module.exports = { number, floorTo, zecText, zecShort, levelText, usdShort, tailText, dayText, dayYear, rangeText, timeText,
  chainName, VENUES, POOLS, ORDINALS, WORDS, shortTxid, signedPct };
