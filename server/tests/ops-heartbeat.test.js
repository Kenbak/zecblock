'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const helper = path.resolve(__dirname, '../deploy/lib/indexer-progress-health.sh');
const monitor = path.resolve(__dirname, '../deploy/check-ops-health.sh');
const now = 1_793_150_000;
function assess({ indexed = 100, tip = 100, success = now - 30, poll = now - 5, pending = 'none' } = {}) {
  const result = spawnSync('bash', [helper,
    ...[indexed, tip, success, poll, pending, now, 3, 600].map(String)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').filter(Boolean).map(line => line.split('|')[0]);
}

test('caught-up writer may wait indefinitely for a block while polling successfully', () => {
  assert.deepEqual(assess({ success: now - 86_400 }), []);
});
test('a newly observed block gets a full work grace period after a quiet chain', () => {
  assert.deepEqual(assess({ tip: 101, success: now - 86_400, pending: now - 1 }), []);
  assert.deepEqual(assess({ tip: 101, success: now - 86_400, pending: now - 600 }), []);
});
test('one pending block without progress fails despite fresh polls and acceptable lag', () => {
  assert.deepEqual(assess({ tip: 101, success: now - 86_400, pending: now - 601 }), ['ingest_stalled']);
});
test('recent committed progress resets the stall budget during catch-up', () => {
  assert.deepEqual(assess({ tip: 102, success: now - 1, pending: now - 3600 }), []);
});
test('pending same-height reorg work cannot keep polling indefinitely', () => {
  assert.deepEqual(assess({ success: now - 3600, pending: now - 601 }), ['ingest_stalled']);
});
test('a hung idle writer fails its poll heartbeat even when the chain is quiet', () => {
  assert.deepEqual(assess({ success: now - 3600, poll: now - 601 }), ['tip_heartbeat_stale']);
});
test('excess lag, missing work clocks, ahead checkpoints and invalid clocks fail closed', () => {
  assert.deepEqual(assess({ tip: 104, pending: now - 5 }), ['lag']);
  assert.deepEqual(assess({ tip: 101 }), ['pending_work_clock_missing']);
  assert.deepEqual(assess({ indexed: 101 }), ['checkpoint_ahead']);
  assert.deepEqual(assess({ poll: 0 }), ['tip_clock_invalid']);
  assert.deepEqual(assess({ poll: now + 1 }), ['tip_clock_invalid']);
  assert.deepEqual(assess({ success: 0 }), ['success_clock_invalid']);
  assert.deepEqual(assess({ success: now + 1 }), ['success_clock_invalid']);
  assert.deepEqual(assess({ pending: now + 1 }), ['pending_clock_invalid']);
  assert.deepEqual(assess({ pending: 0 }), ['pending_clock_invalid']);
  for (const value of ['', 'abc', '1+1', '999999999999999999999', '-1']) {
    assert.deepEqual(assess({ poll: value }), ['invalid_state']);
  }
});

const bashVersion = spawnSync('bash', ['-c', 'echo "${BASH_VERSINFO[0]}"'], { encoding: 'utf8' });
test('whole ops monitor queries work clocks and deduplicates changing stall ages', {
  skip: Number(bashVersion.stdout.trim()) < 4 ? 'production monitor requires Bash 4+' : false,
}, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ops-heartbeat-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const stub = (name, source) => writeFileSync(path.join(bin, name), `#!/bin/sh\n${source}\n`, { mode: 0o755 });
  stub('sudo', 'shift 2; exec "$@"');
  stub('date', 'case "$*" in *+%s*) echo "$TEST_NOW";; *) exec /bin/date "$@";; esac');
  stub('psql', `case "$*" in
    *last_seen_rpc_tip*) case "$*" in *last_tip_check_at*pending_work_since*) cat "$TEST_STATE";; *) echo 'incorrect heartbeat query' >&2; exit 1;; esac;;
    *pg_stat_activity*) echo '1|100';;
    *pg_stat_archiver*) echo 'on|0|1|0';;
    *pg_stat_replication*) echo '1|0';;
    *last_indexed_height*) echo '100';;
    *) exit 1;; esac`);
  stub('pgbackrest', `echo '[{"status":{"code":0},"backup":[{"timestamp":{"stop":${now}}}]}]'`);
  stub('redis-cli', 'echo PONG');
  stub('curl', `case "$*" in
    *sendMessage*) echo sent >> "$TEST_MESSAGES";;
    *getblockcount*) echo '{"result":100}';;
    *) echo '{"connected":true}';; esac`);
  const state = path.join(dir, 'snapshot');
  const messages = path.join(dir, 'messages');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_STATE: state,
    TEST_MESSAGES: messages, TEST_NOW: String(now), TELEGRAM_BOT_TOKEN: 'fixture', TELEGRAM_CHAT_ID: 'fixture',
    OPS_HEALTH_STATE_DIR: path.join(dir, 'monitor'), OPS_HEALTH_DISK_PATHS: '/does-not-exist', REPLICA_HOST: '' };
  const run = () => spawnSync('bash', [monitor], { env, encoding: 'utf8' });
  try {
    writeFileSync(state, `100|100|${now - 3600}|${now - 5}|none\n`);
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    writeFileSync(state, `100|101|${now - 3600}|${now - 5}|${now - 601}\n`);
    result = run();
    assert.equal(result.status, 1, result.stderr);
    assert.equal(readFileSync(messages, 'utf8').trim().split('\n').length, 1);
    env.TEST_NOW = String(now + 60);
    result = run();
    assert.equal(result.status, 1, result.stderr);
    assert.equal(readFileSync(messages, 'utf8').trim().split('\n').length, 1, 'changing age must honor cooldown');
    writeFileSync(state, `100|101|${now - 3600}|${now - 601}|${now - 601}\n`);
    result = run();
    assert.equal(result.status, 1, result.stderr);
    assert.equal(readFileSync(messages, 'utf8').trim().split('\n').length, 2, 'new poll failure alerts immediately');
    writeFileSync(state, `101|101|${now + 59}|${now + 59}|none\n`);
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(messages, 'utf8').trim().split('\n').length, 3, 'one recovery message');
    assert.equal(run().status, 0);
    assert.equal(readFileSync(messages, 'utf8').trim().split('\n').length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
