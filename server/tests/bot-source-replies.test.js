'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const https = require('https');
const { EventEmitter } = require('events');
const { preparePublication } = require('../bot/lib/editorial-source');
const { deliverSourceReply, recoverSourceReplies } = require('../bot/lib/editorial-source-delivery');
const { publish, run } = require('../bot/jobs/editorial');
const { XClient } = require('../bot/lib/x-client');
const fixtures = require('./fixtures/bot-editorial-stories');
const { insightFixtures } = require('../bot/lib/editorial-insights');
const logger = { info() {}, warn() {}, error() {} };

test('scheduled examples have a focused parent and one attributable source reply', () => {
  for (const story of [...fixtures, ...insightFixtures()]) {
    const p = preparePublication(story);
    assert.doesNotMatch(p.content, /https?:\/\//);
    assert.ok(p.content.length <= 280);
    assert.ok(p.sourceReply.content.length <= 280);
    assert.equal(new URL(p.sourceReply.url).origin, 'https://zecblock.com');
    assert.match(p.sourceReply.content, /Source & data/);
    if (story.type.startsWith('flow_') || story.type === 'swap') {
      assert.equal(p.sourceReply.url, story.content.split('\n').at(-1));
    }
  }
  const share = fixtures.find(s => s.type === 'activity_daily');
  assert.match(preparePublication(share).sourceReply.url, /\/charts\/privacy-adoption\?range=30d$/);
  assert.match(preparePublication(share).sourceReply.content, /Chart updates over time/);
  const weekly = structuredClone(fixtures.find(s => s.type === 'activity_weekly'));
  weekly.evidence.sourceUrl = 'https://cipherscan.app/privacy';
  assert.equal(new URL(preparePublication(weekly).sourceReply.url).origin, 'https://zecblock.com');
  assert.equal(preparePublication(fixtures.find(s => s.type === 'hashrate')).sourceReply.url, 'https://zecblock.com/network');
  assert.equal(preparePublication(insightFixtures().find(s => s.type === 'pool_trend')).sourceReply.url, 'https://zecblock.com/pools#flows');
});

test('source links cannot redirect users to an unexpected host or a private API', () => {
  const story = fixtures[0];
  for (const url of ['https://example.com/tx/a', 'http://zecblock.com/privacy',
    'https://zecblock.com.evil.test/privacy', 'https://user@zecblock.com/privacy', 'https://zecblock.com/v1/stats']) {
    assert.throws(() => preparePublication({ ...story, content: `Verified fact\n\n${url}` }), /Unexpected editorial source/);
  }
  assert.throws(() => preparePublication({ ...story, content: 'Facts https://zecblock.com/privacy and more facts' }), /one trailing URL/);
  assert.throws(() => preparePublication({ ...story, content: 'https://zecblock.com/privacy' }), /no story/);
});

test('preview returns the exact parent/reply pair without DB or X operations', async () => {
  const fail = () => { throw new Error('Unexpected external action'); };
  const result = await publish({ query: fail }, { dryRun: true, post: fail, reply: fail }, fixtures[0], { logger });
  assert.equal(result.status, 'preview');
  assert.deepEqual({ content: result.content, sourceReply: result.sourceReply }, preparePublication(fixtures[0]));
});

test('source delivery distinguishes a definite rate limit from an ambiguous acceptance', async () => {
  const parent = { key: 'test', id: '123', sourceReply: { url: 'https://zecblock.com/privacy', content: 'Source\nhttps://zecblock.com/privacy' } };
  for (const [code, status] of [[429, 'retryable'], [403, 'blocked'], [500, 'uncertain'], [undefined, 'uncertain']]) {
    const writes = [];
    const db = { async query(sql, args) { writes.push([sql, args]); return { rows: sql.startsWith('INSERT') ? [{ id: 1 }] : [] }; } };
    const result = await deliverSourceReply(db, { async reply() { throw Object.assign(new Error('delivery failed'), { statusCode: code }); } }, parent, { logger });
    assert.equal(result.status, status);
    assert.equal(writes.at(-1)[1][1], status);
  }
  assert.deepEqual(await recoverSourceReplies({ query() { throw new Error('Unexpected DB access'); } }, { dryRun: true }), []);
});

test('reply HTTP payload targets its parent and preserves known response status', async t => {
  let body, statusCode = 201;
  t.mock.method(https, 'request', (_options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.write = value => { body = JSON.parse(value); };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      callback(res);
      res.emit('data', JSON.stringify({ data: { id: '456', text: body.text } }));
      res.emit('end');
    };
    return req;
  });
  const x = new XClient({ accessToken: 'unit-test-placeholder', logger });
  assert.deepEqual(await x.reply('Source & data', '123'), { id: '456', text: 'Source & data' });
  assert.deepEqual(body, { text: 'Source & data', reply: { in_reply_to_tweet_id: '123' } });
  await assert.rejects(x.reply('Source', 'not-a-post-id'), /Invalid reply parent/);
  statusCode = 429;
  await assert.rejects(x.reply('Source', '123'), error => error.statusCode === 429);
});

test('only a definite HTTP 401 can refresh and resubmit a post', async () => {
  const x = new XClient({ accessToken: 'unit-test-placeholder', refreshToken: 'unit-test-placeholder', clientId: 'unit-test', logger });
  let sends = 0, refreshes = 0;
  x._doRefresh = async () => { refreshes++; };
  x._postTweet = async () => {
    sends++;
    throw Object.assign(new Error('X API 500: upstream operation 401 failed after acceptance'), { statusCode: 500 });
  };
  await assert.rejects(x.reply('Source', '123'), error => error.statusCode === 500);
  assert.equal(sends, 1); assert.equal(refreshes, 0);
  x._postTweet = async () => {
    sends++;
    if (sends === 2) throw Object.assign(new Error('X API 401: expired'), { statusCode: 401 });
    return { id: '456' };
  };
  assert.equal((await x.reply('Source', '123')).id, '456');
  assert.equal(sends, 3); assert.equal(refreshes, 1);
});

test('lost reply IDs and DB failure after reply acceptance remain held for reconciliation', async () => {
  const parent = { key: 'accepted', id: '123', sourceReply: { content: 'Source', url: 'https://zecblock.com/privacy' } };
  for (const lostId of [false, true]) {
    const statuses = [];
    const db = { async query(sql, args) {
      if (sql.startsWith('INSERT')) return { rows: [{ id: 1, attempts: 1 }] };
      if (sql.includes("SET status='posted'")) throw new Error('DB acknowledgement lost');
      statuses.push(args[1]); return { rows: [] };
    } };
    const result = await deliverSourceReply(db, { reply: async () => lostId ? {} : { id: '456' } }, parent, { logger });
    assert.equal(result.status, 'uncertain'); assert.deepEqual(statuses, ['uncertain']);
  }
  const db = { query: async sql => ({ rows: sql.startsWith('INSERT') ? [{ id: 1, attempts: 5 }] : [] }) };
  const exhausted = await deliverSourceReply(db, { reply: async () => { throw Object.assign(new Error('rate limited'), { statusCode: 429 }); } }, parent, { logger });
  assert.equal(exhausted.status, 'blocked');
});

test('new insight activation excludes pre-feature weekly catch-up and waits for a future reporting period', async () => {
  const now = new Date('2026-10-28T08:00:00Z');
  let insightActivation = '2026-10-27T08:00:00Z', scans = 0;
  const lock = { query: async () => ({ rows: [{ acquired: true }] }), release() {} };
  const pool = { connect: async () => lock, query: async (sql, args) => {
    if (!sql.startsWith('SELECT metadata')) return { rows: [] };
    const activatedAt = args[0] === 'analysis:insights:activation:v1' ? insightActivation : '2026-09-20T00:00:00Z';
    return { rows: activatedAt ? [{ metadata: { activatedAt } }] : [] };
  } };
  const story = (type, target) => ({ type, key: `new:${type}:${target}`, score: 80, content: 'Verified facts',
    evidence: { target, editorial: { topic: type, significance: 80 } } });
  const collectors = { assertMainnetFresh: async () => {}, liveCandidates: async () => [],
    activityCandidates: async () => [], hashrateCandidate: async () => null, signalCandidates: async () => [],
    insightCandidates: async () => { scans++; return [story('network_briefing', '2026-10-25'), story('pool_trend', '2026-10-27')]; } };
  const result = await run(pool, { dryRun: true }, { now, collectors, logger });
  assert.equal(scans, 1); assert.deepEqual(result.candidates.map(s => s.type), ['pool_trend']);
  insightActivation = null;
  const firstPreview = await run(pool, { dryRun: true }, { now, collectors, logger });
  assert.equal(scans, 1); assert.equal(firstPreview.candidates.length, 0);
});

test('real PostgreSQL: source failure retries only the reply; ambiguous replies stay held',
  { skip: process.env.ACTIVITY_TEST_POSTGRES !== '1' && !process.env.TEST_ACTIVITY_DATABASE_URL }, async () => {
    const { Pool } = require('pg');
    const connection = process.env.TEST_ACTIVITY_DATABASE_URL;
    const admin = new Pool(connection ? { connectionString: connection } : { host: '/tmp', database: 'postgres' });
    const name = `bot_reply_${process.pid}_${Date.now()}`;
    let db;
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      const url = connection ? new URL(connection) : null;
      if (url) url.pathname = `/${name}`;
      db = new Pool(url ? { connectionString: url.toString() } : { host: '/tmp', database: name });
      await db.query(fs.readFileSync(require.resolve('../bot/migrations/001_social_post_outbox.sql'), 'utf8'));
      let parents = 0, replies = 0;
      const x = {
        async post(content) { parents++; assert.doesNotMatch(content, /https?:\/\//); return { id: '12345' }; },
        async reply(_content, parentId) {
          replies++; assert.equal(parentId, '12345');
          if (replies === 1) throw Object.assign(new Error('rate limited'), { statusCode: 429 });
          return { id: '67890' };
        },
      };
      const results = await Promise.all([publish(db, x, fixtures[0], { logger }), publish(db, x, fixtures[0], { logger })]);
      assert.equal(parents, 1); assert.equal(replies, 1);
      assert.deepEqual(results.map(r => r.status).sort(), ['duplicate', 'posted']);
      assert.equal(results.find(r => r.status === 'posted').sourceReply.status, 'retryable');
      await recoverSourceReplies(db, x, { logger });
      assert.equal(replies, 1, 'respect retry delay');
      await db.query("UPDATE social_post_outbox SET updated_at=NOW()-interval '6 minutes' WHERE post_type='source_reply'");
      await Promise.all([recoverSourceReplies(db, x, { logger }), recoverSourceReplies(db, x, { logger })]);
      assert.equal(parents, 1); assert.equal(replies, 2);
      const source = (await db.query("SELECT * FROM social_post_outbox WHERE post_type='source_reply'")).rows[0];
      assert.equal(source.status, 'posted'); assert.equal(source.x_post_id, '67890'); assert.equal(source.attempts, 2);
      // Simulate a crash after saving a parent but before its source claim.
      await db.query("DELETE FROM social_post_outbox WHERE post_type='source_reply'");
      await recoverSourceReplies(db, { ...x, async reply() { replies++; throw new Error('response timeout'); } }, { logger });
      assert.equal((await db.query("SELECT status FROM social_post_outbox WHERE post_type='source_reply'")).rows[0].status, 'uncertain');
      const heldReplies = replies;
      await recoverSourceReplies(db, x, { logger });
      assert.equal(replies, heldReplies); assert.equal(parents, 1);
      // Pre-upgrade parents have no deliveryVersion=2 and must not get replies.
      await db.query("DELETE FROM social_post_outbox WHERE post_type='source_reply'; UPDATE social_post_outbox SET metadata=metadata-'deliveryVersion'");
      await recoverSourceReplies(db, x, { logger });
      assert.equal(replies, heldReplies);
    } finally {
      if (db) await db.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.end();
    }
  });
