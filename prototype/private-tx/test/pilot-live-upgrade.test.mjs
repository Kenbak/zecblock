import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('offline live-pilot migration preserves rolling state and rolls back owned units safely', () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./pilot-live-upgrade.py', import.meta.url))], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Ran 7 tests/);
});
