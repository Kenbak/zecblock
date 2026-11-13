'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cards = require('../bot/lib/animated-card');
const replay = require('../bot/jobs/replay');
const { XClient } = require('../bot/lib/x-client');

const SUNDAY = new Date('2026-11-15T21:05:00Z');
const quiet = { info() {}, warn() {}, error() {} };
const day = i => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
const softwarePayload = { data: { bucket: 'day', history: Array.from({ length: 100 }, (_, i) => ({ date: day(i), total: 100,
  counts: { zebra: i < 50 ? 60 : 20, zakura: i < 50 ? 0 : 70, other: 0, unknown: i < 50 ? 40 : 10, conflicting: 0, missing: 0 } })) } };

/** Outbox double: answers the history read, records claims and status updates. */
function fakePool(history = [], { locked = true } = {}) {
  const calls = [];
  const client = { query: async sql => (/pg_try_advisory_lock/.test(sql) ? { rows: [{ acquired: locked }] } : { rows: [] }), release() {} };
  return {
    calls,
    connect: async () => client,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^SELECT/.test(sql.trim())) return { rows: history };
      if (/^INSERT/.test(sql.trim())) return { rows: [{ id: 7 }] };
      return { rows: [] };
    },
  };
}

function fakeX(overrides = {}) {
  const log = [];
  return { log, dryRun: false,
    uploadVideo: async file => { log.push(['upload', fs.existsSync(file)]); return '123'; },
    postUploaded: async (text, mediaId) => { log.push(['post', text, mediaId]); return { id: '999', text }; },
    ...overrides };
}

const options = extra => ({ now: SUNDAY, logger: quiet, assertFresh: async () => {}, tries: new Map(),
  load: async url => { if (!url.includes('/v1/mining/software')) throw new Error('unexpected source'); return softwarePayload; },
  render: async (_model, file) => { fs.writeFileSync(file, 'video'); }, ...extra });

test('the slot is Sunday from 21:00 UTC and nothing else', () => {
  assert.deepEqual(replay.replaySlot(SUNDAY), { date: '2026-11-15', key: 'replay:v1:2026-11-15' });
  assert.equal(replay.replaySlot(new Date('2026-11-15T20:59:59Z')), null);
  assert.equal(replay.replaySlot(new Date('2026-11-16T00:00:00Z')), null, 'Monday is too late: a missed week is not made up');
  assert.equal(replay.replaySlot(new Date('2026-11-14T22:00:00Z')), null);
  assert.equal(replay.replaySlot(new Date('2026-11-15T23:59:59Z')).key, 'replay:v1:2026-11-15');
});

test('the animation posted longest ago goes next', () => {
  assert.deepEqual(replay.rotation([]), replay.ORDER);
  const row = (animation, created_at, status = 'posted') => ({ post_type: 'replay', status, created_at, metadata: { animation } });
  const history = [row('software', '2026-11-01T21:00:00Z'), row('swaps', '2026-11-08T21:00:00Z'), row('pools', '2026-11-08T21:00:00Z', 'failed')];
  assert.deepEqual(replay.rotation(history), ['pools', 'pool-race', 'shielded-share', 'hashrate', 'supply', 'software', 'swaps']);
  assert.deepEqual(replay.rotation([...history, { post_type: 'swap', status: 'posted', created_at: '2026-11-09T00:00:00Z', metadata: { animation: 'pools' } }])[0], 'pools', 'only replay posts count');
});

test('post copy states the final frame and links the matching page', () => {
  const model = cards.softwareShareModel(softwarePayload, {}, SUNDAY);
  assert.equal(replay.replayCopy('software', model),
    '🟨 70.0% of Zcash blocks are tagged Zakura.\n\nThe 7-day share since Jan 2026. Miners write the tag themselves.\n\nhttps://zecblock.com/mining');
  assert.equal(model.post().lead.startsWith(model.headline(model.dates.length - 1, true)), true, 'the post leads with the number the video ends on');
  for (const id of replay.ORDER) assert.match(cards.ANIMATIONS[id].page, /^\/[a-z]+$/);
  assert.deepEqual([...replay.ORDER].sort(), Object.keys(cards.ANIMATIONS).sort(), 'every animation is in the rotation');
  assert.throws(() => replay.replayCopy('software', { post: () => ({ lead: 'x'.repeat(300), context: '' }) }), /280/);
});

test('a week posts one video: upload, then claim, then post', async () => {
  const pool = fakePool(), x = fakeX();
  const result = await replay.run(pool, x, options());
  assert.deepEqual(result, { key: 'replay:v1:2026-11-15', status: 'posted', animation: 'software', id: '999' });
  assert.deepEqual(x.log.map(entry => entry[0]), ['upload', 'post']);
  assert.equal(x.log[0][1], true, 'the rendered file exists while it uploads');
  assert.equal(x.log[1][2], '123');
  const [, claim, done] = pool.calls;
  assert.match(claim.sql, /ON CONFLICT\(dedup_key\) DO NOTHING/);
  assert.deepEqual(claim.params.slice(0, 2), ['replay', 'replay:v1:2026-11-15']);
  const metadata = JSON.parse(claim.params[3]);
  assert.deepEqual([metadata.animation, metadata.editorialVersion, metadata.source], ['software', 1, '/v1/mining/software?period=1y&bucket=day']);
  assert.match(done.sql, /status='posted'/);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(`zecblock-replay-software-${process.pid}-`)), [], 'the temporary video is removed');
});

test('nothing posts outside the window, twice in a week, or right after another post', async () => {
  const forbidden = fakeX({ uploadVideo: async () => { throw new Error('must not upload'); } });
  assert.deepEqual(await replay.run(fakePool(), forbidden, options({ now: new Date('2026-11-13T21:05:00Z') })), { skipped: 'outside-window' });
  const claimed = [{ post_type: 'replay', dedup_key: 'replay:v1:2026-11-15', status: 'uncertain', created_at: '2026-11-15T21:00:10Z', metadata: {} }];
  assert.deepEqual(await replay.run(fakePool(claimed), forbidden, options()), { skipped: 'already-claimed' });
  const recent = [{ post_type: 'swap', dedup_key: 'swap:a', status: 'posted', created_at: '2026-11-15T20:55:00Z', metadata: {} }];
  assert.deepEqual(await replay.run(fakePool(recent), forbidden, options()), { skipped: 'paced' });
  const scan = [{ post_type: 'editorial_scan', dedup_key: 'analysis:scan:x', status: 'evaluated', created_at: '2026-11-15T21:04:00Z', metadata: {} }];
  assert.equal((await replay.run(fakePool(scan), fakeX(), options())).status, 'posted', 'bookkeeping rows do not pace a post');
  assert.deepEqual(await replay.run(fakePool([], { locked: false }), forbidden, options()), { skipped: 'another-run-active' });
});

test('an unusable source moves to the next animation; none usable posts nothing', async () => {
  const pool = fakePool(), x = fakeX();
  const result = await replay.run(pool, x, options({ load: async url => (url.includes('/v1/mining/software') ? { data: { bucket: 'week', history: [] } } : url.includes('/v1/crosschain') ? { data: { coverage: { stale: true }, trends: [] } } : { success: false }) }));
  assert.deepEqual(result, { skipped: 'no-usable-source' });
  assert.equal(x.log.length, 0);
  assert.equal(pool.calls.length, 1, 'no claim is written');
});

test('a failed render or upload claims nothing and stops after three tries', async () => {
  const tries = new Map();
  for (const failing of [{ render: async () => { throw new Error('spawn ffmpeg ENOENT'); } }, {}]) {
    const pool = fakePool();
    const x = fakeX({ uploadVideo: async () => { throw new Error('upload refused'); } });
    await assert.rejects(replay.run(pool, x, options({ tries, ...failing })), /ENOENT|upload refused/);
    assert.equal(pool.calls.filter(call => /^INSERT/.test(call.sql.trim())).length, 0);
  }
  await assert.rejects(replay.run(fakePool(), fakeX({ uploadVideo: async () => { throw new Error('upload refused'); } }), options({ tries })));
  assert.deepEqual(await replay.run(fakePool(), fakeX(), options({ tries })), { skipped: 'attempts-exhausted' });
});

test('an ambiguous post is held for reconciliation, never retried', async () => {
  const pool = fakePool();
  const result = await replay.run(pool, fakeX({ postUploaded: async () => { throw new Error('X API request timed out'); } }), options());
  assert.equal(result.status, 'uncertain');
  assert.match(pool.calls.at(-1).sql, /status='uncertain'/);
});

test('dry run renders and previews without touching X or the outbox', async () => {
  const pool = fakePool();
  const x = { dryRun: true, uploadVideo: async () => { throw new Error('no upload'); }, postUploaded: async () => { throw new Error('no post'); } };
  const result = await replay.run(pool, x, options());
  assert.equal(result.status, 'preview');
  assert.equal(pool.calls.length, 1);
});

test('video upload is chunked and waits for X to finish processing', async () => {
  const file = path.join(os.tmpdir(), `bot-replay-test-${process.pid}.mp4`);
  fs.writeFileSync(file, Buffer.alloc(9 * 1024 * 1024, 1));
  try {
    const x = new XClient({ accessToken: 'unit-test-placeholder', logger: quiet });
    const requests = [], chunks = [];
    const states = [{ state: 'in_progress', check_after_secs: 1 }, { state: 'succeeded' }];
    x._apiRequest = async (_host, target, method, body) => {
      requests.push([method, target, body ? JSON.parse(body) : null]);
      if (target.endsWith('/initialize')) return { data: { id: '555' } };
      if (target.endsWith('/finalize')) return { data: { id: '555', processing_info: { state: 'pending', check_after_secs: 1 } } };
      return { data: { processing_info: states.shift() } };
    };
    x._appendChunk = async (id, index, chunk, type) => { chunks.push([id, index, chunk.length, type]); };
    const wait = x._waitForProcessing.bind(x);
    x._waitForProcessing = (id, info) => wait(id, info, { sleep: async () => {} });
    assert.equal(await x.uploadVideo(file), '555');
    assert.deepEqual(requests[0], ['POST', '/2/media/upload/initialize', { media_type: 'video/mp4', media_category: 'tweet_video', total_bytes: 9 * 1024 * 1024 }]);
    assert.deepEqual(chunks, [['555', 0, 4194304, 'video/mp4'], ['555', 1, 4194304, 'video/mp4'], ['555', 2, 1048576, 'video/mp4']]);
    assert.deepEqual(requests.slice(2).map(r => r.slice(0, 2)), [['GET', '/2/media/upload?command=STATUS&media_id=555'], ['GET', '/2/media/upload?command=STATUS&media_id=555']]);

    await assert.rejects(wait('555', { state: 'failed', error: { message: 'InvalidMedia' } }), /processing failed/);
    x._apiRequest = async () => ({ data: { processing_info: { state: 'pending', check_after_secs: 1 } } });
    await assert.rejects(wait('555', { state: 'pending' }, { deadlineMs: -1, sleep: async () => {} }), /timed out/);

    const sent = [];
    x._postTweet = async (...args) => { sent.push(args); return { id: '1', text: args[0] }; };
    await x.postUploaded('hello', '555');
    assert.deepEqual(sent, [['hello', undefined, ['555']]]);
    await assert.rejects(x.postUploaded('hello', 'abc'), /Invalid media ID/);
    await assert.rejects(x.postUploaded('x'.repeat(281), '555'), /Invalid post copy/);
  } finally { fs.unlinkSync(file); }
});
