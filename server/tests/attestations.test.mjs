import test from 'node:test';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { randomBytes, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { checkEvidencePolicy, checkRelease, isPublicAddress, verifyCertificatePath, fetchAttestation, publicLookup, pinnedLookup, MAX_RESPONSE_BYTES, DEADLINE_MS, MAX_DOCUMENT_AGE_MS, CLOCK_SKEW_MS } from '../lib/attestation-verifier.mjs';
import { encode } from '../vendor/tee-attestation-js/src/lib/cbor.js';
import { verify } from '../vendor/tee-attestation-js/src/tee/nitro.js';
import { X509Certificate } from 'node:crypto';
import store from '../lib/attestation-store.js';
import statuses from '../../lib/attestation-status.js';
const require = createRequire(import.meta.url);
const express = require('../api/node_modules/express');
const { createAttestationRouter } = require('../api/routes/attestations');
const NOW = Date.parse('2026-09-09T00:00:00Z');
const pcrs = { PCR0: '1'.repeat(96), PCR1: '2'.repeat(96), PCR2: '3'.repeat(96) };
const fingerprint = 'a'.repeat(64);
const evidence = () => ({ verified: true, pcrs, digest: 'SHA384', timestamp: NOW, userData: { tls: { mode: 'tls', domain: 'example.com', certfp: fingerprint } } });
const success = (overrides = {}) => ({ checkedAt: new Date(NOW).toISOString(), reachable: true, evidence: 'verified', tlsBinding: 'matched', release: 'unconfirmed', errorCode: null, attestedAt: new Date(NOW).toISOString(), pcrs, certificateFingerprint: fingerprint, documentSha256: fingerprint, claimedCommit: null, verifier: 'test', ...overrides });
const snapshot = () => store.nextSnapshot(null, new Map(store.registry.map((e) => [e.id, success()])), NOW);

test('binding policy requires signed mode, exact hostname and same-connection certificate', () => {
  assert.equal(checkEvidencePolicy(evidence(), 'example.com', fingerprint, NOW), true);
  assert.equal(checkEvidencePolicy(evidence(), 'other.example.com', fingerprint, NOW), false);
  assert.equal(checkEvidencePolicy(evidence(), 'example.com', 'b'.repeat(64), NOW), false);
  assert.equal(checkEvidencePolicy({ ...evidence(), userData: null }, 'example.com', fingerprint, NOW), false);
});

test('rejects failed signature/nonce, debug/missing/malformed PCRs, wrong digest and stale/future evidence', () => {
  for (const change of [
    { verified: false }, { digest: 'SHA256' }, { pcrs: {} },
    { pcrs: { ...pcrs, PCR0: '0'.repeat(96) } }, { pcrs: { ...pcrs, PCR2: 'abc' } },
    { timestamp: NOW - MAX_DOCUMENT_AGE_MS - 1 }, { timestamp: NOW + CLOCK_SKEW_MS + 1 }, { timestamp: null },
  ]) assert.throws(() => checkEvidencePolicy({ ...evidence(), ...change }, 'example.com', fingerprint, NOW));
});

test('release baselines are independent and complete; a match is not necessarily reproduced', () => {
  assert.equal(checkRelease(pcrs, null), 'unconfirmed');
  const baseline = { pcrs, authority: 'published', commit: 'a'.repeat(40), referenceUrl: 'https://example.com/release' };
  assert.equal(checkRelease(pcrs, baseline), 'published_match');
  assert.equal(checkRelease(pcrs, { ...baseline, authority: 'reproduced' }), 'reproduced_match');
  assert.equal(checkRelease({ ...pcrs, PCR1: 'a'.repeat(96) }, baseline), 'mismatch');
  for (const change of [{ pcrs: { PCR0: pcrs.PCR0 } }, { authority: 'observed' }, { commit: 'main' }, { referenceUrl: '' }]) {
    assert.throws(() => checkRelease(pcrs, { ...baseline, ...change }));
  }
});

test('private, loopback, link-local, mapped IPv6 and special-use destinations are rejected', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1', '192.0.2.1', '::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('1.1.1.1'), true);
});

test('current failures never inherit an earlier success and a dead worker expires at fifteen minutes', () => {
  const previous = snapshot();
  const failure = success({ checkedAt: new Date(NOW + 1000).toISOString(), reachable: false, evidence: 'not_checked', tlsBinding: 'not_checked', pcrs: null, errorCode: 'timeout' });
  const next = store.nextSnapshot(previous, new Map(store.registry.map((e) => [e.id, failure])), NOW + 1000);
  const published = store.publicSnapshot(next, 'mainnet', NOW + 1000);
  assert.equal(published.endpoints[0].status, 'unreachable');
  assert.deepEqual(published.endpoints[0].lastSuccessful, previous.endpoints[0].latest);
  assert.equal(statuses.attestationStatus(success(), NOW + statuses.FRESH_FOR_MS - 1), 'verified');
  assert.equal(statuses.attestationStatus(success(), NOW + statuses.FRESH_FOR_MS), 'stale');
  assert.equal(statuses.attestationStatus(success({ checkedAt: new Date(NOW + CLOCK_SKEW_MS + 1).toISOString() }), NOW), 'unavailable');
});

test('snapshots enforce schema, network isolation, registry identities and invalid storage semantics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'attestation-store-test-'));
  try {
    const path = join(dir, 'snapshot.json');
    const value = snapshot();
    await store.saveSnapshot(value, path);
    assert.deepEqual(await store.readSnapshot(path), value);
    assert.equal(store.publicSnapshot(value, 'mainnet', NOW).endpoints.length, 2);
    assert.equal(store.publicSnapshot(value, 'testnet', NOW).endpoints.length, 1);
    assert.equal(store.publicSnapshot(value, 'crosslink-testnet', NOW).endpoints.length, 0);
    value.endpoints[0].identity = '0'.repeat(64);
    assert.equal(store.publicSnapshot(value, 'mainnet', NOW).endpoints[0].latest, null);
    for (const invalid of [null, {}, { ...snapshot(), version: 2 }, { ...snapshot(), endpoints: [{ id: 'bad' }] }]) {
      assert.equal(store.publicSnapshot(invalid, 'mainnet', NOW).available, false);
      assert.ok(store.publicSnapshot(invalid, 'mainnet', NOW).endpoints.every((e) => e.latest === null));
    }
    await writeFile(path, '{corrupt');
    await assert.rejects(store.readSnapshot(path));
    await writeFile(path, 'x'.repeat(300 * 1024));
    await assert.rejects(store.readSnapshot(path));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('actual HTTP API exposes public observations, missing IDs return 404 and no request triggers a probe', async () => {
  const app = express();
  let value = snapshot();
  app.use(createAttestationRouter({ network: 'testnet', now: () => NOW, read: async () => value }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/network/attestations`;
  try {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, follow');
    const result = await response.json();
    assert.equal(result.endpoints.length, 1);
    assert.equal(result.network, 'testnet');
    assert.equal((await fetch(`${base}/zecrocks-mainnet`)).status, 404);
    assert.equal((await fetch(`${base}/unknown`)).status, 404);
    assert.equal((await (await fetch(`${base}/zecrocks-testnet`)).json()).endpoint.id, 'zecrocks-testnet');
    value = null;
    const unavailable = await (await fetch(base)).json();
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.endpoints[0].status, 'not_checked');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('real COSE verification rejects wrong nonces and signatures; synthetic roots never pass the production trust path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'attestation-crypto-test-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  try {
    run('ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', 'root.key');
    run('req', '-new', '-x509', '-sha384', '-key', 'root.key', '-out', 'root.crt', '-days', '1', '-subj', '/CN=Test root', '-addext', 'basicConstraints=critical,CA:TRUE');
    run('ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', 'leaf.key');
    run('req', '-new', '-key', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=Test leaf');
    run('x509', '-req', '-sha384', '-in', 'leaf.csr', '-CA', 'root.crt', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '1');
    const root = await readFile(join(dir, 'root.crt'), 'utf8');
    const leaf = await readFile(join(dir, 'leaf.crt'), 'utf8');
    const key = await readFile(join(dir, 'leaf.key'));
    const nonce = randomBytes(32);
    const protectedHeader = Uint8Array.of(0xa1, 0x01, 0x38, 0x22);
    const payload = encode({ digest: 'SHA384', timestamp: Date.now(), nonce,
      certificate: new X509Certificate(leaf).raw, cabundle: [new X509Certificate(root).raw],
      pcrs: { 0: Buffer.from(pcrs.PCR0, 'hex'), 1: Buffer.from(pcrs.PCR1, 'hex'), 2: Buffer.from(pcrs.PCR2, 'hex') } });
    const signature = sign('sha384', encode(['Signature1', protectedHeader, new Uint8Array(), payload]), { key, dsaEncoding: 'ieee-p1363' });
    const document = encode([protectedHeader, {}, payload, signature]);
    assert.equal((await verify(document, { nonce, rootCert: root })).verified, true);
    assert.match((await verify(document, { nonce: randomBytes(32), rootCert: root })).error, /Nonce mismatch/);
    const altered = Buffer.from(document); altered[altered.length - 1] ^= 1;
    assert.match((await verify(altered, { nonce, rootCert: root })).error, /signature verification failed/);
    assert.equal((await verify(document, { nonce })).verified, false);
    await assert.rejects(verifyCertificatePath(document), (error) => error.code === 'invalid_certificate_chain');
    await assert.rejects(verifyCertificatePath(Uint8Array.of(1, 2, 3)), (error) => error.code === 'invalid_document');
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('HTTPS transport rejects redirects, malformed/oversized bodies and slow responses', async (t) => {
  let scenario = 'valid';
  t.mock.method(https, 'request', (options, onResponse) => {
    assert.equal(options.path, '/attestation');
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.lookup, publicLookup);
    const request = new EventEmitter();
    request.destroy = (error) => { request.emit('error', error); request.emit('close'); };
    request.end = (body) => {
      assert.equal(Buffer.from(JSON.parse(body).nonce, 'base64').length, 32);
      if (scenario === 'slow') return;
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = scenario === 'redirect' ? 302 : 200;
        response.socket = { getPeerCertificate: () => ({ raw: Buffer.from('test certificate') }) };
        response.resume = () => request.emit('close');
        onResponse(response);
        if (scenario === 'redirect') return;
        response.emit('data', Buffer.from(scenario === 'oversized' ? 'x'.repeat(MAX_RESPONSE_BYTES + 1) : scenario === 'malformed' ? '{bad' : '{"document":"test"}'));
        response.emit('end');
        request.emit('close');
      });
    };
    return request;
  });
  assert.equal((await fetchAttestation('example.com', randomBytes(32))).body.document, 'test');
  for (const [value, code] of [['redirect', 'http_error'], ['oversized', 'response_too_large'], ['malformed', 'invalid_response']]) {
    scenario = value;
    await assert.rejects(fetchAttestation('example.com', randomBytes(32)), (error) => error.code === code);
  }
  scenario = 'slow';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = fetchAttestation('example.com', randomBytes(32));
  const assertion = assert.rejects(pending, (error) => error.code === 'timeout');
  t.mock.timers.tick(DEADLINE_MS);
  await assertion;
});

test('current build confirmation expires and never survives a failed or different observation', () => {
  const entry = store.registry.find(item => item.id === 'zecrocks-mainnet');
  const endpoint = { ...entry, latest: success({ release: 'reproduced_match' }) };
  assert.equal(statuses.matchesReproducedBuild(endpoint, NOW), true);
  assert.equal(statuses.matchesReproducedBuild(endpoint, NOW + statuses.FRESH_FOR_MS), false);
  for (const changed of [{release:'mismatch'}, {release:'unconfirmed'}, {release:'published_match'}, {tlsBinding:'mismatch'}, {reachable:false}, {evidence:'failed'}]) {
    assert.equal(statuses.matchesReproducedBuild({ ...endpoint, latest: { ...endpoint.latest, ...changed } }, NOW), false);
  }
  assert.equal(statuses.matchesReproducedBuild({...endpoint, baseline:{...endpoint.baseline,authority:'published'}}, NOW), false);
  const data = store.publicSnapshot(snapshot(), 'mainnet', NOW);
  const exposed = data.endpoints.find(item => item.id === entry.id);
  assert.equal(exposed.baseline.tag, entry.baseline.tag);
  assert.equal(exposed.hubConfiguration.hostname, 'hub.zcash.caution.co');
});

test('retired test endpoints are absent even from retained snapshots and return 404', async () => {
  const old = snapshot();
  old.endpoints.push({id:'shieldedlabs-hub',identity:'a'.repeat(64),latest:success(),lastSuccessful:null});
  assert.ok(!store.publicSnapshot(old,'mainnet',NOW).endpoints.some(e=>e.id.startsWith('shieldedlabs-')));
  const app=express();app.use(createAttestationRouter({network:'mainnet',read:async()=>old,now:()=>NOW}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try {
    for(const id of ['shieldedlabs-hub','shieldedlabs-shim']) assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/network/attestations/${id}`)).status,404);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('pinned hub lookups dial only the reviewed public address', () => {
  const answers = [];
  pinnedLookup('54.151.176.23')('hub.zcash.caution.co', {}, (...args) => answers.push(args));
  pinnedLookup('54.151.176.23')('hub.zcash.caution.co', { all: true }, (...args) => answers.push(args));
  assert.deepEqual(answers, [[null, '54.151.176.23', 4], [null, [{ address: '54.151.176.23', family: 4 }]]]);
  pinnedLookup('10.0.0.1')('hub.zcash.caution.co', {}, (error) => assert.equal(error.code, 'private_address'));
});

test('pinned hub targets only accept a literal IPv4 address on 443', () => {
  const entry = (address) => ({ baseline: { hubConfiguration: { hostname: 'hub.example', address } } });
  assert.deepEqual(store.pinnedHubTarget(entry('54.151.176.23:443')), { ip: '54.151.176.23', hostname: 'hub.example', address: '54.151.176.23:443' });
  for (const address of ['54.151.176.23:8443', 'hub.example:443', undefined]) assert.equal(store.pinnedHubTarget(entry(address)), null);
  assert.equal(store.pinnedHubTarget({ baseline: null }), null);
});

test('hub deployment comparison needs two bound answers and reports certificate or PCR differences', () => {
  const pinned = success();
  assert.equal(store.compareHubDeployments(pinned, success()), 'same');
  assert.equal(store.compareHubDeployments(pinned, { ...success(), certificateFingerprint: 'c'.repeat(64) }), 'different');
  assert.equal(store.compareHubDeployments(pinned, { ...success(), pcrs: { ...pinned.pcrs, PCR0: 'd'.repeat(96) } }), 'different');
  for (const other of [undefined, { ...success(), tlsBinding: 'mismatch' }, { ...success(), evidence: 'failed' }]) assert.equal(store.compareHubDeployments(pinned, other), 'unknown');
  assert.equal(store.compareHubDeployments({ ...pinned, evidence: 'not_checked' }, success()), 'unknown');
});

test('pinned hub observations are optional, validated and served only for configured shims', () => {
  const entry = store.registry.find((item) => item.id === 'zecrocks-mainnet');
  const observations = new Map(store.registry.map((item) => [item.id, success()]));
  const next = store.nextSnapshot(null, observations, NOW, new Map([[entry.id, { ...success(), certificateFingerprint: 'c'.repeat(64) }]]));
  assert.ok(store.validateSnapshot(next));
  assert.equal(next.endpoints.find((item) => item.id === entry.id).pinnedHub.listedHub, 'different');
  const exposed = store.publicSnapshot(next, 'mainnet', NOW).endpoints;
  assert.equal(exposed.find((item) => item.id === entry.id).pinnedHub.address, entry.baseline.hubConfiguration.address);
  assert.equal(exposed.find((item) => item.id === 'caution-hub').pinnedHub, null);
  const older = store.nextSnapshot(null, observations, NOW);
  assert.ok(store.validateSnapshot(older));
  assert.equal(store.publicSnapshot(older, 'mainnet', NOW).endpoints.find((item) => item.id === entry.id).pinnedHub, null);
  const corrupt = structuredClone(next);
  corrupt.endpoints.find((item) => item.id === entry.id).pinnedHub.listedHub = 'yes';
  assert.equal(store.validateSnapshot(corrupt), false);
  assert.throws(() => store.nextSnapshot(null, observations, NOW, new Map([[entry.id, { checkedAt: 'bad' }]])));
});
