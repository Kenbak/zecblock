/**
 * Mining Pool Attribution
 *
 * Maps known coinbase payout addresses to mining pool identities.
 * Sources: Zcashinfo.com labels, coinbase tag analysis, Shawn Murphy's peer analysis,
 * AiCoin on-chain article (confirmed addresses), 2Miners documentation,
 * zecminingpool.com network dashboard cross-reference (Oct 2026).
 * Last audited: 2026-10-10 (live reference feed + canonical node coinbases).
 */

const POOL_BY_ADDRESS = {
  // --- ViaBTC ---
  // ~35% hashrate (Aug 2026). No distinctive coinbase tag (just version bytes).
  // Confirmed via zecminingpool.com cross-reference: this address mines 34.6%
  // of blocks in 1-week window, matching ViaBTC's reported share exactly.
  // Previous note said "NOT ViaBTC" — that was incorrect; ViaBTC rotated to
  // this address around Jun 15 when their old address (t1at7nV...) stopped.
  't1MKn34KBa8Xh4g8qU8psibBXvURafphVn7': {
    name: 'ViaBTC',
    url: 'https://www.viabtc.com',
    region: 'US/CN',
  },
  // ViaBTC old address (AiCoin confirmed "t1at7nV...received 1.73M ZEC total")
  't1at7nVNsv6taLRrNRvnQdtfLNRDfsGc3Ak': {
    name: 'ViaBTC',
    url: 'https://www.viabtc.com',
    region: 'US/CN',
    deprecated: '2026-06-22',
  },

  // --- ViaBTC-Solo ---
  // ~7% hashrate (Aug 2026). ViaBTC's solo mining service.
  // Previously mislabeled as NiceHash — corrected via zecminingpool.com cross-reference.
  't1SEgZvXCu3ceE42qrq5pCeSq7HbLjX8NJv': {
    name: 'ViaBTC-Solo',
    url: 'https://www.viabtc.com',
    region: 'US/CN',
  },

  // --- F2Pool ---
  // Coinbase tag: "Mined by [username]"
  // Source: Zcashinfo.com, AiCoin on-chain analysis
  't1PEp2GJLSdhDfCKqc2J211WKDUS1NfoQNy': {
    name: 'F2Pool',
    url: 'https://f2pool.com',
    region: 'HK',
  },

  // --- Foundry USA Pool ---
  // Coinbase tag: "Foundry Zcash Pool #PrivacyMatt..."
  // Source: Zcashinfo.com, AiCoin on-chain analysis (confirmed address)
  't1SqwRAAdSig6dE4EBPLonAait219VmkUjP': {
    name: 'Foundry USA',
    url: 'https://foundrydigital.com',
    region: 'US',
  },
  // Official testnet: live reference + Foundry tag and payout in node block 4484946.
  'tmTwLU5Y855hfBZ25ZaWuTvcrqjrCMFAZR9': {
    name: 'Foundry USA',
    url: 'https://foundrydigital.com',
    region: null,
  },

  // --- Luxor ---
  // Source: Shawn Murphy peer analysis (IP: 15.204.182.52, Reston VA)
  't1XQZdZMnzXBcL8yx2PR27dSNrqctgwLgux': {
    name: 'Luxor',
    url: 'https://luxor.tech',
    region: 'US',
  },

  // Live network feed and coinbase "mined by KuPool" (block 3512788).
  't1Y2tYgDJnH4m1uQPDXxvXQSh1Jbun3AP22': {
    name: 'KuPool',
    url: 'https://kupool.com',
    region: null,
  },

  // Live network feed and /molepool.com/ coinbase (block 3511796).
  't1MqmXugaf5VSQvAVBhshK28S2kW762kNNH': {
    name: 'Molepool',
    url: 'https://zec.molepool.com',
    region: null,
  },

  // --- 2Miners ---
  // Coinbase tag: "2Miners https://2miners.com"
  // Current primary address (confirmed by coinbase tag, Aug 2026)
  't1VTjv7XF3hYqxQkxKmHHErvus3bDrbbkGg': {
    name: '2Miners',
    url: 'https://2miners.com',
    region: 'EU',
  },
  // 2Miners secondary address (same coinbase tag, low volume)
  't1QxTHUputbmZRxd3EqP671sLqd6KNBQbXJ': {
    name: '2Miners',
    url: 'https://2miners.com',
    region: 'EU',
  },
  // 2Miners old address (deprecated, confirmed by coinbase tag + 2Miners documentation)
  't1fu6KgYtHEXk2ZhTpM1XD7jbnSmW6wokDM': {
    name: '2Miners',
    url: 'https://2miners.com',
    region: 'EU',
    deprecated: '2026-07',
  },
  't1bnxtY7aLCjWx9Ru1YcGwRWch3eEWUFK7u': {
    name: '2Miners',
    url: 'https://2miners.com',
    region: 'EU',
    deprecated: '2026-06-02',
  },

  // --- NiceHash ---
  // Coinbase tag: "/NiceHash/"
  // Sluicey is a separate shielded-payout pool; its coinbase tag is handled
  // independently below and must not be attributed to NiceHash.
  't1eBv4a3wBhVaFgWYjXrFYTU7pruCWaBpLW': {
    name: 'NiceHash',
    url: 'https://www.nicehash.com',
    region: null,
  },

  // --- AntPool ---
  // Coinbase tag: "." (minimal single dot)
  // Source: Confirmed via coinbase tag matching against network monitoring
  't1L2b66MXbgpVMXDfUa94GCBFAN4dCxGohM': {
    name: 'AntPool',
    url: 'https://www.antpool.com',
    region: 'JP',
  },
  't1ZVi2YGk98tEGYcNpXYnJFWCoLG2oYwv3J': {
    name: 'AntPool',
    url: 'https://www.antpool.com',
    region: 'JP',
    deprecated: '2026-06-15',
  },

  // --- Kryptex ---
  // Current address (confirmed via zecminingpool.com cross-reference, Aug 2026).
  // Previously mislabeled as Poolin — corrected.
  't1e6hceYHkzCbwcwGZzKeMfXXW7x7gr19Cw': {
    name: 'Kryptex',
    url: 'https://www.kryptex.com',
    region: 'EU',
  },
  // Kryptex old address
  't1Mofe2EigYNfgqSTPbK4k1iJTxyCEEQCEC': {
    name: 'Kryptex',
    url: 'https://www.kryptex.com',
    region: 'EU',
    deprecated: '2026-07',
  },

  // --- ZEC Mining Pool ---
  // Coinbase tag: "🌸zecminingpool.com" (Zakura client)
  't1Uo7EN1A3GN29UjQJbUFYvrhxQd6Gt7qdA': {
    name: 'ZEC Mining Pool',
    url: 'https://zecminingpool.com',
    region: null,
  },

  // --- Mining Dutch ---
  // Current payout: live reference mapping, node-confirmed block 3512289.
  // The software-only coinbase marker does not independently name this pool.
  't1cQA9Rxn31tqHcgZzydrpDjgsQGmjpBgpB': {
    name: 'Mining Dutch',
    url: 'https://www.mining-dutch.nl',
    region: null,
  },
  // Historical Binance payout, not Mining Dutch. ZcashInfo's explicit
  // /api/v1/mining/pools/binance known_addresses registry lists this address;
  // node coinbases at 3372741 and 3405273 confirm the payout address.
  // Identity authority is the external registry, not the unmarked coinbase.
  't1egMFNkP7EfkK25y8s4GeiMkEGnqcMnTb1': {
    name: 'Binance Pool',
    url: 'https://pool.binance.com',
    region: null,
  },

  // t1Na7ykQ6vE4CbxBPuUDUQx5n6aEWXu1VQq was labeled Binance Pool
  // in commit 336808e (June 24), with only "Small consistent miner" as evidence.
  // Both live reference and ZcashInfo's recent/earliest sampled blocks leave it
  // unidentified. Keep unattributed until ownership is corroborated;
  // an empty tag is not evidence of Binance.

  // --- MySoloPool ---
  // Corroborated by block 3479731 (address + Mysolopool.com tag) and
  // 3431985 (same payout address before the tag was set). PR #72 / issue #73.
  't1Yw8NGbPDs7fgpxzJ8gzCgurAQ8GFQBkk2': {
    name: 'MySoloPool',
    url: 'https://zcash.mysolopool.com',
    region: null,
  },

  // --- Unidentified / inactive ---
  // Consistent ~7% hashrate, stopped Jun 15. No coinbase tag to confirm identity.
  't1K79TgQbqu74d6rBmsMu2oFEXEwAmdYiT7': {
    name: 'Unidentified #5',
    url: null,
    region: null,
    deprecated: '2026-06-15',
  },
  // ~2% hashrate, no coinbase tag (just Zebra version marker).
  // zecminingpool.com labels as "Private Miner B". Previously mislabeled as Solopool.
  't1fpcZ2Dbwn4oj35oWBTUhtmUciSq7HG7LU': {
    name: 'Private Miner B',
    url: null,
    region: null,
  },

  // --- Funding stream (not a pool) ---
  // ZIP-207 funding-stream payout address, not a miner. blocks.miner_address
  // (written by the indexer) can still end up pointing here on blocks where
  // the actual miner reward is deposited entirely into a shielded pool and
  // this is the only transparent coinbase output left — isFundingStream lets
  // callers detect and correctly relabel that case instead of showing "Miner".
  // A coinbase tag alone does not establish the miner identity. Never return
  // a funding-stream recipient as a mining pool.
  't3cFfPt1Bcvgez9ZbMBFWeZsskxTkPzGCow': {
    name: 'FPF / Zcash Community Grants',
    url: null,
    region: null,
    isFundingStream: true,
  },

  // --- Testnet Funding Streams ---
  // ZIP-214 testnet FPF / Zcash Community Grants funding-stream address,
  // used for all post-NU6 and post-NU6.1 address slots. This is distinct
  // from the deferred-development lockbox, which has no output address.
  // Source: https://zips.z.cash/zip-0214 (Testnet Recipients, Revision 1+2)
  't2HifwjUj9uyxr9bknR8LFuQbc98c3vkXtu': {
    // This metadata prevents the recipient being treated as a miner, but must
    // not produce a miner-pool label in block-list responses.
    name: null,
    url: null,
    region: null,
    isFundingStream: true,
  },
};

// Public pool markers identify the pool, never the shielded payout recipient.
// Sluicey: https://sluicey.xyz/ and reported block 3480541.
// MySoloPool: https://zcash.mysolopool.com and block 3479731 (PR #72).
const POOL_BY_TAG = {
  mysolopool: { name: 'MySoloPool', url: 'https://zcash.mysolopool.com', region: null, attribution: 'coinbase-tag' },
  sluicey: { name: 'Sluicey Pool', url: 'https://sluicey.xyz/', region: null, attribution: 'coinbase-tag' },
  kupool: { name: 'KuPool', url: 'https://kupool.com', region: null, attribution: 'coinbase-tag' },
  molepool: { name: 'Molepool', url: 'https://zec.molepool.com', region: null, attribution: 'coinbase-tag' },
  zecminingpool: { name: 'ZEC Mining Pool', url: 'https://zecminingpool.com', region: null, attribution: 'coinbase-tag' },
  foundry: { name: 'Foundry USA', url: 'https://foundrydigital.com', region: null, attribution: 'coinbase-tag' },
};
// One ordered pattern registry keeps SQL filters and JS labels identical.
// Match complete observed markers, not generic worker text or software emoji.
const TAG_PATTERNS = Object.entries({
  sluicey: 'Get Sluicey Yall sluicey.xyz',
  mysolopool: 'Mysolopool.com',
  kupool: 'mined by KuPool',
  molepool: '/molepool.com/',
  zecminingpool: 'zecminingpool.com',
  foundry: 'Foundry Zcash Pool #PrivacyMatters',
}).map(([tag, marker]) => [tag, `^(?:[0-9a-f]{2})*${Buffer.from(marker).toString('hex')}(?:[0-9a-f]{2})*$`]);
function getPoolTag(coinbaseHex) {
  if (typeof coinbaseHex !== 'string') return null;
  for (const [tag, pattern] of TAG_PATTERNS) {
    if (new RegExp(pattern, 'i').test(coinbaseHex)) return tag;
  }
  return null;
}
// Identifiers are internal call-site constants, never request input.
function getPoolTagSql(column = 'coinbase_hex') {
  if (!/^[a-z_]+(?:\.[a-z_]+)?$/.test(column)) throw new Error('Invalid coinbase SQL column');
  return `CASE ${TAG_PATTERNS.map(([tag, pattern]) => `WHEN ${column} ~* '${pattern}' THEN '${tag}'`).join(' ')} ELSE NULL END`;
}
function getPoolName(address, coinbaseHex) {
  const pool = address ? POOL_BY_ADDRESS[address] : null;
  if (pool && !pool.isFundingStream) return pool.name;
  return POOL_BY_TAG[getPoolTag(coinbaseHex)]?.name || null;
}

function getPoolInfo(address, coinbaseHex) {
  return (address ? POOL_BY_ADDRESS[address] : null) || POOL_BY_TAG[getPoolTag(coinbaseHex)] || null;
}

module.exports = { POOL_BY_ADDRESS, POOL_BY_TAG, getPoolName, getPoolInfo, getPoolTag, getPoolTagSql };
