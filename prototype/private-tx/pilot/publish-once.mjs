import { resolve } from 'node:path';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { publishRecent } from '../publish-recent.mjs';
import { prepareState } from './state-budget.mjs';

// systemd serializes this one-shot unit. Its timer cannot start overlapping
// instances, and no PID lock can survive a killed publisher and block refresh.
if (!process.env.PRIVATE_TX_LOCAL_DIR || !process.env.PRIVATE_TX_EVALUATOR) {
  throw new Error('Pilot state directory and native evaluator must be explicit.');
}
const localDir = resolve(process.env.PRIVATE_TX_LOCAL_DIR);
try {
  await prepareState(localDir);
  await publishRecent({ localDir, binary: resolve(process.env.PRIVATE_TX_EVALUATOR) });
  process.stdout.write('Bounded read-only PIR publication completed.\n');
} catch {
  const path = resolve(localDir, 'publisher-status.json');
  let previous = {};
  try { previous = JSON.parse(await readFile(path, 'utf8')); } catch { /* first run */ }
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ state: 'unavailable', lastSuccessAt: previous.lastSuccessAt ?? null, observedAt: new Date().toISOString(), message: 'Bounded pilot refresh failed; the previous snapshot remains available.' })}\n`);
  await rename(temporary, path);
  process.stderr.write('Bounded PIR publication unavailable; previous snapshot retained.\n');
  process.exitCode = 1;
}
