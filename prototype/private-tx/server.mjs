import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_QUERY_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_CHUNKS = 64;
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// Only encrypted query bytes cross this bridge. Never pass a transaction ID,
// route parameter, request headers or arbitrary user input as a CLI argument.
export function nativeEvaluator(binary, fixtureDir) {
  const child = spawn(binary, ['serve', fixtureDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let sequence = 0;
  let stopped = false;
  child.stderr.resume(); // Do not persist native payloads or potentially sensitive diagnostics.
  const failAll = () => {
    stopped = true;
    for (const pending of waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Local evaluator unavailable.'));
    }
    waiting.clear();
  };
  child.on('error', failAll);
  child.on('exit', failAll);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let reply;
    try { reply = JSON.parse(line); } catch { failAll(); child.kill(); return; }
    const pending = waiting.get(reply.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    waiting.delete(reply.id);
    if (typeof reply.response === 'string' && !reply.error) {
      pending.resolve(Buffer.from(reply.response, 'base64'));
    } else pending.reject(new Error('Local query rejected.'));
  });
  return {
    async evaluate(query) {
      // The native stdin protocol evaluates in FIFO order. Bound queued work
      // while admitting a browser's fixed batch independently of reply content.
      if (stopped || waiting.size >= MAX_BATCH_CHUNKS) throw new Error('Local evaluator unavailable or queue full.');
      const id = ++sequence;
      return await new Promise((resolveReply, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          stopped = true;
          child.kill();
          reject(new Error('Local query timed out.'));
        }, 60_000);
        waiting.set(id, { resolve: resolveReply, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, query: query.toString('base64') })}\n`, error => {
          if (error) failAll();
        });
      });
    },
    close() { failAll(); lines.close(); child.kill(); },
  };
}

// No upstream reads happen here. Only the independent publisher can advance
// current.json. Retained evaluators keep in-flight sessions on their own setup.
export function localPublications({ localDir = resolve(HERE, '.local'), binary = resolve(HERE, '../pir-browser/target/release/zecblock-pir-fixture'), createEvaluator = nativeEvaluator } = {}) {
  const retained = new Map();
  let active = null;
  let loading = null;
  async function refresh() {
    const pointer = JSON.parse(await readFile(resolve(localDir, 'current.json'), 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(pointer.publicationId) || pointer.directory !== pointer.publicationId) throw new Error('Invalid local publication pointer.');
    if (active?.manifest.publicationId === pointer.publicationId) return active;
    if (retained.has(pointer.publicationId)) { active = retained.get(pointer.publicationId); return active; }
    const dir = resolve(localDir, 'publications', pointer.directory);
    const manifestBytes = await readFile(resolve(dir, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (manifest.schema !== 'zecblock-private-tx-full-v1' || manifest.publicationId !== pointer.publicationId) throw new Error('Incompatible local publication.');
    if (!Number.isSafeInteger(manifest.chunkCount) || manifest.chunkCount < 1 || manifest.chunkCount > MAX_BATCH_CHUNKS) throw new Error('Unsupported fixed batch size.');
    if (!Number.isSafeInteger(manifest.scheme?.request_bytes) || manifest.scheme.request_bytes < 1 || manifest.scheme.request_bytes > MAX_QUERY_BYTES) throw new Error('Invalid encrypted query geometry.');
    const publicBytes = await readFile(resolve(dir, 'public.bin'));
    const publication = { manifest, manifestBytes, publicBytes, evaluator: createEvaluator(binary, dir) };
    retained.set(pointer.publicationId, publication);
    active = publication;
    // Three generations bound RAM while allowing ordinary in-flight lookups.
    while (retained.size > 3) {
      const id = retained.keys().next().value;
      retained.get(id).evaluator.close();
      retained.delete(id);
    }
    return publication;
  }
  return {
    async current() {
      loading ??= refresh().finally(() => { loading = null; });
      return loading;
    },
    get(id) { return retained.get(id); },
    async status() {
      try { return JSON.parse(await readFile(resolve(localDir, 'publisher-status.json'), 'utf8')); }
      catch { return { state: 'unknown' }; }
    },
    close() { for (const item of retained.values()) item.evaluator.close(); retained.clear(); },
  };
}

function respond(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
  res.end(body);
}

async function requestBytes(req) {
  const announced = Number(req.headers['content-length']);
  if (Number.isFinite(announced) && announced > MAX_QUERY_BYTES) throw new Error('oversize');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_QUERY_BYTES) throw new Error('oversize');
    chunks.push(chunk);
  }
  if (!length) throw new Error('empty');
  return Buffer.concat(chunks);
}

export async function startPrototype({
  port = 4318,
  fixtureDir = resolve(HERE, '.local/fixture'),
  wasmDir = resolve(HERE, '../pir-browser/pkg'),
  evaluator,
  publications,
  onRequest = () => {},
} = {}) {
  if (!evaluator && !publications) throw new Error('A local PIR evaluator is required.');
  const initialPublication = publications && await publications.current();
  const manifestBytes = initialPublication?.manifestBytes ?? await readFile(resolve(fixtureDir, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const setupFile = manifest.setupFile ?? 'public.bin';
  if (basename(setupFile) !== setupFile) throw new Error('Invalid fixture setup path.');
  const staticFiles = new Map([
    ['/', [resolve(HERE, 'web/index.html'), 'text/html; charset=utf-8']],
    ['/app.js', [resolve(HERE, 'web/app.js'), 'text/javascript; charset=utf-8']],
    ['/worker.js', [resolve(HERE, 'web/worker.js'), 'text/javascript; charset=utf-8']],
    ['/style.css', [resolve(HERE, 'web/style.css'), 'text/css; charset=utf-8']],
    ['/fonts/geist-sans.woff2', [resolve(HERE, 'web/fonts/geist-sans.woff2'), 'font/woff2']],
    ['/fonts/geist-mono.woff2', [resolve(HERE, 'web/fonts/geist-mono.woff2'), 'font/woff2']],
    [`/fixture/${setupFile}`, [resolve(fixtureDir, setupFile), 'application/octet-stream']],
    ['/wasm/zecblock_pir_browser.js', [resolve(wasmDir, 'zecblock_pir_browser.js'), 'text/javascript; charset=utf-8']],
    ['/wasm/zecblock_pir_browser_bg.wasm', [resolve(wasmDir, 'zecblock_pir_browser_bg.wasm'), 'application/wasm']],
  ]);
  const server = createServer(async (req, res) => {
    // Reject hostile browser origins and URLs before handling any data. This
    // prototype deliberately cannot bind publicly or proxy production APIs.
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    if (req.headers.host !== `127.0.0.1:${address.port}` ||
        (req.headers.origin && req.headers.origin !== origin) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
      respond(res, 403, 'Local requests only.'); return;
    }
    if (!req.url || req.url.includes('?') || req.url.includes('#')) {
      respond(res, 400, 'Query strings are not accepted.'); return;
    }
    // Captured by tests in memory only. Runtime has no request/access logger.
    onRequest({ method: req.method, path: req.url });
    try {
      if (req.method === 'GET' && req.url === '/health') {
        const current = publications && await publications.current();
        respond(res, 200, JSON.stringify({ local: true, fixtureOnly: !publications, publicationId: current?.manifest.publicationId, snapshot: current?.manifest.snapshot }), 'application/json'); return;
      }
      if (req.method === 'GET' && req.url === '/robots.txt') {
        respond(res, 200, 'User-agent: *\nDisallow: /\n'); return;
      }
      if (req.method === 'GET' && req.url === '/publication/status.json') {
        const status = publications ? await publications.status() : { state: 'unknown' };
        respond(res, 200, JSON.stringify(status), 'application/json'); return;
      }
      if (req.method === 'GET' && ['/fixture/manifest.json', '/publication/manifest.json'].includes(req.url)) {
        const current = publications && await publications.current();
        respond(res, 200, current?.manifestBytes ?? manifestBytes, 'application/json'); return;
      }
      const setupMatch = req.method === 'GET' && req.url.match(/^\/publication\/([a-f0-9]{64})\/public\.bin$/);
      if (setupMatch && publications) {
        await publications.current();
        const publication = publications.get(setupMatch[1]);
        if (!publication) { respond(res, 409, 'Publication retired; refresh the local catalogue.'); return; }
        respond(res, 200, publication.publicBytes, 'application/octet-stream'); return;
      }
      if (req.method === 'POST' && req.url === '/pir/query') {
        if (req.headers['content-type'] !== 'application/octet-stream') {
          respond(res, 415, 'Binary PIR queries only.'); return;
        }
        const query = await requestBytes(req);
        let selectedEvaluator = evaluator;
        if (publications) {
          const id = req.headers['x-pir-publication'];
          if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) { respond(res, 409, 'A supported local publication is required.'); return; }
          const publication = publications.get(id);
          if (!publication) { respond(res, 409, 'Publication retired; refresh the local catalogue.'); return; }
          if (query.length !== publication.manifest.scheme.request_bytes) {
            respond(res, 400, 'Invalid encrypted query length.'); return;
          }
          selectedEvaluator = publication.evaluator;
        }
        const result = await selectedEvaluator.evaluate(query);
        respond(res, 200, result, 'application/octet-stream'); return;
      }
      const file = req.method === 'GET' && staticFiles.get(req.url);
      if (!file) { respond(res, 404, 'Not found.'); return; }
      respond(res, 200, await readFile(file[0]), file[1]);
    } catch (error) {
      const status = error.message === 'oversize' ? 413 : error.message === 'empty' ? 400 : 503;
      // No selected identifier, request body or native error is reflected.
      respond(res, status, status === 413 ? 'Query too large.' : 'Local lookup unavailable. No public lookup was attempted.');
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 16;
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    manifest,
    close: async () => {
      evaluator?.close?.();
      publications?.close();
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fixtureDir = resolve(process.env.PRIVATE_TX_FIXTURE_DIR ?? resolve(HERE, '.local/fixture'));
  const binary = resolve(process.env.PRIVATE_TX_EVALUATOR ?? resolve(HERE, '../pir-browser/target/release/zecblock-pir-fixture'));
  const localDir = resolve(process.env.PRIVATE_TX_LOCAL_DIR ?? resolve(HERE, '.local'));
  const port = Number(process.env.PRIVATE_TX_PORT ?? '4318');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port.');
  const fixtureMode = Boolean(process.env.PRIVATE_TX_FIXTURE_DIR);
  const evaluator = fixtureMode ? nativeEvaluator(binary, fixtureDir) : undefined;
  const publications = fixtureMode ? undefined : localPublications({ binary, localDir });
  try {
    const app = await startPrototype({ port, fixtureDir, evaluator, publications });
    process.stdout.write(`Local private transaction view: ${app.url}\n`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
  } catch (error) { evaluator?.close(); publications?.close(); throw error; }
}
