/**
 * Pure helpers for the staged API load test (scripts/perf/load-test.mjs).
 * Kept free of network and filesystem access so they are unit-testable.
 */

/** Public production API hosts. Running against them requires --allow-production. */
export const PRODUCTION_HOSTS = Object.freeze([
  'api.zecblock.com',
  'api.testnet.zecblock.com',
  'api.crosslink.zecblock.com',
  'api.mainnet.cipherscan.app',
  'api.testnet.cipherscan.app',
  'api.crosslink.cipherscan.app',
]);

/**
 * Per-IP public limit is 600 requests/60s (server/api/server.js). Without a
 * service key a production run is capped well below it so the test never
 * measures the limiter and never crowds out other clients from the same IP.
 */
export const PRODUCTION_KEYLESS_MAX_RPS = 6;

/**
 * Default read mix, weighted toward what explorer pages actually request.
 * `{tip}`, `{height}` and `{txid}` are filled from a fixture read at startup.
 */
export const DEFAULT_SCENARIO = Object.freeze([
  { name: 'health', path: '/api/network/health', weight: 1 },
  { name: 'info', path: '/api/info', weight: 1 },
  { name: 'blocks-list', path: '/api/blocks?limit=10', weight: 4 },
  { name: 'block-recent', path: '/api/block/{tip}', weight: 2 },
  { name: 'block-historic', path: '/api/block/{height}', weight: 3 },
  { name: 'tx-detail', path: '/api/tx/{txid}', weight: 3 },
  { name: 'mempool', path: '/api/mempool', weight: 2 },
  { name: 'accounting', path: '/api/network/accounting', weight: 1 },
  { name: 'block-speed', path: '/api/network/block-speed', weight: 1 },
  { name: 'v1-network-info', path: '/v1/network/info', weight: 1 },
]);

/** "1:30,4:30,8:30" → [{ concurrency: 1, seconds: 30 }, ...] */
export function parseStages(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('--stages must be "concurrency:seconds[,...]"');
  return value.split(',').map((part) => {
    const match = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(part);
    if (!match) throw new TypeError(`Invalid stage "${part}"; expected concurrency:seconds`);
    const concurrency = Number(match[1]);
    const seconds = Number(match[2]);
    if (concurrency < 1 || concurrency > 512) throw new RangeError(`Stage concurrency must be 1–512, got ${concurrency}`);
    if (seconds < 1 || seconds > 3600) throw new RangeError(`Stage duration must be 1–3600 s, got ${seconds}`);
    return { concurrency, seconds };
  });
}

/**
 * Decide whether a run may start and with what request-rate cap.
 * Returns { ok, maxRps, reason }.
 */
export function guardTarget({ baseUrl, allowProduction = false, hasServiceKey = false, maxRps = null }) {
  let url;
  try { url = new URL(baseUrl); } catch { return { ok: false, reason: `Invalid --base-url: ${baseUrl}` }; }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, reason: '--base-url must be http(s)' };
  const production = PRODUCTION_HOSTS.includes(url.hostname.toLowerCase());
  if (!production) return { ok: true, production, maxRps };
  if (!allowProduction) {
    return { ok: false, production, reason: `${url.hostname} is a production API. Pass --allow-production for a bounded latency run, or target an isolated instance for capacity tests.` };
  }
  if (hasServiceKey) return { ok: true, production, maxRps };
  const capped = maxRps == null ? PRODUCTION_KEYLESS_MAX_RPS : Math.min(maxRps, PRODUCTION_KEYLESS_MAX_RPS);
  return { ok: true, production, maxRps: capped };
}

/** Deterministic PRNG (mulberry32) so a seed reproduces the same request sequence. */
export function createRandom(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createPicker(scenario, random) {
  const total = scenario.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(total > 0)) throw new RangeError('Scenario weights must sum to more than zero');
  return () => {
    let roll = random() * total;
    for (const entry of scenario) {
      roll -= entry.weight;
      if (roll < 0) return entry;
    }
    return scenario[scenario.length - 1];
  };
}

/** Fill `{tip}`, `{height}` and `{txid}` placeholders from the fixture. */
export function resolvePath(template, fixture, random) {
  return template
    .replaceAll('{tip}', String(fixture.tip))
    .replaceAll('{height}', () => String(fixture.minHeight + Math.floor(random() * (fixture.tip - fixture.minHeight + 1))))
    .replaceAll('{txid}', () => fixture.txids[Math.floor(random() * fixture.txids.length)]);
}

/** Nearest-rank percentile on an ascending-sorted array. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

const round = (value) => value == null ? null : Math.round(value * 10) / 10;

/**
 * Summarize raw samples: { endpoint, status, ms, bytes, cache, error }.
 * Errors are network/timeouts (status 0). Any non-2xx counts as failed.
 */
export function summarize(samples, elapsedSeconds) {
  const latencies = samples.filter((s) => s.status > 0).map((s) => s.ms).sort((a, b) => a - b);
  const statuses = {};
  const cache = {};
  let failed = 0;
  let rateLimited = 0;
  let bytes = 0;
  for (const sample of samples) {
    const key = sample.status === 0 ? (sample.error || 'network-error') : String(sample.status);
    statuses[key] = (statuses[key] || 0) + 1;
    if (sample.status < 200 || sample.status >= 300) failed += 1;
    if (sample.status === 429) rateLimited += 1;
    if (sample.cache) cache[sample.cache] = (cache[sample.cache] || 0) + 1;
    bytes += sample.bytes || 0;
  }
  return {
    requests: samples.length,
    rps: elapsedSeconds > 0 ? round(samples.length / elapsedSeconds) : null,
    failed,
    failedPct: samples.length ? round((failed / samples.length) * 100) : 0,
    rateLimited,
    statuses,
    cache,
    bytes,
    latencyMs: {
      p50: round(percentile(latencies, 50)),
      p90: round(percentile(latencies, 90)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      max: round(latencies.length ? latencies[latencies.length - 1] : null),
    },
  };
}

export function summarizeByEndpoint(samples, elapsedSeconds) {
  const groups = new Map();
  for (const sample of samples) {
    if (!groups.has(sample.endpoint)) groups.set(sample.endpoint, []);
    groups.get(sample.endpoint).push(sample);
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, group]) => [name, summarize(group, elapsedSeconds)]));
}

/** Whether a stage breached the abort threshold, so later (heavier) stages are skipped. */
export function shouldAbort(summary, abortFailedPct) {
  return summary.requests > 0 && summary.failedPct > abortFailedPct;
}

/** Markdown table of stage results for a results document. */
export function stagesTable(stages) {
  const rows = stages.map(({ concurrency, seconds, summary }) => {
    const l = summary.latencyMs;
    return `| ${concurrency} | ${seconds} | ${summary.requests} | ${summary.rps ?? '—'} | ${l.p50 ?? '—'} | ${l.p95 ?? '—'} | ${l.p99 ?? '—'} | ${l.max ?? '—'} | ${summary.failedPct}% | ${summary.rateLimited} |`;
  });
  return [
    '| Concurrency | Seconds | Requests | Req/s | p50 ms | p95 ms | p99 ms | Max ms | Failed | 429s |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows,
  ].join('\n');
}
