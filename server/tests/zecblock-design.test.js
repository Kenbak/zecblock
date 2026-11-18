const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '../..');

function load(file, imports = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((name) => name in imports ? imports[name] : require(name), module, module.exports);
  return module.exports;
}

const privacyPalette = load('lib/privacy-palette.ts');
const { getChartColors } = load('lib/chart-theme.ts', { './privacy-palette': privacyPalette });
const { SupplyVerification } = load('app/ironwood/components/SupplyVerification.tsx', {
  '@/components/ShareableCard': { ShareableCard: ({ children }) => React.createElement('section', null, children) },
  '@/hooks/useCurrencyToggle': { fmtValue: (v) => String(v) },
  './PoolBalanceRow': { PoolBalanceRow: () => null },
});

function renderVerification(pct) {
  return renderToStaticMarkup(React.createElement(SupplyVerification, {
    overview: { supplyAudit: {}, poolSizes: { chainSupplyZat: 1000, transparentZat: 600, sproutZat: 0, saplingZat: 0, orchardZat: 27, ironwoodZat: 373, sourceHeight: 1, isLive: false }, supplyVerification: pct === null ? null : { chainSupplyZat: 1000, verifiedPct: pct } },
    colors: getChartColors('dark'),
  }));
}

test('supply verification preserves a 2.7% pending fraction instead of inflating it to 5%', () => {
  const html = renderVerification(97.3);
  const widths = [...html.matchAll(/width:([\d.]+)%/g)].map(m => Number(m[1]));
  assert.equal(widths.length, 2);
  assert.equal(widths[0], 97.3);
  assert.ok(Math.abs(widths[1] - 2.7) < 1e-9);
  assert.ok(html.includes('Pending'));
});

test('zero and complete verification retain exact endpoints', () => {
  for (const pct of [0, 100]) {
    const html = renderVerification(pct);
    assert.ok(html.includes(`width:${pct}%`));
    assert.ok(html.includes(`width:${100-pct}%`));
  }
});

test('unavailable or invalid verification draws no fabricated proportion', () => {
  for (const pct of [null, -1, 101, NaN]) {
    const html = renderVerification(pct);
    assert.ok(html.includes('Supply verification unavailable'));
    assert.ok(!html.includes('role="img"'));
  }
});

test('metadata uses the new mainnet identity and preserves network indexation boundaries', () => {
  for (const network of ['mainnet', 'testnet', 'crosslink-testnet']) {
    const seo = load('lib/seo.ts', {
      '@/lib/network': { getConfiguredNetwork: () => network },
      '@/lib/api-config': { getApiUrlForNetwork: () => '' },
      '@/lib/server-fetch': {},
      '@/lib/api-client': load('lib/api-client.ts'),
    });
    const meta = seo.buildPageMetadata({ title: 'Zcash Shielded Pools | ZecBlock', description: 'Pool balances', path: '/pools' });
    assert.equal(meta.robots.index, network === 'mainnet');
    assert.equal(meta.robots.follow, true);
    assert.equal(meta.openGraph.siteName, 'ZecBlock');
    assert.equal(meta.openGraph.images[0].width, 1200);
    const shareImage = new URL(meta.openGraph.images[0].url);
    assert.equal(shareImage.pathname, '/opengraph-image');
    // Versioned so X/Discord refetch the card after the image changes.
    assert.ok(shareImage.searchParams.get('v'));
    assert.equal(meta.twitter.images[0], meta.openGraph.images[0].url);
    assert.equal(meta.alternates.canonical, network === 'mainnet' ? 'https://zecblock.com/pools' : network === 'testnet' ? 'https://testnet.zecblock.com/pools' : 'https://crosslink.zecblock.com/pools');
    const home = seo.buildPageMetadata({ title: 'Explorer | ZecBlock', description: 'Search', path: '/', indexOnTestnet: true });
    assert.equal(home.robots.index, network !== 'crosslink-testnet');
  }
});

test('homepage titles lead with each network\'s search phrase and name the brand once', () => {
  const expected = {
    mainnet: /^Zcash Explorer\b/,
    testnet: /^Zcash Testnet Explorer\b/,
    'crosslink-testnet': /^Zcash Crosslink Explorer\b/,
  };
  for (const [network, phrase] of Object.entries(expected)) {
    const seo = load('lib/seo.ts', {
      '@/lib/network': { getConfiguredNetwork: () => network },
      '@/lib/api-config': { getApiUrlForNetwork: () => '' },
      '@/lib/server-fetch': {},
      '@/lib/api-client': load('lib/api-client.ts'),
    });
    const { title, description } = seo.getSiteCopy();
    assert.match(title, phrase);
    assert.match(title, / \| ZecBlock$/);
    assert.equal(title.match(/ZecBlock/g).length, 1);
    assert.ok(description.length >= 50 && description.length <= 160, `${network} description length ${description.length}`);
  }
});

test('the hidden homepage feed placeholder adds no heading or placeholder text to the outline', () => {
  const feedCard = fs.readFileSync(path.join(root, 'components/HomeFeedCard.tsx'), 'utf8');
  assert.doesNotMatch(feedCard, /LOADING_ACTIVITY/);
  assert.match(feedCard, /labelAsHeading=\{false\}/);
  const { SectionHeader } = load('components/ui/SectionHeader.tsx', { 'next/link': () => null });
  const heading = renderToStaticMarkup(React.createElement(SectionHeader, { label: 'RECENT_BLOCKS' }));
  const sizer = renderToStaticMarkup(React.createElement(SectionHeader, { label: 'RECENT_BLOCKS', labelAsHeading: false }));
  assert.match(heading, /<h2[^>]*>RECENT_BLOCKS<\/h2>/);
  assert.doesNotMatch(sizer, /<h2/);
  assert.match(sizer, /<div class="section-header-label [^"]*">RECENT_BLOCKS<\/div>/);
});

const { summarizeMempool } = load('lib/mempool-summary.ts');

test('mempool composition separates fully shielded count from inclusive pool share', () => {
  const rows = [{ type: 'shielded' }, { type: 'mixed' }, { type: 'mixed' }, { type: 'transparent' }];
  assert.deepEqual(summarizeMempool(rows), { shielded: 1, mixed: 2, transparent: 1, shown: 4, shieldedShare: 75 });
  // Recomputed from the current list after a stream removal, rather than stale poll stats.
  assert.equal(summarizeMempool(rows.slice(1)).shieldedShare, 67);
  assert.equal(summarizeMempool([]).shieldedShare, null);
  assert.equal(summarizeMempool([{ type: 'transparent' }]).shieldedShare, 0);
});

test('network cadence preserves timestamp reversals and missing predecessors', () => {
  const { blockIntervals } = load('lib/network-overview.ts');
  const blocks = [{ height: 13, timestamp: 260 }, { height: 10, timestamp: 200 }, { height: 11, timestamp: 190 }];
  const original = JSON.stringify(blocks);
  assert.deepEqual(blockIntervals(blocks), [
    { height: 11, timestamp: 190, seconds: -10 },
    { height: 13, timestamp: 260, seconds: null },
  ]);
  assert.equal(JSON.stringify(blocks), original);
  assert.deepEqual(blockIntervals([]), []);
});

test('fee band uses both actual percentiles and rejects invalid observations', () => {
  const { feeBand } = load('lib/network-overview.ts');
  assert.deepEqual(feeBand({ p10: 1000, median: 5000, p90: 12000 }), { range: [0.01, 0.12], median: 0.05 });
  for (const row of [{p10:-1,median:1,p90:2}, {p10:3,median:2,p90:4}, {p10:1,median:5,p90:4}, {p10:NaN,median:2,p90:3}]) assert.equal(feeBand(row), null);
});

test('unknown node readiness is never displayed as healthy or synced', () => {
  const { observationStatus, blockAgeLabel } = load('lib/network-overview.ts');
  assert.equal(observationStatus(null), 'Unavailable');
  assert.equal(observationStatus({ healthy: true }), 'Unavailable');
  assert.equal(observationStatus({ healthy: true, ready: false }), 'Not ready');
  assert.equal(observationStatus({ healthy: true, ready: true }), 'Ready');
  assert.equal(observationStatus({ healthy: false, ready: true }), 'Degraded');
  assert.equal(blockAgeLabel(0, 1000), 'unavailable');
  assert.equal(blockAgeLabel(2, 1000), 'ahead of local clock');
});


test('privacy identities agree across chart, flow, CSS and pool registries', () => {
  const { getFlowColors } = load('lib/flow-colors.ts', { './privacy-palette': privacyPalette });
  const { SHIELDED_POOLS } = load('lib/shielded-pools.ts');
  const { Badge, StatusBadge } = load('components/ui/Badge.tsx');
  assert.ok(renderToStaticMarkup(React.createElement(StatusBadge, { status: 'shielded' })).includes('badge-shielded'));
  for (const [key, color] of [['ironwood', 'ironwood'], ['orchard', 'purple'], ['sapling', 'green'], ['sprout', 'muted']]) {
    const pool = SHIELDED_POOLS.find(p => p.key === key);
    assert.equal(pool.badgeColor, color);
    assert.ok(renderToStaticMarkup(React.createElement(Badge, { color: pool.badgeColor }, pool.label)).includes(`badge-${color}`));
  }
  const css = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
  for (const theme of ['dark', 'light']) {
    const p = privacyPalette.getPrivacyColors(theme);
    const c = getChartColors(theme);
    assert.equal(c.shielded, p.shielded);
    assert.equal(getFlowColors(theme).shielded, p.shielded);
    assert.equal(c.ironwoodPool, p.ironwood);
    assert.notEqual(c.shielded, c.ironwoodPool);
    assert.notEqual(c.shielded, c.orchardPool);
    const selector = theme === 'dark' ? ':root {' : '/* Light Theme Overrides */\n.light {';
    const start = css.indexOf(selector) + selector.length;
    const block = css.slice(start, css.indexOf('}', start));
    for (const role of ['shielded', 'ironwood']) {
      const rgb = p[role].slice(1).match(/../g).map(v => parseInt(v, 16)).join(' ');
      assert.ok(block.includes(`--color-${role}-rgb: ${rgb};`));
      assert.ok(block.includes(`--color-${role}-ink: ${p[`${role}Ink`]};`));
    }
  }
});

test('legacy Crosslink hostname redirects to the same path on ZecBlock without capturing other networks', async () => {
  const config = load('next.config.ts').default;
  const redirects = await config.redirects();
  const rule = redirects.find((r) => r.destination === 'https://crosslink.zecblock.com/:path*');
  assert.ok(rule);
  assert.equal(rule.source, '/:path*');
  assert.equal(rule.permanent, true);
  assert.equal(rule.has.length, 1);
  assert.equal(rule.has[0].type, 'host');
  const host = new RegExp(`^(?:${rule.has[0].value})$`);
  assert.ok(host.test('crosslink.cipherscan.app'));
  for (const other of ['cipherscan.app', 'testnet.cipherscan.app', 'zecblock.com', 'crosslink.zecblock.com']) {
    assert.equal(host.test(other), false);
  }
});
