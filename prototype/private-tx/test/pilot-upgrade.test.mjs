import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('offline pilot upgrade guards cover publisher wait, admission, rollback and unchanged units', () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./pilot-upgrade.py', import.meta.url))], {
    encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Ran 8 tests/);
});
