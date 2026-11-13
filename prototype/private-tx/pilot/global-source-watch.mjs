import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readStateBytes, readStateJson } from '../state-files.mjs';
import { canonicalHeaders } from './archive-source.mjs';
import { atomicJson } from './source-guard.mjs';
import { admitGlobalManifest } from '../global-server.mjs';
import { createHash } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/;
export async function globalGuardTick({ globalDir, guardFile, headers = canonicalHeaders }) {
  let publicationId = null;
  try {
    const manifest = admitGlobalManifest(await readStateJson(resolve(globalDir, 'manifest.json'), 2 * 1024 * 1024));
    const anchorBytes = await readStateBytes(resolve(globalDir, 'anchors.json'), 256 * 1024);
    const anchors = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(anchorBytes));
    if (!Array.isArray(anchors) || anchors.length !== manifest.sourceSummary.canonicalAnchorCount
      || createHash('sha256').update(anchorBytes).digest('hex') !== manifest.sourceSummary.canonicalAnchorsSha256) throw new Error('Invalid bound anchors.');
    publicationId = manifest.publicationId;
    const expected = new Map();
    for (const anchor of anchors) {
      if (!Number.isSafeInteger(anchor.height) || anchor.height < 0 || !HASH.test(anchor.hash) || expected.has(anchor.height)) throw new Error('Invalid anchor.');
      expected.set(anchor.height, anchor.hash);
    }
    const fresh = await headers([...expected.keys()]);
    if (fresh.blocks.length !== expected.size || new Set(fresh.blocks.map(block => block.height)).size !== expected.size
      || fresh.blocks.some(block => expected.get(block.height) !== block.hash)) throw new Error('Canonical observation changed.');
    const guard = { schema: 'zecblock-global-source-guard-v1', publicationId, state: 'ready', observedAt: fresh.observedAt, tip: fresh.tip,
      canonicalAnchorsSha256: manifest.sourceSummary.canonicalAnchorsSha256, canonicalAnchorCount: anchors.length };
    await atomicJson(guardFile, guard, 0o640); return guard;
  } catch {
    const guard = { schema: 'zecblock-global-source-guard-v1', publicationId, state: 'unavailable', observedAt: new Date().toISOString() };
    await atomicJson(guardFile, guard, 0o640); return guard;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const globalDir = process.env.PRIVATE_TX_GLOBAL_DIR, guardFile = process.env.PRIVATE_TX_GLOBAL_GUARD;
  if (!globalDir || !guardFile) throw new Error('Explicit global data/guard paths required.');
  const abort = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => abort.abort());
  while (!abort.signal.aborted) {
    await globalGuardTick({ globalDir, guardFile });
    try { await delay(2000, undefined, { signal: abort.signal }); } catch { break; }
  }
}
