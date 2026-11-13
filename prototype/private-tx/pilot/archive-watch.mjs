import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPrimarySnapshotReader, decodePrimarySnapshot, primaryFactsFingerprint } from '../primary-source.mjs';
import { exportLive } from '../export-live.mjs';
import { rawFromLoopback } from './publish-live.mjs';
import { publishCollection } from './publish-archive.mjs';
import { captureRequest } from './archive-source.mjs';
import { validateCollection } from '../collection.mjs';
import { atomicJson, freshGuard, verifyGuard } from './source-guard.mjs';
import { readStateJson } from '../state-files.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };
const validHeight = value => Number.isSafeInteger(value) && value >= 0;

export async function archiveHead(localDir) {
  try { return validateCollection(await readStateJson(resolve(localDir, 'collection.json'), 8 * 1024 * 1024)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function nextCapture({ collection, tip, blocks, bootstrapHeight, liveWindow = 16, backfillFrom,
  maxBlocks = 128, avoidBackfill = false } = {}) {
  assert(validHeight(tip?.height) && validHeight(bootstrapHeight) && Number.isSafeInteger(liveWindow)
    && liveWindow > 0 && liveWindow <= maxBlocks && maxBlocks <= 128, 'Explicit bounded archive configuration required.');
  const request = (startHeight, endHeight) => ({ schema: 'zecblock-private-capture-request-v1', startHeight,
    ...(endHeight === undefined ? {} : { endHeight }) });
  if (!collection) return request(bootstrapHeight);
  const canonical = new Map((blocks ?? []).map(block => [block.height, block.hash]));
  // An independently observed replacement is repaired before publishing any
  // further state. A missing guard entry is never guessed to be canonical.
  for (const segment of collection.segments) {
    if (segment.manifest.coverage.startHeight > tip.height) continue;
    if (blocks && (segment.manifest.coverage.blocks.some(block => canonical.get(block.height) !== block.hash)
      || canonical.get(segment.manifest.snapshot.height) !== segment.manifest.snapshot.hash)) {
      return request(segment.manifest.coverage.startHeight, Math.min(segment.manifest.coverage.endHeight, tip.height));
    }
  }
  if (collection.segments.every(segment => segment.manifest.coverage.startHeight > tip.height)) {
    return request(Math.max(0, tip.height - liveWindow + 1));
  }
  const tail = collection.segments.filter(segment => segment.manifest.coverage.startHeight <= tip.height).at(-1).manifest.coverage;
  if (tail.endHeight < tip.height) {
    // Catch the live tip first after a long interruption. Any intervening gap
    // remains explicit in collection.coverage.ranges until backfill fills it.
    const start = tip.height - tail.endHeight > liveWindow ? Math.max(tail.endHeight + 1, tip.height - liveWindow + 1)
      : tip.height - tail.startHeight + 1 <= maxBlocks ? tail.startHeight : tail.endHeight + 1;
    return request(start);
  }
  if (backfillFrom !== undefined && !avoidBackfill) {
    assert(validHeight(backfillFrom), 'Invalid historical coverage floor.');
    let cursor = backfillFrom;
    for (const range of collection.coverage.ranges) {
      if (cursor < range.startHeight) return request(cursor, Math.min(range.startHeight - 1, cursor + maxBlocks - 1));
      cursor = Math.max(cursor, range.endHeight + 1);
    }
  }
  return request(tail.startHeight);
}

async function setRequest(localDir, request) {
  const path = resolve(localDir, 'capture-request.json');
  try {
    const previous = captureRequest(await readStateJson(path, 1024));
    if (previous.requestId === captureRequest(request).requestId) return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await atomicJson(path, request, 0o640);
}

function replacementSegments(collection, source, guard) {
  const retired = [], retained = [];
  const canonical = new Map(guard.blocks.map(block => [Number(block.height), block.hash]));
  for (const segment of collection?.segments ?? []) {
    const range = segment.manifest.coverage;
    let invalid = false;
    try { verifyGuard(guard, segment.manifest); } catch { invalid = true; }
    // A reorg may invalidate several archives or their observation anchors at
    // once. Retire every independently invalid view, including nonoverlapping
    // ones; retaining a second invalid view would deadlock every activation.
    // Missing coverage remains a declared gap while canonical data is rebuilt.
    if (invalid) retired.push(segment.publicationId);
    const overlaps = range.startHeight <= source.coverage.endHeight && range.endHeight >= source.coverage.startHeight;
    if (!overlaps) { if (!invalid) retained.push(segment); continue; }
    const changed = range.blocks.some(block => canonical.get(block.height) !== block.hash);
    assert(source.coverage.startHeight <= range.startHeight
      && source.coverage.endHeight >= (changed ? Math.min(range.endHeight, guard.tip.height) : range.endHeight),
    'A replacement source must cover the entire retained canonical segment.');
  }
  return { retained, retired };
}

function smallerCapture(collection, requested, tip, config, blocks) {
  const tail = collection?.segments.at(-1).manifest.coverage;
  const end = Math.min(requested.endHeight ?? tip.height, tip.height, requested.startHeight + 127);
  return tail && requested.startHeight === tail.startHeight && tail.endHeight < tip.height
    ? { schema: 'zecblock-private-capture-request-v1', startHeight: tail.endHeight + 1 }
    : end > requested.startHeight ? { schema: 'zecblock-private-capture-request-v1', startHeight: requested.startHeight,
      endHeight: requested.startHeight + Math.floor((end - requested.startHeight) / 2) }
      : nextCapture({ collection, tip, blocks, ...config, avoidBackfill: true });
}

export async function archiveTick({ localDir, sourceDir, binary, config, rawCache = new Map(),
  readRaw = rawFromLoopback, publish = publishCollection, avoidBackfill = false, signal } = {}) {
  signal?.throwIfAborted();
  const collection = await archiveHead(localDir);
  const requested = captureRequest(await readStateJson(resolve(localDir, 'capture-request.json'), 1024));
  const guard = await readStateJson(resolve(sourceDir, 'guard.json'), 512 * 1024);
  assert(guard.schema === 'zecblock-private-source-guard-v1' && guard.state === 'ready'
    && Date.now() - Date.parse(guard.observedAt) <= 10_000 && Date.parse(guard.observedAt) <= Date.now() + 1000,
  'Fresh primary source guard required.');
  if (guard.requestId !== requested.requestId) return { waiting: true, sourceState: 'request-pending' };
  if (guard.captureState !== 'ready') {
    if (guard.captureState === 'capacity-blocked') {
      await setRequest(localDir, smallerCapture(collection, requested, guard.tip, config, guard.blocks));
    } else if (guard.captureState !== 'waiting' || collection?.segments.some(segment => {
      try { verifyGuard(guard, segment.manifest); return false; } catch { return true; }
    })) {
      await setRequest(localDir, nextCapture({ collection, tip: guard.tip, blocks: guard.blocks, ...config, avoidBackfill: true }));
    }
    await atomicJson(resolve(localDir, 'publisher-status.json'), {
      state: collection?.coverage.endHeight === guard.tip.height ? 'degraded' : guard.captureState === 'capacity-blocked' ? 'capacity-blocked' : 'unavailable',
      observedAt: new Date().toISOString(), collectionId: collection?.collectionId ?? null, served: collection?.snapshot ?? null,
      source: guard.tip, captureState: guard.captureState,
      message: 'No new candidate activated. Retained collection coverage remains explicit; source job is waiting or unavailable.',
    });
    return { waiting: true, sourceState: guard.captureState };
  }
  const snapshot = decodePrimarySnapshot(JSON.stringify(await readStateJson(resolve(sourceDir, 'latest.json'), 128 * 1024 * 1024)));
  const fingerprint = primaryFactsFingerprint(snapshot);
  assert(snapshot.requestId === requested.requestId && guard.requestId === requested.requestId
    && snapshot.fingerprint === fingerprint && guard.fingerprint === fingerprint, 'Source request/facts fingerprint mismatch.');
  // Guard admission binds both source block membership and its snapshot anchor.
  verifyGuard(guard, { coverage: { blocks: snapshot.blocks }, snapshot: snapshot.tip });
  const alreadyPublished = collection?.segments.some(segment => segment.manifest.coverage.primaryFingerprint === fingerprint);
  if (alreadyPublished) {
    await atomicJson(resolve(localDir, 'publisher-status.json'), { state: 'ready', observedAt: new Date().toISOString(),
      collectionId: collection.collectionId, source: guard.tip, served: collection.snapshot,
      coverage: { ...collection.coverage, blocks: undefined },
      message: 'Source recovered or unchanged. Published collection head and captured transaction observations are unchanged.' });
    await setRequest(localDir, nextCapture({ collection, tip: guard.tip, blocks: guard.blocks, ...config, avoidBackfill }));
    return { unchanged: true, collectionId: collection.collectionId };
  }
  const keys = new Set(snapshot.transactions.map(tx => `${tx.txid}:${tx.block_hash}`));
  for (const key of rawCache.keys()) if (!keys.has(key)) rawCache.delete(key);
  let rawBytes = [...rawCache.values()].reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value)), 0);
  const capacity = () => { const error = new Error('Aggregate raw source capacity exceeded.'); error.code = 'SOURCE_CAPACITY'; return error; };
  if (rawBytes > 64 * 1024 * 1024) { rawCache.clear(); throw capacity(); }
  const scope = await createPrimarySnapshotReader({ capture: snapshot, readRaw: async txid => {
    const tx = snapshot.transactions.find(row => row.txid === txid);
    assert(tx, 'Raw transaction outside captured source.');
    const key = `${txid}:${tx.block_hash}`;
    if (!rawCache.has(key)) {
      const value = await readRaw(txid);
      const size = Buffer.byteLength(JSON.stringify(value));
      if (size > 8 * 1024 * 1024 || rawBytes + size > 64 * 1024 * 1024) throw capacity();
      rawBytes += size; rawCache.set(key, value);
    }
    return rawCache.get(key);
  } });
  try {
    const source = await exportLive({ read: scope.read, startHeight: snapshot.coverage.startHeight,
      endHeight: snapshot.coverage.endHeight, maxBlocks: 128, maxRecords: 2048,
      sourceOrigin: 'mainnet-primary-read-only-snapshot', sourceAuthority: scope.authority });
    source.coverage.primaryFingerprint = fingerprint;
    source.coverage.sourceObservedAt = snapshot.observedAt;
    source.coverage.scope = 'Complete confirmed block segment. Transaction observations are tied to this segment snapshot; collection ranges declare any unpublished gaps.';
    const { retained, retired } = replacementSegments(collection, source, guard);
    const result = await publish({ localDir, binary, sources: [source], retainedSegments: retained,
      retirePublicationIds: retired, signal,
      beforeActivate: async next => {
        const admission = await freshGuard(sourceDir, next, { notBefore: Date.now(), waitMs: 6000 });
        assert(admission.requestId === requested.requestId && admission.fingerprint === fingerprint,
          'Primary facts changed while preparing a collection; candidate not activated.');
        for (const segment of next.segments) verifyGuard(admission, segment.manifest);
      } });
    const readyAt = new Date().toISOString();
    await atomicJson(resolve(localDir, 'publisher-status.json'), { state: 'ready', observedAt: readyAt,
      lastSuccessAt: readyAt, collectionId: result.collectionId, source: guard.tip, served: result.collection.snapshot,
      coverage: { ...result.collection.coverage, blocks: undefined },
      observationToReadyMs: Date.parse(readyAt) - Date.parse(snapshot.observedAt), cleanupWarning: result.cleanupWarning,
      message: 'Confirmed archive/live collection. Coverage and every transaction observation remain explicitly snapshot-bound.' });
    await setRequest(localDir, nextCapture({ collection: result.collection, tip: guard.tip, blocks: guard.blocks, ...config, avoidBackfill }));
    return result;
  } finally { await scope.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const localDir = process.env.PRIVATE_TX_COLLECTION_DIR, sourceDir = process.env.PRIVATE_TX_SOURCE_DIR;
  assert(localDir && sourceDir && process.env.PRIVATE_TX_EVALUATOR, 'Explicit archive publisher paths required.');
  const config = await readStateJson('/etc/zecblock-pir-pilot/archive.json', 8192);
  assert(config.schema === 'zecblock-private-archive-config-v1', 'Explicit archive configuration required.');
  await mkdir(localDir, { recursive: true, mode: 0o750 });
  const bootstrap = { schema: 'zecblock-private-capture-request-v1', startHeight: config.bootstrapHeight };
  try { captureRequest(await readStateJson(resolve(localDir, 'capture-request.json'), 1024)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await setRequest(localDir, bootstrap); }
  const abort = new AbortController(), rawCache = new Map();
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => abort.abort());
  let backfillAfter = 0;
  while (!abort.signal.aborted) {
    try { await archiveTick({ localDir, sourceDir, binary: process.env.PRIVATE_TX_EVALUATOR, config,
      rawCache, avoidBackfill: Date.now() < backfillAfter, signal: abort.signal }); }
    catch (error) {
      const current = await archiveHead(localDir);
      const capacity = /capacity|budget|bound|fit/i.test(error.message);
      backfillAfter = Date.now() + 60_000;
      await atomicJson(resolve(localDir, 'publisher-status.json'), { state: capacity ? 'capacity-blocked' : 'unavailable',
        observedAt: new Date().toISOString(), collectionId: current?.collectionId ?? null,
        served: current?.snapshot ?? null, activationMayHaveOccurred: Boolean(error.activationMayHaveOccurred),
        message: 'Collection refresh unavailable. Read the retained collection head for actual published coverage; no complete candidate was silently truncated.' });
      try {
        const guard = await readStateJson(resolve(sourceDir, 'guard.json'), 512 * 1024);
        if (guard.state === 'ready') {
          const requested = captureRequest(await readStateJson(resolve(localDir, 'capture-request.json'), 1024));
          const request = error.code === 'SOURCE_CAPACITY' ? smallerCapture(current, requested, guard.tip, config, guard.blocks)
            : nextCapture({ collection: current, tip: guard.tip, blocks: guard.blocks, ...config, avoidBackfill: true });
          await setRequest(localDir, request);
        }
      } catch { /* The independent source owns fresh readiness; never fabricate it. */ }
      process.stderr.write('Archive publication unavailable; inspect explicit published coverage.\n');
    }
    try { await delay(1000, undefined, { signal: abort.signal }); } catch { break; }
  }
}
