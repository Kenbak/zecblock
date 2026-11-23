// Markdown versions of ZecBlock pages for language models, following the
// llms.txt convention (https://llmstxt.org): /llms.txt indexes them, and each
// page's Markdown lives at its URL with `.md` appended.
//
// Each document describes what its page shows, using the page's own title and
// description. It never contains live chain figures: those change every block
// and are served by the API and MCP server instead. CI checks that every page
// has a document and that titles and descriptions match the page metadata
// (server/tests/llms-docs.test.js).

import { CHART_CATALOG, type CatalogChart } from '@/lib/chart-catalog';
import { chartPublicTitle, chartRanges, chartSource } from '@/lib/chart-sharing';
import { getAllNewsletters } from '@/lib/newsletter';
import { getEndpointsByCategory } from '@/app/docs/endpoints';
import { getTools } from '@/server/api/v1/mcp/catalog';
import { markdownPathFor } from './paths';
import { getHomeAbout, homeAboutMarkdown } from '@/lib/home-about';

export const SITE_URL = 'https://zecblock.com';
// Public API origin only; never a configured server-side origin.
export const PUBLIC_API_URL = 'https://api.zecblock.com';
export const MCP_URL = `${PUBLIC_API_URL}/v1/mcp`;

export type LlmsSection =
  | 'Explorer'
  | 'Data pages'
  | 'Network and mining'
  | 'Privacy and shielded pools'
  | 'Charts and valuation'
  | 'Governance'
  | 'Tools'
  | 'Developers'
  | 'About'
  | 'Newsletter';

export const SECTION_ORDER: LlmsSection[] = [
  'Explorer', 'Data pages', 'Network and mining', 'Privacy and shielded pools', 'Charts and valuation',
  'Governance', 'Tools', 'Developers', 'About', 'Newsletter',
];

export interface LlmsDoc {
  /** Page path on zecblock.com, or the shared path prefix of a data page type. */
  path: string;
  markdownPath: string;
  section: LlmsSection;
  /** Page title as served, including the " | ZecBlock" suffix where the page has one. */
  title: string;
  description: string;
  markdown: string;
}

interface PageEntry {
  path: string;
  section: LlmsSection;
  title: string;
  description: string;
  /** Extra Markdown after the summary. */
  body?: string;
  /** MCP tools that return this page's live data. */
  tools?: string[];
}

// Titles and descriptions are the pages' own metadata (checked in CI). Grant
// round pages build theirs from live proposal counts; their entries omit counts.
const PAGES: PageEntry[] = [
  { path: '/', section: 'Explorer', title: 'Zcash Explorer & Privacy Analytics | ZecBlock', description: 'ZecBlock is an open-source Zcash block explorer. Search blocks, transactions and addresses, and explore shielded pools, network activity and privacy analytics.', tools: ['chain_info', 'blocks', 'transactions'] },
  { path: '/blocks', section: 'Explorer', title: 'Latest Zcash Blocks - Block Explorer | ZecBlock', description: 'Browse the latest Zcash blocks with transaction counts, sizes, mining rewards, and timestamps. Real-time block explorer data.', tools: ['blocks', 'block'] },
  { path: '/txs', section: 'Explorer', title: 'Latest Zcash Transactions | ZecBlock', description: 'Browse the latest Zcash transactions including shielded, transparent, and coinbase transactions. Real-time transaction explorer.', tools: ['transactions', 'transaction'],
    body: 'The shielded view, [/txs?type=shielded](https://zecblock.com/txs?type=shielded), lists shielded Zcash transactions and tracks shielding and deshielding flows across the Ironwood, Orchard and Sapling pools.' },
  { path: '/mempool', section: 'Explorer', title: 'Zcash Mempool: Pending Transactions | ZecBlock', description: 'Watch pending and unconfirmed Zcash transactions in real time, including transaction size, fee rate, and confirmation status.', tools: ['mempool'] },
  { path: '/mempool/live', section: 'Explorer', title: 'Mempool Live — Zcash Network Screensaver | ZecBlock', description: 'Watch pending Zcash transactions in a full-screen mempool visualization for passive monitoring.', tools: ['mempool'] },
  { path: '/rich-list', section: 'Explorer', title: 'Rich List — Top Zcash Addresses by Balance | ZecBlock', description: 'Explore the top Zcash transparent addresses ranked by balance. See labeled exchanges, mining pools, and supply concentration stats.', tools: ['address'] },
  { path: '/reorgs', section: 'Explorer', title: 'Zcash Forks & Orphaned Blocks | ZecBlock', description: 'Monitor Zcash forks, orphaned blocks, competing tips, reorg depth, affected miners, and consensus health in real time.', tools: ['reorg_summary'] },
  { path: '/crosschain', section: 'Explorer', title: 'ZEC Cross-Chain Swap Analytics | ZecBlock', description: 'Explore native ZEC swaps through NEAR Intents, Maya and THORChain with venue-specific charts, transaction records and explicit historical coverage.', tools: ['crosschain_analytics', 'crosschain_swaps', 'crosschain_shielding', 'crosschain_venues', 'crosschain_venue_analytics', 'crosschain_venue_swaps'] },

  { path: '/network', section: 'Network and mining', title: 'Zcash Network Stats & Node Map | ZecBlock', description: 'Explore Zcash protocol parameters, issuance and the next halving, observed nodes, block cadence, hashrate and transaction fees.', tools: ['chain_info', 'network_supply', 'network_halving', 'network_fees', 'network_accounting'] },
  { path: '/network/nodes', section: 'Network and mining', title: 'Zcash Network Nodes | ZecBlock', description: 'Explore the Zcash peer-to-peer network: observed active nodes, client implementations, version adoption, and geographic distribution.' },
  { path: '/network/attestations', section: 'Network and mining', title: 'Zero Indexer Attestation Monitor | ZecBlock', description: 'Check fresh enclave evidence, TLS certificate bindings and software release status for experimental Zcash Zero Indexer shims and hubs.' },
  { path: '/network/wallet-servers', section: 'Network and mining', title: 'Zcash Wallet Servers: Live Lightwalletd Status | ZecBlock', description: 'Live checks of public Zcash wallet servers, including fastz.cash and zec.rocks: which answer, their block height, software and if their tip matches our index.' },
  { path: '/network/block-speed', section: 'Network and mining', title: 'Zcash Block Speed: 75-Second Blocks to 25 with NU7 | ZecBlock', description: 'Daily measured Zcash block times and NU7’s 25-second target: how many blocks are fast or slow, first confirmation, time until received funds are spendable and blocks per hour.' },
  { path: '/network/upgrades', section: 'Network and mining', title: 'Zcash Network Upgrades: Changes & Trackers | ZecBlock', description: 'Explore major changes in every Zcash network upgrade, from Overwinter to NU7: block speed, NSM reserve and fees, shielded pools, transactions and funding.', tools: ['chain_info'] },
  { path: '/mining', section: 'Network and mining', title: 'Zcash Mining Statistics & Pool Distribution | ZecBlock', description: 'Explore Zcash hashrate, observed orphan rates, mining pool shares, block production, fees, and miner reward flows. Compare 24h, 7d, and 30d orphan observations.' },
  { path: '/zodl', section: 'Network and mining', title: 'Zcash Miner ZODL Leaderboard | ZecBlock', description: 'Compare unspent Zcash mining rewards and their first transfers by pool, including shielding and labeled exchange flows. Transfers do not prove sales.' },
  { path: '/calendar', section: 'Network and mining', title: 'Zcash Calendar: Upgrades, Votes & Key Blocks | ZecBlock', description: 'Every important Zcash block and date in one timeline: network upgrades, halvings, coinholder votes, grant deadlines and snapshots, with estimated blocks for what is ahead.', tools: ['network_halving'] },
  { path: '/usage-clock', section: 'Network and mining', title: 'The Rhythm of Zcash | ZecBlock', description: 'Explore Zcash\'s daily activity rhythm on a 24-hour clock and compare when transactions happen with where network nodes operate.' },
  { path: '/pulse', section: 'Network and mining', title: 'Zcash Network Pulse — Statistical Anomaly Feed | ZecBlock', description: 'Auto-detected on-chain anomalies for Zcash: unusual transaction volumes, shielding spikes, cross-chain flows, fee surges, and valuation signals.' },

  { path: '/privacy', section: 'Privacy and shielded pools', title: 'Zcash Privacy Score & Shielded Usage | ZecBlock', description: 'Understand the Zcash Privacy Score: weighted shielded usage, fully shielded transaction share, supply depth, reshielding and historical trends.' },
  { path: '/privacy-risks', section: 'Privacy and shielded pools', title: 'Zcash Privacy Risk Analysis | ZecBlock', description: 'Inspect public Zcash amount and timing patterns, candidate transaction links and withdrawal batches. Heuristic signals do not prove ownership.' },
  { path: '/privacy/wallets', section: 'Privacy and shielded pools', title: 'Zcash Wallet Signals | ZecBlock', description: 'Explore observed Zcash fee patterns and wallet implementation signals. Compare transaction matches with clear coverage and attribution limits.' },
  { path: '/pools', section: 'Privacy and shielded pools', title: 'Zcash Shielded Pool Statistics | ZecBlock', description: 'Compare Zcash shielded pool balances, transaction counts and shares, and public shielding flows across Ironwood, Orchard, Sapling, and Sprout.', tools: ['pool_overview', 'pool_history', 'pool_activity'] },
  { path: '/turnstile', section: 'Privacy and shielded pools', title: 'Zcash Turnstile Tracker | ZecBlock', description: 'Track where deshielded ZEC goes: transparent addresses, reshielding, exchanges, and other transfers. Updated hourly.' },
  { path: '/ironwood', section: 'Privacy and shielded pools', title: 'Zcash Ironwood Upgrade & Migration Tracker | ZecBlock', description: 'Track the Zcash Ironwood (NU6.3) activation, Orchard migration, Ironwood shielded supply, and observable turnstile activity on ZecBlock.', tools: ['pool_overview'] },

  { path: '/charts', section: 'Charts and valuation', title: 'Zcash Charts & On-Chain Analytics | ZecBlock', description: 'Explore and share Zcash charts for shielded supply, transaction activity, mining, fees, valuation and cross-chain swaps, with clear units and data sources.' },
  { path: '/cards', section: 'Charts and valuation', title: 'Live Zcash Data Cards to Share | ZecBlock', description: 'Branded, always-current images of Zcash privacy, supply, valuation, network, mining and cross-chain swap data. Search by topic, then post, download or embed.' },
  { path: '/valuation', section: 'Charts and valuation', title: 'Zcash Valuation & Market Context | ZecBlock', description: 'Track ZEC price in USD and as a percentage of Bitcoin, with ZEC/BTC history, modeled cost basis, transparent spending and shielded supply.' },
  { path: '/zift', section: 'Charts and valuation', title: 'Zift by ZecBlock: Zcash Data, SQL and Dashboards', description: 'Ask questions about Zcash mainnet, write SQL against public chain data, and save charts and dashboards. Every result links to its source data.' },

  { path: '/governance', section: 'Governance', title: 'Zcash Governance: Votes & Results | ZecBlock', description: 'Follow Zcash coinholder votes and retroactive grant rounds, review proposals, learn how to vote with shielded ZEC, and verify past results.' },
  { path: '/governance/nu7', section: 'Governance', title: 'NU7 Coinholder Vote Results & Verification | ZecBlock', description: 'See published Zcash NU7 coinholder vote results, ZEC participation by question, and instructions to independently verify the tally with your own voting-chain node.' },
  { path: '/governance/nu7-1-miner-poll', section: 'Governance', title: 'NU7.1 Miner Sentiment Poll: Live Tally by Pool | ZecBlock', description: 'Live tally of Zcash miner ballots on the five NU7.1 questions, read from the coinbase of every block from 3,591,200 to 3,629,650, with a breakdown by mining pool.' },
  { path: '/governance/retroactive-grants-q4-2026', section: 'Governance', title: 'Q4 2026 Retroactive Grants: Proposals & Vote Schedule | ZecBlock', description: 'Proposals for completed Zcash work in the Q4 2026 coinholder retroactive grants round, with the vote schedule. Browse every request and filter by category.' },
  { path: '/governance/retroactive-grants-q3-2026', section: 'Governance', title: 'Coinholder Retroactive Grants Q3 | ZecBlock', description: 'The Q3 2026 Zcash coinholder retroactive grants vote.' },

  { path: '/tools', section: 'Tools', title: 'Zcash Tools | ZecBlock', description: 'Zcash tools to decode and broadcast transactions, decrypt shielded memos, compare public flow amounts, simulate block times, convert ZEC units and search anchor roots.' },
  { path: '/decrypt', section: 'Tools', title: 'Decrypt Zcash Transaction Memos | ZecBlock', description: 'Decrypt Orchard and Ironwood transaction memos in your browser using a Zcash viewing key. Your key never leaves your device.' },
  { path: '/tools/decode', section: 'Tools', title: 'Decode a Raw Zcash Transaction | ZecBlock', description: 'Free tool to decode raw Zcash transaction hex into human-readable fields. View inputs, outputs, shielded data, and more without broadcasting.' },
  { path: '/tools/broadcast', section: 'Tools', title: 'Broadcast a Zcash Transaction | ZecBlock', description: 'Broadcast a fully signed raw Zcash transaction through ZecBlock\'s Zebra node. No private key is required or submitted.' },
  { path: '/tools/blend-check', section: 'Tools', title: 'Zcash Amount Frequency — Blend Check | ZecBlock', description: 'Compare a ZEC amount with observed public shielding and deshielding flows. Amount frequency is a heuristic, not a privacy guarantee.' },
  { path: '/tools/block-time-simulator', section: 'Tools', title: 'Zcash Block Time Simulator: 20s vs 25s vs 75s | ZecBlock', description: 'Try any Zcash block time from 5 to 150 seconds and any payment size to see waits, long gaps, orphan risk and costs, using a model checked against every speed mainnet has run at.' },
  { path: '/tools/unit-converter', section: 'Tools', title: 'ZEC / Zatoshi Unit Converter | ZecBlock', description: 'Convert between ZEC and zatoshis (1 ZEC = 100,000,000 zatoshis). Free Zcash unit converter for developers and users.' },
  { path: '/tools/anchor-search', section: 'Tools', title: 'Anchor Root Search - Wallet Debugging Tool | ZecBlock', description: 'Search for Sapling and Orchard commitment tree anchor roots across canonical and orphaned blocks. Helps debug wallet sync issues and fork detection.' },

  { path: '/docs', section: 'Developers', title: 'Zcash API Documentation | ZecBlock', description: 'Explore the ZecBlock v1 public API reference: Zcash endpoints, request bodies, pagination, exact amounts, error handling and OpenAPI downloads.' },
  { path: '/docs/mcp', section: 'Developers', title: 'Zcash MCP Server for AI Assistants | ZecBlock', description: 'Connect an AI assistant to ZecBlock’s read-only Zcash MCP server. Query public blocks, transactions, shielded pools and network data with exact amounts and coverage.' },

  { path: '/about', section: 'About', title: 'About the Zcash Explorer | ZecBlock', description: 'Explore the story behind ZecBlock, formerly CipherScan: a Zcash blockchain explorer for public network data, shielded pool analytics and developer tools.' },
  { path: '/learn', section: 'About', title: 'Learn Zcash: Wallets, Privacy & Resources | ZecBlock', description: 'Learn how Zcash privacy works, explore wallets and ways to get ZEC, and find resources for running a node or building on the network.' },
  { path: '/press', section: 'About', title: 'Press Kit & Brand Assets | ZecBlock', description: 'Download ZecBlock logos, brand colors and media copy. Press resources for the Zcash explorer formerly known as CipherScan.' },
  { path: '/privacy-policy', section: 'About', title: 'Privacy Policy | ZecBlock', description: 'Read how ZecBlock handles analytics, logs, local browser data, and public Zcash blockchain information while protecting visitor privacy.' },
  { path: '/terms', section: 'About', title: 'Terms of Service | ZecBlock', description: 'Review the terms for using ZecBlock\'s Zcash explorer, APIs, privacy tools, and blockchain data, including availability and liability limits.' },

  { path: '/newsletter', section: 'Newsletter', title: 'Zcash Weekly Newsletter | ZecBlock', description: 'Weekly Zcash intelligence — protocol updates, network stats, and privacy insights. RSS-first, with no email-open tracking.',
    body: 'RSS feed: https://zecblock.com/newsletter/rss' },
];

// One description per data page type. These pages exist for every block,
// transaction, address and name, so they share a document with example URLs.
const TEMPLATES: PageEntry[] = [
  { path: '/tx/', section: 'Data pages', title: 'Zcash transaction pages | ZecBlock', description: 'One page per Zcash transaction at /tx/{txid}, where txid is the 64-character hexadecimal transaction hash. Shows whether the transaction is pending in the mempool, confirmed in a block or reorganized, and its public inputs and outputs. Shielded components do not reveal amounts or addresses.', tools: ['transaction', 'transactions'],
    body: [
      'Example URL: https://zecblock.com/tx/855fed69195900f16ccc080d0061168f72ce6f8f4cc7b0890c48459b873d9a96',
      '',
      'Pending transactions keep the same URL once confirmed. A shielded memo can be read in the browser with a viewing key at https://zecblock.com/decrypt; the key never leaves the device.',
    ].join('\n') },
  { path: '/block/', section: 'Data pages', title: 'Zcash block pages | ZecBlock', description: 'One page per Zcash block at /block/{height}, also reachable by block hash. Shows whether the block is canonical or orphaned, its hash and the transactions it records.', tools: ['block', 'blocks'],
    body: [
      'Example URL: https://zecblock.com/block/3543405 (the block that activated NU7).',
      '',
      'The height page is the canonical URL for a block on the current chain; a hash lookup for such a block points to its height page. Orphaned blocks keep their own hash pages, labeled as orphaned, with a link to the block that replaced them.',
    ].join('\n') },
  { path: '/address/', section: 'Data pages', title: 'Zcash address pages | ZecBlock', description: 'One page per Zcash address at /address/{address}. Transparent addresses show their public balance and indexed transactions. Shielded balances and activity are private.', tools: ['address'],
    body: 'For a Unified Address (`u1`), transparent receiver activity, if present, can be inspected separately; its shielded history is not public. Sapling (`zs`) addresses show no public balance or history.' },
  { path: '/name/', section: 'Data pages', title: 'Zcash Name pages | ZecBlock', description: 'One page per Zcash Name at /name/{name}: a registered name shows the address it resolves to, its status and registration history; an available name shows claim pricing and registration details.' },
];

const TEMPLATE_PARAMS: Record<string, string> = { '/tx/': '{txid}', '/block/': '{height}', '/address/': '{address}', '/name/': '{name}' };

function stripSiteSuffix(title: string): string {
  return title.replace(/\s*\|\s*ZecBlock$/, '');
}

function liveDataSection(tools: string[] | undefined, endpoints: string[] = []): string {
  const reference = `[API reference](${SITE_URL}/docs.md) · [MCP server](${SITE_URL}/docs/mcp.md)`;
  if (!tools?.length && !endpoints.length) return `Live Zcash data: ${reference}.`;
  const lines = [
    '## Live data',
    '',
    'This Markdown holds no live figures; the HTML page shows current values.',
  ];
  if (endpoints.length) {
    lines.push('', 'REST API:', '', ...endpoints.map(endpoint => `- \`GET ${PUBLIC_API_URL}${endpoint}\``));
  }
  if (tools?.length) {
    lines.push('', `MCP tools (server: ${MCP_URL}): ${tools.map(tool => `\`${tool}\``).join(', ')}.`);
  }
  lines.push('', `Reference: ${reference}.`);
  return lines.join('\n');
}

function pageMarkdown(entry: PageEntry, url: string, extra = ''): string {
  return [
    `# ${stripSiteSuffix(entry.title)}`,
    '',
    `> ${entry.description}`,
    '',
    `Page: ${url}`,
    ...(entry.body ? ['', entry.body] : []),
    ...(extra ? ['', extra] : []),
    '',
    liveDataSection(entry.tools),
    '',
  ].join('\n');
}

function chartDoc(chart: CatalogChart): LlmsDoc {
  const path = `/charts/${chart.id}`;
  const title = `${chartPublicTitle(chart)} | ZecBlock`;
  const markdown = [
    `# ${chartPublicTitle(chart)}`,
    '',
    `> ${chart.description}`,
    '',
    `Page: ${SITE_URL}${path}`,
    '',
    `- Category: ${chart.category}`,
    `- Unit: ${chart.unit}`,
    `- Window: ${chart.window}`,
    `- Series: ${chart.series.map(series => series.label).join(', ')}`,
    `- Source: ${chartSource(chart)}`,
    `- Ranges: ${chartRanges(chart).join(', ')} (add \`?range=\` to the page URL)`,
    `- Related page: ${SITE_URL}${chart.href}`,
    '',
    liveDataSection(undefined, [chart.endpoint]),
    '',
  ].join('\n');
  return { path, markdownPath: markdownPathFor(path), section: 'Charts and valuation', title, description: chart.description, markdown };
}

function docsMarkdown(entry: PageEntry): string {
  const categories = getEndpointsByCategory(PUBLIC_API_URL).map(({ name, endpoints }) => [
    `### ${name}`,
    '',
    ...endpoints.map(endpoint => `- \`${endpoint.method} ${endpoint.path}\`: ${endpoint.description}`),
  ].join('\n'));
  return pageMarkdown(entry, `${SITE_URL}${entry.path}`, [
    `Base URL: ${PUBLIC_API_URL}. Amounts are exact zatoshi decimal strings (1 ZEC = 100,000,000 zatoshis). The full OpenAPI description is at ${SITE_URL}/openapi-v1.json.`,
    '',
    '## Endpoints',
    '',
    categories.join('\n\n'),
  ].join('\n'));
}

function mcpMarkdown(entry: PageEntry): string {
  const tools = getTools('mainnet') as Array<{ name: string; description: string }>;
  return pageMarkdown(entry, `${SITE_URL}${entry.path}`, [
    '## Connect',
    '',
    `Add a remote MCP server using Streamable HTTP and no authentication: ${MCP_URL}`,
    '',
    '```',
    `claude mcp add --transport http zecblock ${MCP_URL}`,
    `codex mcp add zecblock --url ${MCP_URL}`,
    '```',
    '',
    '## Tools',
    '',
    ...tools.map(tool => `- \`${tool.name}\`: ${tool.description}`),
  ].join('\n'));
}

function newsletterDocs(): LlmsDoc[] {
  return getAllNewsletters().map(issue => {
    const path = `/newsletter/${issue.slug}`;
    const markdown = [
      `# ${issue.title}`,
      '',
      ...(issue.summary ? [`> ${issue.summary}`, ''] : []),
      `Published ${issue.date}${issue.issue ? ` · Issue ${issue.issue}` : ''} · Page: ${SITE_URL}${path}`,
      '',
      issue.content.trim(),
      '',
    ].join('\n');
    return { path, markdownPath: markdownPathFor(path), section: 'Newsletter' as const, title: `${issue.title} | ZecBlock`, description: issue.summary, markdown };
  });
}

function chartDocs(): LlmsDoc[] {
  return CHART_CATALOG.map(chartDoc);
}

let cached: LlmsDoc[] | undefined;

/** Every Markdown document, in llms.txt order. */
export function getLlmsDocs(): LlmsDoc[] {
  if (cached) return cached;
  const pageDocs = PAGES.map(entry => ({
    path: entry.path,
    markdownPath: markdownPathFor(entry.path),
    section: entry.section,
    title: entry.title,
    description: entry.description,
    markdown: entry.path === '/docs' ? docsMarkdown(entry)
      : entry.path === '/docs/mcp' ? mcpMarkdown(entry)
      // The homepage's About section, the same text as on the page.
      : entry.path === '/' ? pageMarkdown(entry, `${SITE_URL}/`, homeAboutMarkdown(getHomeAbout('mainnet')!, SITE_URL))
      : pageMarkdown(entry, `${SITE_URL}${entry.path}`),
  }));
  const templateDocs = TEMPLATES.map(entry => ({
    path: entry.path,
    markdownPath: markdownPathFor(entry.path),
    section: entry.section,
    title: entry.title,
    description: entry.description,
    markdown: pageMarkdown(entry, `${SITE_URL}${entry.path}${TEMPLATE_PARAMS[entry.path]}`),
  }));
  const docs = [...pageDocs, ...templateDocs, ...chartDocs(), ...newsletterDocs()];
  cached = SECTION_ORDER.flatMap(section => docs.filter(doc => doc.section === section));
  return cached;
}

export function findLlmsDoc(markdownPath: string): LlmsDoc | undefined {
  return getLlmsDocs().find(doc => doc.markdownPath === markdownPath);
}

/** /llms.txt in the llms.txt format: H1, summary, details, then H2 file lists. */
export function renderLlmsTxt(): string {
  const docs = getLlmsDocs();
  const lines = [
    '# ZecBlock',
    '',
    '> ZecBlock is an open-source Zcash blockchain explorer and analytics site, formerly CipherScan. It shows public Zcash mainnet data: blocks, transactions, addresses, shielded pools, mining, network health, privacy analytics, cross-chain swaps and governance votes.',
    '',
    `zecblock.com is the site. The source code is at https://github.com/Kenbak/zecblock and the project posts on X as https://x.com/zecblock.`,
    '',
    'Every page has a Markdown version at its URL with `.md` appended; the homepage is https://zecblock.com/index.md. Transaction, block, address and name pages share one Markdown description per page type. These files describe what each page shows and contain no live chain figures.',
    '',
    `For current data, use the public REST API (${PUBLIC_API_URL}/v1, reference: ${SITE_URL}/docs.md) or the read-only MCP server (${MCP_URL}, setup: ${SITE_URL}/docs/mcp.md). Amounts are exact zatoshi decimal strings (1 ZEC = 100,000,000 zatoshis). Shielded amounts, addresses and memos are encrypted on chain; unknown or encrypted amounts are not zero.`,
  ];
  for (const section of SECTION_ORDER) {
    const sectionDocs = docs.filter(doc => doc.section === section);
    if (!sectionDocs.length) continue;
    lines.push('', `## ${section}`, '');
    for (const doc of sectionDocs) {
      lines.push(`- [${stripSiteSuffix(doc.title)}](${SITE_URL}${doc.markdownPath})${doc.description ? `: ${doc.description}` : ''}`);
    }
  }
  lines.push(
    '',
    '## Optional',
    '',
    `- [llms-full.txt](${SITE_URL}/llms-full.txt): every Markdown document above in one file.`,
    `- [OpenAPI description](${SITE_URL}/openapi-v1.json): machine-readable API schema (large).`,
    `- [Newsletter RSS](${SITE_URL}/newsletter/rss): weekly issues as a feed.`,
    `- [Sitemap](${SITE_URL}/sitemap.xml): every indexable HTML page.`,
    '',
  );
  return lines.join('\n');
}

/** /llms-full.txt: every document, separated by rules. */
export function renderLlmsFull(): string {
  return `${getLlmsDocs().map(doc => doc.markdown.trim()).join('\n\n---\n\n')}\n`;
}
