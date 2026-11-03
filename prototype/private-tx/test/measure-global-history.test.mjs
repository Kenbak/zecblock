import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createGlobalHistoryPlan, validateGlobalHistoryPlan, estimateGlobalHistory,
  captureGlobalHistoryCampaign, CAMPAIGN_LIMITS } from '../pilot/measure-global-history.mjs';

const hash = height => height.toString(16).padStart(64, '0');
function plan(blocks = 161) {
  const eras = Array.from({ length: 11 }, (_, index) => ({ name: `era${index}`, start: index * blocks, end: (index + 1) * blocks - 1 }));
  return createGlobalHistoryPlan({ eras, tip: { height: 11 * blocks - 1, hash: hash(11 * blocks - 1) },
    createdAt: '2026-11-03T14:01:23.559992Z' });
}

test('seeded SRSWOR is reproducible, distinct and bounded within every stratum', () => {
  const a = plan(), b = plan(); assert.deepEqual(a, b); validateGlobalHistoryPlan(a);
  assert.equal(a.selectedClusters, 33); assert.ok(a.selectedBlocks <= 528);
  for (const stratum of a.strata) {
    assert.equal(stratum.populationClusters, 11); assert.equal(stratum.clusters.length, 3);
    assert.equal(new Set(stratum.clusters.map(cluster => cluster.clusterIndex)).size, 3);
    assert.equal(stratum.inclusionProbability, 3 / 11);
    assert.ok(stratum.clusters.every(cluster => cluster.startHeight >= stratum.startHeight && cluster.endHeight <= stratum.endHeight));
  }
  const changed = structuredClone(a); changed.strata[0].clusters[0].startHeight++;
  assert.throws(() => validateGlobalHistoryPlan(changed), /changed/);
  assert.notDeepEqual(a.strata, createGlobalHistoryPlan({ eras: a.strata.map(s => ({ name: s.name, start: s.startHeight, end: s.endHeight })),
    tip: a.fixedTip, seed: 20261104 }).strata);
});

test('short tail clusters remain eligible sampling units rather than omitted blocks', () => {
  const value = plan(17);
  assert.equal(value.selectedClusters, 22); assert.equal(value.selectedBlocks, 187);
  for (const stratum of value.strata) {
    assert.equal(stratum.populationClusters, 2); assert.equal(stratum.sampleClusters, 2);
    assert.deepEqual(stratum.clusters.map(cluster => cluster.endHeight - cluster.startHeight + 1), [16, 1]);
  }
});

test('HT expansion and finite population variance use cluster totals and M/n weights', () => {
  const value = plan(160);
  const metrics = value.strata.flatMap(stratum => stratum.clusters.map((cluster, index) => ({ clusterId: cluster.id, bytes: (index + 1) * 10 })));
  const result = estimateGlobalHistory(value, metrics, ['bytes']).estimates.bytes;
  assert.equal(result.estimatedTotal, 11 * 10 * 20);
  assert.ok(Math.abs(result.estimatedVariance - 11 * 10 ** 2 * (1 - 3 / 10) * 100 / 3) < 1e-9);
  assert.ok(Math.abs(result.satterthwaiteDegreesOfFreedom - 22) < 1e-9);
  assert.ok(result.approximate95Interval.lower < result.estimatedTotal);
  assert.ok(result.approximate95Interval.upper > result.estimatedTotal);
  assert.match(result.intervalMeaning, /Not an exact bound/);
  const missing = estimateGlobalHistory(value, metrics.slice(1), ['bytes']).estimates.bytes;
  assert.equal(missing.available, false); assert.equal(missing.missingClusterIds.length, 1);
  assert.throws(() => estimateGlobalHistory(value, [...metrics, metrics[0]], ['bytes']), /Duplicate/);
});

test('census strata and their short tails expand exactly with zero sampling variance', () => {
  const value = plan(17), metrics = value.strata.flatMap(stratum => stratum.clusters.map(cluster => ({ clusterId: cluster.id,
    blocks: cluster.endHeight - cluster.startHeight + 1 })));
  const result = estimateGlobalHistory(value, metrics, ['blocks']).estimates.blocks;
  assert.equal(result.estimatedTotal, 187); assert.equal(result.estimatedVariance, 0);
});

async function box(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'global-history-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = plan(1), calls = { captures: [], raw: 0, headers: 0 };
  const dependencies = {
    runtime: { canonicalHeaders: async heights => {
      calls.headers++; return { blocks: heights.map(height => ({ height, hash: hash(height) })), observedAt: '2026-11-03T15:00:00Z' };
    } }, now: () => '2026-11-03T14:02:00Z',
    statfsFn: async () => ({ bavail: 100_000, bsize: 4096 * 1000 }),
    captureModule: {
      rawGlobalFromLoopback: async () => { calls.raw++; return {}; },
      captureGlobalSource: async options => {
        calls.captures.push(options);
        const selected = options.ranges[0];
        return { source: { schema: 'zecblock-private-global-source-v1', records: [{ synthetic: true }] },
          anchors: [{ height: selected.startHeight, hash: hash(selected.startHeight) }], receipt: { readOnly: true } };
      },
    },
  };
  return { directory, value, calls, dependencies, run: options => captureGlobalHistoryCampaign({ plan: value, directory, ...options }, dependencies) };
}

test('capture-only campaign saves private sources and complete cluster receipts without publication', async t => {
  const value = await box(t), result = await value.run();
  assert.equal(result.complete, true); assert.equal(result.completedClusters, 11); assert.equal(result.preparedOrPublished, false);
  assert.equal(value.calls.headers, 1); assert.equal(value.calls.captures.length, 11);
  assert.equal(result.parts.length, 11); assert.equal(result.counts.rawCalls, 0);
  for (const options of value.calls.captures) {
    assert.equal(options.maxSourceBytes, 128 * 1024 ** 2); assert.equal(options.maxRecords, 2048);
    assert.ok(options.signal instanceof AbortSignal); assert.equal(options.ranges.length, 1);
  }
  const files = await readdir(value.directory); assert.equal(files.filter(name => name.endsWith('.source.json')).length, 11);
  assert.match(await readFile(resolve(value.directory, 'sampling-plan.json'), 'utf8'), /SRSWOR/);
  const resumed = await value.run(); assert.equal(resumed.complete, true); assert.equal(value.calls.captures.length, 11);
});

test('capacity splits preserve selected cluster identity and all complete blocks', async t => {
  const value = await box(t); value.value = plan(17);
  const capture = value.dependencies.captureModule.captureGlobalSource;
  value.dependencies.captureModule.captureGlobalSource = async options => {
    const selected = options.ranges[0];
    if (selected.endHeight > selected.startHeight) { const failure = new Error('capacity exceeded'); failure.code = 'CAPACITY'; throw failure; }
    return capture(options);
  };
  const result = await captureGlobalHistoryCampaign({ plan: value.value, directory: value.directory }, value.dependencies);
  assert.equal(result.complete, true); assert.equal(result.completedClusters, 22);
  assert.equal(result.parts.length, 187);
  assert.ok(result.parts.every(part => part.startHeight === part.endHeight));
  assert.equal(new Set(result.parts.map(part => part.clusterId)).size, 22);
});

test('unsplittable failures remain missing and are never silently imputed', async t => {
  const value = await box(t);
  value.dependencies.captureModule.captureGlobalSource = async () => { throw new Error('raw unavailable'); };
  const result = await value.run();
  assert.equal(result.complete, false); assert.equal(result.completedClusters, 0); assert.equal(result.failures.length, 11);
  assert.equal(result.parts.length, 0);
  assert.equal((await readdir(value.directory)).filter(name => name.endsWith('.source.json')).length, 0);
});

test('campaign budgets reject before capture and cancellation prevents subsequent source jobs', async t => {
  const value = await box(t);
  await assert.rejects(value.run({ maxWallMs: CAMPAIGN_LIMITS.wallMs + 1 }), /budget/);
  await assert.rejects(value.run({ maxRawCalls: CAMPAIGN_LIMITS.rawCalls + 1 }), /budget/);
  assert.equal(value.calls.captures.length, 0);
  const abort = new AbortController(); abort.abort();
  const result = await value.run({ signal: abort.signal });
  assert.equal(result.complete, false); assert.equal(value.calls.captures.length, 0);
});
