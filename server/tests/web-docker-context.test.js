'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
function sources(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(rel);
    return /\.(tsx?|jsx?|mjs)$/.test(entry.name) ? [rel] : [];
  });
}

test('every server module imported by the web app is re-included in the web Docker context', () => {
  const ignores = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8').split('\n');
  assert.ok(ignores.includes('server'), 'the web image still excludes the backend tree');
  const imports = new Set();
  for (const file of ['app', 'components', 'lib', 'hooks', 'contexts'].filter((d) => fs.existsSync(path.join(root, d))).flatMap(sources)) {
    for (const [, spec] of fs.readFileSync(path.join(root, file), 'utf8').matchAll(/from ['"]@\/(server\/[^'"]+)['"]/g)) imports.add(spec);
  }
  for (const spec of imports) {
    const file = ['', '.js', '.ts', '.tsx'].map((ext) => spec + ext).find((candidate) => fs.existsSync(path.join(root, candidate)));
    assert.ok(file, `${spec} exists`);
    assert.ok(ignores.includes(`!${file}`), `.dockerignore re-includes ${file}`);
  }
});
