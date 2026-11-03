import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SELF = 'prototype/private-tx/pilot/global-bundle.mjs';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const git = (root, args, options = {}) => execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024, ...options });
const gitBytes = (root, revision, path) => git(root, ['show', `${revision}:${path}`]);

// This is the complete transitive import closure of the global query server and
// canonical-source watcher. No installer, unit, publisher or captured data is
// included. The archive/source helpers are imports of the watcher, not services
// that this bundle starts or enables.
export const GLOBAL_RUNTIME_FILES = Object.freeze([
  'prototype/private-tx/global-server.mjs',
  'prototype/private-tx/state-files.mjs',
  'prototype/private-tx/pilot/global-source-watch.mjs',
  'prototype/private-tx/pilot/archive-source.mjs',
  'prototype/private-tx/pilot/source-watch.mjs',
  'prototype/private-tx/pilot/source-guard.mjs',
  'prototype/private-tx/collection.mjs',
  'prototype/private-tx/primary-source.mjs',
  ...['global-index.html', 'app.js', 'global-worker.js', 'style.css',
    'fonts/geist-sans.woff2', 'fonts/geist-mono.woff2', 'fonts/LICENSE.txt']
    .map(path => `prototype/private-tx/web/${path}`),
]);
export const GLOBAL_GENERATED_FILES = Object.freeze([
  'prototype/pir-browser/pkg/zecblock_pir_browser.js',
  'prototype/pir-browser/pkg/zecblock_pir_browser_bg.wasm',
]);
export const NATIVE_SOURCE_PATHS = Object.freeze([
  'prototype/pir-browser/native',
  'prototype/pir-browser/src/full_record.rs',
  'prototype/pir-browser/src/global.rs',
  'prototype/pir-browser/bootstrap.py',
  'prototype/pir-browser/build.sh',
  'prototype/pir-browser/rust-toolchain.toml',
  'server/tests/fixtures/browser-transactions.json',
]);
const NATIVE_CONFIGURATION = ['prototype/pir-browser/Cargo.toml', 'prototype/pir-browser/Cargo.lock'];
const NATIVE_TARGET = 'prototype/pir-browser/target/release/zecblock-pir-fixture';

async function ordinaryBytes(root, path) {
  const file = resolve(root, path), info = await lstat(file);
  assert(info.isFile() && !info.isSymbolicLink(), `Bundle input must be an ordinary file: ${path}`);
  return readFile(file);
}

// Exported independently so an exact native candidate can be checked before the
// browser/runtime commit is ready. Browser-only code and dev dependencies may
// change independently; native/profile/normal dependency changes may not.
export function verifyGlobalNativeClosure(root, nativeBuild, binary, commit) {
  assert(/^[a-f0-9]{40}$/.test(nativeBuild?.commit)
    && nativeBuild.buildSourceContainsUncommittedFiles === false
    && nativeBuild.containerExitCode === 0
    && nativeBuild.artifact?.bytes === binary.length
    && nativeBuild.artifact.sha256 === sha256(binary), 'Native build receipt mismatch.');
  assert(binary.length >= 64 && binary.subarray(0, 4).toString('hex') === '7f454c46'
    && binary[4] === 2 && binary[5] === 1 && binary.readUInt16LE(18) === 62,
  'Global bundle requires a Linux x86_64 ELF executable.');
  const nativeFiles = git(root, ['ls-tree', '-r', '--name-only', nativeBuild.commit,
    'prototype/pir-browser/native'], { encoding: 'utf8' }).trim().split('\n');
  const required = [...nativeFiles, ...NATIVE_SOURCE_PATHS.filter(path => path !== 'prototype/pir-browser/native'),
    ...NATIVE_CONFIGURATION];
  assert(nativeBuild.files && required.every(path => Object.hasOwn(nativeBuild.files, path)),
    'Native receipt omits a required source/configuration input.');
  for (const [path, expected] of Object.entries(nativeBuild.files)) {
    const bytes = gitBytes(root, nativeBuild.commit, path);
    assert(expected.bytes === bytes.length && expected.sha256 === sha256(bytes), `Native receipt source mismatch: ${path}`);
  }
  git(root, ['diff', '--quiet', nativeBuild.commit, commit, '--', ...NATIVE_SOURCE_PATHS]);
  const configurations = Object.fromEntries([
    ['oldCargo', nativeBuild.commit, NATIVE_CONFIGURATION[0]], ['newCargo', commit, NATIVE_CONFIGURATION[0]],
    ['oldLock', nativeBuild.commit, NATIVE_CONFIGURATION[1]], ['newLock', commit, NATIVE_CONFIGURATION[1]],
  ].map(([key, revision, path]) => [key, gitBytes(root, revision, path).toString('utf8')]));
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
}

export async function buildGlobalBundle({ root = ROOT, nativePath, receiptPath } = {}) {
  assert(nativePath && receiptPath,
    'Usage: node prototype/private-tx/pilot/global-bundle.mjs <Linux x86_64 native binary> <build receipt.json>');
  const commit = git(root, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const cleanPaths = [...GLOBAL_RUNTIME_FILES, SELF, ...NATIVE_SOURCE_PATHS, ...NATIVE_CONFIGURATION,
    'prototype/pir-browser/src', 'prototype/private-tx/ui'];
  const dirty = git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...cleanPaths], { encoding: 'utf8' }).trim();
  assert(!dirty, `Global bundle requires clean committed source inputs:\n${dirty}`);
  const inputs = new Map();
  for (const path of [...GLOBAL_RUNTIME_FILES, SELF]) {
    const working = await ordinaryBytes(root, path), committed = gitBytes(root, commit, path);
    assert(working.equals(committed), `Global bundle input differs from HEAD: ${path}`);
    if (path !== SELF) inputs.set(path, committed);
  }
  const binary = await ordinaryBytes(root, resolve(nativePath));
  const receipt = await ordinaryBytes(root, resolve(receiptPath));
  const nativeBuild = JSON.parse(receipt.toString('utf8'));
  verifyGlobalNativeClosure(root, nativeBuild, binary, commit);
  for (const path of GLOBAL_GENERATED_FILES) inputs.set(path, await ordinaryBytes(root, path));
  const binding = inputs.get(GLOBAL_GENERATED_FILES[0]).toString('utf8');
  assert(binding.includes('export class GlobalPirBrowser'), 'Generated browser binding omits GlobalPirBrowser.');
  const exports = new Set(WebAssembly.Module.exports(new WebAssembly.Module(inputs.get(GLOBAL_GENERATED_FILES[1])))
    .map(value => value.name));
  assert(['globalpirbrowser_new', 'globalpirbrowser_make_query', 'globalpirbrowser_decode_response',
    'globalpirbrowser_cancel_query'].every(name => exports.has(name)), 'Generated WASM omits the global browser API.');
  inputs.set(NATIVE_TARGET, binary);
  const destination = resolve(root, 'prototype/private-tx/.local/global-bundles');
  await mkdir(destination, { recursive: true });
  const staging = await mkdtemp(resolve(destination, `${commit.slice(0, 12)}-`)), hashes = {};
  for (const [path, bytes] of inputs) {
    const target = resolve(staging, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    if (path === NATIVE_TARGET) await chmod(target, 0o755);
    hashes[path] = { sha256: sha256(bytes), bytes: bytes.length };
  }
  const provenance = {
    schema: 'zecblock-private-global-bundle-v1', commit,
    branch: git(root, ['branch', '--show-current'], { encoding: 'utf8' }).trim(), createdAt: new Date().toISOString(),
    environment: 'Isolated experimental global confirmed-transaction PIR runtime; loopback/SSH only; bounded published coverage',
    bundleScript: { path: SELF, sha256: sha256(gitBytes(root, commit, SELF)) },
    nativeBuildReceiptSha256: sha256(receipt), nativeBuild,
    generatedBrowserAssets: { files: GLOBAL_GENERATED_FILES, buildReceiptProvided: false,
      verification: 'Exact byte hashes and global API exports; this bundle does not attest a WASM source-to-artifact rebuild.' },
    files: hashes,
  };
  await writeFile(resolve(staging, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  const archive = `${staging}.tar.gz`;
  execFileSync('tar', ['-czf', archive, '-C', staging, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const packed = await readFile(archive);
  return { commit, archive, staging, bytes: packed.length, sha256: sha256(packed) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(`${JSON.stringify(await buildGlobalBundle({ nativePath: process.argv[2], receiptPath: process.argv[3] }), null, 2)}\n`);
}
