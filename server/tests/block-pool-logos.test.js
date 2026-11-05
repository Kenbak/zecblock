const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');

function load(file) {
  const exports = {};
  const box = ({ children, label }) => React.createElement('div', { 'data-fact': label }, children);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require(name) {
    if (name === 'react/jsx-runtime') return require(name);
    if (name === '@/components/PoolLogo') return { PoolLogo: ({ name }) => React.createElement('span', { 'data-pool-logo': name, 'aria-hidden': true }) };
    if (name === '@/components/ui/Card') return { Card: box, CardBody: box };
    if (name === '@/components/ui/FactBox') return {
      FactBox: box,
      BoldZec: ({ value }) => React.createElement('span', {}, String(value)),
      CopyableHash: ({ value }) => React.createElement('span', {}, value),
    };
    if (name === '@/lib/utils') return { formatRelativeTime: () => '2m ago', formatDateUTC: () => 'UTC' };
    if (name === '@/lib/config') return { CURRENCY: 'ZEC' };
    if (name === '@/components/CoinbaseMessage') return { CoinbaseMessage: () => null };
    if (name === '@/components/CopyButton') return { CopyButton: () => null };
    if (name === '@/components/BlockFirstSeen') return { BlockFirstSeen: () => null, BLOCK_FIRST_SEEN_EXPLANATION: 'Local observation' };
    if (name === '@/components/ui/Badge') return { Badge: box };
    if (name === '@/components/ui/HashLink') return { HashLink: ({ value }) => React.createElement('span', {}, value) };
    if (name === 'next/link') return { default: box };
    throw new Error(`Unexpected import ${name}`);
  } });
  return exports;
}

const { BlockFactsCard } = load('app/block/[height]/components/BlockFactsCard.tsx');
const { OrphanedBlockBanner } = load('app/block/[height]/components/OrphanedBlockBanner.tsx');
const miner = 't1MinerReward';
const fund = 't3FundingStream';
const base = {
  height: 100, hash: 'blockhash', timestamp: 1000, transactionCount: 1, size: 1000,
  difficulty: 1, confirmations: 2, minerAddress: miner, minerPool: 'Luxor',
  minerPoolUrl: 'https://luxor.tech', minerPoolRegion: 'US',
  transactions: [{ vout: [
    { value: 1.25, scriptPubKey: { addresses: [miner] } },
    { value: 0.125, scriptPubKey: { addresses: [fund] } },
  ] }],
};
const facts = (data) => renderToStaticMarkup(React.createElement(BlockFactsCard, {
  data, showMoreDetails: false, coinbaseClientEmoji: null, coinbaseClientInfo: {},
  onToggleMoreDetails() {}, onScrollToTransactions() {},
}));
const logoCount = html => (html.match(/data-pool-logo=/g) || []).length;

test('block reward logos follow the identified miner, not every coinbase recipient', () => {
  const html = facts(base);
  assert.equal(logoCount(html), 1);
  assert.match(html, /data-pool-logo="Luxor"/);
  assert.match(html, /href="https:\/\/luxor.tech"/);
  assert.match(html, /Funding stream/);
  assert.match(html, /1\.2500 ZEC/);
  assert.match(html, /0\.1250 ZEC/);

  // A known funding-stream payout is still not a miner when its output is
  // the only visible transparent recipient of a shielded miner reward.
  const funded = facts({ ...base, minerAddress: fund, minerPool: 'Luxor', minerPoolIsFundingStream: true,
    transactions: [{ vout: [{ value: 0.125, scriptPubKey: { addresses: [fund] } }], value_balance_sapling: '-125000000' }],
  });
  assert.equal(logoCount(funded), 0, 'funding-stream authority overrides a pool-shaped name');
  assert.match(funded, /Funding stream/);
  assert.match(funded, /Shielded coinbase output/);
  assert.doesNotMatch(funded, />Miner</);
});

test('tag-only attribution retains its qualifier and unknown payouts do not acquire a pool identity', () => {
  const tagged = facts({ ...base, minerAddress: undefined,
    transactions: [{ vout: [{ value: 0.125, scriptPubKey: { addresses: [fund] } }], value_balance_sapling: '-125000000' }],
  });
  assert.equal(logoCount(tagged), 1);
  assert.match(tagged, /\(coinbase tag\)/);
  assert.match(tagged, /payout recipient remains shielded/);
  assert.match(tagged, /Funding stream/);

  const unknown = facts({ ...base, minerPool: null, minerAddress: 'ViaBTC' });
  assert.equal(logoCount(unknown), 0, 'an arbitrary address/name cannot select a logo');
});

test('orphan comparisons keep pool identity separate from funding streams and unknown miners', () => {
  const data = { ...base, isOrphaned: true, canonicalBlock: {
    height: 100, hash: 'canonicalhash', timestamp: 1000, transactionCount: 1,
    minerPool: 'ViaBTC', minerPoolIsFundingStream: true,
  } };
  const html = renderToStaticMarkup(React.createElement(OrphanedBlockBanner, { data }));
  assert.equal(logoCount(html), 1);
  assert.match(html, /data-pool-logo="Luxor"/);
  assert.doesNotMatch(html, /data-pool-logo="ViaBTC"/);
  const unknown = renderToStaticMarkup(React.createElement(OrphanedBlockBanner, { data: {
    ...data, minerPool: null, canonicalBlock: { ...data.canonicalBlock, minerPool: null },
  } }));
  assert.equal(logoCount(unknown), 0);
  assert.equal((unknown.match(/Unknown miner/g) || []).length, 2);
});
