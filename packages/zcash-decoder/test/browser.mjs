import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(await readFile(resolve(root, 'test/fixtures/synthetic.json')));
const server = createServer(async (request, response) => {
  const path = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
  if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
  try {
    const type = path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
    response.writeHead(200, { 'Content-Type': type }); response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const page = await browser.newPage();
  const requests = []; const logs = [];
  page.context().on('request', r => requests.push({ url: r.url(), body: r.postData() }));
  page.on('console', m => logs.push(m.text()));
  await page.goto(origin + '/dist/index.js');
  const result = await page.evaluate(async ({ origin, fixture }) => {
    const { ZcashWASM } = await import(origin + '/dist/index.js');
    const wasm = await ZcashWASM.init();
    const memo = await wasm.decryptMemo(fixture.tx_nu7, fixture.key);
    let rejected = false;
    try { await wasm.decryptMemo(fixture.tx_nu7 + '00', fixture.key); } catch { rejected = true; }
    const workerSource = `import {ZcashWASM} from ${JSON.stringify(origin + '/dist/index.js')};
      self.onmessage = async ({data}) => { try {const w = await ZcashWASM.init();
      self.postMessage({result: await w.decryptMemo(data.tx, data.key)});} catch(e) {self.postMessage({error: String(e)});} };`;
    const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    const worker = new Worker(url, { type: 'module' });
    const workerResult = await new Promise((resolve, reject) => {
      worker.onmessage = e => resolve(e.data); worker.onerror = reject;
      worker.postMessage({ tx: fixture.tx, key: fixture.key });
    });
    worker.terminate(); URL.revokeObjectURL(url);
    return { memo, rejected, workerResult, type: wasm.detectKeyType(fixture.key) };
  }, { origin, fixture });
  assert.deepEqual(result, { memo: { memo: 'hello', amount: 0.00000123 }, rejected: true,
    workerResult: { result: { memo: 'hello', amount: 0.00000123 } }, type: 'ufvk-mainnet' });
  assert.ok(requests.every(r => new URL(r.url).origin === origin && !r.body));
  assert.ok(logs.every(l => !l.includes(fixture.key)));
  console.log(JSON.stringify({ browser: browser.version(), page: 'NU7 memo + trailing-byte rejection',
    worker: 'NU6.3 memo', requests: requests.length, externalRequests: 0, postedData: 0, keyLogs: 0 }));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
