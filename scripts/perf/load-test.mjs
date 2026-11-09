#!/usr/bin/env node
/**
 * Staged read-load test for the explorer API.
 *
 * Runs a weighted mix of real explorer reads at increasing concurrency, records
 * latency percentiles, status codes and application cache states per stage and
 * per endpoint, and writes a JSON artifact (artifacts/perf/ is git-ignored).
 *
 * Capacity tests belong on an isolated instance. Production hosts are refused
 * unless --allow-production is passed; keyless production runs are then capped
 * at PRODUCTION_KEYLESS_MAX_RPS so they stay far below the 600/min per-IP limit.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_SCENARIO,
  createPicker,
  createRandom,
  guardTarget,
  parseStages,
  resolvePath,
  shouldAbort,
  stagesTable,
  summarize,
  summarizeByEndpoint,
} from './load-test-lib.mjs';

const USAGE = `Usage: npm run perf:load -- --base-url=http://127.0.0.1:3001 [options]

  --stages=1:30,4:30,8:30,16:30   concurrency:seconds per stage (default shown)
  --max-rps=N                     global request-rate cap (default: none; production keyless: 6)
  --timeout-ms=10000              per-request timeout
  --history-blocks=50000          historic block heights are drawn from [tip-N, tip]
  --abort-failed-pct=5            skip remaining stages after a stage exceeds this failure %
  --seed=1                        PRNG seed for a reproducible request sequence
  --label=NAME                    free-form label stored in the artifact
  --output=artifacts/perf/load-<timestamp>.json
  --allow-production              required for api.zecblock.com and other public hosts
  --markdown                      also print a Markdown stage table

The X-Service-Key header is read from the LOADTEST_SERVICE_KEY environment
variable when set (never from a flag, never printed or written to the artifact).
Use it only against an isolated instance whose keys you control.`;

function parseArgs(argv) {
  const options = {};
  const booleans = new Set(['allow-production', 'markdown', 'help']);
  for (const argument of argv) {
    if (!argument.startsWith('--')) throw new TypeError(`Unexpected argument: ${argument}`);
    const equals = argument.indexOf('=');
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    if (booleans.has(name)) { options[name] = true; continue; }
    if (equals === -1) throw new TypeError(`--${name} requires =value`);
    options[name] = argument.slice(equals + 1);
  }
  return options;
}

const positiveInt = (value, fallback, name) => {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`--${name} must be a positive integer`);
  return n;
};

async function fetchJson(url, headers, timeoutMs) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

/** Read the tip and a pool of real txids so every request targets existing data. */
async function loadFixture(baseUrl, headers, timeoutMs, historyBlocks) {
  const list = await fetchJson(`${baseUrl}/api/blocks?limit=10`, headers, timeoutMs);
  const tip = Number(list.blocks?.[0]?.height);
  if (!Number.isSafeInteger(tip) || tip < 1) throw new Error('Could not read the chain tip from /api/blocks');
  const txids = [];
  for (const block of list.blocks.slice(1, 6)) {
    const detail = await fetchJson(`${baseUrl}/api/block/${block.height}`, headers, timeoutMs);
    for (const tx of detail.transactions ?? []) if (typeof tx.txid === 'string') txids.push(tx.txid);
  }
  if (!txids.length) throw new Error('Could not collect any txids from recent blocks');
  return { tip, minHeight: Math.max(1, tip - historyBlocks), txids };
}

/** Simple global pacer: hands out start times no closer than 1/maxRps apart. */
function createPacer(maxRps) {
  if (!maxRps) return async () => {};
  const interval = 1000 / maxRps;
  let next = performance.now();
  return async () => {
    const now = performance.now();
    const slot = Math.max(now, next);
    next = slot + interval;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  };
}

async function timedRequest(baseUrl, entry, pathname, headers, timeoutMs) {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}${pathname}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.arrayBuffer();
    return {
      endpoint: entry.name,
      status: response.status,
      ms: performance.now() - started,
      bytes: body.byteLength,
      cache: response.headers.get('x-zecblock-cache') || response.headers.get('x-cipherscan-cache') || null,
    };
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { endpoint: entry.name, status: 0, ms: performance.now() - started, bytes: 0, cache: null, error: timeout ? 'timeout' : 'network-error' };
  }
}

async function runStage({ baseUrl, concurrency, seconds, pick, fixture, random, headers, timeoutMs, pace }) {
  const samples = [];
  const started = performance.now();
  const deadline = started + seconds * 1000;
  const worker = async () => {
    while (performance.now() < deadline) {
      await pace();
      if (performance.now() >= deadline) break;
      const entry = pick();
      samples.push(await timedRequest(baseUrl, entry, resolvePath(entry.path, fixture, random), headers, timeoutMs));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (performance.now() - started) / 1000;
  return { concurrency, seconds, elapsedSeconds: Math.round(elapsed * 100) / 100, summary: summarize(samples, elapsed), endpoints: summarizeByEndpoint(samples, elapsed) };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || !options['base-url']) { console.log(USAGE); return options.help ? 0 : 2; }

  const baseUrl = options['base-url'].replace(/\/+$/, '');
  const serviceKey = process.env.LOADTEST_SERVICE_KEY || '';
  const stages = parseStages(options.stages ?? '1:30,4:30,8:30,16:30');
  const timeoutMs = positiveInt(options['timeout-ms'], 10_000, 'timeout-ms');
  const historyBlocks = positiveInt(options['history-blocks'], 50_000, 'history-blocks');
  const abortFailedPct = Number(options['abort-failed-pct'] ?? 5);
  const seed = positiveInt(options.seed, 1, 'seed');
  const requestedRps = options['max-rps'] == null ? null : positiveInt(options['max-rps'], null, 'max-rps');

  const guard = guardTarget({ baseUrl, allowProduction: Boolean(options['allow-production']), hasServiceKey: Boolean(serviceKey), maxRps: requestedRps });
  if (!guard.ok) { console.error(guard.reason); return 2; }

  const headers = { 'User-Agent': 'zecblock-load-test/1', Accept: 'application/json', ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}) };
  const random = createRandom(seed);
  const pick = createPicker(DEFAULT_SCENARIO, random);
  const pace = createPacer(guard.maxRps);

  console.error(`Target ${baseUrl}${guard.production ? ' (production)' : ''} · rate cap ${guard.maxRps ?? 'none'} req/s · service key ${serviceKey ? 'yes' : 'no'}`);
  const fixture = await loadFixture(baseUrl, headers, timeoutMs, historyBlocks);
  console.error(`Fixture: tip ${fixture.tip}, historic heights ${fixture.minHeight}–${fixture.tip}, ${fixture.txids.length} txids`);

  const startedAt = new Date().toISOString();
  const results = [];
  let aborted = null;
  for (const stage of stages) {
    const result = await runStage({ baseUrl, ...stage, pick, fixture, random, headers, timeoutMs, pace });
    results.push(result);
    const { summary } = result;
    console.error(`c=${stage.concurrency} ${stage.seconds}s: ${summary.requests} req, ${summary.rps} req/s, p50 ${summary.latencyMs.p50} ms, p95 ${summary.latencyMs.p95} ms, p99 ${summary.latencyMs.p99} ms, failed ${summary.failedPct}%`);
    if (shouldAbort(summary, abortFailedPct)) {
      aborted = `Stage c=${stage.concurrency} failed ${summary.failedPct}% > ${abortFailedPct}%; remaining stages skipped.`;
      console.error(aborted);
      break;
    }
  }

  const artifact = {
    tool: 'scripts/perf/load-test.mjs',
    label: options.label ?? null,
    baseUrl,
    production: guard.production,
    rateCapRps: guard.maxRps ?? null,
    serviceKey: Boolean(serviceKey),
    seed,
    startedAt,
    finishedAt: new Date().toISOString(),
    fixture: { tip: fixture.tip, minHeight: fixture.minHeight, txidCount: fixture.txids.length },
    scenario: DEFAULT_SCENARIO,
    aborted,
    stages: results,
  };
  const output = options.output ?? path.join('artifacts', 'perf', `load-${startedAt.replace(/[:.]/g, '-')}.json`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`);
  console.error(`Wrote ${output}`);
  if (options.markdown) console.log(stagesTable(results));
  return aborted ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 1; });
}
