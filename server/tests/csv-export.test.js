const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const csv = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../../lib/csv.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: csv, BigInt });

test('CSV cells neutralize spreadsheet formulas but keep numbers', () => {
  assert.equal(csv.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csv.csvCell('+cmd'), '"\'+cmd"');
  assert.equal(csv.csvCell('@SUM(A1)'), '"\'@SUM(A1)"');
  assert.equal(csv.csvCell('-0.81090248'), '"-0.81090248"');
  assert.equal(csv.csvCell('1e-8'), '"1e-8"');
  assert.equal(csv.csvCell(null), '""');
  assert.equal(csv.toCsv(['a', 'b'], [['1', 'x,y']]), '"a","b"\r\n"1","x,y"\r\n');
});

test('zatoshi strings convert to exact decimal ZEC', () => {
  assert.equal(csv.zatToZecString('43892090013445'), '438920.90013445');
  assert.equal(csv.zatToZecString('100000000'), '1');
  assert.equal(csv.zatToZecString('1'), '0.00000001');
  assert.equal(csv.zatToZecString('-81090248'), '-0.81090248');
  assert.equal(csv.zatToZecString('2100000000000000'), '21000000');
});
