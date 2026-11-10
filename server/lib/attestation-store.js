const { readFile, stat, mkdir, rename, writeFile, unlink } = require('node:fs/promises');
const { dirname } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const registry = require('../data/attestation-endpoints.json');
const { FRESH_FOR_MS, attestationStatus } = require('../../lib/attestation-status');
const SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const DEFAULT_SNAPSHOT_PATH = '/var/lib/cipherscan/attestations/snapshot.json';
const getSnapshotPath = () => process.env.ATTESTATION_SNAPSHOT_PATH || DEFAULT_SNAPSHOT_PATH;
const identity = (endpoint) => createHash('sha256').update(JSON.stringify(endpoint)).digest('hex');
const isoDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value);

function validCheck(check) {
  if (!check || !isoDate(check.checkedAt) || typeof check.reachable !== 'boolean'
    || !['verified', 'failed', 'not_checked'].includes(check.evidence)
    || !['matched', 'mismatch', 'not_checked'].includes(check.tlsBinding)
    || !['unconfirmed', 'published_match', 'reproduced_match', 'mismatch'].includes(check.release)
    || !(check.errorCode === null || /^[a-z_]{1,64}$/.test(check.errorCode ?? ''))
    || typeof check.verifier !== 'string' || check.verifier.length > 150) return false;
  if (check.claimedCommit !== null && !hex(check.claimedCommit, 40)) return false;
  if (check.evidence === 'verified') {
    return check.reachable && isoDate(check.attestedAt)
      && ['PCR0', 'PCR1', 'PCR2'].every((key) => hex(check.pcrs?.[key], 96) && check.pcrs[key] !== '0'.repeat(96))
      && hex(check.certificateFingerprint, 64) && hex(check.documentSha256, 64);
  }
  return check.tlsBinding === 'not_checked' && check.release === 'unconfirmed';
}

// The registry address is `ip:port`; the observer only speaks HTTPS on 443.
function pinnedHubTarget(endpoint) {
  const configuration = endpoint.baseline?.hubConfiguration;
  const ip = configuration?.address?.match(/^(\d{1,3}(?:\.\d{1,3}){3}):443$/)?.[1];
  return ip ? { ip, hostname: configuration.hostname, address: configuration.address } : null;
}

// Compares two observations from one collector run. Anything short of two
// bound, verified answers stays unknown rather than implying a split or a match.
function compareHubDeployments(pinned, listed) {
  const bound = (check) => check?.evidence === 'verified' && check.tlsBinding === 'matched';
  if (!bound(pinned) || !bound(listed)) return 'unknown';
  const same = pinned.certificateFingerprint === listed.certificateFingerprint
    && ['PCR0', 'PCR1', 'PCR2'].every((key) => pinned.pcrs[key] === listed.pcrs[key]);
  return same ? 'same' : 'different';
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== SNAPSHOT_VERSION || !isoDate(snapshot.generatedAt)
    || !Array.isArray(snapshot.endpoints) || snapshot.endpoints.length > 100) return false;
  const ids = new Set();
  return snapshot.endpoints.every((entry) => {
    if (!entry || typeof entry.id !== 'string' || ids.has(entry.id) || !hex(entry.identity, 64)
      || !validCheck(entry.latest) || (entry.lastSuccessful !== null && !validCheck(entry.lastSuccessful))) return false;
    if (entry.lastSuccessful && (entry.lastSuccessful.evidence !== 'verified'
      || entry.lastSuccessful.tlsBinding !== 'matched'
      || entry.lastSuccessful.release === 'mismatch'
      || Date.parse(entry.lastSuccessful.checkedAt) > Date.parse(entry.latest.checkedAt))) return false;
    // Optional so snapshots written before this field remain readable.
    if (entry.pinnedHub !== undefined && (!validCheck(entry.pinnedHub?.latest)
      || !['same', 'different', 'unknown'].includes(entry.pinnedHub.listedHub))) return false;
    ids.add(entry.id);
    return true;
  });
}

async function readSnapshot(path = getSnapshotPath()) {
  // Stat first and bound the read again: do not parse arbitrarily large files.
  const info = await stat(path);
  if (info.size > MAX_SNAPSHOT_BYTES) throw new Error('Invalid attestation snapshot');
  const raw = await readFile(path, 'utf8');
  if (Buffer.byteLength(raw) > MAX_SNAPSHOT_BYTES) throw new Error('Invalid attestation snapshot');
  const snapshot = JSON.parse(raw);
  if (!validateSnapshot(snapshot)) throw new Error('Invalid attestation snapshot');
  return snapshot;
}

async function saveSnapshot(snapshot, path = getSnapshotPath()) {
  if (!validateSnapshot(snapshot)) throw new Error('Invalid attestation snapshot');
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o640, flag: 'wx' });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

function nextSnapshot(previous, observations, now = Date.now(), pinnedHubs = new Map()) {
  const endpoints = registry.map((endpoint) => {
    const latest = observations.get(endpoint.id);
    if (!validCheck(latest)) throw new Error('Missing or invalid observation');
    const previousEntry = previous?.endpoints.find((entry) => entry.id === endpoint.id && entry.identity === identity(endpoint));
    const pinned = pinnedHubs.get(endpoint.id);
    if (pinned && !validCheck(pinned)) throw new Error('Missing or invalid observation');
    return { id: endpoint.id, identity: identity(endpoint), latest,
      lastSuccessful: attestationStatus(latest, now) === 'verified' ? latest : previousEntry?.lastSuccessful ?? null,
      ...(pinned ? { pinnedHub: { latest: pinned, listedHub: compareHubDeployments(pinned, observations.get(endpoint.hubId)) } } : {}) };
  });
  return { version: SNAPSHOT_VERSION, generatedAt: new Date(now).toISOString(), endpoints };
}

function publicSnapshot(snapshot, network, now = Date.now()) {
  // Treat future collector clocks and malformed files as unavailable, never green.
  const usable = validateSnapshot(snapshot) && Date.parse(snapshot.generatedAt) <= now + 30_000;
  const endpoints = registry.filter((endpoint) => endpoint.network === network).map((endpoint) => {
    const entry = usable ? snapshot.endpoints.find((item) => item.id === endpoint.id && item.identity === identity(endpoint)) : null;
    return { id: endpoint.id, name: endpoint.name, network: endpoint.network, role: endpoint.role,
      hostname: endpoint.hostname, attestationUrl: `https://${endpoint.hostname}/attestation`,
      sourceUrl: endpoint.sourceUrl, referenceUrl: endpoint.referenceUrl,
      hubId: endpoint.hubId, experimental: true, configurationAuthority: endpoint.baseline?.hubConfiguration ? 'Reproduced build configuration; current match required' : 'Published configuration; not reproduced',
      hubConfiguration: endpoint.baseline?.hubConfiguration ? { ...endpoint.baseline.hubConfiguration, authority: 'reproduced' } : null,
      baseline: endpoint.baseline ? { authority: endpoint.baseline.authority, commit: endpoint.baseline.commit, referenceUrl: endpoint.baseline.referenceUrl, tag: endpoint.baseline.tag ?? null, tagReferenceUrl: endpoint.baseline.tagReferenceUrl ?? null } : null,
      pinnedHub: entry?.pinnedHub && pinnedHubTarget(endpoint) ? { address: pinnedHubTarget(endpoint).address, hostname: pinnedHubTarget(endpoint).hostname, ...entry.pinnedHub } : null,
      latest: entry?.latest ?? null, lastSuccessful: entry?.lastSuccessful ?? null,
      status: attestationStatus(entry?.latest, now) };
  });
  return { success: true, network, generatedAt: usable ? snapshot.generatedAt : null,
    servedAt: new Date(now).toISOString(), freshForMs: FRESH_FOR_MS, pollIntervalMs: 300_000,
    available: Boolean(usable), endpoints };
}

module.exports = { registry, identity, pinnedHubTarget, compareHubDeployments, validCheck, validateSnapshot, readSnapshot, saveSnapshot, nextSnapshot, publicSnapshot, getSnapshotPath };
