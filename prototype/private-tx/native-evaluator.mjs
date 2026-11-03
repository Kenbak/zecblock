import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const MAX_BATCH_CHUNKS = 64;

// Shared bridge has no dependency on the executable HTTP entry point.
// Only encrypted bytes cross the native stdin protocol.
export function nativeEvaluator(binary, fixtureDir) {
  const child = spawn(binary, ['serve', fixtureDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let sequence = 0;
  let stopped = false;
  let finishClose;
  const exited = new Promise(resolveExit => { finishClose = resolveExit; });
  child.stderr.resume(); // Do not persist native payloads or potentially sensitive diagnostics.
  const failAll = () => {
    stopped = true;
    for (const pending of waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Local evaluator unavailable.'));
    }
    waiting.clear();
  };
  child.on('error', () => { failAll(); finishClose(); });
  child.on('exit', () => { failAll(); finishClose(); });
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
    async close() {
      failAll(); lines.close(); child.kill();
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      force.unref();
      try { await exited; } finally { clearTimeout(force); }
    },
  };
}
