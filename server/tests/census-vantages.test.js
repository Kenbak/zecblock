'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVantages, isCollectorSource, isPrimarySource, persistVantageStatus, MAX_VANTAGES } = require('../lib/census-vantages');
const { CHAIN_PROOF, CHAIN_BLOCK_HASH } = require('../lib/node-census');

test('collector sources match the migration 043 pattern', () => {
  for (const value of ['direct', 'tor', 'direct-nyc3', 'direct-sgp1', 'direct-syd1', 'direct-sao']) assert.equal(isCollectorSource(value), true, value);
  for (const value of ['', 'Direct', 'direct-', 'direct-n', 'direct-NYC3', 'direct-3nyc', 'tor-nyc3', 'direct-nyc_3', 'direct-nyc3 ', null]) {
    assert.equal(isCollectorSource(value), false, String(value));
  }
  assert.equal(isPrimarySource('direct'), true);
  assert.equal(isPrimarySource('tor'), true);
  assert.equal(isPrimarySource('direct-nyc3'), false);
});

test('vantage config admits only literal IPv4 crawler RPCs inside the private network', () => {
  assert.deepEqual(parseVantages(''), { vantages: [], errors: [] });
  assert.deepEqual(parseVantages(undefined), { vantages: [], errors: [] });
  const { vantages, errors } = parseVantages(' nyc3=10.77.0.2:54321, sgp1=10.77.0.3:54321 ,syd1=10.77.0.4:54321,');
  assert.deepEqual(errors, []);
  assert.deepEqual(vantages, [
    { source: 'direct-nyc3', host: '10.77.0.2', port: 54321 },
    { source: 'direct-sgp1', host: '10.77.0.3', port: 54321 },
    { source: 'direct-syd1', host: '10.77.0.4', port: 54321 },
  ]);
  const rejected = parseVantages([
    'pub=8.8.8.8:54321', 'lan=10.78.0.2:54321', 'dns=observer.example:54321', 'six=[fd00::2]:54321',
    'nyc3=10.77.0.2:0', 'nyc3=10.77.0.2:70000', 'NYC=10.77.0.5:54321', 'ok=10.77.0.6:54321',
    'ok=10.77.0.7:54321', 'dup=10.77.0.6:54321', 'noport=10.77.0.8',
  ].join(','));
  assert.deepEqual(rejected.vantages, [{ source: 'direct-ok', host: '10.77.0.6', port: 54321 }]);
  assert.equal(rejected.errors.length, 10);
  assert.ok(rejected.errors.every(error => !error.includes('8.8.8.8:54321') || error.includes('outside')));
  assert.deepEqual(parseVantages('a1=192.168.5.9:1', '192.168.5.0/24').vantages, [{ source: 'direct-a1', host: '192.168.5.9', port: 1 }]);
  assert.throws(() => parseVantages('a1=10.77.0.2:1', '0.0.0.0/0'), /CIDR/);
  const many = Array.from({ length: MAX_VANTAGES + 2 }, (_, i) => `v${i}x=10.77.0.${i + 10}:54321`).join(',');
  assert.equal(parseVantages(many).vantages.length, MAX_VANTAGES);
});

test('vantage status keeps last admitted facts on failure and prunes unconfigured sources', async () => {
  const calls = [];
  const client = { async query(sql, values) {
    calls.push({ sql, values });
    return { rows: /to_regclass/.test(sql) ? [{ status: 'census_vantage_status' }] : [] };
  } };
  const at = Date.parse('2026-11-05T00:00:00Z');
  assert.equal(await persistVantageStatus(client, [
    { source: 'direct', attemptedAtMs: at, outcome: 'admitted', generatedAtMs: at - 1000, verifiedEndpoints: 3, gossipSupported: true, gossipReceipts: 7 },
    { source: 'direct-nyc3', attemptedAtMs: at, outcome: 'unreachable' },
    { source: 'direct-sgp1', attemptedAtMs: at, outcome: 'admitted', generatedAtMs: at - 2000, verifiedEndpoints: 0, gossipSupported: false, gossipReceipts: null },
  ], ['direct', 'tor', 'direct-nyc3', 'direct-sgp1']), true);
  assert.deepEqual(calls[1].values, [['direct', 'tor', 'direct-nyc3', 'direct-sgp1']]);
  assert.match(calls[2].sql, /COALESCE\(EXCLUDED\.admitted_at, census_vantage_status\.admitted_at\)/);
  assert.deepEqual(calls[2].values, ['direct', new Date(at), 'admitted', new Date(at), new Date(at - 1000), 3, true, 7]);
  assert.deepEqual(calls[3].values, ['direct-nyc3', new Date(at), 'unreachable', null, null, null, null, null]);
  assert.deepEqual(calls[4].values, ['direct-sgp1', new Date(at), 'admitted', new Date(at), new Date(at - 2000), 0, false, null]);
  const missing = { async query() { return { rows: [{ status: null }] }; } };
  assert.equal(await persistVantageStatus(missing, [], []), false);
});

test('the ingester polls each vantage over its private address and admits sources independently', async () => {
  const { collectCrawlerSources, configuredVantages } = require('../jobs/ingest-crawl');
  const now = Date.parse('2026-11-05T00:00:00Z');
  const fresh = (addr) => ({ generated_at_ms: now - 1000, node_info: [{ addr, last_verified_at_ms: now - 6000,
    chain_verified_at_ms: now - 5000, chain_proof: CHAIN_PROOF, chain_block_hash: CHAIN_BLOCK_HASH }] });
  const calls = [];
  const rpc = async (method, port, host, options) => {
    calls.push([method, port ?? null, host ?? null, options?.timeout ?? null]);
    if (host === '10.77.0.3') throw new Error('ECONNREFUSED');
    if (host === '10.77.0.4') return { ...fresh('5.5.5.5:8233'), generated_at_ms: now - 10 * 60 * 1000 };
    return fresh(host ? '4.4.4.4:8233' : '1.1.1.1:8233');
  };
  const vantages = configuredVantages('nyc3=10.77.0.2:54321,sgp1=10.77.0.3:54321,syd1=10.77.0.4:54321,pub=8.8.8.8:54321');
  assert.equal(vantages.length, 3, 'a public address is never polled');
  const sources = await collectCrawlerSources({ rpc, vantages, now: () => now });
  assert.deepEqual(sources.map(source => [source.source, source.outcome]), [
    ['direct', 'admitted'], ['tor', 'admitted'], ['direct-nyc3', 'admitted'],
    ['direct-sgp1', 'unreachable'], ['direct-syd1', 'rejected'],
  ]);
  assert.deepEqual(calls.slice(2).map(call => call.slice(1)), [[54321, '10.77.0.2', 15000], [54321, '10.77.0.3', 15000], [54321, '10.77.0.4', 15000]]);
  assert.equal(calls[0][2], null, 'the primary collectors keep their loopback defaults');
  assert.equal(sources[2].verifiedEndpoints, 1);
  assert.equal(sources[3].metrics, null);
});

test('the collector watchdog keeps primary defaults and accepts an observer override', () => {
  const { healthTargets } = require('../jobs/check-crawler-health');
  assert.deepEqual(healthTargets(''), [['127.0.0.1:54321', 'zcash-crawler.service'], ['127.0.0.1:54322', 'zcash-crawler-tor.service']]);
  assert.deepEqual(healthTargets('10.77.0.2:54321=zcash-crawler.service'), [['10.77.0.2:54321', 'zcash-crawler.service']]);
  for (const bad of ['10.77.0.2:54321=sshd.service', 'host:1=zcash-crawler.service', '10.77.0.2:54321=zcash-crawler.service;reboot']) {
    assert.throws(() => healthTargets(bad), /Invalid/, bad);
  }
});
