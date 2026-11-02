import { rename, open, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readStateJson } from '../state-files.mjs';

export async function atomicJson(path, value, mode = 0o600) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', mode);
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`);
      await file.chmod(mode); // Group-readable controls also work under UMask0077.
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

export function verifyGuard(guard, manifest, { now = Date.now(), maxAgeMs = 10_000, notBefore = 0 } = {}) {
  if (guard?.schema !== 'zecblock-private-source-guard-v1' || guard.state !== 'ready'
      || !Number.isFinite(Date.parse(guard.observedAt)) || Date.parse(guard.observedAt) < notBefore
      || now - Date.parse(guard.observedAt) > maxAgeMs || Date.parse(guard.observedAt) > now + 1000
      || !Array.isArray(guard.blocks) || !Array.isArray(manifest?.coverage?.blocks)) {
    throw new Error('Primary canonical guard is unavailable or stale.');
  }
  const canonical = new Map(guard.blocks.map(block => [Number(block.height), block.hash]));
  if (canonical.size !== guard.blocks.length || guard.blocks.some(block => !Number.isSafeInteger(Number(block.height))
    || Number(block.height) < 0 || !/^[a-f0-9]{64}$/.test(block.hash))) throw new Error('Invalid canonical guard entries.');
  for (const block of manifest.coverage.blocks) {
    if (canonical.get(Number(block.height)) !== block.hash) throw new Error('Primary canonical membership changed; publication retired.');
  }
  if (!manifest.coverage.blocks.length) throw new Error('Publication has no canonical range.');
  if (manifest.snapshot && canonical.get(Number(manifest.snapshot.height)) !== manifest.snapshot.hash) {
    throw new Error('Publication snapshot anchor changed; publication retired.');
  }
  return guard;
}

export async function freshGuard(sourceDir, manifest, { notBefore = 0, waitMs = 0 } = {}) {
  const deadline = Date.now() + waitMs;
  do {
    try {
      const guard = await readStateJson(resolve(sourceDir, 'guard.json'), 512 * 1024);
      return verifyGuard(guard, manifest, { notBefore });
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(100);
    }
  } while (true);
}
