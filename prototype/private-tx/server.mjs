import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_QUERY_BYTES = 4 * 1024 * 1024;
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
  let busy = false;
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
      if (stopped || busy) throw new Error('Local evaluator unavailable or busy.');
      busy = true;
      const id = ++sequence;
      try {
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
      } finally { busy = false; }
    },
    close() { failAll(); lines.close(); child.kill(); },
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
  onRequest = () => {},
} = {}) {
  if (!evaluator) throw new Error('A local PIR evaluator is required.');
  const manifestBytes = await readFile(resolve(fixtureDir, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const setupFile = manifest.setupFile ?? 'public.bin';
  if (basename(setupFile) !== setupFile) throw new Error('Invalid fixture setup path.');
  const staticFiles = new Map([
    ['/', [resolve(HERE, 'web/index.html'), 'text/html; charset=utf-8']],
    ['/app.js', [resolve(HERE, 'web/app.js'), 'text/javascript; charset=utf-8']],
    ['/worker.js', [resolve(HERE, 'web/worker.js'), 'text/javascript; charset=utf-8']],
    ['/style.css', [resolve(HERE, 'web/style.css'), 'text/css; charset=utf-8']],
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
        respond(res, 200, JSON.stringify({ local: true, fixtureOnly: true }), 'application/json'); return;
      }
      if (req.method === 'GET' && req.url === '/robots.txt') {
        respond(res, 200, 'User-agent: *\nDisallow: /\n'); return;
      }
      if (req.method === 'GET' && req.url === '/fixture/manifest.json') {
        respond(res, 200, manifestBytes, 'application/json'); return;
      }
      if (req.method === 'POST' && req.url === '/pir/query') {
        if (req.headers['content-type'] !== 'application/octet-stream') {
          respond(res, 415, 'Binary PIR queries only.'); return;
        }
        const query = await requestBytes(req);
        const result = await evaluator.evaluate(query);
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
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    manifest,
    close: async () => {
      evaluator.close?.();
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fixtureDir = resolve(process.env.PRIVATE_TX_FIXTURE_DIR ?? resolve(HERE, '.local/fixture'));
  const binary = resolve(process.env.PRIVATE_TX_EVALUATOR ?? resolve(HERE, '../pir-browser/target/release/zecblock-pir-fixture'));
  const port = Number(process.env.PRIVATE_TX_PORT ?? '4318');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port.');
  const evaluator = nativeEvaluator(binary, fixtureDir);
  try {
    const app = await startPrototype({ port, fixtureDir, evaluator });
    process.stdout.write(`Local fixture prototype: ${app.url}\n`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
  } catch (error) { evaluator.close(); throw error; }
}
