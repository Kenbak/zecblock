'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const file = path.join(__dirname, '../../app/tx/[txid]/components/tx-summary.tsx');
const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const stubs = {
  'next/link': (props) => React.createElement('a', { href: props.href }, props.children),
  '@/lib/config': { CURRENCY: 'ZEC' },
  '@/components/AddressWithLabel': { AddressWithLabel: ({ address }) => address, AddressDisplay: ({ address }) => address },
  './tx-classification': { firstOutputAddress: (outputs) => outputs[0]?.address || null, rankedRecipients: () => [] },
};
const module_ = { exports: {} };
new Function('require', 'module', 'exports', code)((name) => stubs[name] ?? require(name), module_, module_.exports);
const { generateTxSummary } = module_.exports;

const data = { inputs: [{ address: 't1RDCnMNpvVMfngtFkEYq38LxD9c7cQHGch' }], outputs: [{ address: 't1Out' }] };
const bridge = (extra) => ({ direction: 'exit', otherChain: 'eth', otherToken: 'USDC', otherAmount: 1263.030664, otherAmountUsd: 1265.5, zecAmount: 1, zecAddress: null, ...extra });
const summary = (allBridges) => renderToStaticMarkup(React.createElement(React.Fragment, null, generateTxSummary(data, { allBridges, txType: 'transparent', valueBalance: 0 })));

test('bridge summaries name the venue that reported the swap', () => {
  const maya = summary([bridge({ venue: 'maya' })]);
  assert.match(maya, /1 ZEC was bridged out by t1RDCnMNpvVMfngtFkEYq38LxD9c7cQHGch to 1,263\.0307 USDC on ETH via Maya Protocol\./);
  assert.match(summary([bridge({ venue: 'thorchain', direction: 'entry', otherChain: 'btc', otherToken: 'BTC', otherAmount: 0.01306366, otherAmountUsd: 0 })]), /bridged from BTC to .* via THORChain\./);
  assert.match(summary([bridge({})]), /via NEAR Intents\./, 'older responses without a venue keep the NEAR label');
  assert.match(summary([bridge({ venue: 'near' }), bridge({ venue: 'maya' })]), /2 swaps via NEAR Intents and Maya Protocol\./);
  assert.match(summary([bridge({ venue: 'maya' }), bridge({ venue: 'maya' })]), /2 swaps via Maya Protocol\./);
});
