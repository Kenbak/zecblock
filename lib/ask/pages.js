/* eslint-disable @typescript-eslint/no-require-imports */
/* Public descriptors only. Never serialize DOM text, query strings or wallet state. */
const chartPages = require('./chart-pages.json');
const base = { version: 1, metric: 'balances', period: '30d', pool: 'all', view: 'line', start: null, end: null };
const pages = {
  '/': { id: 'home', title: 'Zcash overview', topic: 'home' },
  '/zift': { id: 'ask', title: 'Zift', topic: 'explorer' },
  '/txs': { id: 'transactions', title: 'Transactions', topic: 'transactions' },
  '/blocks': { id: 'blocks', title: 'Blocks', topic: 'blocks' },
  '/pools': { id: 'pools', title: 'Shielded pools', topic: 'pools', spec: base },
  '/ironwood': { id: 'ironwood', title: 'Ironwood', topic: 'ironwood', spec: { ...base, metric: 'migration_share', period: '90d' } },
  '/crosschain': { id: 'crosschain', title: 'Cross-chain swaps', topic: 'crosschain', spec: { ...base, metric: 'swap_volume', view: 'bar' } },
  '/pulse': { id: 'pulse', title: 'Network Pulse', topic: 'pulse', spec: { ...base, metric: 'pulse', view: 'bar' } },
  '/zodl': { id: 'miner_zodl', title: 'Miner ZODL', topic: 'miner_zodl' },
  '/network': { id: 'network', title: 'Network', topic: 'network' },
  '/network/upgrades': { id: 'network_upgrades', title: 'Network Upgrades', topic: 'network_upgrades' },
  '/network/block-speed': { id: 'block_speed', title: 'Block Speed', topic: 'block_speed' },
  '/rich-list': { id: 'addresses', title: 'Funded transparent addresses', topic: 'addresses' },
  '/mempool': { id: 'mempool', title: 'Mempool', topic: 'mempool' },
  '/network/nodes': { id: 'nodes', title: 'Network Nodes', topic: 'nodes' },
  '/mining': { id: 'mining', title: 'Mining', topic: 'mining' },
  '/reorgs': { id: 'reorgs', title: 'Forks & Reorgs', topic: 'reorgs' },
  '/charts': { id: 'charts', title: 'Charts', topic: 'charts' },
  '/turnstile': { id: 'turnstile', title: 'Turnstile Tracker', topic: 'turnstile' },
  '/privacy-risks': { id: 'privacy_risks', title: 'Privacy Risk Analysis', topic: 'privacy_risks' },
  '/privacy/wallets': { id: 'wallet_signals', title: 'Wallet Signals', topic: 'wallet_signals' },
  '/valuation': { id: 'valuation', title: 'Valuation & Market Context', topic: 'valuation' },
  '/usage-clock': { id: 'usage_clock', title: 'Usage Clock', topic: 'usage_clock' },
  '/governance': { id: 'governance', title: 'Governance', topic: 'governance' },
  '/tools': { id: 'tools', title: 'Developer Tools', topic: 'tools' },
  '/tools/decode': { id: 'decode', title: 'Decode Transaction', topic: 'decode' },
  '/tools/broadcast': { id: 'broadcast', title: 'Broadcast Transaction', topic: 'broadcast' },
  '/decrypt': { id: 'decrypt', title: 'Decrypt Memo', topic: 'decrypt' },
  '/tools/blend-check': { id: 'blend_check', title: 'Blend Check', topic: 'blend_check' },
  '/tools/unit-converter': { id: 'unit_converter', title: 'Unit Converter', topic: 'unit_converter' },
  '/tools/anchor-search': { id: 'anchor_search', title: 'Anchor Root Search', topic: 'anchor_search' },
  '/docs': { id: 'docs', title: 'API Docs', topic: 'docs' },
  '/learn': { id: 'learn', title: 'Learn Zcash', topic: 'learn' },
  '/newsletter': { id: 'newsletter', title: 'Newsletter', topic: 'newsletter' },
  '/about': { id: 'about', title: 'About', topic: 'about' },
  '/press': { id: 'press', title: 'Press & Brand', topic: 'press' },
  '/network/attestations': { id: 'attestations', title: 'Indexer Attestations', topic: 'attestations' },
  '/privacy-policy': { id: 'privacy_policy', title: 'Privacy Policy', topic: 'privacy_policy' },
  '/terms': { id: 'terms', title: 'Terms of Service', topic: 'terms' },
  '/privacy': { id: 'privacy', title: 'Privacy Score', topic: 'privacy_score' },
};
for (const chart of chartPages) pages[`/charts/${chart.id}`] = { id: `chart_${chart.id.replace(/-/g, '_')}`, title: chart.title, topic: `chart_${chart.id.replace(/-/g, '_')}` };
const aliases = { '/blocks/latest': '/blocks', '/txs/latest': '/txs', '/mempool/live': '/mempool' };
const pageQuestions = {
  attestations: ['Is an attestation the same as a reproduced build?'],
  privacy_policy: ['Is browser-local decryption the same as private chat?'],
  terms: ['Where are the availability conditions?'],
  name: ['Does a readable name verify someone’s identity?'],
  mempool: ['Does pending mean confirmed?'],
  network: ['How should I read the hashrate estimate?'],
  network_upgrades: ['Does a linked tracker prove an upgrade is active?'],
  nodes: ['Is this a count of every Zcash node?'],
  mining: ['Do software markers prove which node software miners run?'],
  reorgs: ['What is the difference between an orphan and a reorg?'],
  charts: ['What should I check before comparing charts?'],
  privacy_score: ['Does the privacy score measure my transaction’s privacy?'],
  turnstile: ['Does an exchange destination mean the ZEC was sold?'],
  privacy_risks: ['Does a high score prove these transactions are linked?'],
  wallet_signals: ['Can these signals identify someone’s wallet?'],
  valuation: ['Are MVRV and NUPL independent signals?'],
  usage_clock: ['Does daylight correlation show where users live?'],
  governance: ['Does a vote result mean a network upgrade is live?'],
  tools: ['What is the difference between decoding and broadcasting?'],
  decode: ['Does decoding broadcast the transaction?'],
  broadcast: ['Does successful broadcast mean confirmed?'],
  decrypt: ['Should I give Ask my viewing key?'],
  blend_check: ['Does a common amount guarantee anonymity?'],
  unit_converter: ['What is a zatoshi?'],
  anchor_search: ['Does an anchor root reveal private payments?'],
  docs: ['How do I interpret unknown freshness?'],
  learn: ['What is the difference between a wallet and a full node?'],
  newsletter: ['Are newsletter figures live network readings?'],
  about: ['Where do I find integration details?'],
  press: ['Where can I find the logo assets?'],
  address: ['Is an address the same as a user?']
};
function describePage(pathname) {
  pathname = pathname.replace(/\/$/, '') || '/';
  if (Object.hasOwn(aliases, pathname)) pathname = aliases[pathname];
  if (Object.hasOwn(pages, pathname)) return pages[pathname];
  if (/^\/tx\/[a-fA-F0-9]{64}$/.test(pathname)) return { id: 'transaction', title: 'Transaction', topic: 'transactions' };
  if (/^\/block\/(\d{1,9}|[a-fA-F0-9]{64})$/.test(pathname)) return { id: 'block', title: 'Block', topic: 'block' };
  if (/^\/address\/[A-Za-z0-9]{20,200}$/.test(pathname)) return { id: 'address', title: 'Address', topic: 'address', questions: pageQuestions.address };
  if (/^\/governance\/[a-z0-9-]{1,100}$/.test(pathname)) return { ...pages['/governance'], title: 'Governance round guide' };
  if (/^\/name\/[^/?#]{1,200}$/.test(pathname)) return { id: 'name', title: 'Zcash name', topic: 'name', questions: pageQuestions.name };
  if (/^\/newsletter\/[a-z0-9-]{1,120}$/.test(pathname)) return { ...pages['/newsletter'], title: 'Newsletter issue guide' };
  return { id: 'explorer', title: 'Zcash explorer', topic: 'explorer' };
}
for (const page of Object.values(pages)) if (pageQuestions[page.topic]) page.questions = pageQuestions[page.topic];
const pageIds = [...new Set([...Object.values(pages).map(page => page.id), 'transaction', 'block', 'address', 'name', 'explorer'])];
function pageById(id) {
  return Object.values(pages).find(page => page.id === id) || ({ name: describePage('/name/example'), transaction: describePage('/tx/' + 'a'.repeat(64)), block: describePage('/block/1'), address: describePage('/address/' + 'a'.repeat(35)) })[id] || describePage('');
}
module.exports = { describePage, pageById, pageIds };
