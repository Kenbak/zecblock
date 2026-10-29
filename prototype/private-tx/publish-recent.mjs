import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, open, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { exportRecent, saveSource } from './export-recent.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCAL = resolve(HERE, '.local');

export async function publishRecent({ source, localDir = LOCAL, binary = resolve(HERE, '../pir-browser/target/release/zecblock-pir-fixture') } = {}) {
  await mkdir(localDir, { recursive: true });
  const statusPath = resolve(localDir, 'publisher-status.json');
  let previous = {};
  try { previous = JSON.parse(await readFile(statusPath, 'utf8')); } catch { /* first publication */ }
  const status = async fields => {
    const tmp = `${statusPath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ ...fields, observedAt: new Date().toISOString() })}\n`);
    await rename(tmp, statusPath);
  };
  const publications = resolve(localDir, 'publications');
  await mkdir(publications, { recursive: true });
  const staging = await mkdtemp(resolve(publications, '.candidate-'));
  try {
    await status({ state: 'preparing', lastSuccessAt: previous.lastSuccessAt ?? null });
    source ??= await exportRecent({ blockCount: Number(process.env.PRIVATE_TX_BLOCKS ?? 4), tipDepth: Number(process.env.PRIVATE_TX_DEPTH ?? 2) });
    const sourcePath = resolve(staging, 'source.json');
    await saveSource(source, sourcePath);
    await new Promise((resolveExit, reject) => {
      const child = spawn(binary, ['prepare-full', sourcePath, staging], { stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.resume();
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolveExit() : reject(new Error('Local full-record preparation failed; previous publication retained.')));
    });
    const manifest = JSON.parse(await readFile(resolve(staging, 'manifest.json'), 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(manifest.publicationId)) throw new Error('Invalid local publication identity.');
    if (!Number.isSafeInteger(manifest.chunkCount) || manifest.chunkCount < 1 || manifest.chunkCount > 64) throw new Error('Publication exceeds the browser fixed-batch budget; previous snapshot retained.');
    const destination = resolve(publications, manifest.publicationId);
    try { await rename(staging, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !(await readFile(resolve(destination, 'manifest.json'))).equals(await readFile(resolve(staging, 'manifest.json')))) throw error;
    }
    const pointer = resolve(localDir, 'current.json');
    const temporary = `${pointer}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ publicationId: manifest.publicationId, directory: manifest.publicationId })}\n`);
    await rename(temporary, pointer);
    await status({ state: 'ready', publicationId: manifest.publicationId, lastSuccessAt: source.snapshot.publishedAt });
    // Bound local disk growth. Query processes have already loaded their own
    // immutable tables; the server independently retains three generations.
    const generations = [];
    for (const name of await readdir(publications)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const item = JSON.parse(await readFile(resolve(publications, name, 'manifest.json'), 'utf8'));
      generations.push({ name, publishedAt: item.snapshot.publishedAt });
    }
    generations.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    const keep = new Set([manifest.publicationId, ...generations.filter(g => g.name !== manifest.publicationId).slice(0, 3).map(g => g.name)]);
    for (const item of generations) if (!keep.has(item.name)) await rm(resolve(publications, item.name), { recursive: true });
    return { publicationId: manifest.publicationId, records: source.records.length, snapshot: source.snapshot, coverage: source.coverage, chunkCount: manifest.chunkCount };
  } catch (error) {
    await status({ state: 'unavailable', lastSuccessAt: previous.lastSuccessAt ?? null, message: 'Read-only refresh or preparation failed; the previous local snapshot remains available.' });
    throw error;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const interval = process.argv.includes('--watch') ? Number(process.env.PRIVATE_TX_REFRESH_SECONDS ?? 180) : 0;
  if (interval && (!Number.isInteger(interval) || interval < 120 || interval > 3600)) throw new Error('Local refresh interval must be 120–3600 seconds.');
  await mkdir(LOCAL, { recursive: true });
  const lockPath = resolve(LOCAL, 'publisher.lock');
  const lock = await open(lockPath, 'wx');
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
  try {
    do {
      try {
        const result = await publishRecent();
        console.log(JSON.stringify({ readOnlySource: true, localPublication: true, ...result }));
      } catch (error) {
        console.error(`Local publication failed: ${error.message}`);
        if (!interval) throw error;
      }
      if (!interval || abort.signal.aborted) break;
      try { await delay(interval * 1000, undefined, { signal: abort.signal }); } catch { break; }
    } while (!abort.signal.aborted);
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
