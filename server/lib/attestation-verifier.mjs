import https from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, verify, ROOT_CERT } from '../vendor/tee-attestation-js/src/tee/nitro.js';

export const VERIFIER_VERSION = 'cipherscan-nitro-v1:ba0d0c57de673c8576c91a8730775a87575f5c10';
export const DEADLINE_MS = 15_000;
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_DOCUMENT_AGE_MS = 5 * 60_000;
export const CLOCK_SKEW_MS = 30_000;
const execFileAsync = promisify(execFile);

export class ObservationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Resolve once into the socket: validation must cover the actual address dialed,
// not a preflight DNS answer that can change before the connection.
export function isPublicAddress(address) {
  if (isIP(address) !== 4) return false; // Observer deliberately uses IPv4 only.
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && [0, 2, 168].includes(b))
    || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
}

export function publicLookup(hostname, options, callback) {
  lookup(hostname, { family: 4, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      return callback(new ObservationError('private_address'));
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, 4);
  });
}

// Dials one reviewed address while the hostname still drives SNI, certificate
// validation and the attested TLS binding. Same public-address rule as DNS.
export function pinnedLookup(address) {
  return (_hostname, options, callback) => {
    if (!isPublicAddress(address)) return callback(new ObservationError('private_address'));
    if (options.all) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  };
}

export function fetchAttestation(hostname, nonce, dialAddress = null) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname, port: 443, path: '/attestation', method: 'POST', agent: false,
      lookup: dialAddress ? pinnedLookup(dialAddress) : publicLookup, family: 4, rejectUnauthorized: true,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'CipherScan-Attestation/1.0' },
    }, (response) => {
      // Redirects are never followed. A TLS cert belongs to this connection.
      if (response.statusCode !== 200) {
        response.resume();
        reject(new ObservationError('http_error'));
        return;
      }
      const leaf = response.socket.getPeerCertificate().raw;
      if (!leaf) { response.destroy(); reject(new ObservationError('tls_certificate_missing')); return; }
      const leafFingerprint = createHash('sha256').update(leaf).digest('hex');
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) request.destroy(new ObservationError('response_too_large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ body: JSON.parse(Buffer.concat(chunks)), leafFingerprint }); }
        catch { reject(new ObservationError('invalid_response')); }
      });
    });
    // Wall-clock deadline includes DNS, handshake and a slow/trickling body.
    const timer = setTimeout(() => request.destroy(new ObservationError('timeout')), DEADLINE_MS);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end(JSON.stringify({ nonce: nonce.toString('base64') }));
  });
}

// The upstream browser library authenticates chain signatures. OpenSSL adds full
// X.509 path/CA constraints using only the pinned Nitro root, not system roots.
export async function verifyCertificatePath(document) {
  let parsed;
  try { parsed = parse(document); } catch { throw new ObservationError('invalid_document'); }
  if (!Array.isArray(parsed.cabundle) || parsed.cabundle.length > 8 || !parsed.payload.certificate) {
    throw new ObservationError('invalid_certificate_chain');
  }
  const dir = await mkdtemp(join(tmpdir(), 'cipherscan-attestation-'));
  try {
    const pem = (der) => new X509Certificate(der).toString();
    await Promise.all([
      writeFile(join(dir, 'root'), ROOT_CERT, { mode: 0o600 }),
      writeFile(join(dir, 'leaf'), pem(parsed.payload.certificate), { mode: 0o600 }),
      writeFile(join(dir, 'chain'), parsed.cabundle.map(pem).join('\n'), { mode: 0o600 }),
    ]);
    await execFileAsync('openssl', ['verify', '-no-CAfile', '-no-CApath', '-no-CAstore',
      '-trusted', join(dir, 'root'), '-untrusted', join(dir, 'chain'), join(dir, 'leaf')],
    { timeout: 5000, maxBuffer: 8192 });
  } catch (error) {
    if (error.code === 'ENOENT') throw new ObservationError('verifier_unavailable');
    throw new ObservationError('invalid_certificate_chain');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export function checkEvidencePolicy(result, hostname, fingerprint, now = Date.now()) {
  if (!result.verified) throw new ObservationError('invalid_attestation');
  if (result.digest !== 'SHA384' || !['PCR0', 'PCR1', 'PCR2'].every((key) =>
    /^[0-9a-f]{96}$/.test(result.pcrs?.[key] ?? '') && result.pcrs[key] !== '0'.repeat(96))) {
    throw new ObservationError('invalid_measurements');
  }
  if (!Number.isSafeInteger(result.timestamp) || result.timestamp < now - MAX_DOCUMENT_AGE_MS
    || result.timestamp > now + CLOCK_SKEW_MS) throw new ObservationError('invalid_timestamp');
  const tls = result.userData?.tls;
  return Boolean(tls?.mode === 'tls' && tls.domain === hostname
    && /^[0-9a-f]{64}$/.test(tls.certfp ?? '') && tls.certfp === fingerprint);
}

export function checkRelease(pcrs, baseline) {
  if (!baseline) return 'unconfirmed';
  // Never infer expected values from the attestation or its unsigned manifest.
  if (!['published', 'reproduced'].includes(baseline.authority)
    || !/^[0-9a-f]{40}$/.test(baseline.commit ?? '')
    || !baseline.referenceUrl?.startsWith('https://')
    || !['PCR0', 'PCR1', 'PCR2'].every((key) => /^[0-9a-f]{96}$/.test(baseline.pcrs?.[key] ?? '')
      && baseline.pcrs[key] !== '0'.repeat(96))) throw new ObservationError('invalid_baseline');
  return ['PCR0', 'PCR1', 'PCR2'].every((key) => pcrs[key] === baseline.pcrs[key])
    ? (baseline.authority === 'reproduced' ? 'reproduced_match' : 'published_match') : 'mismatch';
}

export async function observeEndpoint(endpoint, { dialAddress = null } = {}) {
  const checkedAt = new Date().toISOString();
  let reachable = false;
  try {
    const nonce = randomBytes(32);
    const { body, leafFingerprint } = await fetchAttestation(endpoint.hostname, nonce, dialAddress);
    reachable = true;
    if (typeof body?.document !== 'string' || body.document.length > MAX_RESPONSE_BYTES
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.document)
      || !body.document) throw new ObservationError('invalid_document');
    const document = Buffer.from(body.document, 'base64');
    await verifyCertificatePath(document);
    const result = await verify(document, { nonce });
    const tlsBound = checkEvidencePolicy(result, endpoint.hostname, leafFingerprint);
    const release = checkRelease(result.pcrs, endpoint.baseline);
    const claimed = body.manifest?.app_source;
    // Never turn manifest URLs into links or commands. Only expose a bounded
    // commit when the claim names the repository already in our local registry.
    const normalize = (url) => typeof url === 'string' ? url.replace(/\.git$/, '').replace(/\/$/, '') : '';
    const claimedCommit = endpoint.sourceUrl && Array.isArray(claimed?.urls)
      && claimed.urls.some((url) => normalize(url) === normalize(endpoint.sourceUrl))
      && /^[0-9a-f]{40}$/.test(claimed.commit ?? '') ? claimed.commit : null;
    return { checkedAt, reachable, evidence: 'verified', tlsBinding: tlsBound ? 'matched' : 'mismatch',
      release, errorCode: tlsBound ? null : 'tls_binding_mismatch',
      attestedAt: new Date(result.timestamp).toISOString(),
      pcrs: Object.fromEntries(['PCR0', 'PCR1', 'PCR2'].map((key) => [key, result.pcrs[key]])),
      certificateFingerprint: leafFingerprint, documentSha256: createHash('sha256').update(document).digest('hex'),
      claimedCommit, verifier: VERIFIER_VERSION };
  } catch (error) {
    return { checkedAt, reachable, evidence: reachable ? 'failed' : 'not_checked', tlsBinding: 'not_checked',
      release: 'unconfirmed', errorCode: error instanceof ObservationError ? error.code : 'connection_failed',
      attestedAt: null, pcrs: null, certificateFingerprint: null, documentSha256: null,
      claimedCommit: null, verifier: VERIFIER_VERSION };
  }
}
