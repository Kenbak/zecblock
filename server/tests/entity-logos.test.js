const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'lib/entity-logos.ts'), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', code)(loaded, loaded.exports);
const { getEntityLogoSrc } = loaded.exports;

test('curated address-label aliases resolve to existing local entity assets', () => {
  for (const [label, entity] of [
    ['Gemini Cold Wallet', 'gemini'],
    ['Gemini Custody', 'gemini'],
    ['Binance Hot Wallet', 'binance'],
    ['Kraken Deposit', 'kraken'],
    ['Coinbase Prime Custody', 'coinbase'],
    ['Grayscale Zcash Trust', 'grayscale'],
    ['Hyperunit Hot Wallet', 'hyperunit'],
    ['Kucoin Cold Wallet', 'kucoin'],
    ['NEAR Intent Bridge', 'near-intents'],
  ]) {
    const src = getEntityLogoSrc(label);
    assert.equal(src, `/brands/entities/${entity}.png`);
    assert.ok(fs.existsSync(path.join(root, 'public', src)));
  }
  assert.equal(getEntityLogoSrc('  GEMINI CUSTODY  '), '/brands/entities/gemini.png');
});

test('lookalike or unsourced labels do not acquire another entity’s mark', () => {
  for (const label of ['Gemini Custody unofficial', 'My Binance Wallet', 'Kraken-like', 'Coinbase imposter', 'Grayscale', 'Grayscale Zcash Trust unofficial', 'My Grayscale Zcash Trust', 'Grayscale Bitcoin Trust', 'Kucoin Cold Wallet unofficial', 'My Kucoin Cold Wallet', 'NEAR Intent Bridge unofficial', 'NEAR', 'ZIP-271 Disbursement Multisig', 'constructor', '__proto__', 'toString', '']) {
    assert.equal(getEntityLogoSrc(label), undefined, label);
  }
});

test('API-provided logo paths stay within locally served brand assets', () => {
  assert.equal(getEntityLogoSrc('A newly labelled entity', '/brands/entities/new-entity.svg'), '/brands/entities/new-entity.svg');
  for (const logo of ['https://example.com/logo.png', '//example.com/logo.png', 'data:image/svg+xml,logo', 'javascript:alert(1)', '/brands/../private/logo.png', '/brands/entities/logo.png?remote=https://example.com', '/other/logo.png']) {
    assert.equal(getEntityLogoSrc('A newly labelled entity', logo), undefined, logo);
  }
  assert.equal(getEntityLogoSrc('Gemini Custody', 'https://example.com/logo.png'), '/brands/entities/gemini.png');
});
