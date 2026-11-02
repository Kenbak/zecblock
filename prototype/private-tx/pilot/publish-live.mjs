import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPrimarySnapshotReader, decodePrimarySnapshot, primaryFactsFingerprint } from '../primary-source.mjs';
import { exportLive } from '../export-live.mjs';
import { publishRecent } from '../publish-recent.mjs';
import { prepareState } from './state-budget.mjs';
import { atomicJson, freshGuard } from './source-guard.mjs';
import { planFullSource } from './publish-archive.mjs';

async function currentManifest(localDir) {
  const pointer = JSON.parse(await readFile(resolve(localDir, 'current.json'), 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(pointer.directory) || pointer.directory !== pointer.publicationId) throw new Error('Invalid live publication pointer.');
  return JSON.parse(await readFile(resolve(localDir, 'publications', pointer.directory, 'manifest.json'), 'utf8'));
}

export function admitSource(source) {
  const sizes = source.records.map(record => Buffer.byteLength(JSON.stringify({
    schema: 'zecblock-private-tx-record-v1', network: source.network, snapshot: source.snapshot,
    coverage: source.coverage, txid: record.txid, detail: record.detail, raw: record.raw,
    ...(record.price === undefined ? {} : { price: record.price }), ...(record.source === undefined ? {} : { source: record.source }),
  })));
  const chunks = Math.ceil(Math.max(...sizes) / 8064);
  const payloadRows = sizes.reduce((sum, bytes) => sum + Math.ceil(bytes / 8064), 0);
  if (!sizes.length || chunks < 1 || chunks > 64 || payloadRows + 1 > 2048) {
    throw new Error('Cumulative pilot capacity exceeded; all previous records retained.');
  }
  return { chunks, records: sizes.length, payloadRows, coverRows: 1 };
}

// The native planner owns the versioned storage codec. JSON byte estimates
// remain useful only for the legacy uncompressed helper above.
export function admitNativePlan(plan, source) {
  const positive = field => Number.isSafeInteger(plan?.[field]) && plan[field] > 0;
  if (plan?.schema !== 'zecblock-private-tx-plan-v1' || plan.recordCodec !== 'json-context-zlib-v1'
    || plan.packing !== 'compact-v1' || plan.rows !== 2048 || plan.rowBytes !== 8192 || plan.payloadBytes !== 8064
    || plan.coverRows !== 1 || !positive('records') || plan.records > 2048 || plan.records !== source.records.length
    || !['payloadRows', 'totalRows', 'chunkCount', 'recordBytesTotal', 'decodedBytesTotal',
      'legacyRecordBytesTotal', 'maxRecordBytes', 'maxDecodedRecordBytes'].every(positive)
    || plan.decodedAggregateLimit !== 64 * 1024 ** 2 || typeof plan.fits !== 'boolean'
    || plan.totalRows !== plan.payloadRows + 1 || plan.payloadRows < plan.records
    || plan.maxRecordBytes > 64 * 8064 || plan.maxDecodedRecordBytes > 8 * 1024 ** 2) {
    throw new Error('Invalid or incompatible native live capacity plan; previous publication retained.');
  }
  const fits = plan.totalRows <= 2048 && plan.chunkCount <= 64 && plan.legacyRecordBytesTotal <= plan.decodedAggregateLimit;
  if (plan.fits !== fits || (fits && plan.capacityReason !== null)) {
    throw new Error('Inconsistent native live capacity plan; previous publication retained.');
  }
  if (!fits) throw new Error('Cumulative pilot capacity exceeded; all previous records retained.');
  return { chunks: plan.chunkCount, records: plan.records, payloadRows: plan.payloadRows, coverRows: 1 };
}

export async function rawFromLoopback(txid) {
  if (!/^[a-f0-9]{64}$/.test(txid)) throw new Error('Invalid raw observation identifier.');
  const response = await fetch(`http://127.0.0.1:3001/v1/transactions/${txid}/verbose`, {
    method: 'GET', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Raw transaction observation unavailable.');
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw new Error('Raw response capacity exceeded.');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (body.meta?.network !== 'mainnet' || body.data?.txid !== txid) throw new Error('Raw network/identity mismatch.');
  return body;
}

export async function liveTick({ localDir, sourceDir, binary, config, rawCache = new Map(), readRaw = rawFromLoopback, publish = publishRecent, planSource = planFullSource }) {
  const previous = await currentManifest(localDir);
  const snapshot = decodePrimarySnapshot(await readFile(resolve(sourceDir, 'latest.json'), 'utf8'));
  const sourceGuard = await freshGuard(sourceDir, { coverage: { blocks: snapshot.blocks } });
  if (sourceGuard.captureState === 'capacity-blocked') throw new Error('Primary cumulative capture capacity exceeded; previous complete snapshot retained.');
  const fingerprint = snapshot.fingerprint;
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || primaryFactsFingerprint(snapshot) !== fingerprint) throw new Error('Primary snapshot fingerprint mismatch.');
  if (previous.coverage.primaryFingerprint === fingerprint) {
    await atomicJson(resolve(localDir, 'publisher-status.json'), { state: 'ready', observedAt: new Date().toISOString(),
      lastSuccessAt: previous.snapshot.publishedAt, publicationId: previous.publicationId,
      source: { ...snapshot.tip, observedAt: snapshot.observedAt, fingerprint }, served: previous.snapshot });
    return { unchanged: true, publicationId: previous.publicationId };
  }
  const retainedKeys = new Set(snapshot.transactions.map(tx => `${tx.txid}:${tx.block_hash}`));
  for (const key of rawCache.keys()) if (!retainedKeys.has(key)) rawCache.delete(key);
  const scope = await createPrimarySnapshotReader({ capture: async () => snapshot, readRaw: async txid => {
    const tx = snapshot.transactions.find(row => row.txid === txid);
    if (!tx) throw new Error('Transaction outside captured cohort.');
    const key = `${txid}:${tx.block_hash}`;
    if (!rawCache.has(key)) rawCache.set(key, await readRaw(txid));
    return rawCache.get(key);
  }, readPrice: async () => { throw new Error('Historical price not captured by live pilot.'); } });
  try {
    const source = await exportLive({ read: scope.read, startHeight: config.startHeight,
      maxBlocks: config.maxBlocks, maxRecords: config.maxRecords, sourceOrigin: 'mainnet-primary-read-only-snapshot', sourceAuthority: scope.authority });
    source.coverage.primaryFingerprint = fingerprint;
    source.coverage.sourceObservedAt = snapshot.observedAt;
    admitNativePlan(await planSource(source, localDir, { binary }), source);
    await prepareState(localDir);
    const result = await publish({ source, localDir, binary, beforeActivate: async manifest => {
      const guard = await freshGuard(sourceDir, manifest, { notBefore: Date.now(), waitMs: 6000 });
      if (guard.fingerprint !== fingerprint) throw new Error('Primary facts changed during preparation; rebuild latest candidate.');
    } });
    const readyAt = new Date().toISOString();
    await atomicJson(resolve(localDir, 'publisher-status.json'), {
      state: 'ready', observedAt: readyAt, lastSuccessAt: readyAt, publicationId: result.publicationId,
      source: { height: snapshot.tip.height, hash: snapshot.tip.hash, observedAt: snapshot.observedAt, fingerprint },
      served: { height: source.coverage.endHeight, hash: source.snapshot.hash, publishedAt: readyAt },
      observationToReadyMs: Date.parse(readyAt) - Date.parse(snapshot.observedAt),
      message: 'Bounded cumulative primary snapshot; page metadata remains pinned until explicit refresh.',
    });
    // Cache is bounded by the complete retained cohort, including canonical block identity.
    const keep = new Set(snapshot.transactions.map(tx => `${tx.txid}:${tx.block_hash}`));
    for (const key of rawCache.keys()) if (!keep.has(key)) rawCache.delete(key);
    return result;
  } finally { await scope.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.PRIVATE_TX_LOCAL_DIR || !process.env.PRIVATE_TX_SOURCE_DIR || !process.env.PRIVATE_TX_EVALUATOR) throw new Error('Explicit live state/source/evaluator paths required.');
  const localDir = resolve(process.env.PRIVATE_TX_LOCAL_DIR), sourceDir = resolve(process.env.PRIVATE_TX_SOURCE_DIR);
  const config = JSON.parse(await readFile('/etc/zecblock-pir-pilot/live.json', 'utf8'));
  const rawCache = new Map();
  // Reuse separately observed raw bytes after restart; SQL detail is always recaptured.
  try {
    const manifest = await currentManifest(localDir);
    const old = JSON.parse(await readFile(resolve(localDir, 'publications', manifest.publicationId, 'source.json'), 'utf8'));
    for (const record of old.records) rawCache.set(`${record.txid}:${record.detail.blockHash}`, { meta: { network: 'mainnet', generatedAt: record.source?.rawObservedAt }, data: record.raw });
  } catch { /* An unseeded cache is safe; no serving pointer is changed here. */ }
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
  while (!abort.signal.aborted) {
    try { await liveTick({ localDir, sourceDir, binary: resolve(process.env.PRIVATE_TX_EVALUATOR), config, rawCache }); }
    catch (error) {
      let previous = {}, guard = {};
      try { previous = await currentManifest(localDir); } catch { /* status remains explicit */ }
      try { guard = JSON.parse(await readFile(resolve(sourceDir, 'guard.json'), 'utf8')); } catch { /* unavailable */ }
      const capacity = /capacity|bound|fit|chunk/i.test(error.message);
      await atomicJson(resolve(localDir, 'publisher-status.json'), { state: capacity ? 'capacity-blocked' : 'unavailable', observedAt: new Date().toISOString(),
        publicationId: previous.publicationId, lastSuccessAt: previous.snapshot?.publishedAt ?? null,
        source: guard.tip, served: previous.snapshot, reason: capacity ? 'cumulative_capacity' : 'capture_or_preparation_failed',
        message: capacity ? 'Cumulative pilot capacity reached; previous complete snapshot retained without dropping records.' : 'Primary capture or preparation unavailable; previous snapshot retained.' });
      process.stderr.write('Live PIR refresh unavailable; previous complete snapshot retained.\n');
    }
    try { await delay(1000, undefined, { signal: abort.signal }); } catch { break; }
  }
}
