#!/usr/bin/env node
'use strict';

/**
 * Zcash calendar source watcher.
 *
 * Reads public organizer announcements (Zcash Community Forum JSON, organizer
 * posts on X via the bot's token) and node release notes (GitHub releases), extracts dates and block heights, and sends
 * a Telegram digest of candidates that are not yet in the calendar. It never
 * edits the calendar: a human approves each event into lib/grant-rounds.ts or
 * lib/zcash-calendar.ts. Source text is untrusted data, never instructions.
 *
 *   node server/jobs/watch-calendar-sources.js --preview   # print, no state, no Telegram
 *   node server/jobs/watch-calendar-sources.js             # send new candidates, remember them
 */

const fs = require('node:fs');
const path = require('node:path');
const { htmlToText, extractDates, extractHeights, isCandidateTopic, classify, knownCalendar, formatDigest } = require('../lib/calendar-watch');

const FORUM = 'https://forum.zcashcommunity.com';
/** Governance, Foundation, Protocol, Zebra, Ecosystem updates, Retroactive grants. */
const CATEGORIES = [[25, 'governance'], [21, 'foundation'], [23, 'protocol'], [46, 'zebra'], [31, 'ecosystem-updates'], [54, 'retroactive-grants']];
/** Organizer accounts whose topics are always reviewed (others need a calendar keyword). */
const TRUSTED_AUTHORS = ['FPF', 'zcashfoundation', 'ZcashFoundation', 'shieldedlabs', 'ShieldedLabs', 'zodl', 'ZODL'];
const RELEASES = ['ZcashFoundation/zebra', 'zcash/zcash', 'zcash/wallet'];
const CALENDAR_FILES = ['lib/grant-rounds.ts', 'lib/zcash-calendar.ts', 'lib/nu7-vote-config.ts', 'lib/upgrade-history-data.ts'];
const USER_AGENT = 'ZecBlock-calendar-watch/1 (+https://zecblock.com/calendar)';
const { parseAccounts, fromQueries } = require('../lib/zcash-x-accounts');
const { readXToken } = require('../lib/x-read-token');
const X_KEYWORDS = '(vote OR voting OR poll OR snapshot OR deadline OR activation OR activates OR upgrade OR NU7 OR "NU7.1" OR NU8 OR halving OR "call for proposals")';

async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${new URL(url).hostname} HTTP ${response.status}`);
  return response.json();
}

async function forumCandidates({ fetchImpl, since, logger }) {
  const out = [];
  for (const [id, slug] of CATEGORIES) {
    let list;
    try { list = await getJson(`${FORUM}/c/${slug}/${id}/l/latest.json`, fetchImpl); } catch (error) { logger.warn(`[calendar-watch] forum ${slug}: ${error.message}`); continue; }
    const users = new Map((list.users ?? []).map(u => [u.id, u.username]));
    for (const topic of list.topic_list?.topics ?? []) {
      const author = users.get(topic.posters?.find(p => /original poster/i.test(p.description ?? ''))?.user_id ?? topic.posters?.[0]?.user_id);
      if (Date.parse(topic.last_posted_at ?? topic.bumped_at ?? topic.created_at) < since) continue;
      if (!isCandidateTopic({ title: topic.title, categoryId: topic.category_id ?? id, author }, TRUSTED_AUTHORS)) continue;
      out.push({ topicId: topic.id, slug: topic.slug, title: topic.title, author, category: slug });
    }
  }
  const unique = [...new Map(out.map(t => [t.topicId, t])).values()];
  const results = [];
  // Small, sequential detail reads: polite to the forum and bounded per run.
  for (const topic of unique.slice(0, 40)) {
    try {
      const detail = await getJson(`${FORUM}/t/${topic.topicId}.json`, fetchImpl);
      const post = detail.post_stream?.posts?.[0];
      if (!post) continue;
      const text = htmlToText(post.cooked);
      results.push({
        key: `forum:${topic.topicId}:v${post.version ?? 1}`,
        source: `forum/${topic.category}${topic.author ? ` · ${topic.author}` : ''}`,
        topicId: topic.topicId, title: detail.title ?? topic.title, url: `${FORUM}/t/${topic.slug}/${topic.topicId}`,
        published: post.created_at, text,
      });
    } catch (error) { logger.warn(`[calendar-watch] topic ${topic.topicId}: ${error.message}`); }
  }
  return results;
}

/** Recent ecosystem posts on X that mention calendar keywords. One or two paid search requests per run. */
async function xCandidates({ fetchImpl, since, now = Date.now(), logger, env }) {
  const token = readXToken(env);
  if (!token) { logger.info('[calendar-watch] X skipped: no token available'); return []; }
  // Ecosystem accounts (server/lib/zcash-x-accounts.js), overridable with CALENDAR_WATCH_X_ACCOUNTS.
  const accounts = parseAccounts(env.CALENDAR_WATCH_X_ACCOUNTS);
  if (!accounts.length) return [];
  // Recent search covers seven days; never ask for older posts.
  const start = new Date(Math.max(since, now - 6.9 * 86_400_000)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const tweets = [];
  const users = new Map();
  for (const query of fromQueries(accounts, `${X_KEYWORDS} -is:retweet -is:reply`)) {
    const url = `https://api.x.com/2/tweets/search/recent?${new URLSearchParams({ query, max_results: '25', start_time: start, 'tweet.fields': 'created_at,author_id,note_tweet', expansions: 'author_id', 'user.fields': 'username' })}`;
    let response;
    try {
      response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    } catch { logger.warn('[calendar-watch] X request failed'); return []; }
    // Never echo the response or token. 401 means the bot's token expired; the bot refreshes it on its next post.
    if (!response.ok) { logger.warn(`[calendar-watch] X skipped (HTTP ${response.status})`); return []; }
    let body;
    try { body = await response.json(); } catch { return []; }
    for (const u of body.includes?.users ?? []) users.set(u.id, u.username);
    tweets.push(...(body.data ?? []));
  }
  const body = { data: tweets };
  return (body.data ?? []).map(tweet => {
    const user = users.get(tweet.author_id) ?? 'x';
    return {
      key: `x:${tweet.id}`, source: `x/@${user}`, title: `@${user}: ${String(tweet.text).split('\n')[0].slice(0, 90)}`,
      url: `https://x.com/${user}/status/${tweet.id}`, published: tweet.created_at, text: tweet.note_tweet?.text ?? tweet.text ?? '',
    };
  });
}

async function releaseCandidates({ fetchImpl, since, logger }) {
  const results = [];
  for (const repo of RELEASES) {
    let releases;
    try { releases = await getJson(`https://api.github.com/repos/${repo}/releases?per_page=5`, fetchImpl); } catch (error) { logger.warn(`[calendar-watch] ${repo}: ${error.message}`); continue; }
    for (const release of Array.isArray(releases) ? releases : []) {
      if (release.draft || Date.parse(release.published_at) < since) continue;
      const text = String(release.body ?? '');
      // Releases matter to the calendar only when they schedule an upgrade.
      if (!/\b(activation|activates|NU\d|network upgrade)\b/i.test(text)) continue;
      results.push({ key: `github:${repo}:${release.tag_name}`, source: `github/${repo}`, title: `${repo} ${release.name || release.tag_name}`, url: release.html_url, published: release.published_at, text });
    }
  }
  return results;
}

async function chainTip(fetchImpl, env) {
  try {
    const body = await getJson(`${env.CALENDAR_WATCH_API || 'https://api.zecblock.com'}/v1/network/stats`, fetchImpl);
    const height = body?.data?.blockchain?.height;
    return Number.isSafeInteger(height) ? height : null;
  } catch { return null; }
}

function readKnown(root) {
  const texts = CALENDAR_FILES.map(file => { try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return ''; } });
  return knownCalendar(texts);
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { seen: {} }; }
}
function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Turn raw source documents into reviewable candidates, marking what the calendar already has. */
function buildCandidates(documents, known, seen, { now = Date.now(), tip = null } = {}) {
  const candidates = [];
  // A calendar candidate is upcoming or very recent: past work and history are noise.
  const earliest = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10);
  for (const doc of documents) {
    if (seen[doc.key]) continue;
    const dates = extractDates(doc.text, doc.published).filter(d => d.date >= earliest).map(d => ({ ...d, known: known.dates.has(d.date) }));
    const heights = extractHeights(doc.text).filter(h => tip === null || h.value >= tip - 2_000).map(h => ({ ...h, known: known.heights.has(h.value) }));
    const tracked = doc.topicId !== undefined && known.topics.has(doc.topicId);
    // Nothing schedulable, or everything already in the calendar: remember silently.
    const fresh = dates.some(d => !d.known) || heights.some(h => !h.known);
    candidates.push({ ...doc, kind: classify(doc.title, doc.text), dates, heights, tracked, report: fresh && (dates.length > 0 || heights.length > 0) });
  }
  return candidates;
}

async function run({ preview = false, now = Date.now(), fetchImpl = globalThis.fetch, logger = console, env = process.env, root = path.resolve(__dirname, '../..'), send } = {}) {
  const stateFile = env.CALENDAR_WATCH_STATE || '/var/lib/cipherscan-calendar-watch/state.json';
  const state = preview ? { seen: {} } : readState(stateFile);
  const lookbackDays = Number(env.CALENDAR_WATCH_LOOKBACK_DAYS) || (Object.keys(state.seen).length ? 14 : 45);
  const since = now - lookbackDays * 86_400_000;
  const documents = [
    ...await forumCandidates({ fetchImpl, since, logger }),
    ...await releaseCandidates({ fetchImpl, since, logger }),
    ...await xCandidates({ fetchImpl, since, now, logger, env }),
  ];
  const tip = await chainTip(fetchImpl, env);
  const candidates = buildCandidates(documents, readKnown(root), state.seen, { now, tip });
  const report = candidates.filter(c => c.report);
  if (preview) return { report, skipped: candidates.length - report.length };
  if (report.length) {
    const deliver = send ?? (async text => require('../lib/signal-telegram').sendSignalReport(text, { env }));
    await deliver(formatDigest(report));
  }
  // Remember every reviewed document only after a successful delivery.
  for (const c of candidates) state.seen[c.key] = new Date(now).toISOString();
  // Bound the state: keep the most recent 2,000 keys.
  state.seen = Object.fromEntries(Object.entries(state.seen).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 2000));
  state.checkedAt = new Date(now).toISOString();
  writeState(stateFile, state);
  logger.info(`[calendar-watch] ${documents.length} documents, ${report.length} candidates sent`);
  return { report, skipped: candidates.length - report.length };
}

if (require.main === module) {
  const preview = process.argv.includes('--preview');
  if (!preview) { try { require('../lib/job-utils').loadEnv(__dirname); } catch { /* Env may come from systemd. */ } }
  run({ preview })
    .then(({ report, skipped }) => {
      if (!preview) return;
      for (const c of report) {
        console.log(`\n${c.tracked ? '↻' : '•'} ${c.title}\n  ${c.kind} · ${c.source} · ${c.url}`);
        for (const d of c.dates) console.log(`  ${d.known ? '✓' : '+'} ${d.at ?? d.date}  ${d.label}`);
        for (const h of c.heights) console.log(`  ${h.known ? '✓' : '+'} #${h.value}  ${h.excerpt.slice(0, 160)}`);
      }
      console.log(`\n${report.length} candidates · ${skipped} documents with nothing new`);
    })
    .catch(error => { console.error(`[calendar-watch] ${error.message}`); process.exitCode = 1; });
}

module.exports = { run, buildCandidates, readXToken };
