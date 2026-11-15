#!/usr/bin/env node
/**
 * Milestone 4 Verification Script
 *
 * Tests the Milestone 4 deliverables against a live ZecBlock deployment:
 *
 *   1. NU7 network upgrade support (replaces ZSA support)
 *   2. Shielded Rate Tracking: bridged ZEC that gets shielded
 *   3. Infrastructure scaling: monitoring, standby, load test, failover runbook
 *   4. Zakura node migration (replaces Rust indexer research)
 *
 * Deliverables 5–7 (retrospective, 2027 roadmap, final report) are written
 * reports on the forum and are not machine-checked.
 *
 * Usage:
 *   node zcg/milestone-4/verify.js [frontend_url]
 *
 * Examples:
 *   node zcg/milestone-4/verify.js https://zecblock.com
 *   node zcg/milestone-4/verify.js https://testnet.zecblock.com
 *
 * Frontend links are printed for review in a browser; the checks run against
 * the public API behind each page.
 *
 * Set API_BASE to point at a different API host (for example a local API on
 * http://localhost:3001). Requires Node 18+ (built-in fetch). No dependencies.
 */

const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'https://zecblock.com').replace(/\/$/, '');
const IS_TESTNET = BASE.includes('testnet');

function deriveApiBase(frontendUrl) {
  if (process.env.API_BASE) return process.env.API_BASE.replace(/\/$/, '');
  if (frontendUrl.includes('localhost')) return frontendUrl.replace(':3000', ':3001');
  if (IS_TESTNET) return 'https://api.testnet.zecblock.com';
  return 'https://api.zecblock.com';
}

const API = deriveApiBase(BASE);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Activation heights published by the serving node's upgrade schedule.
const NU7_HEIGHT = IS_TESTNET ? 4465026 : 3543405;
const NU7_TARGET_SECONDS = 25;

// ── Utilities ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function assert(condition, testName, detail) {
  if (condition) {
    console.log(`  ✅ ${testName}`);
    passed++;
  } else {
    console.log(`  ❌ ${testName}${detail ? ` — ${detail}` : ''}`);
    failed++;
    failures.push(testName);
  }
}

function skip(testName, reason) {
  console.log(`  ⏭️  ${testName} — ${reason}`);
  skipped++;
}

function show(label, value) {
  if (typeof value === 'object') {
    console.log(`     ${label}:`);
    JSON.stringify(value, null, 2).split('\n').forEach((l) => console.log(`       ${l}`));
  } else {
    console.log(`     ${label}: ${value}`);
  }
}

function url(label, href) {
  console.log(`     🔗 ${label}: ${href}`);
}

function separator(title) {
  console.log(`\n${'━'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('━'.repeat(70));
}

async function fetchSafe(fetchUrl, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const t0 = Date.now();
  try {
    const res = await fetch(fetchUrl, {
      ...options,
      signal: controller.signal,
      headers: { Accept: 'application/json', ...options.headers },
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, ok: res.ok, data, ms: Date.now() - t0 };
  } catch (err) {
    return { status: 0, ok: false, data: null, error: err.message, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

const zat = (v) => BigInt(v);
const zec = (v) => (Number(zat(v)) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct = (r) => `${(r * 100).toFixed(1)}%`;

// ══════════════════════════════════════════════════════════════════════════
//  1. NU7 Network Upgrade Support
// ══════════════════════════════════════════════════════════════════════════

async function testNu7() {
  separator('DELIVERABLE 1: NU7 Network Upgrade Support (replaces ZSA support)');

  url('Block speed', `${BASE}/network/block-speed`);
  url('Network upgrades hub', `${BASE}/network/upgrades`);
  url('NU7 accounting', `${BASE}/network#nu7-accounting`);
  console.log();

  // Block speed and activation schedule
  console.log('  ┌─ Block speed before and after NU7 ───────────────────────────');
  const speed = await fetchSafe(`${API}/api/network/block-speed`);
  assert(speed.ok, `GET /api/network/block-speed → ${speed.status}`);
  if (speed.ok && speed.data) {
    const eras = speed.data.schedule?.eras || [];
    const lastEra = eras[eras.length - 1] || {};
    const latest = speed.data.windows?.latest;
    const before = speed.data.windows?.beforeUpgrade;
    show('Activation', speed.data.activation);
    show('Average block time', { beforeNu7: before?.averageSeconds, sinceNu7: latest?.averageSeconds });

    assert(speed.data.activation?.height === NU7_HEIGHT, `NU7 activation at block ${NU7_HEIGHT.toLocaleString('en-US')}`);
    assert(
      lastEra.height === NU7_HEIGHT && lastEra.seconds === NU7_TARGET_SECONDS,
      'Node schedule sets a 25s target from activation',
    );
    assert(
      typeof latest?.averageSeconds === 'number' && latest.averageSeconds > 15 && latest.averageSeconds < 40,
      'Measured post-NU7 average is close to the 25s target',
      `got ${latest?.averageSeconds}`,
    );
    if (!IS_TESTNET) {
      assert(
        typeof before?.averageSeconds === 'number' && before.averageSeconds > 60 && before.averageSeconds < 90,
        'Measured pre-NU7 average is close to the 75s target',
        `got ${before?.averageSeconds}`,
      );
    }
    assert(Array.isArray(latest?.distribution) && latest.distribution.length > 0, 'Fast/slow block distribution published');
  }

  // Per-block accounting
  console.log('\n  ┌─ NU7 accounting (NSM, fees, miner receipts) ─────────────────');
  const acct = await fetchSafe(`${API}/v1/network/accounting`);
  assert(acct.ok, `GET /v1/network/accounting → ${acct.status}`);
  if (acct.ok && acct.data?.data) {
    const d = acct.data.data;
    show('NSM balance', `${zec(d.nsmBalanceZat || '0')} ZEC (${d.nsmBalanceZat} zat)`);
    show('Tip block', d.block?.height);
    assert(d.schedule?.nu7Height === NU7_HEIGHT, 'Accounting uses the node NU7 height');
    assert(zat(d.nsmBalanceZat || '0') > 0n, 'NSM balance is positive after activation');
    assert(Number(d.block?.height) > NU7_HEIGHT, 'Tip block is past activation');
  }

  const hist = await fetchSafe(`${API}/api/network/accounting/history`);
  assert(hist.ok, `GET /api/network/accounting/history → ${hist.status}`);
  if (hist.ok && Array.isArray(hist.data?.points)) {
    const points = hist.data.points;
    let feeOk = 0;
    let feeChecked = 0;
    let receiptOk = 0;
    let receiptChecked = 0;
    for (const p of points) {
      if (p.feesPaidZat == null || p.feesToNsmZat == null || p.minerFeeAllocationZat == null) continue;
      const fees = zat(p.feesPaidZat);
      const toNsm = zat(p.feesToNsmZat);
      const toMiner = zat(p.minerFeeAllocationZat);
      feeChecked++;
      if (toNsm === (fees * 3n) / 5n && toMiner === fees - toNsm) feeOk++;
      if (p.minerReceiptsZat != null && p.minerSubsidyZat != null) {
        receiptChecked++;
        if (zat(p.minerReceiptsZat) === zat(p.minerSubsidyZat) + toMiner) receiptOk++;
      }
    }
    show('Recent blocks checked (history endpoint window)', { feeSplit: feeChecked, receipts: receiptChecked });
    assert(feeChecked > 0 && feeOk === feeChecked, `Latest ${feeChecked} blocks: fees to NSM = floor(fees × 3/5), miner gets the rest`, `${feeOk}/${feeChecked}`);
    assert(receiptChecked > 0 && receiptOk === receiptChecked, `Latest ${receiptChecked} blocks with receipts: miner receipts = subsidy + miner fee share`, `${receiptOk}/${receiptChecked}`);
  }

  // Node readiness
  console.log('\n  ┌─ Node upgrade readiness ─────────────────────────────────────');
  const ready = await fetchSafe(`${API}/api/network/nodes/upgrade-readiness`);
  assert(ready.ok, `GET /api/network/nodes/upgrade-readiness → ${ready.status}`);
  if (ready.ok && ready.data) {
    show('Readiness', { upgrade: ready.data.referenceUpgrade, readinessPct: ready.data.readinessPct, nodes: `${ready.data.latestCount}/${ready.data.totalActive}` });
    assert(ready.data.referenceUpgrade === 'NU7', 'Readiness is measured against NU7');
    assert(Number(ready.data.totalActive) > 0, 'Active nodes observed');
    assert(Number(ready.data.readinessPct) >= 50, 'Majority of observed nodes run the NU7 protocol version');
  }

}

// ══════════════════════════════════════════════════════════════════════════
//  2. Shielded Rate Tracking
// ══════════════════════════════════════════════════════════════════════════

function checkShieldingSummary(label, summary) {
  const covered = zat(summary.coveredZat);
  const shielded = zat(summary.shieldedZat);
  const b = summary.breakdownZat || {};
  const parts = ['shieldedOnArrival', 'shieldedAfter', 'held', 'exchange', 'bridge', 'transferred'];
  const sum = parts.reduce((acc, k) => acc + zat(b[k] || '0'), 0n);

  assert(summary.shieldedRate > 0 && summary.shieldedRate < 1, `${label}: shielded rate is a share between 0 and 1`, `got ${summary.shieldedRate}`);
  assert(summary.swapCoverage >= 0.9, `${label}: at least 90% of swaps covered`, `got ${summary.swapCoverage}`);
  assert(sum === covered, `${label}: outcome breakdown sums exactly to covered ZEC`);
  assert(zat(b.shieldedOnArrival || '0') + zat(b.shieldedAfter || '0') === shielded, `${label}: shielded = on arrival + after first spend`);
  const expectedRate = covered > 0n ? Number((shielded * 10000n) / covered) / 10000 : 0;
  assert(Math.abs(expectedRate - summary.shieldedRate) < 0.0002, `${label}: rate matches shielded ÷ covered ZEC`);
}

async function testShieldedRate() {
  separator('DELIVERABLE 2: Shielded Rate Tracking — Bridged ZEC That Gets Shielded');

  url('Frontend', `${BASE}/crosschain`);
  url('API', `${API}/v1/crosschain/shielding?period=all`);
  console.log();

  if (IS_TESTNET) {
    skip('Shielded Rate Tracking', 'cross-chain swaps settle on mainnet only; run against https://zecblock.com');
    return;
  }

  const all = await fetchSafe(`${API}/v1/crosschain/shielding?period=all`);
  assert(all.ok, `GET /v1/crosschain/shielding?period=all → ${all.status}`);
  if (all.ok && all.data?.data) {
    const d = all.data.data;
    const s = d.summary;
    show('All time', {
      swaps: s.swaps,
      coveredSwaps: s.coveredSwaps,
      swapCoverage: pct(s.swapCoverage),
      coveredZec: zec(s.coveredZat),
      shieldedZec: zec(s.shieldedZat),
      shieldedRate: pct(s.shieldedRate),
      shieldedOnArrival: pct(Number(zat(s.breakdownZat.shieldedOnArrival)) / Number(zat(s.coveredZat))),
    });
    show('Time to shield (transparent arrivals)', {
      samples: d.timeToShield?.samples,
      medianMinutes: Math.round(d.timeToShield?.medianMinutes ?? NaN),
    });

    checkShieldingSummary('All time', s);
    assert(d.definition && d.definition.population && d.definition.shielded && d.definition.denominator, 'Methodology (population, shielded, denominator) published with the data');
    assert(Array.isArray(d.daily) && d.daily.length > 0, 'Daily series published');
    assert(Array.isArray(d.byChain) && d.byChain.length > 0, 'Per-source-chain breakdown published');
    assert(Number(d.timeToShield?.samples) > 0, 'Time-to-shield measured');
    const classifiedAgeHours = (Date.now() - Date.parse(d.coverage?.lastClassifiedAt)) / 3.6e6;
    show('Classifier', { lastClassifiedAt: d.coverage?.lastClassifiedAt, pendingClassification: d.coverage?.pendingClassification });
    assert(classifiedAgeHours >= 0 && classifiedAgeHours < 24, 'Classifier ran within the last 24 hours', `last run ${d.coverage?.lastClassifiedAt}`);
  }

  const recent = await fetchSafe(`${API}/v1/crosschain/shielding?period=30d`);
  assert(recent.ok, `GET /v1/crosschain/shielding?period=30d → ${recent.status}`);
  if (recent.ok && recent.data?.data?.summary) {
    show('Last 30 days', { shieldedRate: pct(recent.data.data.summary.shieldedRate), swapCoverage: pct(recent.data.data.summary.swapCoverage) });
    checkShieldingSummary('Last 30 days', recent.data.data.summary);
  }

  const mcp = await fetchSafe(`${API}/v1/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const tools = (mcp.data?.result?.tools || []).map((t) => t.name);
  assert(tools.includes('crosschain_shielding'), 'Available to AI clients as the public MCP tool crosschain_shielding');

}

// ══════════════════════════════════════════════════════════════════════════
//  3. Infrastructure Scaling
// ══════════════════════════════════════════════════════════════════════════

function repoFile(rel) {
  try { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); } catch { return null; }
}

async function testInfrastructure() {
  separator('DELIVERABLE 3: Infrastructure Scaling — Monitoring, Standby, Load Test');

  url('Status page', 'https://status.zecblock.com');
  url('Deep health', `${API}/health/deep`);
  console.log();

  console.log('  ┌─ Health and standby ─────────────────────────────────────────');
  const health = await fetchSafe(`${API}/health/deep`);
  assert(health.ok, `GET /health/deep → ${health.status}`);
  if (health.ok && health.data?.checks) {
    const c = health.data.checks;
    show('Checks', {
      status: health.data.status,
      database: c.database?.status,
      replica: c.replica?.status,
      replicaLagBlocks: c.replica?.lag_blocks,
      node: c.node?.status,
      nodeHeight: c.node?.height,
      indexedHeight: c.node?.db_height,
    });
    assert(health.data.status === 'healthy', 'API reports healthy');
    assert(c.database?.status === 'up', 'Primary database up');
    assert(c.node?.status === 'up', 'Node up');
    assert(Math.abs(Number(c.node?.height) - Number(c.node?.db_height)) <= 3, 'Indexer within 3 blocks of the node tip');
    if (!IS_TESTNET) {
      assert(c.replica?.status === 'up' && c.replica?.role === 'standby', 'Streaming-replication standby up');
      assert(Number(c.replica?.lag_blocks) <= 5, 'Standby lag ≤ 5 blocks', `got ${c.replica?.lag_blocks}`);
      assert(c.replica?.circuit === 'CLOSED', 'Read-offload circuit breaker closed (standby serving reads)');
    }
  }

  const status = await fetchSafe('https://status.zecblock.com', { headers: { Accept: 'text/html' } });
  assert(status.ok, `Public status page → ${status.status}`);

  console.log('\n  ┌─ Response times ─────────────────────────────────────────────');
  const endpoints = [
    '/api/blocks?limit=10',
    '/api/network/accounting',
    '/api/network/block-speed',
    '/v1/network/info',
  ];
  for (const ep of endpoints) {
    const res = await fetchSafe(`${API}${ep}`);
    assert(res.ok && res.ms < 3000, `${ep} → ${res.status} in ${res.ms}ms (under 3s)`);
  }

  console.log('\n  ┌─ Load test and failover runbook (repository) ────────────────');
  const loadTest = repoFile('scripts/perf/load-test.mjs');
  const results = repoFile('docs/load-test-results.md');
  const pkg = repoFile('package.json');
  const deployment = repoFile('DEPLOYMENT.md');
  if (loadTest == null && results == null && deployment == null) {
    skip('Repository checks', 'run from a clone of github.com/Kenbak/zecblock');
    return;
  }
  assert(loadTest != null, 'Load test tool: scripts/perf/load-test.mjs');
  assert(pkg != null && /"perf:load"\s*:/.test(pkg), 'npm run perf:load entry point');
  assert(results != null && /\|\s*Concurrency\s*\|/.test(results), 'Published load test results: docs/load-test-results.md');
  assert(deployment != null && /^## Failover\b/m.test(deployment), 'Failover runbook in DEPLOYMENT.md');
  assert(deployment != null && /^## Monitoring/m.test(deployment), 'Monitoring and health checks documented in DEPLOYMENT.md');
}

// ══════════════════════════════════════════════════════════════════════════
//  4. Zakura Node Migration
// ══════════════════════════════════════════════════════════════════════════

async function testZakura() {
  separator('DELIVERABLE 4: Zakura Node Migration (replaces Rust indexer research)');

  url('Node info', `${API}/api/blockchain-info`);
  url('Network nodes', `${BASE}/network/nodes`);
  console.log();

  const info = await fetchSafe(`${API}/api/blockchain-info`);
  assert(info.ok, `GET /api/blockchain-info → ${info.status}`);
  if (info.ok && info.data) {
    show('Serving node', { build: info.data.build, chain: info.data.chain, blocks: info.data.blocks });
    assert(/^\/Zakura:\d+\.\d+\.\d+[^/]*\/$/.test(String(info.data.build || '')), 'Serving node is Zakura');
    assert(info.data.chain === (IS_TESTNET ? 'test' : 'main'), `Node is on ${IS_TESTNET ? 'testnet' : 'mainnet'}`);
    assert(Number(info.data.blocks) > NU7_HEIGHT, 'Node is synced past NU7 activation');
  }

  const stats = await fetchSafe(`${API}/api/network/stats`);
  assert(stats.ok, `GET /api/network/stats → ${stats.status}`);
  if (stats.ok && stats.data) {
    const found = JSON.stringify(stats.data).match(/"subversion":"([^"]+)"/);
    assert(found && found[1].startsWith('/Zakura:'), 'Network stats report the Zakura build', found ? found[1] : 'missing');
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(' ZecBlock — Milestone 4 Verification');
  console.log(` Frontend: ${BASE}`);
  console.log(` API:      ${API}`);
  console.log(` Network:  ${IS_TESTNET ? 'Testnet' : 'Mainnet'} (NU7 at ${NU7_HEIGHT.toLocaleString('en-US')})`);
  console.log('═══════════════════════════════════════════════════════════════════════');

  await testNu7();
  await testShieldedRate();
  await testInfrastructure();
  await testZakura();

  separator('DELIVERABLES 5–7: Retrospective, 2027 Roadmap, Final Report');
  console.log('  Written reports, posted on the ZCG forum thread and GitHub issue #179.');

  console.log(`\n${'═'.repeat(70)}`);
  console.log(` RESULTS: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failures.length > 0) {
    console.log(' Failures:');
    failures.forEach((f) => console.log(`   • ${f}`));
  }
  console.log('═'.repeat(70));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
