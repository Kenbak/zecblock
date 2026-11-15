#!/usr/bin/env node
'use strict';

/**
 * Zcash X pulse: recent posts from the ecosystem accounts we follow
 * (server/lib/zcash-x-accounts.js), ranked by engagement, with trending terms
 * and the format of what performs, plus our own accounts as a baseline.
 * Read it before drafting posts for @zecblock or @k6nb4k.
 *
 *   node server/scripts/x-pulse.js [--days 7] [--max 200] [--json] [--out file]
 *
 * Token: X_BEARER_TOKEN, X_ACCESS_TOKEN, or the bot's X_ACCESS_TOKEN line
 * (read-only, never refreshed). Each run reads up to --max posts, which X bills per post.
 */

const fs = require('node:fs');
const { ZCASH_X_ACCOUNTS, OWN_X_ACCOUNTS, parseAccounts, fromQueries } = require('../lib/zcash-x-accounts');
const { readXToken } = require('../lib/x-read-token');
const { analyzePulse, renderPulse } = require('../lib/x-pulse');

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };

async function fetchPulse({ env = process.env, fetchImpl = globalThis.fetch, days = 7, max = 200, now = Date.now() } = {}) {
  const token = readXToken(env);
  if (!token) throw new Error('No X token: set X_ACCESS_TOKEN (the bot token), X_BEARER_TOKEN, or X_TOKEN_FILE (the bot env file)');
  if (/^\.+$|^<.*>$|^(your|token|xxx)/i.test(token)) throw new Error('The X token looks like a placeholder; paste the real token');
  const accounts = parseAccounts(env.X_PULSE_ACCOUNTS, [...ZCASH_X_ACCOUNTS, ...OWN_X_ACCOUNTS]);
  const start = new Date(now - Math.min(6.9, Math.max(0.5, days)) * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const tweets = [];
  const usernames = new Map();
  for (const query of fromQueries(accounts, '-is:retweet')) {
    let next;
    do {
      const params = new URLSearchParams({ query, max_results: '100', start_time: start, 'tweet.fields': 'created_at,author_id,public_metrics,note_tweet,entities,attachments,conversation_id,referenced_tweets', expansions: 'author_id', 'user.fields': 'username' });
      if (next) params.set('next_token', next);
      const response = await fetchImpl(`https://api.x.com/2/tweets/search/recent?${params}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
      // Status only: never echo bodies that could contain account details.
      if (!response.ok) throw new Error(`X search failed (HTTP ${response.status})${response.status === 401 ? `: X rejected ${env.X_BEARER_TOKEN?.trim() ? 'X_BEARER_TOKEN' : 'the bot access token (X_ACCESS_TOKEN); it expires after about 2 hours and the bot refreshes it on its next post'}` : response.status === 402 || response.status === 429 ? ': out of X API credits or rate-limited' : ''}`);
      const body = await response.json();
      for (const u of body.includes?.users ?? []) usernames.set(u.id, u.username);
      tweets.push(...(body.data ?? []));
      next = body.meta?.next_token;
    } while (next && tweets.length < max);
    if (tweets.length >= max) break;
  }
  return analyzePulse(tweets.slice(0, max), usernames, { own: OWN_X_ACCOUNTS, now });
}

if (require.main === module) {
  fetchPulse({ days: Number(arg('days', 7)), max: Number(arg('max', 200)) })
    .then(pulse => {
      const output = process.argv.includes('--json') ? JSON.stringify(pulse, null, 2) : renderPulse(pulse);
      const out = arg('out');
      if (out) fs.writeFileSync(out, output); else console.log(output);
    })
    .catch(error => { console.error(`[x-pulse] ${error.message}`); process.exitCode = 1; });
}

module.exports = { fetchPulse };
