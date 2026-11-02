'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const dir = path.join(__dirname, '../../app/tx/[txid]/components');
function load(file, stubs = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(dir, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const module_ = { exports: {} };
  new Function('require', 'module', 'exports', code)((name) => stubs[name] ?? require(name), module_, module_.exports);
  return module_.exports;
}

const classification = load('tx-classification.ts');
const { classifyTransaction } = classification;
const { generateTxSummary } = load('tx-summary.tsx', {
  'next/link': (props) => React.createElement('a', { href: props.href }, props.children),
  '@/lib/config': { CURRENCY: 'ZEC' },
  '@/components/AddressWithLabel': { AddressWithLabel: ({ address }) => address, AddressDisplay: ({ address }) => address },
  './tx-classification': classification,
});

const base = { inputs: [], outputs: [], saplingSpendCount: 0, saplingOutputCount: 0, orchardActions: 0, ironwoodActions: 0, hasShieldedData: true };
const summary = (data) => renderToStaticMarkup(React.createElement(React.Fragment, null, generateTxSummary(data, classifyTransaction(data))));

// Mainnet c0174bcd…7e1a (block 3,537,885): one JoinSplit releasing
// 9,093.61122623 ZEC from Sprout into two Sapling outputs.
const sproutToSapling = { ...base, hasSprout: true, saplingOutputCount: 2, valueBalanceSapling: -9093.61102623, valueBalanceSprout: 9093.61122623 };

test('a Sprout JoinSplit feeding Sapling outputs is a Sprout → Sapling migration, not Sapling → Sapling', () => {
  const c = classifyTransaction(sproutToSapling);
  assert.equal(c.txType, 'MIGRATION');
  assert.equal(c.migrationSourcePool, 'Sprout');
  assert.equal(c.migrationDestPool, 'Sapling');
  assert.match(summary(sproutToSapling), /^Sprout → Sapling pool migration\. 9093\.6110 ZEC left the legacy Sprout pool/);
});

test('the same shape without a JoinSplit stays a Sapling transaction', () => {
  const c = classifyTransaction({ ...sproutToSapling, hasSprout: false });
  assert.equal(c.migrationSourcePool, null);
  assert.equal(c.txType, 'SHIELDED');
});

test('Sprout-only and Sprout-with-transparent transactions are not called migrations', () => {
  assert.equal(classifyTransaction({ ...base, hasSprout: true }).txType, 'SPROUT');
  const unshield = classifyTransaction({ ...base, hasSprout: true, outputs: [{ value: 1, scriptPubKey: { addresses: ['t1Out'] } }] });
  assert.equal(unshield.isMigration, false);
  assert.notEqual(unshield.txType, 'SPROUT');
});

test('Ironwood migrations keep their Orchard/Sapling source and Ironwood destination', () => {
  const c = classifyTransaction({ ...base, ironwoodActions: 2, valueBalanceIronwood: -5, valueBalanceSapling: 5.0001, saplingSpendCount: 1 });
  assert.equal(c.migrationSourcePool, 'Sapling');
  assert.equal(c.migrationDestPool, 'Ironwood');
});

test('the migration is still recognised when valueBalanceSprout is not available', () => {
  const { valueBalanceSprout, ...legacy } = sproutToSapling;
  assert.equal(classifyTransaction(legacy).migrationSourcePool, 'Sprout');
});

test('Sprout value leaving to a transparent address is unshielding', () => {
  const c = classifyTransaction({ ...base, hasSprout: true, valueBalanceSprout: 2.0001, outputs: [{ value: 2, scriptPubKey: { addresses: ['t1Out'] } }] });
  assert.equal(c.txType, 'UNSHIELDING');
});
