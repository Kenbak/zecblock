'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cards = require('../bot/lib/animated-card');
const replay = require('../bot/jobs/replay');
const { XClient } = require('../bot/lib/x-client');

const EVENING = new Date('2026-04-10T21:05:00Z');
const quiet = { info() {}, warn() {}, error() {} };
const day = i => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
// 100 days ending 2026-04-10. Zakura out-tags Zebra from `flip` on; a 7-day share follows a few days later.
const software = flip => ({ data: { bucket: 'day', history: Array.from({ length: 100 }, (_, i) => ({ date: day(i), total: 100,
  counts: { zebra: i < flip ? 60 : 20, zakura: i < flip ? 0 : 70, other: 0, unknown: i < flip ? 40 : 10, conflicting: 0, missing: 0 } })) } });
const softwarePayload = software(93);
const KEY = `replay:v2:software:leader:zakura:${day(96)}`;

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

const options = extra => ({ now: EVENING, logger: quiet, assertFresh: async () => {}, tries: new Map(),
  load: async url => (url.includes('/v1/mining/software') ? softwarePayload : { success: false }),
  render: async (_model, file) => { fs.writeFileSync(file, 'video'); }, ...extra });
const replayRow = (animation, created_at, extra = {}) => ({ post_type: 'replay', dedup_key: `replay:v2:${animation}:x`, status: 'posted', created_at, metadata: { animation }, ...extra });

test('the window is every evening from 21:00 UTC', () => {
  assert.deepEqual(replay.replaySlot(EVENING), { date: '2026-04-10' });
  assert.equal(replay.replaySlot(new Date('2026-04-10T20:59:59Z')), null);
  assert.equal(replay.replaySlot(new Date('2026-04-11T00:00:00Z')), null);
});

test('a level is a story only as a fresh all-time high; a leader only once it has held', () => {
  const flat = Array(20).fill(3);
  assert.equal(cards.newLevel(flat), null);
  assert.equal(cards.newLevel([...flat, 4]), 4);
  assert.equal(cards.newLevel([...flat, 4, 4, 4, 4, 4, 4, 4]), 4, 'still news within a week');
  assert.equal(cards.newLevel([...flat, 4, 4, 4, 4, 4, 4, 4, 4]), null, 'old news after a week');
  assert.equal(cards.newLevel([...flat, 5, 4]), null, 'not while below the high');
  assert.equal(cards.newLevel([5, ...flat, 4]), null, 'a level seen before is not new');
  assert.equal(cards.newLevel([3, 4]), null, 'too short to judge');
  const names = [...Array(20).fill('A')], dates = names.map((_, i) => day(i));
  assert.equal(cards.newLeader(names, dates), null);
  assert.equal(cards.newLeader([...names, 'B', 'B'], [...dates, day(20), day(21)]), null, 'two days is not yet a lead');
  assert.equal(cards.newLeader([...names, 'B', 'B', 'B'], [...dates, day(20), day(21), day(22)]), `B:${day(20)}`);
  assert.equal(cards.newLeader([...names, ...Array(8).fill('B')], Array.from({ length: 28 }, (_, i) => day(i))), null, 'old news after a week');
});

test('each model names its own story from its own data', () => {
  assert.equal(cards.softwareShareModel(softwarePayload, {}, EVENING).event(), `leader:zakura:${day(96)}`);
  assert.equal(cards.softwareShareModel(software(50), {}, EVENING).event(), null, 'a lead taken weeks ago at a level already held');
  const pools = share => Array.from({ length: 60 }, (_, i) => ({ date: day(i), sprout: 0, sapling: i < 57 ? 28_500 : share, orchard: 0, ironwood: 0, chainSupply: 100_000, hasPoolBreakdown: true }));
  assert.equal(cards.poolGrowthModel({ data: { points: pools(29_100) } }).event(), 'share:29');
  assert.equal(cards.poolGrowthModel({ data: { points: pools(28_900) } }).event(), null);
  const supply = last => ({ data: { supplyHistory: Array.from({ length: 60 }, (_, i) => ({ date: day(i), circulatingZat: (i < 58 ? 16_999_000 : last) * 1e8 })) } });
  assert.equal(cards.supplyModel(supply(17_010_000)).event(), 'cap:81');
  assert.equal(cards.supplyModel(supply(16_999_500)).event(), null);
  const hashrate = peak => ({ data: { points: Array.from({ length: 100 }, (_, i) => ({ windowStart: `${day(i)}T00:00:00Z`, windowEnd: `${day(i + 1)}T00:00:00Z`, hashrate: i < 93 ? 10e9 : peak })) } });
  assert.equal(cards.hashrateModel(hashrate(15.2e9), {}, new Date(`${day(100)}T21:00:00Z`)).event(), 'record:15.0 GSol/s');
  assert.equal(cards.hashrateModel(hashrate(14.9e9), {}, new Date(`${day(100)}T21:00:00Z`)).event(), null, 'a record short of the next round level is not a story');
  const race = lead => ({ data: { series: Array.from({ length: 200 }, (_, i) => ({ date: day(i - 100), totalBlocks: 1000, pools: i < lead ? { A: 0.6, B: 0.4 } : { A: 0, B: 1 } })) } });
  const raced = cards.poolRaceModel(race(188), {}, EVENING);
  assert.match(raced.event(), /^leader:B:2026-04-/);
  assert.equal(cards.poolRaceModel(race(250), {}, EVENING).event(), null);
});

test('the animation posted longest ago goes next', () => {
  assert.deepEqual(replay.rotation([]), replay.ORDER);
  const row = (animation, created_at, status = 'posted') => ({ post_type: 'replay', status, created_at, metadata: { animation } });
  const history = [row('software', '2026-11-01T21:00:00Z'), row('swaps', '2026-11-08T21:00:00Z'), row('pools', '2026-11-08T21:00:00Z', 'failed')];
  assert.deepEqual(replay.rotation(history), ['pools', 'pool-race', 'shielded-share', 'hashrate', 'supply', 'software', 'swaps']);
  assert.deepEqual(replay.rotation([...history, { post_type: 'swap', status: 'posted', created_at: '2026-11-09T00:00:00Z', metadata: { animation: 'pools' } }])[0], 'pools', 'only replay posts count');
});

test('post copy states the final frame and links the matching page', () => {
  const model = cards.softwareShareModel(softwarePayload, {}, EVENING);
  assert.equal(replay.replayCopy('software', model),
    '🟨 60.0% of Zcash blocks are tagged Zakura.\n\nThe 7-day share since Mar 2026. Miners write the tag themselves.\n\nhttps://zecblock.com/mining');
  assert.equal(model.post().lead.startsWith(model.headline(model.dates.length - 1, true)), true, 'the post leads with the number the video ends on');
  for (const id of replay.ORDER) assert.match(cards.ANIMATIONS[id].page, /^\/[a-z]+$/);
  assert.deepEqual([...replay.ORDER].sort(), Object.keys(cards.ANIMATIONS).sort(), 'every animation is in the rotation');
  assert.throws(() => replay.replayCopy('software', { post: () => ({ lead: 'x'.repeat(300), context: '' }) }), /280/);
});

test('a story posts one video: upload, then claim, then post', async () => {
  const pool = fakePool(), x = fakeX();
  const result = await replay.run(pool, x, options());
  assert.deepEqual(result, { key: KEY, status: 'posted', animation: 'software', id: '999' });
  assert.deepEqual(x.log.map(entry => entry[0]), ['upload', 'post']);
  assert.equal(x.log[0][1], true, 'the rendered file exists while it uploads');
  assert.equal(x.log[1][2], '123');
  const [, claim, done] = pool.calls;
  assert.match(claim.sql, /ON CONFLICT\(dedup_key\) DO NOTHING/);
  assert.deepEqual(claim.params.slice(0, 2), ['replay', KEY]);
  const metadata = JSON.parse(claim.params[3]);
  assert.deepEqual([metadata.animation, metadata.event, metadata.editorialVersion, metadata.source], ['software', `leader:zakura:${day(96)}`, 1, '/v1/mining/software?period=1y&bucket=day']);
  assert.match(done.sql, /status='posted'/);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(`zecblock-replay-software-${process.pid}-`)), [], 'the temporary video is removed');
});

test('an ordinary day posts nothing and is decided once', async () => {
  const forbidden = fakeX({ uploadVideo: async () => { throw new Error('must not upload'); } });
  const tries = new Map();
  let loads = 0;
  const load = async url => { loads++; return url.includes('/v1/mining/software') ? software(50) : { success: false }; };
  assert.deepEqual(await replay.run(fakePool(), forbidden, options({ tries, load })), { skipped: 'no-story-today' });
  assert.equal(loads, 7, 'every animation was asked');
  const pool = fakePool();
  assert.deepEqual(await replay.run(pool, forbidden, options({ tries, load })), { skipped: 'no-story-today' });
  assert.equal(loads, 7, 'the next tick does not fetch again');
  assert.equal(pool.calls.length, 0);
});

test('an unreachable source is looked at again on the next tick', async () => {
  const tries = new Map();
  const load = async () => { throw new Error('fetch failed'); };
  assert.deepEqual(await replay.run(fakePool(), fakeX(), options({ tries, load })), { skipped: 'source-unavailable' });
  assert.equal((await replay.run(fakePool(), fakeX(), options({ tries }))).status, 'posted');
});

test('caps: one video a week, the same video once in 30 days, the same story once', async () => {
  const forbidden = fakeX({ uploadVideo: async () => { throw new Error('must not upload'); } });
  assert.deepEqual(await replay.run(fakePool(), forbidden, options({ now: new Date('2026-04-10T12:00:00Z') })), { skipped: 'outside-window' });
  assert.deepEqual(await replay.run(fakePool([replayRow('pools', '2026-04-05T21:00:00Z')]), forbidden, options()), { skipped: 'weekly-cap' });
  assert.deepEqual(await replay.run(fakePool([replayRow('pools', '2026-04-05T21:00:00Z', { status: 'uncertain' })]), forbidden, options()), { skipped: 'weekly-cap' }, 'a held post counts');
  assert.deepEqual(await replay.run(fakePool([replayRow('software', '2026-03-20T21:00:00Z')]), forbidden, options()), { skipped: 'no-story-today' }, 'same video within 30 days');
  assert.equal((await replay.run(fakePool([replayRow('software', '2026-03-01T21:00:00Z')]), fakeX(), options())).status, 'posted');
  const same = [{ post_type: 'replay', dedup_key: KEY, status: 'failed', created_at: '2026-01-01T21:00:00Z', metadata: { animation: 'software' } }];
  assert.deepEqual(await replay.run(fakePool(same), forbidden, options()), { skipped: 'no-story-today' }, 'a story is claimed once');
  const recent = [{ post_type: 'swap', dedup_key: 'swap:a', status: 'posted', created_at: '2026-04-10T20:55:00Z', metadata: {} }];
  assert.deepEqual(await replay.run(fakePool(recent), forbidden, options()), { skipped: 'paced' });
  const scan = [{ post_type: 'editorial_scan', dedup_key: 'analysis:scan:x', status: 'evaluated', created_at: '2026-04-10T21:04:00Z', metadata: {} }];
  assert.equal((await replay.run(fakePool(scan), fakeX(), options())).status, 'posted', 'bookkeeping rows do not pace a post');
  assert.deepEqual(await replay.run(fakePool([], { locked: false }), forbidden, options()), { skipped: 'another-run-active' });
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
