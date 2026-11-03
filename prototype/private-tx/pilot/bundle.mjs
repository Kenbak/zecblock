import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const nativePath = process.argv[2];
const receiptPath = process.argv[3];
if (!nativePath || !receiptPath) throw new Error('Usage: node pilot/bundle.mjs <Linux x86_64 native binary> <build receipt.json>');
execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'prototype/private-tx', 'prototype/pir-browser'], { cwd: ROOT });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const binary = await readFile(resolve(nativePath));
const nativeBuild = JSON.parse(await readFile(resolve(receiptPath), 'utf8'));
if (!/^[a-f0-9]{40}$/.test(nativeBuild.commit) || nativeBuild.artifact.sha256 !== createHash('sha256').update(binary).digest('hex')) throw new Error('Native build receipt mismatch.');
// The browser binding and test-only dev dependencies may change independently
// of the native executable. Check its actual source/configuration closure;
// never accept a binary after native/profile/normal dependency changes.
execFileSync('git', ['diff', '--quiet', nativeBuild.commit, commit, '--',
  'prototype/pir-browser/native', 'prototype/pir-browser/src/full_record.rs',
  'prototype/pir-browser/src/global.rs',
  'prototype/pir-browser/src/global_codec.rs',
  'prototype/pir-browser/bootstrap.py', 'prototype/pir-browser/build.sh',
  'server/tests/fixtures/browser-transactions.json'], { cwd: ROOT });
const gitFile = (revision, path) => execFileSync('git', ['show', `${revision}:prototype/pir-browser/${path}`], { cwd: ROOT, encoding: 'utf8' });
const configurations = { oldCargo: gitFile(nativeBuild.commit, 'Cargo.toml'), newCargo: gitFile(commit, 'Cargo.toml'), oldLock: gitFile(nativeBuild.commit, 'Cargo.lock'), newLock: gitFile(commit, 'Cargo.lock') };
execFileSync('python3', ['-c', `import json,sys,tomllib
d=json.load(sys.stdin)
a=tomllib.loads(d['oldCargo']); b=tomllib.loads(d['newCargo'])
for key in ['dependencies','patch','profile','workspace']:
 assert a.get(key)==b.get(key), 'Native build configuration changed: '+key
a=tomllib.loads(d['oldLock']); b=tomllib.loads(d['newLock'])
for value in [a,b]:
 value['package']=[p for p in value['package'] if p['name']!='zecblock-pir-browser']
assert a==b, 'Native locked dependencies changed'
`], { input: JSON.stringify(configurations) });
if (binary.subarray(0, 4).toString('hex') !== '7f454c46' || binary[4] !== 2 || binary[5] !== 1 || binary.readUInt16LE(18) !== 62) {
  throw new Error('Pilot requires a Linux x86_64 ELF executable.');
}
const destination = resolve(ROOT, 'prototype/private-tx/.local/pilot-bundles');
await mkdir(destination, { recursive: true });
const staging = await mkdtemp(resolve(destination, `${commit.slice(0, 12)}-`));
const files = [
  'prototype/private-tx/server.mjs',
  'prototype/private-tx/native-evaluator.mjs',
  'prototype/private-tx/collection.mjs',
  'prototype/private-tx/collection-server.mjs',
  'prototype/private-tx/state-files.mjs',
  'prototype/private-tx/publish-recent.mjs',
  'prototype/private-tx/export-recent.mjs',
  'prototype/private-tx/export-live.mjs',
  'prototype/private-tx/primary-source.mjs',
  'prototype/private-tx/pilot/publish-once.mjs',
  'prototype/private-tx/pilot/state-budget.mjs',
  'prototype/private-tx/pilot/install.py',
  'prototype/private-tx/pilot/upgrade.py',
  'prototype/private-tx/pilot/upgrade-live.py',
  'prototype/private-tx/pilot/upgrade-live-release.py',
  'prototype/private-tx/pilot/upgrade-archive.py',
  'prototype/private-tx/pilot/archive-query.conf',
  'prototype/private-tx/pilot/archive-source.conf',
  'prototype/private-tx/pilot/archive-publish.conf',
  'prototype/private-tx/pilot/archive-source.mjs',
  'prototype/private-tx/pilot/archive-watch.mjs',
  'prototype/private-tx/pilot/publish-archive.mjs',
  'prototype/private-tx/pilot/source-guard.mjs',
  'prototype/private-tx/pilot/source-watch.mjs',
  'prototype/private-tx/pilot/publish-live.mjs',
  'prototype/private-tx/pilot/zecblock-pir-pilot-source.service',
  'prototype/private-tx/pilot/zecblock-pir-pilot-live-publish.service',
  'prototype/private-tx/pilot/zecblock-pir-pilot.slice',
  'prototype/private-tx/pilot/zecblock-pir-pilot.service',
  'prototype/private-tx/pilot/zecblock-pir-pilot-publish.service',
  'prototype/private-tx/pilot/zecblock-pir-pilot-publish.timer',
  ...['index.html', 'app.js', 'worker.js', 'style.css', 'fonts/geist-sans.woff2', 'fonts/geist-mono.woff2'].map(p => `prototype/private-tx/web/${p}`),
  ...['zecblock_pir_browser.js', 'zecblock_pir_browser_bg.wasm'].map(p => `prototype/pir-browser/pkg/${p}`),
];
const hashes = {};
const sha256 = data => createHash('sha256').update(data).digest('hex');
for (const path of files) {
  const target = resolve(staging, path);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(ROOT, path), target);
  const data = await readFile(target);
  hashes[path] = { sha256: sha256(data), bytes: data.length };
}
const nativeTarget = 'prototype/pir-browser/target/release/zecblock-pir-fixture';
await mkdir(dirname(resolve(staging, nativeTarget)), { recursive: true });
await writeFile(resolve(staging, nativeTarget), binary);
await chmod(resolve(staging, nativeTarget), 0o755);
hashes[nativeTarget] = { sha256: sha256(binary), bytes: binary.length };
await writeFile(resolve(staging, 'provenance.json'), `${JSON.stringify({
  commit, branch: 'new/private-tx-browser-prototype', createdAt: new Date().toISOString(),
  environment: 'Isolated mainnet-primary confirmed-transaction archive/live PIR service; loopback/SSH only; bounded published coverage',
  nativeBuild, files: hashes,
}, null, 2)}\n`);
const archive = `${staging}.tar.gz`;
execFileSync('tar', ['-czf', archive, '-C', staging, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
const packed = await readFile(archive);
process.stdout.write(`${JSON.stringify({ commit, archive, staging, bytes: packed.length, sha256: sha256(packed) }, null, 2)}\n`);
