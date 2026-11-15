'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzePulse, renderPulse } = require('../lib/x-pulse');
const { fetchPulse } = require('../scripts/x-pulse');
const { ZCASH_X_ACCOUNTS, OWN_X_ACCOUNTS, fromQueries, parseAccounts } = require('../lib/zcash-x-accounts');

const users = new Map([['1', 'zooko'], ['2', 'ShieldedLabs'], ['3', 'zecblock']]);
const t = (id, author, text, likes, extra = {}) => ({ id, author_id: author, text, created_at: `2026-11-1${id % 5}T2${id % 4}:00:00Z`, conversation_id: id, public_metrics: { like_count: likes, retweet_count: Math.floor(likes / 10), reply_count: 2, quote_count: 0, bookmark_count: 1, impression_count: likes * 40 }, ...extra });
const tweets = [
  t('11', '1', 'Shielded supply hit 5.1M ZEC today. Ironwood is working.', 900, { attachments: { media_keys: ['m'] } }),
  t('12', '2', 'NU7.1 poll opens tomorrow. Shielded ZEC only. Ironwood snapshot details soon.', 400),
  t('13', '1', 'gm', 5),
  t('14', '2', 'Thread on the Dev Fund poll and Ironwood:', 50, { conversation_id: '12' }),
  t('15', '1', 'What should NU8 prioritise?', 20),
  t('16', '3', 'Block 3,590,000: fees drop to 1,000 zatoshis.', 120),
];

test('ranks by engagement, keeps our accounts as a separate baseline', () => {
  const p = analyzePulse(tweets, users, { own: OWN_X_ACCOUNTS, now: Date.parse('2026-11-15T18:00:00Z') });
  assert.equal(p.totals.posts, 5);
  assert.equal(p.topPosts[0].username, 'zooko');
  assert.equal(p.topPosts[0].url, 'https://x.com/zooko/status/11');
  assert.ok(p.topPosts.every(x => x.username !== 'zecblock'));
  assert.equal(p.ours.top[0].username, 'zecblock');
  assert.ok(p.trending.some(x => x.term.toLowerCase() === 'ironwood'));
  assert.ok(!p.trending.some(x => ['the', 'today', 'https'].includes(x.term.toLowerCase())));
  assert.equal(p.format.top.media > 0, true);
  const text = renderPulse(p);
  assert.match(text, /## Trending terms/);
  assert.match(text, /## Our accounts \(baseline\)/);
});

test('account list is deduplicated, validated and fits X query limits', () => {
  assert.deepEqual(parseAccounts('@zooko, zooko ,bad handle!,ZcashLabs'), ['zooko', 'ZcashLabs']);
  for (const q of fromQueries([...ZCASH_X_ACCOUNTS, ...OWN_X_ACCOUNTS], '-is:retweet')) assert.ok(q.length <= 512);
  const tiny = fromQueries(['a', 'b', 'c'], '', 22);
  assert.ok(tiny.length > 1 && tiny.every(q => q.length <= 22));
});

test('fetch pages through results with the read-only token and reports auth failures without bodies', async () => {
  const seen = [];
  const pages = [{ data: tweets.slice(0, 3), includes: { users: [...users].map(([id, username]) => ({ id, username })) }, meta: { next_token: 'p2' } }, { data: tweets.slice(3), meta: {} }];
  const fetchImpl = async (url, init) => { seen.push({ url: String(url), auth: init.headers.Authorization }); return Response.json(pages[seen.length - 1]); };
  const pulse = await fetchPulse({ env: { X_BEARER_TOKEN: 'tok' }, fetchImpl, now: Date.parse('2026-11-15T18:00:00Z') });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].auth, 'Bearer tok');
  assert.match(new URL(seen[0].url).searchParams.get('query'), /from:zecblock OR from:k6nb4k/);
  assert.equal(new URL(seen[1].url).searchParams.get('next_token'), 'p2');
  assert.equal(pulse.totals.posts, 5);
  await assert.rejects(fetchPulse({ env: { X_BEARER_TOKEN: 'tok' }, fetchImpl: async () => new Response('{"detail":"secret"}', { status: 401 }) }), error => /HTTP 401.*X_BEARER_TOKEN/.test(error.message) && !/secret/.test(error.message));
  await assert.rejects(fetchPulse({ env: { X_BEARER_TOKEN: '...' }, fetchImpl }), /placeholder/);
  await assert.rejects(fetchPulse({ env: { X_TOKEN_FILE: '/nonexistent' }, fetchImpl }), /No X token/);
});
