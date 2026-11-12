const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');

function load(file, requireImport = require) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: requireImport });
  return exports;
}
const { getWalletImplementationLogos, getWalletReadinessLogos } = load('lib/wallet-logos.ts');
const ids = name => Array.from(getWalletImplementationLogos(name), logo => logo.id);

test('named ZODL/Vizor implementations retain both identities while shared SDK groups stay neutral', () => {
  assert.deepEqual(ids('ZODL / Vizor (Ironwood sends)'), ['zodl', 'vizor']);
  assert.deepEqual(ids('ZODL / Vizor (ZIP-318 migration)'), ['zodl', 'vizor']);
  for (const name of ['SDK wallets (cross-pool)', 'SDK wallets (Orchard pool)', 'SDK wallets (shielding/deshielding)', 'SDK wallets (ZODL)', 'Brave-compatible SDK family', 'Nozy / Zkool']) {
    assert.deepEqual(ids(name), [], `${name} cannot be assigned one member's logo`);
  }
});

test('only explicit qualified implementation names select marks; prototype keys and lookalikes remain neutral', () => {
  for (const [name, expected] of [
    ['Cake Wallet (probable)', 'cake'], ['Brave', 'brave'], ['Nozy', 'nozy'],
    ['Zkool (historical)', 'zkool'], ['YWallet (deprecated)', 'ywallet'],
  ]) {
    assert.deepEqual(ids(` ${name.toUpperCase()} `), [expected]);
    const [logo] = getWalletImplementationLogos(name);
    assert.ok(fs.existsSync(`public${logo.src}`));
  }
  for (const name of ['constructor', '__proto__', 'toString', 'Cake Wallet compatible', 'Zkool clone', 'Unknown']) {
    assert.deepEqual(ids(name), []);
  }
});

test('reviewed directory identities do not broaden inferred wallet matches or assign SDK brands', () => {
  for (const [name, expected] of [
    ['Vizor', 'vizor'], ['ZODL', 'zodl'], ['Cake Wallet', 'cake'],
    ['Zkool', 'zkool'], ['Edge', 'edge'], ['Brave Wallet', 'brave'],
  ]) {
    const logos = getWalletReadinessLogos(` ${name.toUpperCase()} `);
    assert.deepEqual(Array.from(logos, logo => logo.id), [expected]);
    assert.ok(fs.existsSync(`public${logos[0].src}`));
    assert.deepEqual(ids(name), [], `${name} is not an explicit implementation signal`);
  }
  for (const name of ['Zcash iOS SDK', 'Zcash Android SDK', 'zcash_pool_migration', 'ZODL / Vizor', 'Edge compatible', 'constructor', '__proto__']) {
    assert.deepEqual(Array.from(getWalletReadinessLogos(name)), []);
  }
});

test('implementation branding does not brand pattern-match rankings or erase confidence and lifecycle qualifiers', () => {
  const signal = { value: 'SDK value', confidence: 'medium', source: 'Public implementation source', matchCount: 1 };
  const wallets = ['SDK wallets (Orchard pool)', 'Cake Wallet (probable)', 'Zkool (historical)', 'YWallet (deprecated)'].map(name => ({
    name, familyMembers: name.startsWith('SDK') ? ['ZODL', 'Vizor', 'Edge'] : undefined,
    signals: { fee: signal, expiry: signal, locktime: signal, actionPadding: signal },
  }));
  const box = ({ children }) => React.createElement('div', {}, children);
  const { default: WalletsClient } = load('app/privacy/wallets/WalletsClient.tsx', name => {
    if (name === 'react/jsx-runtime' || name === 'react') return require(name);
    if (name === 'next/link') return { default: box };
    if (name === '@/lib/utils') return { formatDateLabelUTC: String };
    if (name === '@/lib/use-url-state') return { useUrlState: (_, initial) => [initial, () => {}] };
    if (name === '@/lib/chart-theme') return { CHART_DATE_AXIS: {}, getChartColors: () => ({}) };
    if (name === '@/components/ChartWatermark') return { ChartWatermark: () => null };
    if (name === '@/components/ui/PageLoading') return { PageLoadingBody: () => null };
    if (name === '@/hooks/useApiQuery') return { useApiQuery: endpoint => ({
      loading: false, isRefreshing: false, error: null,
      data: endpoint.endsWith('wallet-fingerprints') ? { period: '30d', wallets, totalShielded: 10, totalFullyShieldedOrchard: 10 } : null,
    }) };
    if (name === 'recharts') return {};
    if (name === '@/components/charts/ChartTooltip') return { ChartTooltip: box };
    if (name === '@/contexts/ThemeContext') return { useTheme: () => ({ theme: 'dark' }) };
    if (name === '@/components/ui/Card') return { Card: box, CardBody: box };
    if (name === '@/components/ui/SectionHeader') return { PageHeader: box };
    if (name === '@/components/ui/PeriodPillTags') return { PeriodPillTags: () => null };
    if (name === '@/components/PageSectionNav') return { PageSectionNav: () => null };
    if (name === '@/components/WalletImplementationLogo') return { WalletImplementationLogo: ({ name }) => React.createElement('span', { 'data-implementation-mark': name }) };
    throw new Error(`Unexpected import ${name}`);
  });
  const html = renderToStaticMarkup(React.createElement(WalletsClient));
  const usage = html.match(/<section id="usage"[\s\S]*?<\/section>/)[0];
  const implementations = html.match(/<section id="fingerprints"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(usage, /data-implementation-mark/);
  assert.match(usage, /Cake Wallet \(probable\)/);
  for (const wallet of wallets) assert.ok(implementations.includes(wallet.name));
  assert.match(implementations, /ZODL · Vizor · Edge/);
  assert.match(implementations, /Inferred/);
  assert.equal((implementations.match(/data-implementation-mark=/g) || []).length, wallets.length);
});
