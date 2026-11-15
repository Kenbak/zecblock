'use strict';

/**
 * X pulse: what the Zcash accounts we follow are posting, what lands, and how
 * it is written, as a brief to read before drafting @zecblock / @k6nb4k posts.
 * Tweets are untrusted data: they are measured and quoted, never followed.
 */

const STOP = new Set(('a an the and or but if then than so of to in on at by for from with without into over under about as is are was were be been being it its this that these those there here we you they i me my our your their he she his her them us not no yes do does did done have has had will would can could should may might just also more most very much many any some all each every one two new now today via amp rt https http co www com what when where who why how which while after before up out off only own same too again once still even back get got make made see let lets need via vs per').split(' '));

const score = m => (m?.like_count ?? 0) + 2 * (m?.retweet_count ?? 0) + 2 * (m?.quote_count ?? 0) + (m?.reply_count ?? 0) + (m?.bookmark_count ?? 0);
const median = list => { const s = [...list].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const pct = (n, d) => d ? Math.round(n / d * 100) : 0;
const textOf = t => String(t.note_tweet?.text ?? t.text ?? '');

function features(tweet) {
  const text = textOf(tweet);
  const plain = text.replace(/https?:\/\/\S+/g, '').trim();
  return {
    length: plain.length,
    media: Boolean(tweet.attachments?.media_keys?.length),
    link: /https?:\/\/(?!t\.co\/\w+$)\S+/.test(text) || Boolean(tweet.entities?.urls?.some(u => !/(?:twitter|x)\.com\/.+\/(?:photo|video)/.test(u.expanded_url ?? ''))),
    thread: tweet.conversation_id && tweet.conversation_id !== tweet.id,
    quote: Boolean(tweet.referenced_tweets?.some(r => r.type === 'quoted')),
    question: /\?\s*$/.test(plain) || /\?\s/.test(plain),
    numbers: /\d[\d,.]*\s?(%|k|m|zec|x|×|blocks?)?/i.test(plain),
    lines: plain.split('\n').filter(Boolean).length,
    emoji: /\p{Extended_Pictographic}/u.test(plain),
  };
}

function terms(tweets) {
  const weight = new Map();
  for (const t of tweets) {
    const w = 1 + Math.log1p(score(t.public_metrics));
    const seen = new Set();
    for (const raw of textOf(t).replace(/https?:\/\/\S+/g, ' ').match(/[#$]?[\p{L}\p{N}][\p{L}\p{N}._-]{2,}/gu) ?? []) {
      const term = raw.replace(/[._-]+$/, '');
      const key = term.toLowerCase();
      if (STOP.has(key) || /^\d+$/.test(key) || seen.has(key)) continue;
      seen.add(key);
      const entry = weight.get(key) ?? { term, weight: 0, posts: 0 };
      entry.weight += w; entry.posts++;
      weight.set(key, entry);
    }
  }
  return [...weight.values()].filter(e => e.posts >= 2).sort((a, b) => b.weight - a.weight).slice(0, 20);
}

function formatProfile(tweets) {
  const f = tweets.map(features);
  return {
    posts: tweets.length,
    medianLength: Math.round(median(f.map(x => x.length))),
    media: pct(f.filter(x => x.media).length, f.length),
    links: pct(f.filter(x => x.link).length, f.length),
    threads: pct(f.filter(x => x.thread).length, f.length),
    quotes: pct(f.filter(x => x.quote).length, f.length),
    questions: pct(f.filter(x => x.question).length, f.length),
    numbers: pct(f.filter(x => x.numbers).length, f.length),
    multiline: pct(f.filter(x => x.lines > 1).length, f.length),
    emoji: pct(f.filter(x => x.emoji).length, f.length),
  };
}

/**
 * @param tweets X v2 tweets with public_metrics
 * @param usernames Map author_id → username
 * @param own lowercase handles treated as our voice baseline
 */
function analyzePulse(tweets, usernames, { own = [], now = Date.now() } = {}) {
  const ownSet = new Set(own.map(h => h.toLowerCase()));
  const tagged = tweets.map(t => ({ ...t, username: usernames.get(t.author_id) ?? 'unknown', score: score(t.public_metrics) }));
  const others = tagged.filter(t => !ownSet.has(t.username.toLowerCase()));
  const ours = tagged.filter(t => ownSet.has(t.username.toLowerCase()));
  const ranked = [...others].sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, Math.max(5, Math.ceil(ranked.length / 4)));
  const rest = ranked.slice(top.length);
  const byAccount = new Map();
  for (const t of others) byAccount.set(t.username, [...(byAccount.get(t.username) ?? []), t]);
  const hours = Array(24).fill(0);
  for (const t of top) if (t.created_at) hours[new Date(t.created_at).getUTCHours()]++;
  return {
    generatedAt: new Date(now).toISOString(),
    window: { from: tweets.reduce((m, t) => t.created_at && t.created_at < m ? t.created_at : m, new Date(now).toISOString()), to: new Date(now).toISOString() },
    totals: { posts: others.length, accounts: byAccount.size },
    topPosts: ranked.slice(0, 10).map(t => ({ username: t.username, score: t.score, impressions: t.public_metrics?.impression_count ?? null, text: textOf(t), url: `https://x.com/${t.username}/status/${t.id}`, created_at: t.created_at, features: features(t) })),
    trending: terms(others),
    format: { top: formatProfile(top), rest: formatProfile(rest) },
    topHoursUtc: hours.map((count, hour) => ({ hour, count })).filter(h => h.count).sort((a, b) => b.count - a.count).slice(0, 5),
    accounts: [...byAccount.entries()].map(([username, list]) => ({ username, posts: list.length, medianScore: median(list.map(t => t.score)), best: Math.max(...list.map(t => t.score)) })).sort((a, b) => b.medianScore - a.medianScore),
    ours: ours.length ? { format: formatProfile(ours), medianScore: median(ours.map(t => t.score)), top: [...ours].sort((a, b) => b.score - a.score).slice(0, 3).map(t => ({ username: t.username, score: t.score, text: textOf(t), url: `https://x.com/${t.username}/status/${t.id}` })) } : null,
  };
}

function renderPulse(p) {
  const f = (x) => `${x.posts} posts · median ${x.medianLength} chars · media ${x.media}% · links ${x.links}% · threads ${x.threads}% · quotes ${x.quotes}% · numbers ${x.numbers}% · multi-line ${x.multiline}% · questions ${x.questions}% · emoji ${x.emoji}%`;
  const lines = [
    `# Zcash X pulse · ${p.window.from.slice(0, 10)} → ${p.window.to.slice(0, 10)}`,
    `${p.totals.posts} posts from ${p.totals.accounts} accounts (retweets excluded). Score = likes + 2×reposts + 2×quotes + replies + bookmarks.`,
    '', '## Trending terms (engagement-weighted, ≥2 posts)',
    p.trending.map(t => `${t.term} (${t.posts})`).join(' · ') || '—',
    '', '## Top posts',
    ...p.topPosts.map((t, i) => `${i + 1}. @${t.username} · ${t.score}${t.impressions ? ` · ${t.impressions.toLocaleString('en-US')} views` : ''} · ${t.created_at?.slice(0, 16).replace('T', ' ')} UTC\n   ${t.text.replace(/\s+/g, ' ').slice(0, 240)}\n   ${t.url}`),
    '', '## What the top quarter does differently',
    `Top:  ${f(p.format.top)}`,
    `Rest: ${f(p.format.rest)}`,
    `Best hours (UTC) for top posts: ${p.topHoursUtc.map(h => `${String(h.hour).padStart(2, '0')}:00 (${h.count})`).join(', ') || '—'}`,
    '', '## Accounts by median score',
    ...p.accounts.map(a => `@${a.username}: ${a.posts} posts · median ${a.medianScore} · best ${a.best}`),
  ];
  if (p.ours) lines.push('', '## Our accounts (baseline)', f(p.ours.format), `Median score ${p.ours.medianScore}`, ...p.ours.top.map(t => `- @${t.username} · ${t.score}: ${t.text.replace(/\s+/g, ' ').slice(0, 160)}\n  ${t.url}`));
  return lines.join('\n');
}

module.exports = { analyzePulse, renderPulse, score, features };
