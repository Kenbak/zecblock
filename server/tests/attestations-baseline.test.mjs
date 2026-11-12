import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonical, assertRecipe, baselineFromPublished, baselineFromReproduction } from '../scripts/attestation-baseline.mjs';
import store from '../lib/attestation-store.js';
const retired = JSON.parse(await readFile(new URL('../data/attestation-retired-endpoints.json', import.meta.url)));
const recipes = JSON.parse(await readFile(new URL('../data/attestation-build-inputs.json', import.meta.url)));
const endpoint = store.registry.find((entry) => entry.id === 'zecrocks-mainnet');
const manifest = recipes.endpoints[endpoint.id];
const pcrs = { PCR0: '1'.repeat(96), PCR1: '2'.repeat(96), PCR2: '3'.repeat(96) };
const record = { sourceUrl: endpoint.sourceUrl, commit: manifest.app_source.commit, pcrs };
const url = 'https://github.com/ShieldedLabs/zero-hub/releases/tag/example';
const now = Date.parse('2026-09-09T09:00:00Z');
const trusted = { pcr0: pcrs.PCR0, pcr1: pcrs.PCR1, pcr2: pcrs.PCR2, verified_at: new Date(now).toISOString(), tls: { domain: endpoint.hostname, certfp: 'a'.repeat(64) } };

test('all reproduction recipes pin the registered source; a manifest is not a release baseline', () => {
  for (const [id, recipe] of Object.entries(recipes.endpoints)) {
    const registered = [...store.registry, ...retired].find((entry) => entry.id === id);
    assertRecipe(registered, recipe);
    assert.ok(!Object.hasOwn(recipe, 'pcrs'));
  }
  assert.throws(() => assertRecipe(store.registry.find((entry) => entry.id === 'caution-hub'), {}), /No pinned source/);
  assert.equal(canonical({ b: 1, a: [2, 3] }), canonical({ a: [2, 3], b: 1 }));
});
test('changed commands, framework, commit or source cannot become reproduced baselines', () => {
  for (const field of ['run_command', 'framework_source', 'app_source']) {
    assert.throws(() => assertRecipe(endpoint, { ...manifest, [field]: 'changed' }), /manifest changed/);
  }
});
test('published baselines require complete measurements, source identity and HTTPS provenance', () => {
  assert.equal(baselineFromPublished(endpoint, record, url).authority, 'published');
  for (const changed of [{ ...record, sourceUrl: 'https://example.com/fake' }, { ...record, commit: 'main' }, { ...record, pcrs: { ...pcrs, PCR1: '0'.repeat(96) } }]) {
    assert.throws(() => baselineFromPublished(endpoint, changed, url));
  }
  assert.throws(() => baselineFromPublished(endpoint, record, 'http://example.com/release'));
  assert.throws(() => baselineFromPublished(endpoint, record, 'https://user:secret@example.com/release'));
});
test('reproductions reject reused trusted state, missing TLS and wrong domains', () => {
  assert.equal(baselineFromReproduction(endpoint, manifest, trusted, url, now - 1, now).authority, 'reproduced');
  for (const changed of [{ ...trusted, tls: null }, { ...trusted, tls: { ...trusted.tls, domain: 'example.com' } }, { ...trusted, verified_at: new Date(now - 60_000).toISOString() }, { ...trusted, verified_at: new Date(now + 60_000).toISOString() }]) {
    assert.throws(() => baselineFromReproduction(endpoint, manifest, changed, url, now - 1, now));
  }
});
test('API Docker context includes registry and shared freshness module', async () => {
  const dockerfile = await readFile(new URL('../api/Dockerfile', import.meta.url), 'utf8');
  const ignores = await readFile(new URL('../api/Dockerfile.dockerignore', import.meta.url), 'utf8');
  for (const path of ['server/data/attestation-endpoints.json', 'lib/attestation-status.js', 'lib/canary-status.js', 'lib/mining-software.js', 'server/canary/config.js']) {
    assert.ok(dockerfile.includes(`COPY ${path} `));
    assert.ok(ignores.includes(`!${path}\n`));
  }
});

test('activated reproduced baselines match preserved measurements and provenance hashes', async () => {
  const { sha256 } = await import('../scripts/attestation-baseline.mjs');
  for (const entry of store.registry.filter((item) => item.baseline?.authority === 'reproduced')) {
    const match = entry.baseline.referenceUrl.match(/^https:\/\/github\.com\/Kenbak\/cipherscan\/blob\/[a-f0-9]{40}\/server\/data\/attestation-builds\/([a-z0-9-]+)\/README\.md$/);
    assert.ok(match, 'Reproduced baseline needs an immutable preserved evidence reference');
    const directory = new URL(`../data/attestation-builds/${match[1]}/`, import.meta.url);
    const candidate = JSON.parse(await readFile(new URL('candidate.json', directory), 'utf8'));
    const manifest = JSON.parse(await readFile(new URL('built-manifest.json', directory), 'utf8'));
    const trustedRaw = await readFile(new URL('trusted_hashes.json', directory));
    const trustedState = JSON.parse(trustedRaw);
    assert.equal(candidate.endpointId, entry.id);
    assert.equal(candidate.hostname, entry.hostname);
    assert.equal(candidate.sourceUrl, entry.sourceUrl);
    assert.equal(candidate.baseline.commit, entry.baseline.commit);
    assert.equal(manifest.app_source.commit, entry.baseline.commit);
    assert.deepEqual(candidate.baseline.pcrs, entry.baseline.pcrs);
    for (const key of ['PCR0', 'PCR1', 'PCR2']) assert.equal(trustedState[key.toLowerCase()], entry.baseline.pcrs[key]);
    assert.equal(trustedState.tls.domain, entry.hostname);
    assert.equal(sha256(canonical(manifest)), candidate.evidence.manifestSha256);
    assert.equal(sha256(trustedRaw), candidate.evidence.trustedStateSha256);
    assert.equal(candidate.observation.release, 'reproduced_match');
    assert.equal(candidate.observation.tlsBinding, 'matched');
  }
});

test('reviewed hub configuration comes from the same preserved build as the active measurements', async () => {
  const entry = store.registry.find((item) => item.id === 'zecrocks-mainnet');
  const evidenceDir = entry.baseline.referenceUrl.match(/\/attestation-builds\/([a-z0-9-]+)\/README\.md$/)[1];
  const manifest = JSON.parse(await readFile(new URL(`../data/attestation-builds/${evidenceDir}/built-manifest.json`, import.meta.url)));
  assert.equal(manifest.app_source.commit, entry.baseline.commit);
  assert.ok(manifest.run_command.split('\n').includes(`export ZIS_HUB=${entry.baseline.hubConfiguration.address}`));
  assert.ok(manifest.run_command.split('\n').includes(`export ZIS_HUB_TLS=${entry.baseline.hubConfiguration.hostname}`));
  assert.equal(store.registry.find(item => item.id === entry.hubId).hostname, entry.baseline.hubConfiguration.hostname);
  assert.equal(entry.baseline.hubConfiguration.referenceUrl, entry.baseline.referenceUrl);
  for (const endpoint of store.registry.filter(item => item.baseline?.tag)) {
    assert.match(endpoint.baseline.tag, /^deploy-[a-z0-9-]+$/);
    assert.match(endpoint.baseline.tagReviewedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(endpoint.baseline.tagReferenceUrl, `${endpoint.sourceUrl}/tree/${endpoint.baseline.commit}`);
  }
});
