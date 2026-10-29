import { spawn } from 'node:child_process';
import { mkdir, readFile, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildPrimarySnapshotSql, decodePrimarySnapshot, primaryFactsFingerprint } from '../primary-source.mjs';
import { atomicJson } from './source-guard.mjs';

export async function capturePrimary(config, { binary = '/usr/bin/psql' } = {}) {
  const sql = buildPrimarySnapshotSql(config);
  return new Promise((resolveSnapshot, reject) => {
    const child = spawn(binary, ['-X', '--no-align', '--tuples-only', '--quiet', '--set', 'ON_ERROR_STOP=1',
      '--host=/var/run/postgresql', '--dbname=zcash_explorer_mainnet'], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PGAPPNAME: 'zecblock-pir-pilot-source', PGCONNECT_TIMEOUT: '3',
        PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=3000 -c lock_timeout=200' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = []; let bytes = 0, failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 10_000);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 128 * 1024 * 1024) { failed = true; child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    child.stderr.resume(); // No SQL diagnostics or source payloads in service logs.
    child.on('error', () => { clearTimeout(timer); reject(new Error('Primary capture process unavailable.')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) { reject(new Error('Bounded primary read-only capture failed.')); return; }
      try { resolveSnapshot(decodePrimarySnapshot(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) {
        const failure = new Error('Primary snapshot identity, completeness or capacity validation failed.');
        failure.code = /bound|oversized|capacity/i.test(error.message) ? 'CAPACITY' : 'INVALID_SOURCE';
        reject(failure);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(sql);
  });
}

export async function sourceTick({ config, sourceDir, capture = capturePrimary, previousFingerprint = null, statfsFn = statfs }) {
  let snapshot, capacityBlocked = false;
  try { snapshot = await capture(config); }
  catch (error) {
    if (error.code !== 'CAPACITY') throw error;
    const previous = decodePrimarySnapshot(await readFile(resolve(sourceDir, 'latest.json'), 'utf8'));
    // Continue a fresh canonical check of the admitted cohort without claiming
    // the uncaptured extension is complete or moving the persisted floor.
    snapshot = await capture({ ...config, endHeight: previous.coverage.endHeight });
    capacityBlocked = true;
  }
  const fingerprint = primaryFactsFingerprint(snapshot);
  const free = await statfsFn(sourceDir);
  if (Number(free.bavail) * Number(free.bsize) < 1024 ** 3) throw new Error('Source disk reserve unavailable.');
  if (fingerprint !== previousFingerprint) await atomicJson(resolve(sourceDir, 'latest.json'), { ...snapshot, fingerprint }, 0o640);
  await atomicJson(resolve(sourceDir, 'guard.json'), {
    schema: 'zecblock-private-source-guard-v1', state: 'ready', observedAt: new Date().toISOString(),
    sourceObservedAt: snapshot.observedAt, fingerprint, tip: snapshot.tip, startHeight: snapshot.coverage.startHeight,
    endHeight: snapshot.coverage.endHeight, captureState: capacityBlocked ? 'capacity-blocked' : 'ready',
    blocks: snapshot.blocks.map(block => ({ height: Number(block.height), hash: block.hash })),
  }, 0o640);
  return fingerprint;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const sourceDir = resolve(process.env.PRIVATE_TX_SOURCE_DIR ?? '/var/lib/zecblock-pir-source');
  const config = JSON.parse(await readFile('/etc/zecblock-pir-pilot/live.json', 'utf8'));
  if (config.schema !== 'zecblock-private-live-config-v1' || config.intervalMs !== 1000) throw new Error('Explicit bounded live configuration required.');
  await mkdir(sourceDir, { recursive: true });
  const abort = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => abort.abort());
  let fingerprint = null;
  while (!abort.signal.aborted) {
    try { fingerprint = await sourceTick({ config, sourceDir, previousFingerprint: fingerprint }); }
    catch {
      await atomicJson(resolve(sourceDir, 'guard.json'), { schema: 'zecblock-private-source-guard-v1', state: 'unavailable', observedAt: new Date().toISOString(), reason: 'source_capture_failed' }, 0o640);
      process.stderr.write('Bounded primary capture unavailable; no serving readiness advanced.\n');
    }
    try { await delay(config.intervalMs, undefined, { signal: abort.signal }); } catch { break; }
  }
}
