import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readStateJson, readStateBytes } from './state-files.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const REQUEST_BYTES = 20992, LAYER_REPLY_BYTES = 81920, LAYER_PUBLIC_BYTES = 360448;
const DEADLINE_MS = 900_000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
export function canonicalGlobal(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalGlobal).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalGlobal(value[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  assert(encoded !== undefined && (typeof value !== 'number' || Number.isFinite(value)), 'Invalid canonical value.');
  return encoded;
}
export function admitGlobalManifest(manifest) {
  assert(manifest?.schema === 'zecblock-private-global-v1' && manifest.geometry === 'global-2k-64k'
    && manifest.table === 'txdirectory' && manifest.network === 'mainnet'
    && manifest.rows === 2048 && manifest.rowBytes === 65536 && manifest.payloadBytes === 65024
    && manifest.hashAlgorithm === 'sha256-display-v1'
    && ['full-envelope-zlib-v1', 'full-envelope-binary-zlib-v2'].includes(manifest.recordCodec)
    && Number.isSafeInteger(manifest.layerCount) && manifest.layerCount >= 1 && manifest.layerCount <= 128
    && Array.isArray(manifest.layers) && manifest.layers.length === manifest.layerCount
    && HASH.test(manifest.contextId) && HASH.test(manifest.publicationId), 'Unsupported global manifest.');
  assert(manifest.scheme?.request_bytes === REQUEST_BYTES && manifest.scheme.response_bytes === LAYER_REPLY_BYTES
    && manifest.scheme.public_bytes === LAYER_PUBLIC_BYTES, 'Unsupported global wire geometry.');
  const { publicationId, ...identity } = manifest;
  assert(sha(Buffer.from(canonicalGlobal(identity))) === publicationId, 'Global publication identity mismatch.');
  const contextId = identity.contextId;
  const context = Object.fromEntries(Object.entries(identity).filter(([key]) => !['contextId', 'layers', 'noiseCertificate'].includes(key)));
  assert(sha(Buffer.from(canonicalGlobal(context))) === contextId, 'Global context identity mismatch.');
  assert(HASH.test(manifest.sourceSummary?.canonicalAnchorsSha256)
    && Number.isSafeInteger(manifest.sourceSummary.canonicalAnchorCount)
    && manifest.sourceSummary.canonicalAnchorCount > 0 && manifest.sourceSummary.canonicalAnchorCount <= 2048,
  'Manifest-bound canonical anchors are required.');
  manifest.layers.forEach((layer, index) => assert(layer.index === index && HASH.test(layer.merkleRoot)
    && HASH.test(layer.publicSha256) && HASH.test(layer.databaseSha256), 'Invalid ordered global layer.'));
  return manifest;
}

// The native process accepts only encrypted bytes, never the selected txid.
// A fixed maximum bounds its JSONL transport even if a child misbehaves.
export function globalNativeEvaluator(binary, directory, responseBytes, { deadlineMs = DEADLINE_MS, mode = 'serve-global' } = {}) {
  assert(['serve-global', 'serve-global-cached'].includes(mode), 'Unsupported global evaluator mode.');
  const child = spawn(binary, [mode, directory], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', RAYON_NUM_THREADS: '2' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  const maximumLine = Math.ceil(responseBytes / 3) * 4 + 1024;
  let sequence = 0, stopped = false, pendingBytes = Buffer.alloc(0), finish;
  let ready = false, readyResolve, readyReject, stderrTail = '';
  const admitted = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  admitted.catch(() => {});
  const startup = setTimeout(() => { fail(); child.kill(); }, deadlineMs);
  const exited = new Promise(resolveExit => { finish = resolveExit; });
  function fail() {
    stopped = true;
    clearTimeout(startup); readyReject(new Error('Global evaluator startup unavailable.'));
    for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error('Global evaluator unavailable.')); }
    waiting.clear();
  }
  child.stderr.on('data', bytes => {
    stderrTail = (stderrTail + bytes.toString('utf8')).slice(-2048);
    if (!stopped && stderrTail.includes('Experimental global evaluator ready; all ')) {
      ready = true; clearTimeout(startup); readyResolve(); stderrTail = '';
    }
  });
  child.on('error', () => { fail(); finish(); });
  child.on('exit', () => { fail(); finish(); });
  child.stdin.on('error', fail);
  child.stdout.on('data', bytes => {
    if (stopped) return;
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const part = bytes.subarray(offset, newline === -1 ? bytes.length : newline);
      if (pendingBytes.length + part.length > maximumLine) { fail(); child.kill(); return; }
      pendingBytes = Buffer.concat([pendingBytes, part]);
      if (newline === -1) break;
      const line = pendingBytes; pendingBytes = Buffer.alloc(0); offset = newline + 1;
      let reply;
      try { reply = JSON.parse(line.toString('utf8')); } catch { fail(); child.kill(); return; }
      const pending = waiting.get(reply.id);
      if (!pending) { fail(); child.kill(); return; }
      waiting.delete(reply.id); clearTimeout(pending.timer);
      if (typeof reply.response !== 'string' || reply.error || reply.response.length !== Math.ceil(responseBytes / 3) * 4
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(reply.response)) { pending.reject(new Error('Global query rejected.')); continue; }
      const response = Buffer.from(reply.response, 'base64');
      if (response.length !== responseBytes) pending.reject(new Error('Global response framing rejected.'));
      else pending.resolve(response);
    }
  });
  return {
    ready() { return admitted; },
    isAlive() { return ready && !stopped; },
    async evaluate(query) {
      await admitted;
      assert(!stopped && waiting.size < 2 && query.length === REQUEST_BYTES, 'Global evaluator busy or unavailable.');
      const id = ++sequence;
      return await new Promise((resolveReply, reject) => {
        const timer = setTimeout(() => { fail(); child.kill(); }, deadlineMs);
        waiting.set(id, { resolve: resolveReply, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, query: query.toString('base64') })}\n`, error => { if (error) fail(); });
      });
    },
    async close() {
      fail(); child.kill();
      const force = setTimeout(() => child.kill('SIGKILL'), 2000); force.unref();
      try { await exited; } finally { clearTimeout(force); }
    },
  };
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
function respond(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type }); res.end(body);
}
async function requestBytes(req) {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) !== REQUEST_BYTES)) throw new Error('Invalid global upload length.');
  const parts = []; let length = 0;
  for await (const part of req) { length += part.length; if (length > REQUEST_BYTES) throw new Error('Invalid global upload length.'); parts.push(part); }
  assert(length === REQUEST_BYTES, 'Invalid global upload length.'); return Buffer.concat(parts);
}

export async function globalCanonicalGuard(file, manifest) {
  const value = await readStateJson(file, 512 * 1024);
  const age = Date.now() - Date.parse(value.observedAt);
  assert(value.schema === 'zecblock-global-source-guard-v1' && value.publicationId === manifest.publicationId
    && value.canonicalAnchorsSha256 === manifest.sourceSummary.canonicalAnchorsSha256
    && value.canonicalAnchorCount === manifest.sourceSummary.canonicalAnchorCount
    && value.state === 'ready' && Number.isFinite(age) && age >= -1000 && age <= 10_000,
  'Fresh canonical global source guard unavailable.');
}

export async function startGlobalPrototype({ port = 4320, globalDir, binary, wasmDir = resolve(HERE, '../pir-browser/pkg'),
  createEvaluator = globalNativeEvaluator, evaluatorMode = 'serve-global', assertCanonical = async () => {}, onRequest = () => {} } = {}) {
  assert(typeof globalDir === 'string' && typeof binary === 'string', 'Explicit global publication and native paths required.');
  const directory = await lstat(globalDir);
  assert(directory.isDirectory() && !directory.isSymbolicLink(), 'Ordinary immutable global directory required.');
  const manifestBytes = await readStateBytes(resolve(globalDir, 'manifest.json'), 2 * 1024 * 1024);
  const manifest = admitGlobalManifest(JSON.parse(manifestBytes.toString('utf8')));
  const setups = [];
  for (const layer of manifest.layers) {
    const bytes = await readStateBytes(resolve(globalDir, 'layers', String(layer.index).padStart(3, '0'), 'public.bin'), LAYER_PUBLIC_BYTES);
    assert(bytes.length === LAYER_PUBLIC_BYTES && sha(bytes) === layer.publicSha256, 'Global public setup mismatch.'); setups.push(bytes);
  }
  await assertCanonical(manifest);
  const evaluator = createEvaluator(binary, globalDir, manifest.layerCount * LAYER_REPLY_BYTES, { mode: evaluatorMode });
  try { await evaluator.ready?.(); } catch (error) { await evaluator.close(); throw error; }
  const assets = new Map([
    ['/', ['web/global-index.html', 'text/html; charset=utf-8']], ['/app.js', ['web/app.js', 'text/javascript; charset=utf-8']],
    ['/worker.js', ['web/global-worker.js', 'text/javascript; charset=utf-8']], ['/style.css', ['web/style.css', 'text/css; charset=utf-8']],
    ['/fonts/geist-sans.woff2', ['web/fonts/geist-sans.woff2', 'font/woff2']],
    ['/fonts/geist-mono.woff2', ['web/fonts/geist-mono.woff2', 'font/woff2']],
  ]);
  assets.set('/wasm/zecblock_pir_browser.js', [resolve(wasmDir, 'zecblock_pir_browser.js'), 'text/javascript; charset=utf-8']);
  assets.set('/wasm/zecblock_pir_browser_bg.wasm', [resolve(wasmDir, 'zecblock_pir_browser_bg.wasm'), 'application/wasm']);
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== `127.0.0.1:${server.address().port}` || req.headers.origin && req.headers.origin !== origin
      || req.headers['sec-fetch-site'] === 'cross-site') { respond(res, 403, 'Local requests only.'); return; }
    if (!req.url || req.url.includes('?') || req.url.includes('#')) { respond(res, 400, 'Query strings are not accepted.'); return; }
    onRequest({ method: req.method, path: req.url });
    try {
      if (req.method === 'GET' && req.url === '/health') {
        await assertCanonical(manifest);
        assert(!evaluator.isAlive || evaluator.isAlive(), 'Global evaluator is not alive.');
        respond(res, 200, JSON.stringify({ local: true, experimental: true, publicationId: manifest.publicationId,
          records: manifest.sourceSummary.recordCount, layers: manifest.layerCount }), 'application/json'); return;
      }
      if (req.method === 'GET' && req.url === '/robots.txt') { respond(res, 200, 'User-agent: *\nDisallow: /\n'); return; }
      if (req.method === 'GET' && req.url === '/publication/manifest.json') {
        await assertCanonical(manifest);
        assert(!evaluator.isAlive || evaluator.isAlive(), 'Global evaluator is not alive.');
        respond(res, 200, manifestBytes, 'application/json'); return;
      }
      const setup = /^\/publication\/layers\/(0|[1-9]\d*)\/public\.bin$/.exec(req.url);
      if (req.method === 'GET' && setup) {
        const index = Number(setup[1]);
        if (!Number.isSafeInteger(index) || !setups[index]) { respond(res, 404, 'Unknown public layer.'); return; }
        await assertCanonical(manifest); respond(res, 200, setups[index], 'application/octet-stream'); return;
      }
      if (req.method === 'POST' && req.url === '/pir/query') {
        if (req.headers['content-type'] !== 'application/octet-stream' || req.headers['x-pir-publication'] !== manifest.publicationId) {
          respond(res, 400, 'Invalid encrypted request.'); return;
        }
        const bytes = await requestBytes(req); await assertCanonical(manifest);
        const reply = await evaluator.evaluate(bytes);
        await assertCanonical(manifest);
        assert(reply.length === manifest.layerCount * LAYER_REPLY_BYTES, 'Global reply bound exceeded.');
        respond(res, 200, reply, 'application/octet-stream'); return;
      }
      if (req.method === 'GET' && assets.has(req.url)) {
        const [file, type] = assets.get(req.url);
        respond(res, 200, await readFile(resolve(HERE, file)), type); return;
      }
      respond(res, 404, 'Not found.');
    } catch { respond(res, 503, 'Global private lookup unavailable.'); }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.timeout = DEADLINE_MS + 10_000;
  try { await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); }); }
  catch (error) { await evaluator.close(); throw error; }
  return { url: `http://127.0.0.1:${server.address().port}`, manifest, async close() {
    server.closeAllConnections(); await evaluator.close(); await new Promise(done => server.close(done));
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const globalDir = process.env.PRIVATE_TX_GLOBAL_DIR, binary = process.env.PRIVATE_TX_EVALUATOR;
  const guard = process.env.PRIVATE_TX_GLOBAL_GUARD;
  assert(globalDir && binary && guard, 'Explicit global data, native and canonical guard paths required.');
  const port = Number(process.env.PRIVATE_TX_PORT ?? 4320);
  assert(Number.isSafeInteger(port) && port >= 1024 && port <= 65535, 'Invalid global loopback port.');
  const app = await startGlobalPrototype({ globalDir: resolve(globalDir), binary: resolve(binary), port,
    evaluatorMode: process.env.PRIVATE_TX_EVALUATOR_MODE ?? 'serve-global',
    assertCanonical: manifest => globalCanonicalGuard(resolve(guard), manifest) });
  process.stdout.write(`Experimental global private lookup: ${app.url}\n`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
