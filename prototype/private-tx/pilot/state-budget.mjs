import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const GiB = 1024 ** 3;

export async function stateBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Pilot state must contain no symbolic links.');
    bytes += Math.max(info.size, (info.blocks ?? 0) * 512);
    if (info.isDirectory()) bytes += await stateBytes(path);
  }
  return bytes;
}

// Only use with the serialized one-shot publisher. No live candidate exists
// when the next unit invocation starts after a kill/timeout or previous exit.
export async function prepareState(directory, { budgetBytes = 5 * GiB, reserveBytes = GiB } = {}) {
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Pilot state must contain no symbolic links.');
  const publications = resolve(directory, 'publications');
  await mkdir(publications, { recursive: true });
  if ((await lstat(publications)).isSymbolicLink()) throw new Error('Pilot state must contain no symbolic links.');
  for (const entry of await readdir(publications, { withFileTypes: true })) {
    if (/^\.candidate-[a-zA-Z0-9]{6}$/.test(entry.name) && entry.isDirectory()) {
      await rm(resolve(publications, entry.name), { recursive: true });
    }
  }
  const used = await stateBytes(directory);
  if (used + reserveBytes > budgetBytes) throw new Error('Pilot working-data disk budget exceeded.');
  return used;
}
