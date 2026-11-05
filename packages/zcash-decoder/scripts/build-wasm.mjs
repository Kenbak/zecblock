import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../..');
const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
const version = execFileSync('wasm-bindgen', ['--version'], { encoding: 'utf8' }).trim();
if (version !== 'wasm-bindgen 0.2.127') throw new Error('Install wasm-bindgen-cli 0.2.127 before rebuilding.');
const env = { ...process.env,
  RUSTFLAGS: `${process.env.RUSTFLAGS || ''} --remap-path-prefix=${repoRoot}=/zcash-decoder --remap-path-prefix=${cargoHome}/registry=/cargo/registry`,
};
const target = env.CARGO_TARGET_DIR ? resolve(repoRoot, 'wasm', env.CARGO_TARGET_DIR) : join(repoRoot, 'wasm/target');
env.CARGO_TARGET_DIR = target;
execFileSync('cargo', ['build', '--manifest-path', join(repoRoot, 'wasm/Cargo.toml'), '--target',
  'wasm32-unknown-unknown', '--release', '--locked'], { cwd: join(repoRoot, 'wasm'), env, stdio: 'inherit' });
execFileSync('wasm-bindgen', [join(target, 'wasm32-unknown-unknown/release/zcash_wasm.wasm'),
  '--target', 'web', '--out-dir', join(packageRoot, 'wasm')], { env, stdio: 'inherit' });

// Deterministic receipts make the bundled artifact and source inputs reviewable.
const { readFileSync, writeFileSync } = await import('node:fs');
const { createHash } = await import('node:crypto');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sources = Object.fromEntries(['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'src/lib.rs']
  .map(path => [path, sha256(readFileSync(join(repoRoot, 'wasm', path)))]));
const artifacts = Object.fromEntries(['zcash_wasm.js', 'zcash_wasm_bg.wasm', 'zcash_wasm.d.ts', 'zcash_wasm_bg.wasm.d.ts']
  .map(path => [path, sha256(readFileSync(join(packageRoot, 'wasm', path)))]));
const rust = execFileSync('rustc', ['--version'], { cwd: join(repoRoot, 'wasm'), encoding: 'utf8' }).trim();
writeFileSync(join(packageRoot, 'wasm/build-info.json'), JSON.stringify({
  format: 1, sourceRepository: 'https://github.com/Kenbak/zecblock',
  rust, wasmBindgen: version, target: 'wasm32-unknown-unknown', profile: 'release', sources, artifacts,
}, null, 2) + '\n');
