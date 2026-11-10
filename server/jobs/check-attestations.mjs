#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { observeEndpoint } from '../lib/attestation-verifier.mjs';
import store from '../lib/attestation-store.js';

export async function collectAttestations() {
  let previous = null;
  try { previous = await store.readSnapshot(); } catch { /* First run or corrupt snapshot: replace with fresh observations. */ }
  const observations = new Map();
  // Two concurrent checks bound sockets and OpenSSL processes independently of
  // the API. The systemd oneshot timer serializes complete collection runs.
  for (let offset = 0; offset < store.registry.length; offset += 2) {
    const batch = store.registry.slice(offset, offset + 2);
    const results = await Promise.all(batch.map((endpoint) => observeEndpoint(endpoint)));
    batch.forEach((endpoint, index) => observations.set(endpoint.id, results[index]));
  }
  // A shim's measured hub address can differ from what the hub's name resolves
  // to now, so challenge the address the shim's reproduced build actually pins.
  const pinnedHubs = new Map();
  for (const endpoint of store.registry) {
    const target = store.pinnedHubTarget(endpoint);
    if (target) pinnedHubs.set(endpoint.id, await observeEndpoint({ hostname: target.hostname, sourceUrl: null, baseline: null }, { dialAddress: target.ip }));
  }
  const snapshot = store.nextSnapshot(previous, observations, Date.now(), pinnedHubs);
  await store.saveSnapshot(snapshot);
  console.log(JSON.stringify({ generatedAt: snapshot.generatedAt, checks: snapshot.endpoints.map((entry) => ({
    id: entry.id, evidence: entry.latest.evidence, tlsBinding: entry.latest.tlsBinding, release: entry.latest.release, errorCode: entry.latest.errorCode,
  })) }));
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  collectAttestations().catch(() => { console.error('Attestation collection failed; previous snapshot retained.'); process.exitCode = 1; });
}
