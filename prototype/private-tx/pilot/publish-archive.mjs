import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectionManifest, validateCollection, canonicalJson, MAX_SEGMENTS, MAX_COLLECTION_CHUNKS, MAX_COLLECTION_BYTES } from '../collection.mjs';
import { stateBytes } from './state-budget.mjs';

const GiB = 1024 ** 3;
const MAX_FILE = 128 * 1024 ** 2;
const HASH = /^[a-f0-9]{64}$/;
const FILES = ['database.bin', 'public.bin', 'manifest.json'];
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function ordinaryDirectory(path, create = false, mode = 0o700) {
  if (create) await mkdir(path, { recursive: true, mode });
  const info = await lstat(path);
  assert(info.isDirectory() && !info.isSymbolicLink(), 'Archive state requires ordinary directories.');
}

async function boundedFile(path, maximum = MAX_FILE) {
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink() && info.size <= maximum, 'Unsafe or oversized archive file.');
  const bytes = await readFile(path);
  assert(bytes.length <= maximum, 'Archive file grew beyond its bound.');
  return bytes;
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function durableFile(path, bytes, mode = 0o600) {
  assert(bytes.length <= MAX_FILE, 'Archive file byte budget exceeded.');
  const handle = await open(path, 'wx', mode);
  try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
}

async function atomicHead(localDir, bytes) {
  const temporary = resolve(localDir, `.collection-head-${randomUUID()}`);
  let moved = false;
  try {
    await durableFile(temporary, bytes, 0o640);
    await rename(temporary, resolve(localDir, 'collection.json'));
    moved = true;
    await syncDirectory(localDir);
  } catch (error) {
    // A directory fsync failure after rename is an uncertain durability result,
    // not proof that the prior head survived. Callers must inspect the head.
    error.activationMayHaveOccurred = moved;
    throw error;
  } finally { await rm(temporary, { force: true }); }
}

async function command(binary, args, { capture = false, timeoutMs = 60_000, signal, extraFd } = {}) {
  return await new Promise((resolveExit, reject) => {
    const child = spawn(binary, args, {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', RAYON_NUM_THREADS: '2', UV_THREADPOOL_SIZE: '2' },
      stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore', ...(extraFd === undefined ? [] : [extraFd])],
      signal,
    });
    const chunks = []; let bytes = 0, overflow = false, failure;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    if (capture) child.stdout.on('data', part => {
      bytes += part.length;
      if (bytes > 64 * 1024) { overflow = true; child.kill('SIGKILL'); }
      else chunks.push(part);
    });
    // Abort/error can precede actual exit. Keep the writer lock and kill
    // deadline until close, so the next job cannot overlap a dying native job.
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0 || overflow) reject(new Error('Bounded archive helper failed or is already locked.'));
      else resolveExit(Buffer.concat(chunks));
    });
  });
}

// Linux flock locks the inherited open-file description. The parent keeps it
// open after the short utility exits; process death releases it without PID files.
export async function withWriterLock(localDir, operation, { flock = '/usr/bin/flock' } = {}) {
  const handle = await open(resolve(localDir, 'collection-writer.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const info = await handle.stat();
    assert(info.isFile(), 'Archive writer lock must be an ordinary file.');
    await command(flock, ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'], { extraFd: handle.fd, timeoutMs: 3000 });
    return await operation();
  } finally { await handle.close(); }
}

export async function planFullSource(source, directory, { binary, signal } = {}) {
  const path = resolve(directory, `plan-${randomUUID()}.json`);
  const bytes = Buffer.from(JSON.stringify(source));
  assert(bytes.length <= MAX_FILE, 'Archive source byte budget exceeded.');
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    const stdout = await command(binary, ['plan-full', path], { capture: true, timeoutMs: 30_000, signal });
    return JSON.parse(stdout.toString('utf8'));
  } finally { await rm(path, { force: true }); }
}

export async function prepareFullSource(source, directory, { binary, signal } = {}) {
  await durableFile(resolve(directory, 'source.json'), Buffer.from(JSON.stringify(source)));
  await command(binary, ['prepare-full', resolve(directory, 'source.json'), directory], { timeoutMs: 90_000, signal });
  return JSON.parse((await boundedFile(resolve(directory, 'manifest.json'), MAX_COLLECTION_BYTES)).toString('utf8'));
}

function checkedPlan(plan, source) {
  assert(plan?.schema === 'zecblock-private-tx-plan-v1' && plan.recordCodec === 'json-context-zlib-v1'
    && plan.packing === 'compact-v1' && plan.rows === 2048 && plan.rowBytes === 8192 && plan.payloadBytes === 8064
    && plan.coverRows === 1 && plan.records === source.records.length && typeof plan.fits === 'boolean', 'Incompatible native archive plan.');
  for (const field of ['payloadRows', 'totalRows', 'chunkCount']) assert(Number.isSafeInteger(plan[field]) && plan[field] > 0, 'Invalid native archive plan geometry.');
  assert(Number.isSafeInteger(plan.legacyRecordBytesTotal) && plan.legacyRecordBytesTotal > 0
    && plan.totalRows === plan.payloadRows + 1
    && plan.fits === (plan.totalRows <= 2048 && plan.chunkCount <= 64 && plan.legacyRecordBytesTotal <= 64 * 1024 ** 2),
  'Inconsistent native archive capacity plan.');
  return plan;
}

function checkedSource(source) {
  assert(source?.schema === 'zecblock-private-tx-source-v1' && source.network === 'mainnet'
    && source.coverage?.complete === true && Array.isArray(source.coverage.blocks) && source.coverage.blocks.length > 0
    && Array.isArray(source.records) && source.records.length > 0 && source.records.length <= 2048, 'Complete bounded archive source required.');
  const { startHeight, endHeight, blocks } = source.coverage;
  assert(Number.isSafeInteger(startHeight) && startHeight >= 0 && Number.isSafeInteger(endHeight)
    && blocks.length === endHeight - startHeight + 1, 'Incomplete archive source block range.');
  const counts = new Map(), ids = new Set();
  for (const record of source.records) {
    assert(HASH.test(record.txid) && !ids.has(record.txid), 'Duplicate or invalid archive source transaction.');
    ids.add(record.txid);
    const height = Number(record.detail?.blockHeight);
    assert(Number.isSafeInteger(height) && height >= startHeight && height <= endHeight, 'Archive source transaction outside coverage.');
    counts.set(height, (counts.get(height) ?? 0) + 1);
  }
  blocks.forEach((block, index) => assert(block.height === startHeight + index && HASH.test(block.hash)
    && Number.isSafeInteger(block.transactionCount) && block.transactionCount > 0
    && counts.get(block.height) === block.transactionCount, 'Archive source omits part of a block.'));
  return source;
}

function subset(source, blocks) {
  const startHeight = blocks[0].height, endHeight = blocks.at(-1).height;
  const records = source.records.filter(record => Number(record.detail.blockHeight) >= startHeight && Number(record.detail.blockHeight) <= endHeight);
  return { ...source, coverage: { ...source.coverage, startHeight, endHeight, blocks, transactionCount: records.length }, records };
}

// Select fitting complete-block prefixes. Every chosen prefix is independently
// planned; capacity is never inferred from JSON size or by omitting large records.
export async function partitionSource(source, { planSource, maxSegments = MAX_SEGMENTS } = {}) {
  checkedSource(source);
  const result = [];
  let remaining = source.coverage.blocks;
  while (remaining.length) {
    assert(result.length < maxSegments, 'Archive segment capacity exceeded.');
    let low = 1, high = remaining.length, chosen;
    while (low <= high) {
      const size = Math.floor((low + high) / 2);
      const candidate = subset(source, remaining.slice(0, size));
      const plan = checkedPlan(await planSource(candidate), candidate);
      if (plan.fits) { chosen = { source: candidate, plan }; low = size + 1; }
      else high = size - 1;
    }
    assert(chosen, 'A complete source block exceeds archive capacity; coverage is unavailable.');
    result.push(chosen);
    remaining = remaining.slice(chosen.source.coverage.blocks.length);
  }
  return result;
}

async function loadHead(localDir) {
  try { return validateCollection(JSON.parse((await boundedFile(resolve(localDir, 'collection.json'), MAX_COLLECTION_BYTES)).toString('utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function verifySegment(directory, manifest) {
  await ordinaryDirectory(directory);
  const names = await readdir(directory);
  assert(FILES.every(name => names.includes(name)) && names.every(name => FILES.includes(name) || ['source.json', 'expected.json'].includes(name)), 'Archive segment file inventory mismatch.');
  for (const name of names) {
    const bytes = await boundedFile(resolve(directory, name), name === 'manifest.json' ? MAX_COLLECTION_BYTES : MAX_FILE);
    if (name === 'manifest.json') assert(canonicalJson(JSON.parse(bytes.toString('utf8'))) === canonicalJson(manifest), 'Archive manifest drift.');
    if (name === 'database.bin') assert(bytes.length === 2048 * 8192 && sha(bytes) === manifest.databaseSha256, 'Archive database checksum mismatch.');
    if (name === 'public.bin') assert(bytes.length === 45056 && sha(bytes) === manifest.publicSha256, 'Archive setup checksum mismatch.');
  }
  for (const name of names) {
    const handle = await open(resolve(directory, name), 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  await syncDirectory(directory);
}

function preparedMatchesPlan(manifest, source, plan) {
  const catalogue = manifest.catalogue;
  assert(manifest.chunkCount === plan.chunkCount && catalogue?.length === plan.records
    && manifest.recordCodec === plan.recordCodec && canonicalJson(manifest.coverage) === canonicalJson(source.coverage)
    && canonicalJson(manifest.snapshot) === canonicalJson(source.snapshot), 'Prepared segment differs from its native plan/source.');
  const sourceIds = new Map(source.records.map(record => [record.txid, Number(record.detail.blockHeight)]));
  const rows = new Set();
  let maximum = 0;
  for (const entry of catalogue) {
    assert(sourceIds.get(entry.txid) === entry.height && HASH.test(entry.recordSha256)
      && Number.isSafeInteger(entry.recordBytes) && entry.recordBytes > 0 && Array.isArray(entry.rows)
      && entry.rows.length === Math.ceil(entry.recordBytes / 8064), 'Prepared segment record allocation differs from native plan/source.');
    sourceIds.delete(entry.txid);
    for (const row of entry.rows) {
      assert(Number.isSafeInteger(row) && row >= 0 && row < 2047 && !rows.has(row), 'Invalid prepared archive row allocation.');
      rows.add(row);
    }
    maximum = Math.max(maximum, entry.rows.length);
  }
  assert(rows.size === plan.payloadRows && maximum === plan.chunkCount && sourceIds.size === 0,
    'Prepared segment row count differs from its native plan/source.');
}

async function budget(localDir, budgetBytes, reserveBytes) {
  const used = await stateBytes(localDir);
  const disk = await statfs(localDir);
  assert(used + reserveBytes <= budgetBytes && Number(disk.bavail) * Number(disk.bsize) >= reserveBytes, 'Archive disk budget or reserve exceeded.');
}

async function cleanOwnedStaging(localDir) {
  for (const name of await readdir(localDir)) {
    if (!/^\.archive-staging-[a-zA-Z0-9]{6}$/.test(name)) continue;
    const directory = resolve(localDir, name);
    await ordinaryDirectory(directory);
    let owner;
    try { owner = JSON.parse((await boundedFile(resolve(directory, 'owner.json'), 1024)).toString('utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (canonicalJson(owner) !== canonicalJson({ schema: 'zecblock-private-archive-staging-v1', root: resolve(localDir) })) continue;
    // The same kernel writer lock covers every marked staging root. No live
    // archive preparation can own one when a later lock holder reaches here.
    await rm(directory, { recursive: true });
  }
}

async function collectGarbage(localDir, current, previous, additionallyPinned = []) {
  const directory = resolve(localDir, 'collections');
  const heads = [];
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const path = resolve(directory, name);
    const item = validateCollection(JSON.parse((await boundedFile(path, MAX_COLLECTION_BYTES)).toString('utf8')));
    assert(name === `${item.collectionId}.json`, 'Archive history identity mismatch.');
    heads.push({ item, modified: (await lstat(path)).mtimeMs });
  }
  heads.sort((a, b) => b.modified - a.modified);
  const kept = new Set([...(current ? [current.collectionId] : []), ...(previous ? [previous.collectionId] : [])]);
  for (const { item } of heads) if (kept.size < 3) kept.add(item.collectionId);
  const references = new Set(heads.filter(({ item }) => kept.has(item.collectionId)).flatMap(({ item }) => item.segments.map(segment => segment.publicationId)));
  for (const segment of current?.segments ?? []) references.add(segment.publicationId);
  for (const segment of previous?.segments ?? []) references.add(segment.publicationId);
  for (const segment of additionallyPinned) references.add(segment.publicationId);
  for (const name of await readdir(resolve(localDir, 'segments'))) {
    if (!HASH.test(name) || references.has(name)) continue;
    const path = resolve(localDir, 'segments', name);
    await ordinaryDirectory(path);
    await rm(path, { recursive: true });
  }
  for (const { item } of heads) if (!kept.has(item.collectionId)) await rm(resolve(directory, `${item.collectionId}.json`));
  await syncDirectory(resolve(localDir, 'segments'));
  await syncDirectory(directory);
}

export async function publishCollection({ localDir, binary, sources = [], retainedSegments, retirePublicationIds = [], beforeActivate,
  planSource, prepareSource, withLock = withWriterLock, signal, budgetBytes = 5 * GiB, reserveBytes = GiB } = {}) {
  assert(typeof beforeActivate === 'function' && typeof localDir === 'string', 'Explicit archive state and canonical admission callback required.');
  assert(Number.isSafeInteger(budgetBytes) && Number.isSafeInteger(reserveBytes) && reserveBytes > 0
    && budgetBytes >= reserveBytes, 'Explicit positive archive disk bounds required.');
  await ordinaryDirectory(localDir, true, 0o750);
  return await withLock(localDir, async () => {
    signal?.throwIfAborted();
    await ordinaryDirectory(resolve(localDir, 'segments'), true);
    await ordinaryDirectory(resolve(localDir, 'collections'), true);
    await cleanOwnedStaging(localDir);
    const previous = await loadHead(localDir);
    const retained = retainedSegments ?? previous?.segments ?? [];
    assert(Array.isArray(retained) && Array.isArray(sources) && sources.length <= MAX_SEGMENTS, 'Invalid archive inputs.');
    assert(Array.isArray(retirePublicationIds) && new Set(retirePublicationIds).size === retirePublicationIds.length
      && retirePublicationIds.every(id => previous?.segments.some(segment => segment.publicationId === id)), 'Invalid explicit canonical retirement.');
    assert(sources.reduce((total, source) => total + Buffer.byteLength(JSON.stringify(source)), 0) <= MAX_FILE, 'Aggregate source byte budget exceeded.');
    await collectGarbage(localDir, previous, null, retained);
    await budget(localDir, budgetBytes, reserveBytes);
    const staging = await mkdtemp(resolve(localDir, '.archive-staging-'));
    let result;
    try {
      await durableFile(resolve(staging, 'owner.json'), Buffer.from(JSON.stringify({ schema: 'zecblock-private-archive-staging-v1', root: resolve(localDir) })));
      await syncDirectory(staging);
      await syncDirectory(localDir);
      const planner = planSource ?? ((source, directory) => planFullSource(source, directory, { binary, signal }));
      const prepare = prepareSource ?? ((source, directory) => prepareFullSource(source, directory, { binary, signal }));
      const planned = [];
      for (const source of sources) planned.push(...await partitionSource(source, {
        planSource: candidate => planner(candidate, staging), maxSegments: MAX_SEGMENTS - retained.length - planned.length,
      }));
      assert(retained.length + planned.length > 0 && retained.length + planned.length <= MAX_SEGMENTS, 'Archive segment capacity exceeded.');
      assert(retained.reduce((sum, segment) => sum + segment.manifest.chunkCount, 0)
        + planned.reduce((sum, item) => sum + item.plan.chunkCount, 0) <= MAX_COLLECTION_CHUNKS, 'Collection fixed-query budget exceeded.');
      const segments = [...retained];
      for (const item of planned) {
        signal?.throwIfAborted();
        await budget(localDir, budgetBytes, reserveBytes);
        const candidate = await mkdtemp(resolve(staging, 'segment-'));
        const manifest = await prepare(item.source, candidate);
        preparedMatchesPlan(manifest, item.source, item.plan);
        collectionManifest({ segments: [{ publicationId: manifest.publicationId, manifest }] });
        await verifySegment(candidate, manifest);
        // Input DTOs and plaintext test oracles duplicate the complete encoded
        // table. They are useful only during preparation/verification. Runtime
        // reads the immutable table, setup and manifest; resumption is from the
        // committed head and the authoritative read-only source, not this DTO.
        await rm(resolve(candidate, 'source.json'), { force: true });
        await rm(resolve(candidate, 'expected.json'), { force: true });
        await syncDirectory(candidate);
        const destination = resolve(localDir, 'segments', manifest.publicationId);
        try { await rename(candidate, destination); }
        catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
          await verifySegment(destination, manifest);
        }
        await syncDirectory(resolve(localDir, 'segments'));
        segments.push({ publicationId: manifest.publicationId, manifest });
      }
      const collection = collectionManifest({ segments });
      const nextIds = new Set(collection.segments.flatMap(segment => segment.manifest.catalogue.map(entry => entry.txid)));
      for (const segment of previous?.segments ?? []) {
        if (retirePublicationIds.includes(segment.publicationId)) continue;
        assert(segment.manifest.catalogue.every(entry => nextIds.has(entry.txid)), 'Archive activation would silently drop previously published transactions.');
      }
      for (const segment of collection.segments) await verifySegment(resolve(localDir, 'segments', segment.publicationId), segment.manifest);
      await budget(localDir, budgetBytes, reserveBytes);
      await beforeActivate(collection, { previous });
      signal?.throwIfAborted();
      const bytes = Buffer.from(`${canonicalJson(collection)}\n`);
      for (const item of [previous, collection].filter(Boolean)) {
        const history = resolve(localDir, 'collections', `${item.collectionId}.json`);
        try { await durableFile(history, Buffer.from(`${canonicalJson(item)}\n`)); }
        catch (error) {
          if (error.code !== 'EEXIST' || canonicalJson(validateCollection(JSON.parse((await boundedFile(history, MAX_COLLECTION_BYTES)).toString('utf8')))) !== canonicalJson(item)) throw error;
        }
      }
      await syncDirectory(resolve(localDir, 'collections'));
      await atomicHead(localDir, bytes);
      result = { collection, collectionId: collection.collectionId, previousCollectionId: previous?.collectionId ?? null, cleanupWarning: false };
      try { await collectGarbage(localDir, collection, previous); } catch { result.cleanupWarning = true; }
      return result;
    } finally {
      // A cleanup failure must not turn a committed head into a reported failed
      // activation. Leftover staging remains inside the measured disk budget.
      try { await rm(staging, { recursive: true, force: true }); } catch { if (result) result.cleanupWarning = true; }
    }
  });
}
