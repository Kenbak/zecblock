import { statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { capturePrimary, readPrimaryJson } from './source-watch.mjs';
import { atomicJson } from './source-guard.mjs';
import { canonicalJson, validateCollection } from '../collection.mjs';
import { MAINNET_GENESIS_HASH, primaryFactsFingerprint } from '../primary-source.mjs';
import { readStateJson as boundedJson } from '../state-files.mjs';

const HASH = /^[a-f0-9]{64}$/;
const validHeight = value => Number.isSafeInteger(value) && value >= 0;
const assert = (value, message) => { if (!value) throw new Error(message); };
export const MAX_GUARD_HEIGHTS = 2048;

export function captureRequest(value) {
  assert(value?.schema === 'zecblock-private-capture-request-v1' && validHeight(value.startHeight)
    && (value.endHeight === undefined || validHeight(value.endHeight) && value.endHeight >= value.startHeight)
    && Object.keys(value).every(key => ['schema', 'startHeight', 'endHeight'].includes(key)), 'Invalid bounded capture request.');
  const requestId = createHash('sha256').update(canonicalJson(value)).digest('hex');
  return { ...value, requestId };
}

export function headerGuardSql(heights) {
  assert(Array.isArray(heights) && heights.length <= MAX_GUARD_HEIGHTS && heights.every(validHeight)
    && new Set(heights).size === heights.length, 'Canonical guard height bound exceeded.');
  // The sole parameter is a JSON array containing validated integer heights.
  // It crosses libpq as $1 through psql 16's extended-query \bind command.
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='3s';
SET LOCAL lock_timeout='200ms';
SET LOCAL idle_in_transaction_session_timeout='5s';
SET LOCAL work_mem='8MB';
WITH requested AS MATERIALIZED (SELECT value::bigint height FROM jsonb_array_elements_text($1::jsonb)),
tip AS MATERIALIZED (SELECT height,hash FROM public.blocks ORDER BY height DESC LIMIT 1),
selected AS MATERIALIZED (SELECT b.height,b.hash FROM public.blocks b JOIN requested r USING(height))
SELECT jsonb_build_object('schema','zecblock-private-header-guard-v1','network','mainnet',
'database',current_database(),'isPrimary',NOT pg_is_in_recovery(),'readOnly',current_setting('transaction_read_only')='on',
'genesisHash',(SELECT hash FROM public.blocks WHERE height=0),
'observedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
'tip',(SELECT jsonb_build_object('height',height,'hash',hash) FROM tip),
'blocks',COALESCE((SELECT jsonb_agg(jsonb_build_object('height',height,'hash',hash) ORDER BY height) FROM selected),'[]'::jsonb))
\\bind '${JSON.stringify(heights)}'
\\g
ROLLBACK;
`;
}

export async function canonicalHeaders(heights, { read = readPrimaryJson } = {}) {
  const value = await read(headerGuardSql(heights), { maxBytes: 512 * 1024 });
  assert(value?.schema === 'zecblock-private-header-guard-v1' && value.network === 'mainnet'
    && value.database === 'zcash_explorer_mainnet' && value.isPrimary === true && value.readOnly === true
    && value.genesisHash === MAINNET_GENESIS_HASH && validHeight(value.tip?.height) && HASH.test(value.tip.hash)
    && Number.isFinite(Date.parse(value.observedAt)) && Array.isArray(value.blocks) && value.blocks.length <= heights.length,
  'Canonical header source identity mismatch.');
  const wanted = new Set(heights), seen = new Set();
  for (const block of value.blocks) {
    assert(validHeight(block.height) && wanted.has(block.height) && !seen.has(block.height) && HASH.test(block.hash), 'Invalid canonical header response.');
    seen.add(block.height);
  }
  // Missing heights remain missing in the guard: all dependent publications
  // fail closed, rather than preserving an old hash after rollback/deletion.
  return value;
}

export async function archiveSourceTick({ sourceDir, localDir, maxBlocks = 128, capture = capturePrimary,
  headers = canonicalHeaders, statfsFn = statfs } = {}) {
  assert(Number.isSafeInteger(maxBlocks) && maxBlocks >= 1 && maxBlocks <= 128, 'Invalid capture block bound.');
  const request = captureRequest(await boundedJson(resolve(localDir, 'capture-request.json'), 1024));
  let collection;
  try { collection = validateCollection(await boundedJson(resolve(localDir, 'collection.json'), 8 * 1024 * 1024)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const head = await headers([]);
  let snapshot, captureState = 'waiting';
  if (request.startHeight <= head.tip.height) {
    const endHeight = Math.min(request.endHeight ?? head.tip.height, head.tip.height, request.startHeight + maxBlocks - 1);
    try {
      snapshot = await capture({ startHeight: request.startHeight, endHeight, maxBlocks, maxRecords: 2048 });
      snapshot.fingerprint = primaryFactsFingerprint(snapshot);
      snapshot.requestId = request.requestId;
      const free = await statfsFn(sourceDir);
      assert(Number(free.bavail) * Number(free.bsize) >= 1024 ** 3, 'Source disk reserve unavailable.');
      captureState = 'ready';
    } catch (error) {
      // A bad/oversized backfill job must not disable healthy older archives.
      // Canonical headers below are still re-read; no old candidate is reused.
      snapshot = undefined;
      captureState = error.code === 'CAPACITY' ? 'capacity-blocked' : 'unavailable';
    }
  }
  const wanted = new Set(collection?.coverage.blocks.map(block => block.height) ?? []);
  for (const entry of collection?.segments ?? []) wanted.add(entry.manifest.snapshot.height);
  if (collection) wanted.add(collection.snapshot.height);
  for (const block of snapshot?.blocks ?? []) wanted.add(Number(block.height));
  if (snapshot) wanted.add(snapshot.tip.height);
  const fresh = await headers([...wanted].sort((a, b) => a - b));
  const observed = new Map(fresh.blocks.map(block => [block.height, block.hash]));
  if (snapshot) {
    assert(snapshot.blocks.every(block => observed.get(Number(block.height)) === block.hash)
      && observed.get(snapshot.tip.height) === snapshot.tip.hash, 'Captured source changed during canonical guard read.');
    let unchanged = false;
    try {
      const previous = await boundedJson(resolve(sourceDir, 'latest.json'), 128 * 1024 * 1024);
      unchanged = previous.requestId === snapshot.requestId && previous.fingerprint === snapshot.fingerprint;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!unchanged) await atomicJson(resolve(sourceDir, 'latest.json'), snapshot, 0o640);
  }
  const guard = { schema: 'zecblock-private-source-guard-v1', state: 'ready', observedAt: fresh.observedAt,
    tip: fresh.tip, blocks: fresh.blocks, requestId: request.requestId,
    captureState, fingerprint: snapshot?.fingerprint ?? null,
    sourceObservedAt: snapshot?.observedAt ?? null };
  await atomicJson(resolve(sourceDir, 'guard.json'), guard, 0o640);
  return guard;
}

export async function archiveSourceStep(options) {
  try { return await archiveSourceTick(options); }
  catch {
    const guard = { schema: 'zecblock-private-source-guard-v1', state: 'unavailable',
      observedAt: new Date().toISOString(), reason: 'bounded_capture_or_canonical_guard_failed' };
    await atomicJson(resolve(options.sourceDir, 'guard.json'), guard, 0o640);
    return guard;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const sourceDir = process.env.PRIVATE_TX_SOURCE_DIR, localDir = process.env.PRIVATE_TX_COLLECTION_DIR;
  assert(sourceDir && localDir, 'Explicit archive source/control paths required.');
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
  while (!abort.signal.aborted) {
    const guard = await archiveSourceStep({ sourceDir, localDir });
    if (guard.state !== 'ready') {
      process.stderr.write('Archive source unavailable; no publication activated.\n');
    }
    try { await delay(1000, undefined, { signal: abort.signal }); } catch { break; }
  }
}
