const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync('lib/coinbase-message.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', code)(mod, mod.exports);
const { decodeCoinbaseMessage } = mod.exports;
const hex = (text) => Buffer.from(text).toString('hex');

test('coinbase display distinguishes observed empty data from unavailable or malformed data', () => {
  assert.equal(decodeCoinbaseMessage(''), '');
  for (const value of [null, undefined, 'f', 'zz', '00gg']) assert.equal(decodeCoinbaseMessage(value), null);
});

test('coinbase display preserves UTF-8, literal punctuation and complete messages', () => {
  const message = '..🌸 /Zakura:1.0.0/ Mined by café 🦓 <pool> & friends  ';
  assert.equal(decodeCoinbaseMessage(hex(message)), message);
  assert.equal(decodeCoinbaseMessage(hex(message).toUpperCase()), message);
});

test('binary, malformed UTF-8 and invisible directional/control bytes display as dots', () => {
  assert.equal(decodeCoinbaseMessage('04f09f8cb8102f4d696e6564206279204c75786f722f'), '.🌸./Mined by Luxor/');
  assert.equal(decodeCoinbaseMessage('00ff0a7f'), '....');
  assert.equal(decodeCoinbaseMessage(hex('a\u202eb\u200bc\ufeffd')), 'a.b.c.d');
});
