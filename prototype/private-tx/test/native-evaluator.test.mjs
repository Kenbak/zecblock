import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeEvaluator } from '../server.mjs';

test('native bridge admits a bounded full batch and matches queued answers without leaking slots', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'private-tx-native-queue-'));
  const binary = join(dir, 'queued-native.mjs');
  await writeFile(binary, `#!${process.execPath}\nimport {createInterface} from 'node:readline';\nfor await (const line of createInterface({input:process.stdin})) {\n const q=JSON.parse(line);\n await new Promise(resolve=>setTimeout(resolve,2));\n process.stdout.write(JSON.stringify({id:q.id,response:q.query})+'\\n');\n}\n`);
  await chmod(binary, 0o755);
  const evaluator = nativeEvaluator(binary, dir);
  t.after(async () => { evaluator.close(); await rm(dir, { recursive: true, force: true }); });
  const pending = Array.from({ length: 64 }, (_, index) => evaluator.evaluate(Buffer.from([index])));
  await assert.rejects(evaluator.evaluate(Buffer.from([99])), /queue full/);
  const replies = await Promise.all(pending);
  replies.forEach((reply, index) => assert.deepEqual(reply, Buffer.from([index])));
  assert.deepEqual(await evaluator.evaluate(Buffer.from([100])), Buffer.from([100]));
  evaluator.close();
  await assert.rejects(evaluator.evaluate(Buffer.from([1])), /unavailable/);
});
