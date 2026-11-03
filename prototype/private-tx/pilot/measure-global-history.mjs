import { createHash } from 'node:crypto';
import { lstat, open, readFile, statfs } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const HASH = /^[a-f0-9]{64}$/;
const safe = value => Number.isSafeInteger(value) && value >= 0;
const json = value => `${JSON.stringify(value)}\n`;
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : json(value)).digest('hex');
export const CAMPAIGN_LIMITS = Object.freeze({ wallMs: 1_800_000, rawCalls: 9000,
  sourceBytes: 8 * 1024 ** 3, sourceFileBytes: 128 * 1024 ** 2, recordsPerFile: 2048,
  clusterBlocks: 16, clustersPerEra: 3, strata: 11, rawPacingMs: 200 });

function seededInteger(seed, label) {
  let counter = 0;
  return bound => {
    const modulus = BigInt(bound), space = 1n << 64n, cutoff = space - space % modulus;
    while (true) {
      const draw = createHash('sha256').update(`${seed}\0${label}\0${counter++}`).digest().readBigUInt64BE();
      if (draw < cutoff) return Number(draw % modulus);
    }
  };
}

// Three clusters are selected without replacement in EACH era. The shorter
// final cluster remains a sampling unit with the same inclusion probability.
export function createGlobalHistoryPlan({ eras, tip, seed = 20261103, createdAt = new Date().toISOString() } = {}) {
  assert(Array.isArray(eras) && eras.length === 11 && safe(seed) && safe(tip?.height) && HASH.test(tip.hash), 'Invalid fixed historical domain.');
  assert(tip.height >= eras.at(-1).start && tip.height < 3_543_405,
    'The verified eleven-era domain requires a pre-NU7 fixed tip.');
  let previous = -1;
  const strata = eras.map((era, index) => {
    const end = index === eras.length - 1 ? tip.height : era.end;
    assert(typeof era.name === 'string' && era.name.length > 0 && safe(era.start) && safe(end)
      && era.start === previous + 1 && end >= era.start, 'Era coverage must partition the fixed canonical domain.');
    previous = end;
    const populationClusters = Math.ceil((end - era.start + 1) / 16);
    const sampleClusters = Math.min(3, populationClusters), chosen = new Set();
    const random = seededInteger(seed, `${index}:${era.name}:${era.start}:${end}`);
    // Floyd's algorithm is SRSWOR; rejection sampling avoids modulo bias.
    for (let j = populationClusters - sampleClusters; j < populationClusters; j++) {
      const candidate = random(j + 1); chosen.add(chosen.has(candidate) ? j : candidate);
    }
    const clusters = [...chosen].sort((a, b) => a - b).map(clusterIndex => ({
      id: `era-${String(index).padStart(2, '0')}-cluster-${clusterIndex}`,
      clusterIndex, startHeight: era.start + clusterIndex * 16,
      endHeight: Math.min(end, era.start + clusterIndex * 16 + 15),
    }));
    return { index, name: era.name, startHeight: era.start, endHeight: end, populationClusters,
      sampleClusters, inclusionProbability: sampleClusters / populationClusters, clusters };
  });
  return { schema: 'zecblock-private-global-history-sampling-plan-v1', seed,
    randomization: 'SHA-256 counter PRNG with unbiased uint64 rejection sampling; Floyd SRSWOR independently within each era.',
    createdAt, network: 'mainnet', fixedTip: { ...tip }, strata,
    selectedClusters: strata.flatMap(stratum => stratum.clusters).length,
    selectedBlocks: strata.flatMap(stratum => stratum.clusters).reduce((sum, cluster) => sum + cluster.endHeight - cluster.startHeight + 1, 0),
    stressPolicy: 'Chosen genesis/1800003/2000007 stress fixtures are separate; they are never added to the probability estimator.',
    limitations: 'Seed is fixed before outcome inspection. Three clusters per stratum give weak tail coverage; approximate intervals do not bound unsampled exceptional records or hash-bucket maxima.',
    limits: CAMPAIGN_LIMITS };
}

export function validateGlobalHistoryPlan(plan) {
  assert(plan?.schema === 'zecblock-private-global-history-sampling-plan-v1' && Array.isArray(plan.strata), 'Invalid sampling plan.');
  const rebuilt = createGlobalHistoryPlan({ eras: plan.strata.map(stratum => ({ name: stratum.name,
    start: stratum.startHeight, end: stratum.endHeight })), tip: plan.fixedTip, seed: plan.seed, createdAt: plan.createdAt });
  assert(json(rebuilt) === json(plan), 'Sampling plan changed or is not reproducible.');
  return plan;
}

async function privateDirectory(path) {
  assert(typeof path === 'string' && isAbsolute(path), 'Explicit absolute owned scratch directory required.');
  const info = await lstat(path);
  assert(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0
    && (process.getuid === undefined || info.uid === process.getuid()), 'Scratch must be an owned private ordinary directory.');
}

async function exclusiveJson(path, value) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(json(value)); await handle.sync(); } finally { await handle.close(); }
}

async function readJson(path, maxBytes) {
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink() && info.size <= maxBytes && (info.mode & 0o077) === 0,
    'Invalid private campaign file.');
  return JSON.parse(await readFile(path, 'utf8'));
}

function capacityFailure(error) {
  return ['CAPACITY', 'SOURCE_CAPACITY'].includes(error?.code)
    || /(?:capacity|oversized|exceeds.*bound|exceeds.*limit)/i.test(error?.message ?? '');
}

// Capture files remain on the source host. No native prepare, service/unit,
// publication pointer, database write or source endpoint override is reachable.
export async function captureGlobalHistoryCampaign({ plan, directory, captureHelper, runtimeDir,
  maxWallMs = CAMPAIGN_LIMITS.wallMs, maxRawCalls = CAMPAIGN_LIMITS.rawCalls, signal: callerSignal } = {}, dependencies = {}) {
  validateGlobalHistoryPlan(plan); await privateDirectory(directory);
  assert(safe(maxWallMs) && maxWallMs >= 1 && maxWallMs <= CAMPAIGN_LIMITS.wallMs
    && safe(maxRawCalls) && maxRawCalls >= 1 && maxRawCalls <= CAMPAIGN_LIMITS.rawCalls, 'Invalid bounded campaign budget.');
  let captureModule = dependencies.captureModule;
  if (!captureModule) {
    assert(typeof captureHelper === 'string' && isAbsolute(captureHelper), 'Explicit absolute capture helper required.');
    captureModule = await import(pathToFileURL(captureHelper).href);
  }
  const runtime = dependencies.runtime ?? await captureModule.loadGlobalCaptureRuntime(runtimeDir);
  assert(typeof captureModule.captureGlobalSource === 'function' && typeof captureModule.rawGlobalFromLoopback === 'function'
    && typeof runtime.canonicalHeaders === 'function', 'Capture-only runtime is unavailable.');
  const planFile = resolve(directory, 'sampling-plan.json');
  try { await exclusiveJson(planFile, plan); }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert(json(await readJson(planFile, 128 * 1024)) === json(plan), 'Existing campaign plan differs.'); }
  const now = dependencies.now ?? (() => new Date().toISOString());
  const clock = dependencies.clock ?? (() => performance.now());
  const pause = dependencies.pause ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new Error('Campaign deadline exceeded.')), maxWallMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
  const startedAt = now(), started = clock(), parts = [], clusters = [], failures = [];
  let rawCalls = 0, rawResponseBytes = 0, sourceBytes = 0, nextRawAt = 0, ratePauses = 0;
  const anchors = new Map([[plan.fixedTip.height, plan.fixedTip.hash]]);
  const events = await open(resolve(directory, `events-${Date.now()}-${process.pid}.ndjson`), 'wx', 0o600);
  const event = async value => { await events.writeFile(json({ observedAt: now(), ...value })); await events.sync(); };
  const addAnchor = anchor => {
    assert(safe(anchor.height) && HASH.test(anchor.hash) && (!anchors.has(anchor.height) || anchors.get(anchor.height) === anchor.hash),
      'Campaign canonical anchors conflict.'); anchors.set(anchor.height, anchor.hash);
  };
  const sharedRaw = async (txid, options) => {
    signal.throwIfAborted(); assert(rawCalls < maxRawCalls, 'Campaign raw-call budget exceeded.');
    if (clock() < nextRawAt) await pause(Math.ceil(nextRawAt - clock()), signal);
    signal.throwIfAborted(); rawCalls++; nextRawAt = clock() + CAMPAIGN_LIMITS.rawPacingMs;
    return captureModule.rawGlobalFromLoopback(txid, { ...options, onResponse: info => {
      rawResponseBytes += info.bytes;
      if (info.remaining !== null && info.remaining !== undefined && info.remaining < 120) {
        assert(safe(info.resetSeconds) && info.resetSeconds <= 60, 'Rate reset exceeds campaign bound.');
        nextRawAt = Math.max(nextRawAt, clock() + info.resetSeconds * 1000); ratePauses++;
      }
      options.onResponse?.(info);
    } });
  };
  const capturePart = async (cluster, startHeight, endHeight) => {
    signal.throwIfAborted();
    const partId = `${cluster.id}-${startHeight}-${endHeight}`;
    const sourceFile = `${partId}.source.json`, receiptFile = `${partId}.receipt.json`;
    try {
      const previous = await readJson(resolve(directory, receiptFile), 256 * 1024);
      assert(previous.planSha256 === sha(plan) && previous.clusterId === cluster.id
        && previous.startHeight === startHeight && previous.endHeight === endHeight, 'Saved part context mismatch.');
      const info = await lstat(resolve(directory, sourceFile));
      assert(info.isFile() && !info.isSymbolicLink() && info.size === previous.sourceBytes
        && (info.mode & 0o077) === 0 && info.size <= CAMPAIGN_LIMITS.sourceFileBytes, 'Saved source metadata mismatch.');
      const bytes = await readFile(resolve(directory, sourceFile));
      assert(sha(bytes.toString('utf8')) === previous.sourceSha256, 'Saved source digest mismatch.');
      previous.anchors.forEach(addAnchor); parts.push(previous); sourceBytes += previous.sourceBytes;
      await event({ kind: 'part-reused', clusterId: cluster.id, startHeight, endHeight, records: previous.records });
      return [previous];
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(sourceBytes < CAMPAIGN_LIMITS.sourceBytes, 'Campaign source-byte budget exhausted.');
    const free = await (dependencies.statfsFn ?? statfs)(directory);
    assert(Number(free.bavail) * Number(free.bsize) >= 64 * 1024 ** 3, 'Campaign disk reserve unavailable.');
    let result;
    try {
      result = await captureModule.captureGlobalSource({ ranges: [{ startHeight, endHeight }], runtimeDir,
        signal, deadlineMs: Math.min(600_000, maxWallMs), maxSourceBytes: CAMPAIGN_LIMITS.sourceFileBytes,
        maxRecords: CAMPAIGN_LIMITS.recordsPerFile }, { ...runtime, rawFromLoopback: sharedRaw });
    } catch (error) {
      if (capacityFailure(error) && startHeight < endHeight && !signal.aborted) {
        await event({ kind: 'capacity-split', clusterId: cluster.id, startHeight, endHeight });
        const middle = Math.floor((startHeight + endHeight) / 2);
        return [...await capturePart(cluster, startHeight, middle), ...await capturePart(cluster, middle + 1, endHeight)];
      }
      throw error;
    }
    const text = json(result.source), bytes = Buffer.byteLength(text);
    assert(bytes <= CAMPAIGN_LIMITS.sourceFileBytes && sourceBytes + bytes <= CAMPAIGN_LIMITS.sourceBytes,
      'Campaign source-byte budget exceeded.');
    result.anchors.forEach(addAnchor);
    const receipt = { schema: 'zecblock-private-global-history-part-v1', planSha256: sha(plan), clusterId: cluster.id,
      startHeight, endHeight, sourceFile, records: result.source.records.length, sourceBytes: bytes,
      sourceSha256: sha(text), anchors: result.anchors, captureReceipt: result.receipt };
    await exclusiveJson(resolve(directory, sourceFile), result.source);
    await exclusiveJson(resolve(directory, receiptFile), receipt);
    parts.push(receipt); sourceBytes += bytes;
    await event({ kind: 'part-complete', clusterId: cluster.id, startHeight, endHeight, records: receipt.records,
      sourceBytes: bytes, sourceSha256: receipt.sourceSha256 });
    return [receipt];
  };
  let canonicalVerifiedAt = null, globalCanonical = false;
  try {
    for (const stratum of plan.strata) for (const cluster of stratum.clusters) {
      if (signal.aborted || rawCalls >= maxRawCalls) break;
      try {
        const capturedParts = await capturePart(cluster, cluster.startHeight, cluster.endHeight);
        const covered = capturedParts.reduce((sum, part) => sum + part.endHeight - part.startHeight + 1, 0);
        assert(covered === cluster.endHeight - cluster.startHeight + 1, 'Incomplete sampled cluster.');
        clusters.push({ ...cluster, stratumIndex: stratum.index, complete: true,
          records: capturedParts.reduce((sum, part) => sum + part.records, 0), parts: capturedParts.map(part => part.sourceFile) });
      } catch {
        failures.push({ clusterId: cluster.id, reason: signal.aborted ? 'campaign-aborted' : 'bounded-capture-unavailable' });
        await event({ kind: 'cluster-incomplete', clusterId: cluster.id, reason: failures.at(-1).reason });
      }
    }
    if (!signal.aborted && anchors.size <= 2048) {
      const completedAt = now(), headers = await runtime.canonicalHeaders([...anchors.keys()].sort((a, b) => a - b));
      assert(headers.blocks.length === anchors.size && new Set(headers.blocks.map(block => block.height)).size === anchors.size
        && headers.blocks.every(block => anchors.get(block.height) === block.hash)
        && Date.parse(headers.observedAt) >= Date.parse(completedAt), 'Campaign final canonical check failed.');
      canonicalVerifiedAt = headers.observedAt; globalCanonical = true;
    }
  } finally { clearTimeout(timer); await events.close(); }
  const summary = { schema: 'zecblock-private-global-history-capture-v1', readOnly: true, preparedOrPublished: false,
    planSha256: sha(plan), fixedTip: plan.fixedTip, startedAt, completedAt: now(), canonicalVerifiedAt,
    complete: globalCanonical && clusters.length === plan.selectedClusters && failures.length === 0,
    selectedClusters: plan.selectedClusters, completedClusters: clusters.length, selectedBlocks: plan.selectedBlocks,
    clusters, parts, failures, counts: { rawCalls, rawResponseBytes, sourceBytes, ratePauses },
    elapsedMs: clock() - started,
    sourcePolicy: 'Public-chain full source files remain on this host in private scratch; stdout contains aggregates only.',
    limits: { ...CAMPAIGN_LIMITS, wallMs: maxWallMs, rawCalls: maxRawCalls } };
  await exclusiveJson(resolve(directory, `capture-summary-${Date.now()}-${process.pid}.json`), summary);
  return summary;
}

// Design-unbiased HT total under stratified cluster SRSWOR, with finite
// population correction. Approximate intervals cannot bound missed outliers.
export function estimateGlobalHistory(plan, clusterMetrics, metricNames) {
  validateGlobalHistoryPlan(plan);
  assert(Array.isArray(clusterMetrics) && new Set(clusterMetrics.map(value => value.clusterId)).size === clusterMetrics.length,
    'Duplicate or invalid cluster measurements.');
  const metrics = new Map(clusterMetrics.map(value => [value.clusterId, value])), estimates = {};
  for (const name of metricNames) {
    let total = 0, variance = 0, degreesDenominator = 0;
    const strata = [], missing = [];
    for (const stratum of plan.strata) {
      const values = stratum.clusters.map(cluster => {
        const value = metrics.get(cluster.id)?.[name];
        if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) missing.push(cluster.id);
        return value;
      });
      if (values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) continue;
      const n = values.length, M = stratum.populationClusters, mean = values.reduce((sum, value) => sum + value, 0) / n;
      const sampleVariance = n > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1) : 0;
      const contribution = M * mean, v = M === n ? 0 : M ** 2 * (1 - n / M) * sampleVariance / n;
      total += contribution; variance += v;
      if (n > 1) degreesDenominator += v ** 2 / (n - 1);
      strata.push({ name: stratum.name, populationClusters: M, sampleClusters: n,
        clusterTotals: values, estimatedTotal: contribution, variance: v });
    }
    if (missing.length) { estimates[name] = { available: false, missingClusterIds: missing }; continue; }
    const df = degreesDenominator ? variance ** 2 / degreesDenominator : null;
    // Conservative tabulated two-sided t(.975): floor fractional df. At df>30
    // use the df30 value rather than silently replacing it by a normal interval.
    const t95 = [null, 12.706205, 4.302653, 3.182446, 2.776445, 2.570582, 2.446912, 2.364624,
      2.306004, 2.262157, 2.228139, 2.200985, 2.178813, 2.160369, 2.144787, 2.13145,
      2.119905, 2.109816, 2.100922, 2.093024, 2.085963, 2.079614, 2.073873, 2.068658,
      2.063899, 2.059539, 2.055529, 2.051831, 2.048407, 2.04523, 2.042272];
    const critical = df === null ? 0 : t95[Math.max(1, Math.min(30, Math.floor(df)))];
    const standardError = Math.sqrt(variance), margin = critical * standardError;
    estimates[name] = { available: true, estimatedTotal: total, estimatedVariance: variance, standardError,
      satterthwaiteDegreesOfFreedom: df, critical95: critical,
      approximate95Interval: { lower: Math.max(0, total - margin), upper: total + margin }, strata,
      intervalMeaning: 'Approximate design-based interval with Satterthwaite t approximation; n=3 clusters/era gives weak tail information. Not an exact bound on history, exceptional records, hash-bucket maxima or serving size.' };
  }
  return { schema: 'zecblock-private-global-history-estimate-v1', planSha256: sha(plan), estimates };
}

export async function runEncoderStats(binary, sourceFile, { signal, command = 'measure-global' } = {}) {
  assert(isAbsolute(binary) && isAbsolute(sourceFile) && /^[a-z-]+$/.test(command), 'Explicit bounded encoder command required.');
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, [command, sourceFile], { signal, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = []; let bytes = 0;
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) child.kill('SIGKILL'); else chunks.push(chunk); });
    child.once('error', () => reject(new Error('Bounded encoder stats process unavailable.')));
    child.once('close', code => {
      if (code !== 0 || bytes > 1024 * 1024) { reject(new Error('Bounded encoder stats failed.')); return; }
      try { resolveResult(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Invalid aggregate encoder statistics.')); }
    });
  });
}

function args(values) {
  const parsed = { stage: values[0] };
  assert(['plan', 'capture', 'stats'].includes(parsed.stage), 'Choose plan, capture or stats stage.');
  const allowed = new Set(['--directory', ...(parsed.stage === 'plan' ? ['--eras', '--tip']
    : parsed.stage === 'capture' ? ['--capture-helper', '--runtime'] : ['--summary', '--binary', '--command'])]);
  for (let index = 1; index < values.length; index += 2) {
    const key = values[index], value = values[index + 1];
    assert(allowed.has(key) && typeof value === 'string' && !value.startsWith('--') && !(key in parsed), 'Invalid campaign argument.');
    parsed[key] = value;
  }
  return parsed;
}

export async function runGlobalHistoryCli(argv, dependencies = {}) {
  const options = args(argv), directory = options['--directory'];
  await privateDirectory(directory);
  if (options.stage === 'plan') {
    const legacy = JSON.parse(await readFile(options['--eras'], 'utf8'));
    const tip = JSON.parse(await readFile(options['--tip'], 'utf8'));
    const plan = createGlobalHistoryPlan({ eras: legacy.eras, tip: tip.tip ?? tip });
    await exclusiveJson(resolve(directory, 'sampling-plan.json'), plan);
    return plan;
  }
  const plan = validateGlobalHistoryPlan(await readJson(resolve(directory, 'sampling-plan.json'), 128 * 1024));
  if (options.stage === 'capture') {
    const value = await captureGlobalHistoryCampaign({ plan, directory, captureHelper: options['--capture-helper'],
      runtimeDir: options['--runtime'], signal: dependencies.signal }, dependencies);
    return { schema: value.schema, complete: value.complete, counts: value.counts,
      completedClusters: value.completedClusters, selectedClusters: value.selectedClusters,
      selectedBlocks: value.selectedBlocks, elapsedMs: value.elapsedMs };
  }
  assert(options['--summary'] && options['--binary'], 'Explicit capture summary and encoder binary required.');
  const summary = await readJson(options['--summary'], 4 * 1024 * 1024);
  assert(summary.complete === true && summary.planSha256 === sha(plan), 'Only a complete canonically verified campaign may be estimated.');
  const outputs = [], byCluster = new Map();
  for (const part of summary.parts) {
    const value = await (dependencies.measureSource ?? runEncoderStats)(options['--binary'], resolve(directory, part.sourceFile),
      { signal: dependencies.signal, command: options['--command'] ?? 'measure-global' });
    assert(value.recordCount === part.records && safe(value.codecs?.v1?.encodedBytes) && safe(value.codecs?.v2?.encodedBytes),
      'Native codec statistics do not match the complete captured part.');
    outputs.push({ clusterId: part.clusterId, sourceFile: part.sourceFile, sourceSha256: part.sourceSha256, stats: value });
    const totals = byCluster.get(part.clusterId) ?? { clusterId: part.clusterId, records: 0, v1EncodedBytes: 0, v2EncodedBytes: 0 };
    totals.records += value.recordCount; totals.v1EncodedBytes += value.codecs.v1.encodedBytes; totals.v2EncodedBytes += value.codecs.v2.encodedBytes;
    byCluster.set(part.clusterId, totals);
  }
  const result = { schema: 'zecblock-private-global-history-codec-statistics-v1', planSha256: sha(plan), parts: outputs,
    clusterMetrics: [...byCluster.values()], estimate: estimateGlobalHistory(plan, [...byCluster.values()],
      ['records', 'v1EncodedBytes', 'v2EncodedBytes']) };
  await exclusiveJson(resolve(directory, `codec-statistics-${Date.now()}.json`), result);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const abort = new AbortController();
  const stop = () => abort.abort(new Error('Campaign interrupted.'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  try { process.stdout.write(json(await runGlobalHistoryCli(process.argv.slice(2), { signal: abort.signal }))); }
  catch { process.stderr.write('Bounded read-only historical sizing stage failed; no publication or production setting changed.\n'); process.exitCode = 1; }
  finally { for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, stop); }
}
