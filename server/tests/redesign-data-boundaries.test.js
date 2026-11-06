const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(file) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', code)(module, module.exports, id => load(id.startsWith('@/') ? `${id.slice(2)}.ts` : path.resolve(path.dirname(file), `${id}.ts`)));
  return module.exports;
}
const { parseSafeZatoshi, sumZatoshis } = load('lib/format-numbers.ts');
const { normalizeMigrationData, completedDayActivity } = load('app/ironwood/components/api-data.ts');
const { nonCoinbaseActivity } = load('lib/transaction-list.ts');
const { transformTransactions } = load('app/address/[address]/components/helpers.ts');
test('v1 strings normalize before arithmetic without mutating source payloads', () => {
  const wire = { buckets: [{ volumeZat: '34000000' }, { volumeZat: '1000000000' }], poolSizes: { orchardZat: '0', transparentZat: null } };
  const decoded = normalizeMigrationData(wire);
  assert.equal(decoded.buckets.reduce((sum, b) => sum + b.volumeZat, 0), 1034000000);
  assert.equal(wire.buckets[0].volumeZat, '34000000');
  assert.equal(decoded.poolSizes.orchardZat, 0);
  assert.equal(decoded.poolSizes.transparentZat, null);
  for (const invalid of ['', '1.1', '1e8', true, NaN, '9007199254740992']) assert.throws(() => parseSafeZatoshi(invalid));
  assert.equal(sumZatoshis(['1', 2, '-3']), 0);
  assert.throws(() => sumZatoshis([Number.MAX_SAFE_INTEGER, 1]));
});
test('sparse hourly buckets use a bounded completed-day window, not last 24 nonempty rows', () => {
  const end = 1790467200;
  const activity = { granularity: 'hour', bucketSeconds: 3600, buckets: [
    { bucketStart: end - 90000, txCount: 50, volumeZat: 1000000 },
    { bucketStart: end - 86400, txCount: 2, volumeZat: 100 },
    { bucketStart: end - 3600, txCount: 3, volumeZat: 200 },
    { bucketStart: end, txCount: 7, volumeZat: 500 },
  ] };
  assert.deepEqual(completedDayActivity(activity, end + 60), { txCount24h: 5, volumeZat24h: 300 });
  assert.equal(completedDayActivity(null, end), null);
});
test('address rows decode decimal timestamp strings, retain missing timestamps and string zero inputs', () => {
  const row = { txid: 'example', blockTime: '1790467200', netChange: '125000000', txIndex: 0, inputValue: '0', outputValue: '125000000', senderCount: 0 };
  const decoded = transformTransactions({ address: 'example' }, [row])[0];
  assert.equal(decoded.timestamp, 1790467200);assert.equal(decoded.isCoinbase, true);
  assert.equal(transformTransactions({ address: 'example' }, [{ ...row, blockTime: null }])[0].timestamp, null);
});
test('transaction headlines consistently exclude coinbase and preserve genuine zeros', () => {
  assert.deepEqual(nonCoinbaseActivity({ tx24h: 8433, tx24hExclCoinbase: '7287' }, { blocks24h: 1146 }), { txs24h: 7287, txsPerBlock: 7287 / 1146 });
  assert.deepEqual(nonCoinbaseActivity({ tx24hExclCoinbase: 0 }, { blocks24h: 10 }), { txs24h: 0, txsPerBlock: 0 });
  assert.deepEqual(nonCoinbaseActivity({ tx24h: 10 }, { blocks24h: 10 }), { txs24h: null, txsPerBlock: null });
});

test('captured v1 migration fixture totals match exact wire integers', () => {
  const wire = require('./fixtures/redesign-migration-activity.json');
  const decoded = normalizeMigrationData(wire);
  const expected = wire.buckets.reduce((sum, bucket) => sum + BigInt(bucket.volumeZat), 0n);
  assert.equal(BigInt(decoded.buckets.reduce((sum, bucket) => sum + bucket.volumeZat, 0)), expected);
});
test('short date formatting is UTC across host timezones and invalid dates stay unavailable', () => {
  const { formatDateLabelUTC } = load('lib/utils.ts');
  assert.equal(formatDateLabelUTC('2026-09-27T23:59:00-07:00'), 'Sep 28');
  assert.equal(formatDateLabelUTC('invalid'), '—');
});
test('chart exports reveal branding during capture and restore it on success or failure', async () => {
  const { withChartAttribution } = load('lib/chart-export.ts');
  const makeNode = (isLogo, initial = '') => {
    let value = initial, priority = '';
    return { classList: { contains: () => isLogo }, style: {
      getPropertyValue: () => value, getPropertyPriority: () => priority,
      setProperty: (_, next, p) => { value = next; priority = p; },
      removeProperty: () => { value = ''; priority = ''; },
    } };
  };
  const logo = makeNode(true), watermark = makeNode(false, 'none');
  const root = { querySelectorAll: () => [logo, watermark] };
  assert.equal(await withChartAttribution(root, async () => {
    assert.equal(logo.style.getPropertyValue(), 'flex');
    assert.equal(watermark.style.getPropertyValue(), 'block');
    return 'png';
  }), 'png');
  assert.equal(logo.style.getPropertyValue(), '');
  assert.equal(watermark.style.getPropertyValue(), 'none');
  await assert.rejects(withChartAttribution(root, async () => { throw Error('capture failed'); }));
  assert.equal(logo.style.getPropertyValue(), '');
  assert.equal(watermark.style.getPropertyValue(), 'none');
});

test('shielded list API parameters omit the page-only type selector', () => {
  const { shieldedListParams } = load('lib/transaction-list.ts');
  assert.deepEqual(shieldedListParams('all', 'all', 0), { flow_type: 'all', pool: 'all' });
  assert.deepEqual(shieldedListParams('shield', 'ironwood', 1), { flow_type: 'shield', pool: 'ironwood', min_zec: '1' });
});
test('chart exports get an opaque background: translucent cards are composited over the page', () => {
  const { opaqueBackground } = load('lib/chart-export.ts');
  const node = (backgroundColor, parentElement = null) => ({ backgroundColor, parentElement });
  const previous = globalThis.getComputedStyle;
  globalThis.getComputedStyle = element => ({ backgroundColor: element.backgroundColor });
  try {
    const page = node('rgb(11, 12, 14)');
    const glass = node('rgba(255, 255, 255, 0.1)', node('rgba(0, 0, 0, 0)', page));
    assert.equal(opaqueBackground(glass), 'rgb(35, 36, 38)', '10% white over the page colour');
    assert.equal(opaqueBackground(node('rgb(250, 250, 250)', page)), 'rgb(250, 250, 250)', 'an opaque card is kept');
    assert.equal(opaqueBackground(node('transparent', node('rgb(255 255 255 / 50%)'))), 'rgb(133, 134, 135)', 'nothing opaque falls back to the dark page');
  } finally { globalThis.getComputedStyle = previous; }
});
