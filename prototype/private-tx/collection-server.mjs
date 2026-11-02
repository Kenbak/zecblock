import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { nativeEvaluator } from './server.mjs';
import { validateCollection, canonicalJson, MAX_COLLECTION_BYTES, MAX_COLLECTION_CHUNKS } from './collection.mjs';
import { freshGuard, verifyGuard } from './pilot/source-guard.mjs';
import { readStateBytes } from './state-files.mjs';

// A catalogue may retain many immutable tables on disk without retaining a
// heavy native evaluator for each table in memory. This queue runs one native
// process at a time; its admission count includes the currently running job.
export function evaluatorPool({ binary, createEvaluator = nativeEvaluator, maximum = MAX_COLLECTION_CHUNKS } = {}) {
  const queue = [];
  let current = null, currentId = null, running = false, closed = false, admitted = 0;
  async function retire() {
    const previous = current;
    current = null; currentId = null;
    if (previous) await previous.close();
  }
  async function drain() {
    if (running || closed) return;
    running = true;
    try {
      while (queue.length && !closed) {
        // FIFO prevents sustained requests to one public table from starving
        // another table. Arrival order never depends on decrypted contents.
        const job = queue.shift();
        try {
          if (currentId !== job.publicationId) {
            await retire();
            current = createEvaluator(binary, job.directory);
            currentId = job.publicationId;
          }
          job.resolve(await current.evaluate(job.query));
        } catch {
          try { await retire(); }
          catch {
            // An uncertain native shutdown must never start another heavy
            // process. Reject queued work rather than leaving promises hung.
            closed = true;
            for (const pending of queue.splice(0)) { admitted--; pending.reject(new Error('Private evaluator unavailable.')); }
          }
          job.reject(new Error('Private evaluator unavailable.'));
        } finally { admitted--; }
      }
    } finally { running = false; }
  }
  return {
    evaluate(publicationId, directory, query) {
      if (closed || admitted >= maximum) return Promise.reject(new Error('Private evaluator queue full or unavailable.'));
      admitted++;
      const promise = new Promise((resolveJob, reject) => queue.push({ publicationId, directory, query, resolve: resolveJob, reject }));
      void drain();
      return promise;
    },
    async close() {
      closed = true;
      for (const job of queue.splice(0)) { admitted--; job.reject(new Error('Private evaluator unavailable.')); }
      await retire();
    },
  };
}

export function collectionPublications({ localDir, binary, sourceDir, createEvaluator = nativeEvaluator, verifyCanonical } = {}) {
  const heads = new Map(), segments = new Map();
  const pool = evaluatorPool({ binary, createEvaluator });
  let loading = null;
  async function usable(publication) {
    if (verifyCanonical) await verifyCanonical(publication.manifest);
    else if (sourceDir) {
      const guard = await freshGuard(sourceDir, publication.manifest);
      for (const segment of publication.manifest.segments ?? []) verifyGuard(guard, segment.manifest);
    }
  }
  async function refresh() {
    const bytes = await readStateBytes(resolve(localDir, 'collection.json'), MAX_COLLECTION_BYTES);
    if (bytes.length > MAX_COLLECTION_BYTES) throw new Error('Collection metadata budget exceeded.');
    const manifest = validateCollection(JSON.parse(bytes.toString('utf8')));
    const existing = heads.get(manifest.collectionId);
    if (existing) return existing;
    const additions = [];
    for (const entry of manifest.segments) {
      if (segments.has(entry.publicationId)) {
        if (canonicalJson(segments.get(entry.publicationId).manifest) !== canonicalJson(entry.manifest)) {
          throw new Error('Cached immutable segment manifest changed.');
        }
        continue;
      }
      const directory = resolve(localDir, 'segments', entry.publicationId);
      const [onDisk, publicBytes] = await Promise.all([
        readFile(resolve(directory, 'manifest.json')), readFile(resolve(directory, 'public.bin')),
      ]);
      // The immutable catalogue commits the complete per-table manifest. A
      // pointer cannot substitute different files under the same identifier.
      const diskManifest = JSON.parse(onDisk.toString('utf8'));
      if (JSON.stringify(diskManifest) !== JSON.stringify(entry.manifest)) {
        // Formatting/key order are immaterial, unlike values.
        if (canonicalJson(diskManifest) !== canonicalJson(entry.manifest)) throw new Error('Immutable segment manifest mismatch.');
      }
      if (publicBytes.length !== entry.manifest.scheme.public_bytes
        || createHash('sha256').update(publicBytes).digest('hex') !== entry.manifest.publicSha256) throw new Error('Invalid segment setup commitment.');
      additions.push([entry.publicationId, { manifest: entry.manifest, manifestBytes: onDisk, publicBytes, directory,
        evaluator: { evaluate: query => pool.evaluate(entry.publicationId, directory, query) } }]);
    }
    for (const [id, publication] of additions) segments.set(id, publication);
    const head = { manifest, manifestBytes: bytes };
    heads.set(manifest.collectionId, head);
    while (heads.size > 3) heads.delete(heads.keys().next().value);
    const referenced = new Set([...heads.values()].flatMap(item => item.manifest.segments.map(segment => segment.publicationId)));
    for (const id of segments.keys()) if (!referenced.has(id)) segments.delete(id);
    return head;
  }
  return {
    async current() {
      loading ??= refresh().finally(() => { loading = null; });
      const value = await loading;
      await usable(value);
      return value;
    },
    get(id) { return segments.get(id); },
    async assertUsable(publication) { await usable(publication); },
    async status() {
      try { return JSON.parse(await readFile(resolve(localDir, 'publisher-status.json'), 'utf8')); }
      catch { return { state: 'unknown' }; }
    },
    async close() { heads.clear(); segments.clear(); await pool.close(); },
  };
}
