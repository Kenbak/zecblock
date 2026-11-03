import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startGlobalPrototype, admitGlobalManifest, canonicalGlobal, globalNativeEvaluator, globalCanonicalGuard } from '../global-server.mjs';
import { globalGuardTick } from '../pilot/global-source-watch.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const id = '1'.repeat(64);
async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'global-server-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const anchors = [{ height: 1, hash: id }], anchorBytes = Buffer.from(canonicalGlobal(anchors));
  const context = { schema: 'zecblock-private-global-v1', geometry: 'global-2k-64k', table: 'txdirectory', network: 'mainnet',
    rows: 2048, rowBytes: 65536, payloadBytes: 65024, layerCount: 1, hashAlgorithm: 'sha256-display-v1',
    recordCodec: 'full-envelope-zlib-v1', sourceDigest: id, sourceSummary: { recordCount: 1,
      canonicalAnchorCount: 1, canonicalAnchorsSha256: hash(anchorBytes) },
    scheme: { request_bytes: 20992, response_bytes: 81920, public_bytes: 360448 } };
  const setup = Buffer.alloc(360448), contextId = hash(Buffer.from(canonicalGlobal(context)));
  const body = { ...context, contextId, layers: [{ index: 0, merkleRoot: id, databaseSha256: id, publicSha256: hash(setup), preparedFiles: [] }] };
  const manifest = { ...body, publicationId: hash(Buffer.from(canonicalGlobal(body))) };
  await mkdir(resolve(directory, 'layers/000'), { recursive: true });
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(resolve(directory, 'anchors.json'), anchorBytes);
  await writeFile(resolve(directory, 'layers/000/public.bin'), setup);
  return { directory, manifest, anchors, setup, guardFile: resolve(directory, 'guard.json') };
}

test('global metadata binds canonical anchor digest, context and ordered artifacts', async t => {
  const box = await fixture(t);
  assert.equal(admitGlobalManifest(box.manifest), box.manifest);
  for (const mutate of [m => { m.rows = 1; }, m => { m.contextId = id; }, m => { m.sourceSummary.canonicalAnchorsSha256 = id; },
    m => { m.layers[0].publicSha256 = id; }, m => { m.layers[0].index = 1; }]) {
    const bad = structuredClone(box.manifest); mutate(bad); assert.throws(() => admitGlobalManifest(bad));
  }
});

test('global HTTP accepts only fixed opaque uploads and rechecks canonical state after evaluation', async t => {
  const box = await fixture(t); let calls = 0, guard = true, stopped = false;
  const evaluator = { async evaluate(bytes) { calls++; assert.equal(bytes.length, 20992); return Buffer.alloc(81920); },
    async close() { stopped = true; } };
  const app = await startGlobalPrototype({ port: 0, globalDir: box.directory, binary: '/unused', createEvaluator: () => evaluator,
    assertCanonical: async () => { if (!guard) throw new Error('guard'); } });
  t.after(() => app.close());
  assert.equal((await fetch(app.url + '/health')).status, 200);
  assert.equal((await fetch(app.url + '/?tx=' + id)).status, 400);
  assert.equal((await fetch(app.url + '/v1/transactions/' + id)).status, 404);
  let response = await fetch(app.url + '/pir/query', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream',
    'X-PIR-Publication': box.manifest.publicationId }, body: Buffer.alloc(20992) });
  assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, 81920);
  response = await fetch(app.url + '/pir/query', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream',
    'X-PIR-Publication': box.manifest.publicationId }, body: Buffer.alloc(1) });
  assert.equal(response.status, 503); assert.equal(calls, 1);
  evaluator.evaluate = async () => { guard = false; return Buffer.alloc(81920); };
  response = await fetch(app.url + '/pir/query', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream',
    'X-PIR-Publication': box.manifest.publicationId }, body: Buffer.alloc(20992) });
  assert.equal(response.status, 503); assert.match(await response.text(), /unavailable/); assert.equal(stopped, false);
});

test('global watcher cannot authorize unrelated anchors for a real publication ID', async t => {
  const box = await fixture(t); let reads = 0;
  const headers = async heights => { reads++; return { observedAt: new Date().toISOString(), tip: { height: 10, hash: id }, blocks: heights.map(height => ({ height, hash: id })) }; };
  let result = await globalGuardTick({ globalDir: box.directory, guardFile: box.guardFile, headers });
  assert.equal(result.state, 'ready'); await globalCanonicalGuard(box.guardFile, box.manifest);
  await writeFile(resolve(box.directory, 'anchors.json'), canonicalGlobal([{ height: 0, hash: id }]));
  result = await globalGuardTick({ globalDir: box.directory, guardFile: box.guardFile, headers });
  assert.equal(result.state, 'unavailable'); assert.equal(reads, 1);
  await assert.rejects(globalCanonicalGuard(box.guardFile, box.manifest));
  await writeFile(box.guardFile, JSON.stringify({ ...result, state: 'ready', canonicalAnchorCount: 1, canonicalAnchorsSha256: id }));
  await assert.rejects(globalCanonicalGuard(box.guardFile, box.manifest));
});

test('native admission gates startup and liveness gates health', async t => {
  const box = await fixture(t);
  await assert.rejects(startGlobalPrototype({ port: 0, globalDir: box.directory, binary: '/missing-global-native-test' }));
  let alive = true;
  const evaluator = { async ready() {}, isAlive: () => alive, async evaluate() { throw new Error('unused'); }, async close() {} };
  const app = await startGlobalPrototype({ port: 0, globalDir: box.directory, binary: '/unused', createEvaluator: () => evaluator });
  t.after(() => app.close()); assert.equal((await fetch(app.url + '/health')).status, 200);
  alive = false; assert.equal((await fetch(app.url + '/health')).status, 503);
  assert.equal((await fetch(app.url + '/publication/manifest.json')).status, 503);
});

test('native bridge bounds individual frames when two full replies share stdout chunks', async t => {
  const box = await fixture(t), binary = resolve(box.directory, 'fake-native');
  const script = `#!${process.execPath}\nconst readline=require('node:readline');let pending=[];process.stderr.write('Experimental global evaluator ready; all 1 layers evaluated per query\\n');readline.createInterface({input:process.stdin}).on('line',line=>{pending.push(JSON.parse(line));if(pending.length===2){process.stdout.write(pending.map(x=>JSON.stringify({id:x.id,response:Buffer.alloc(81920).toString('base64')})).join('\\n')+'\\n');pending=[];}});\n`;
  await writeFile(binary, script); await chmod(binary, 0o700);
  const evaluator = globalNativeEvaluator(binary, box.directory, 81920, { deadlineMs: 3000 });
  t.after(() => evaluator.close()); await evaluator.ready();
  const replies = await Promise.all([evaluator.evaluate(Buffer.alloc(20992)), evaluator.evaluate(Buffer.alloc(20992))]);
  assert.deepEqual(replies.map(reply => reply.length), [81920, 81920]); assert.equal(evaluator.isAlive(), true);
});
