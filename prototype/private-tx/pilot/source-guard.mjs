import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function atomicJson(path, value, mode = 0o600) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode });
  await rename(temporary, path);
}

export function verifyGuard(guard, manifest, { now = Date.now(), maxAgeMs = 10_000, notBefore = 0 } = {}) {
  if (guard?.schema !== 'zecblock-private-source-guard-v1' || guard.state !== 'ready'
      || !Number.isFinite(Date.parse(guard.observedAt)) || Date.parse(guard.observedAt) < notBefore
      || now - Date.parse(guard.observedAt) > maxAgeMs || Date.parse(guard.observedAt) > now + 1000
      || !Array.isArray(guard.blocks) || !Array.isArray(manifest?.coverage?.blocks)) {
    throw new Error('Primary canonical guard is unavailable or stale.');
  }
  const canonical = new Map(guard.blocks.map(block => [Number(block.height), block.hash]));
  for (const block of manifest.coverage.blocks) {
    if (canonical.get(Number(block.height)) !== block.hash) throw new Error('Primary canonical membership changed; publication retired.');
  }
  if (!manifest.coverage.blocks.length) throw new Error('Publication has no canonical range.');
  return guard;
}

export async function freshGuard(sourceDir, manifest, { notBefore = 0, waitMs = 0 } = {}) {
  const deadline = Date.now() + waitMs;
  do {
    try {
      const guard = JSON.parse(await readFile(resolve(sourceDir, 'guard.json'), 'utf8'));
      return verifyGuard(guard, manifest, { notBefore });
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(100);
    }
  } while (true);
}
