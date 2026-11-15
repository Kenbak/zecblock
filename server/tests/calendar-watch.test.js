'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const watch = require('../lib/calendar-watch');
const job = require('../jobs/watch-calendar-sources');

const FPF_CALL = '<p>Deadline to submit a proposal: <strong>November 13th at 20:00 UTC</strong></p><p>Full Schedule:</p><ul><li>Call for Proposals: October 30 (Fri) – November 13 (Fri) @ 20:00 UTC</li><li>Mandatory Review Period: November 16 (Mon) – December 16 (Wed) @ 20:00 UTC</li><li>Polling/Voting Period: December 17 (Thu) – December 29 (Tue) @ 20:00 UTC</li></ul>';
const ZEBRA = 'Earlier sidecar builds cannot follow Testnet past NU7 at height 4,465,026, or Mainnet past NU7 at height 3,543,405.\n- `getstandardfee` on Mainnet reports 5000 zatoshis per logical action until the next block is at height 3,590,000, and 1000 from then on.\nThis release follows NU7 on Mainnet (height 3,543,405) and Testnet (height 4,465,026).';

test('organizer schedules yield exact UTC deadlines with their labels and date-only starts', () => {
  const dates = watch.extractDates(watch.htmlToText(FPF_CALL), '2026-10-30T11:17:25Z');
  const at = label => dates.filter(d => d.label.startsWith(label)).map(d => d.at ?? d.date);
  assert.deepEqual(at('Deadline to submit a proposal'), ['2026-11-13T20:00:00Z']);
  assert.deepEqual(at('Mandatory Review Period'), ['2026-11-16', '2026-12-16T20:00:00Z']);
  assert.deepEqual(at('Polling/Voting Period'), ['2026-12-17', '2026-12-29T20:00:00Z']);
});

test('years are never read as days, and far yearless dates in work summaries are dropped', () => {
  assert.deepEqual(watch.extractDates('Two contributions (March and June 2026).', '2026-11-13T00:00:00Z'), []);
  assert.deepEqual(watch.extractDates('Core engineering from July 1 to September 30, 2026.', '2026-11-13T00:00:00Z').map(d => d.date), ['2026-09-30']);
  // A January date in a December post belongs to the next year.
  assert.equal(watch.extractDates('Results by January 5.', '2026-12-20T00:00:00Z')[0].date, '2027-01-05');
});

test('heights keep their sentence and drop the ones the source places on testnet', () => {
  const heights = watch.extractHeights(ZEBRA);
  assert.deepEqual(heights.map(h => h.value), [3_543_405, 3_590_000]);
  assert.match(heights.find(h => h.value === 3_590_000).excerpt, /getstandardfee/);
  assert.deepEqual(watch.extractHeights('Activate NU7 on public Testnet at height 4,465,026.'), []);
});

test('applications are not candidates; organizer posts and calendar keywords are', () => {
  const trusted = ['FPF'];
  assert.equal(watch.isCandidateTopic({ title: 'Retroactive Grant Application - zcrowd', categoryId: 54, author: 'someone' }, trusted), false);
  assert.equal(watch.isCandidateTopic({ title: 'Anything at all', categoryId: 54, author: 'FPF' }, trusted), true);
  assert.equal(watch.isCandidateTopic({ title: 'ZCG and the Dev Fund: Timeline for Proposals and Polling', categoryId: 25, author: 'x' }, trusted), true);
  assert.equal(watch.isCandidateTopic({ title: 'Wallet backup question', categoryId: 25, author: 'x' }, trusted), false);
});

test('the known calendar is read from source files', () => {
  const known = watch.knownCalendar([fs.readFileSync('lib/grant-rounds.ts', 'utf8'), fs.readFileSync('lib/zcash-calendar.ts', 'utf8')]);
  assert.ok(known.topics.has(59298) && known.topics.has(57056));
  assert.ok(known.dates.has('2026-12-17'));
  assert.ok(known.heights.has(3_500_662));
});

test('entities decode exactly once', () => {
  assert.equal(watch.htmlToText('<p>A &amp;lt;b&amp;gt; &amp; C &lt;tag&gt;</p>'), 'A &lt;b&gt; & C <tag>');
});

test('digest marks known and new items, escapes Markdown and stays under Telegram limits', () => {
  const text = watch.formatDigest([{ title: 'Fee *drop*', kind: 'upgrade', source: 'github/zebra', url: 'https://x.test', tracked: false,
    dates: [{ date: '2026-12-17', at: null, label: 'Voting', known: true }], heights: [{ value: 3_590_000, excerpt: 'until height 3,590,000', known: false }] }]);
  assert.match(text, /Fee \\\*drop\\\*/);
  assert.match(watch.formatDigest([{ title: 'a\\_b', kind: 'k', source: 's', url: 'u', dates: [], heights: [] }]), /a\\\\\\_b/);
  assert.match(text, /✓ 2026-12-17 — Voting/);
  assert.match(text, /\+ block #3,590,000/);
  const many = Array.from({ length: 80 }, (_, i) => ({ title: `T${i}`, kind: 'vote', source: 's', url: 'u', dates: [{ date: '2026-12-01', label: 'x'.repeat(60) }], heights: [] }));
  assert.ok(watch.formatDigest(many).length < 4096);
});

test('a run sends only new candidates once, then remembers them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-watch-'));
  const env = { CALENDAR_WATCH_STATE: path.join(dir, 'state.json') };
  const now = Date.parse('2026-11-15T18:00:00Z');
  const fetchImpl = async url => {
    const u = String(url);
    const body = u.includes('/c/governance/') ? { users: [{ id: 1, username: 'FPF' }], topic_list: { topics: [{ id: 900, slug: 'poll', title: 'Coinholder poll dates', category_id: 25, created_at: '2026-11-14T00:00:00Z', last_posted_at: '2026-11-14T00:00:00Z', posters: [{ user_id: 1, description: 'Original Poster' }] }] } }
      : u.includes('/c/') ? { topic_list: { topics: [] } }
      : u.endsWith('/t/900.json') ? { title: 'Coinholder poll dates', post_stream: { posts: [{ version: 1, created_at: '2026-11-14T00:00:00Z', cooked: '<p>Polling opens November 20 and closes November 30 @ 20:00 UTC</p>' }] } }
      : u.includes('/v1/network/stats') ? { data: { blockchain: { height: 3_576_600 } } }
      : new URL(u).hostname === 'api.github.com' ? [{ tag_name: 'v9', name: 'v9', published_at: '2026-11-10T00:00:00Z', html_url: 'https://gh/v9', body: 'Mainnet fee change at height 3,600,000 (network upgrade schedule).' }]
      : null;
    return new Response(JSON.stringify(body), { status: body === null ? 404 : 200 });
  };
  const sent = [];
  const logger = { info() {}, warn() {} };
  const first = await job.run({ now, fetchImpl, env, logger, send: async text => { sent.push(text); } });
  assert.equal(sent.length, 1);
  assert.equal(first.report.length, 4); // the poll + one release per watched repo
  assert.match(sent[0], /2026-11-30 20:00 UTC|2026-11-20/);
  assert.match(sent[0], /block #3,600,000/);
  await job.run({ now: now + 3600_000, fetchImpl, env, logger, send: async text => { sent.push(text); } });
  assert.equal(sent.length, 1, 'already-seen documents are not sent again');
  // A failed delivery must not mark documents as seen.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-watch-'));
  const env2 = { CALENDAR_WATCH_STATE: path.join(dir2, 'state.json') };
  await assert.rejects(job.run({ now, fetchImpl, env: env2, logger, send: async () => { throw new Error('telegram down'); } }));
  assert.equal(fs.existsSync(env2.CALENDAR_WATCH_STATE), false);
});

test('X uses the bot token read-only, sends one search, and an expired token only skips X', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-watch-x-'));
  const tokenFile = path.join(dir, 'bot.env');
  fs.writeFileSync(tokenFile, 'DB_PASSWORD=secret\nX_ACCESS_TOKEN=abc123\nX_REFRESH_TOKEN=never-used\n');
  assert.equal(require('../lib/x-read-token').readXToken({ CALENDAR_WATCH_X_TOKEN_FILE: tokenFile }), 'abc123');
  assert.equal(require('../lib/x-read-token').readXToken({ X_BEARER_TOKEN: 'app', CALENDAR_WATCH_X_TOKEN_FILE: tokenFile }), 'app');
  const now = Date.parse('2026-11-15T18:00:00Z');
  const calls = [];
  const fetchFor = status => async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://api.x.com/')) {
      calls.push({ u, auth: init.headers.Authorization });
      if (status !== 200) return new Response('{"title":"Unauthorized"}', { status });
      return new Response(JSON.stringify({ data: [{ id: '42', author_id: '7', created_at: '2026-11-15T10:00:00Z', text: 'Coinholder poll on NU7.1 closes December 5 at 20:00 UTC' }], includes: { users: [{ id: '7', username: 'ZcashFoundation' }] } }));
    }
    if (u.includes('/v1/network/stats')) return Response.json({ data: { blockchain: { height: 3_576_600 } } });
    return Response.json(new URL(u).hostname === 'api.github.com' ? [] : { topic_list: { topics: [] } });
  };
  const env = { CALENDAR_WATCH_STATE: path.join(dir, 'state.json'), CALENDAR_WATCH_X_TOKEN_FILE: tokenFile };
  const sent = [];
  const result = await job.run({ now, fetchImpl: fetchFor(200), env, logger: { info() {}, warn() {} }, send: async text => { sent.push(text); } });
  assert.ok(calls.length >= 1 && calls.length <= 3);
  assert.equal(calls[0].auth, 'Bearer abc123');
  const query = new URL(calls[0].u).searchParams.get('query');
  assert.match(query, /from:ZcashFoundation OR from:zcash OR from:ShieldedLabs/);
  for (const c of calls) assert.ok(new URL(c.u).searchParams.get('query').length <= 512);
  assert.equal(result.report[0].url, 'https://x.com/ZcashFoundation/status/42');
  assert.match(sent[0], /2026-12-05 20:00 UTC/);
  assert.doesNotMatch(sent[0], /abc123|never-used|secret/);
  // 401: the run continues without X, and nothing is refreshed or rewritten.
  const warnings = [];
  await job.run({ now, fetchImpl: fetchFor(401), env: { ...env, CALENDAR_WATCH_STATE: path.join(dir, 's2.json') }, logger: { info() {}, warn: m => warnings.push(m) }, send: async () => {} });
  assert.ok(warnings.some(w => /X skipped \(HTTP 401\)/.test(w)));
  assert.equal(fs.readFileSync(tokenFile, 'utf8').includes('X_ACCESS_TOKEN=abc123'), true);
});
