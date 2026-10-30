#!/usr/bin/env node
'use strict';

// Local review only. This module imports no X client, environment loader or DB
// connection. Every image and parent/reply pair uses the production builders.
const fs = require('fs');
const path = require('path');
const { renderEditorial } = require('../server/bot/lib/zecblock-cards');
const { preparePublication } = require('../server/bot/lib/editorial-source');
const p = require('../server/bot/lib/editorial-policy');
const { poolMilestoneStories } = require('../server/bot/lib/pool-activity-milestones');
const { insightFixtures } = require('../server/bot/lib/editorial-insights');
const { addDays } = require('../server/lib/transaction-activity');
const nu7 = require('../server/bot/lib/nu7-stories');
const schedule = require('../server/api/lib/network-schedule');

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const output = path.resolve(arg('output', 'output/bot-editorial-review'));
const evidenceFile = path.resolve(arg('evidence', path.join(output, 'published-evidence.json')));
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function poolFixture(comparison = false) {
  const target = '2026-10-25', launch = '2026-07-28', start = addDays(launch, -365);
  const count = (Date.parse(target) - Date.parse(start)) / 86400000 + 1;
  const days = Array.from({ length: count }, (_, i) => {
    const date = addDays(start, i), latest = date === target;
    const recent = date >= addDays(target, -6);
    const sinceLaunch = (Date.parse(date) - Date.parse(launch)) / 86400000;
    const daysLeft = (Date.parse(target) - Date.parse(date)) / 86400000;
    // Illustrative DAILY counts, not interpolated rolling totals. The last
    // eight days prove equality first, then the final strict 51,500/49,000 lead.
    const finish = [5500, 6000, 6500, 7000, 7500, 8000, 8500, 8000];
    const ironwoodExample = daysLeft <= 7 ? finish[7 - daysLeft]
      : Math.max(0, Math.round(1000 + 54 * sinceLaunch + 140 * Math.sin(sinceLaunch / 5)));
    const orchardExample = daysLeft <= 7 ? 7000
      : Math.round(7000 + Math.max(0, 80 - sinceLaunch) * 23 + 130 * Math.sin(sinceLaunch / 6));
    return { date, complete: true, totalTransactions: 20000,
      orchard: comparison ? orchardExample : 12000,
      ironwood: date < launch ? 0 : comparison ? ironwoodExample
        : latest ? 12500 : recent ? 9900 : 1000 };
  });
  const source = { historyStart: start, days, capturedAt: '2026-10-26T08:00:00Z',
    activation: { height: 3428143, date: launch, timestamp: Date.parse(`${launch}T12:00:00Z`) / 1000 },
    tip: { height: 3530000, hash: 'f'.repeat(64), timestamp: Date.parse('2026-10-26T07:59:00Z') / 1000 } };
  return poolMilestoneStories(source, target)[0];
}

function fromPublished(row) {
  const evidence = row.metadata;
  if (row.post_type === 'activity_daily') {
    return p.dailyActivity({ days: evidence.days, tip: evidence.tip, capturedAt: evidence.capturedAt }, row.dedup_key.split(':').at(-1));
  }
  if (row.post_type === 'activity_weekly') return p.weeklyActivity({ week: evidence.period.start, metadata: evidence });
  if (row.post_type.startsWith('flow_')) return p.flowStory(evidence);
  if (row.post_type === 'swap') return p.swapStory(evidence);
  // A published hashrate record retains its original verified evidence. Its
  // stored 91-point card is not enough to re-prove an all-time record today.
  if (row.post_type === 'hashrate') return { type: row.post_type, key: row.dedup_key, content: row.content, evidence };
  if (row.post_type === 'network_signal') return p.signalStory(evidence.metric, evidence.rows, evidence.target);
  return null;
}

// Illustrative NU7 stories at mainnet's scheduled height. Times, pools and
// amounts are synthetic; the gates and copy are the production builders.
function nu7Fixtures() {
  const H = 3543405, T = Date.parse('2026-11-06T00:31:00Z') / 1000, at = s => new Date(s * 1000);
  const jitter = i => [0.4, 1.7, 0.9, 1.2, 0.3, 2.1, 0.8, 1.1][i % 8];
  const recent = [];
  for (let t = T - 75, h = H - 1; t > T - 1200; h--) { recent.unshift({ height: h, timestamp: Math.round(t) }); t -= 75 * jitter(h); }
  for (let t = T, h = H; t < T + 360; h++) { recent.push({ height: h, timestamp: Math.round(t) }); t += 25 * jitter(h); }
  const tip = recent.at(-1);
  const plan = { network: 'main', nu7Height: H, eras: [{ height: 0, seconds: 150 }, { height: 653600, seconds: 75 }, { height: H, seconds: 25 }] };
  let lo = 3535800, hi = 6132390;
  while (lo < hi) { const m = (lo + hi) >> 1; if (schedule.targetSeconds(plan, m, 6132390) / 86400 <= 364.5) hi = m; else lo = m + 1; }
  return [
    ['NU7 countdown · a day before', nu7.countdownStory({ nu7Height: H, tip: { height: H - 1120, timestamp: T - 84000 },
      readiness: { referenceUpgrade: 'NU7', latestProtocol: 170190, latestCount: 371, totalActive: 466, readinessPct: 79.6 } })],
    ['NU7 is live', nu7.activationStory({ nu7Height: H, block: { height: H, timestamp: T }, tip, pool: 'ViaBTC', recent, now: at(tip.timestamp + 60) })],
    ['NU7 first 24 hours', nu7.firstDayStory({ nu7Height: H, activationTime: T, now: at(T + 87000),
      after: { blocks: 3448, averageSeconds: 25.06 }, before: { blocks: 1149, averageSeconds: 75.2 } })],
    ['NU7 block milestone', nu7.blockMilestoneStory({ nu7Height: H, tip: { height: H + 10040 }, start: { height: H - 1, timestamp: T - 75 },
      crossing: { height: H + 9999, timestamp: T + 250600 }, now: at(T + 251000) })],
    ['NSM reserve milestone', nu7.nsmMilestoneStory({ nu7Height: H, now: at(T + 9 * 86400),
      baseline: { height: H - 1, nsmZat: '0' }, current: { height: H + 30500, nsmZat: '1012345678' },
      crossing: { height: H + 30100, timestamp: T + 8.8 * 86400, nsmZat: '1000081234' },
      daily: Array.from({ length: 9 }, (_, i) => ({ date: addDays('2026-11-06', i), nsmZat: i === 8 ? '1012345678' : String(Math.round((i + 1) * 111000000)) })) })],
    ['Halving countdown', nu7.halvingCountdownStory({ schedule: plan, tip: { height: lo, timestamp: T + 390 * 86400 }, ...schedule })],
  ];
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const examples = [], declined = [];
  const measuredFile = path.join(output, 'measured-insights.json');
  if (fs.existsSync(measuredFile)) {
    for (const story of JSON.parse(fs.readFileSync(measuredFile, 'utf8'))) {
      examples.push({ label: story.type === 'network_briefing' ? 'Weekly briefing · measured chain data' : 'Measured public-flow trend',
        basis: 'Read-only canonical database snapshot · real historical data', story });
    }
  }
  if (fs.existsSync(evidenceFile)) {
    const data = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    const extra = path.join(output, 'recent-activity-evidence.json');
    const posts = [...data.posts, ...(fs.existsSync(extra) ? JSON.parse(fs.readFileSync(extra, 'utf8')) : [])];
    const seen = new Set(), types = new Set();
    for (const row of posts) {
      if (seen.has(row.dedup_key)) continue;
      seen.add(row.dedup_key);
      const story = fromPublished(row);
      if (!story) { declined.push({ key: row.dedup_key, type: row.post_type, reason: 'No longer meets standalone significance gate' }); continue; }
      // A few different real examples are more useful than a wall of flows.
      if (types.has(story.type) || ['flow_deshield', 'network_signal'].includes(story.type)) continue;
      types.add(story.type);
      examples.push({ label: ({ activity_daily: 'Activity record', activity_weekly: 'Historical weekly activity',
        hashrate: 'Historical hashrate record', flow_shield: 'Rare shielding event', swap: 'Tracked cross-chain swap' })[story.type] || story.type,
      basis: 'Published historical evidence · redesigned locally', originalUrl: `https://x.com/zecblock_bot/status/${row.x_post_id}`,
      observed: row.posted_at, story });
    }
  }
  const [briefing, reversal, streak, pace] = insightFixtures();
  for (const [label, story] of [['Weekly network briefing', briefing], ['Public flow reversal', reversal],
    ['Sustained public inflows', streak], ['Changing public-flow pace', pace],
    ['Ironwood weekly-share milestone', poolFixture()], ['Ironwood / Orchard crossover', poolFixture(true)], ...nu7Fixtures()]) {
    if (story) examples.push({ label, basis: 'Illustrative fixture · synthetic numbers, not live data', story });
  }
  const manifest = [];
  for (const [index, example] of examples.entries()) {
    const publication = preparePublication(example.story);
    const image = `${String(index + 1).padStart(2, '0')}-${example.story.type}.png`;
    const file = await renderEditorial(example.story);
    fs.copyFileSync(file, path.join(output, image)); fs.unlinkSync(file);
    manifest.push({ label: example.label, basis: example.basis, originalUrl: example.originalUrl,
      observed: example.observed, type: example.story.type, topic: example.story.evidence.editorial?.topic,
      parent: publication.content, sourceReply: publication.sourceReply, image });
  }
  fs.writeFileSync(path.join(output, 'examples.json'), `${JSON.stringify({ examples: manifest, declined }, null, 2)}\n`);
  const mixFile = path.join(output, 'published-mix.json');
  const mix = fs.existsSync(mixFile) ? JSON.parse(fs.readFileSync(mixFile, 'utf8')) : null;
  const last100 = mix?.windows?.filter(r => r.bucket === 'last_100_posts') || [];
  const mixRows = last100.map(r => `<tr><td>${escape(r.post_type)}</td><td>${r.n}</td></tr>`).join('');
  const cards = manifest.map((e, i) => `<article data-type="${escape(e.type)}" data-measured="${!e.basis.startsWith('Illustrative')}">
    <div class="example-heading"><h2>${escape(e.label)}</h2><span>${escape(e.basis)}</span></div>
    <div class="post"><div class="account"><b>ZecBlock Data</b><small>@zecblock_bot · local preview</small></div>
      <p class="post-copy">${escape(e.parent)}</p><img src="${escape(e.image)}" alt="${escape(e.label)} chart preview" width="1200" height="675">
    </div>
    <div class="reply"><small>FIRST REPLY · SOURCE</small><p>${escape(e.sourceReply?.content || '')}</p>
      ${e.sourceReply ? `<a href="${escape(e.sourceReply.url)}" target="_blank" rel="noreferrer">Open website source</a>` : ''}</div>
    ${e.originalUrl ? `<a class="original" href="${escape(e.originalUrl)}" target="_blank" rel="noreferrer">Compare with original published post</a>` : ''}
    <small class="counter">${i + 1} / ${manifest.length} · ${e.parent.length} parent characters · ${e.sourceReply?.content.length || 0} reply characters</small>
  </article>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow"><title>ZecBlock bot · pre-deployment examples</title>
    <style>:root{color-scheme:dark;font-family:Arial,sans-serif;background:#0b0c0e;color:#f1f3f5}*{box-sizing:border-box}body{max-width:1060px;margin:0 auto;padding:36px 24px}h1{font-size:30px;letter-spacing:-.7px;max-width:700px}header p{color:#c2c7cf;line-height:1.65;max-width:800px}h2{font-size:19px;margin:0 0 8px}a{color:#e8cf78;text-decoration:none}a:hover{text-decoration:underline}small{color:#9ca4b0}nav{display:flex;gap:10px;flex-wrap:wrap;margin:24px 0}button{background:#111316;color:#c2c7cf;border:1px solid #24272d;padding:9px 14px;border-radius:6px;cursor:pointer}button.active{color:#f8bc21;border-color:#9ca4b0}.examples{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:34px 24px}article{min-width:0;border-top:1px solid #24272d;padding-top:20px}.example-heading{min-height:66px}.example-heading span{font-size:12px;line-height:1.5;color:#9ca4b0}.post{border:1px solid #24272d;border-radius:12px;overflow:hidden;background:#111316}.account{padding:18px 18px 0;display:flex;flex-direction:column;gap:5px}.post-copy{font-size:16px;line-height:1.55;white-space:pre-wrap;padding:0 18px;min-height:120px}.post img{display:block;width:100%;height:auto;border-top:1px solid #24272d}.reply{margin:0 0 14px 22px;padding:18px 0 0 18px;border-left:2px solid #24272d}.reply p{font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6;color:#c2c7cf}.reply a,.original{font-size:12px}.counter{display:block;margin-top:10px}.measure{padding:18px 0;margin:20px 0;border-top:1px solid #24272d;border-bottom:1px solid #24272d}.measure table{font-size:13px;border-collapse:collapse}.measure td{padding:5px 24px 5px 0}.measure summary{cursor:pointer;color:#c2c7cf}footer{font-size:12px;color:#9ca4b0;margin:32px 0;line-height:1.7}@media(max-width:760px){body{padding:20px 14px}.examples{grid-template-columns:1fr}.post-copy{min-height:0}}</style></head><body>
    <header><small>PRE-DEPLOYMENT REVIEW · NOTHING PUBLISHED</small><h1>More stories worth reading.<br>Evidence that earns the space.</h1>
    <p>These examples use the new selection, copy, chart renderer and first-reply source format. Measured examples use a read-only canonical database snapshot or saved evidence from published posts. Synthetic examples are labeled individually; they show the new formats and do not claim current events.</p></header>
    ${mix ? `<details class="measure"><summary>Measured feed mix: 83 of the last 100 posts concerned money movement</summary><p>46 shielding/deshielding alerts + 23 swaps + 14 cross-chain summaries. Other posts: 14 daily activity, 2 network signals, 1 weekly activity. Read-only outbox observation: ${escape(mix.observedAt)}.</p><table><tbody>${mixRows}</tbody></table></details>` : ''}
    <nav aria-label="Example filters"><button class="active" data-filter="all">All examples</button><button data-filter="network_briefing">Weekly briefing</button><button data-filter="pool_trend">Trends</button><button data-filter="milestone">Ironwood</button><button data-filter="nu7">NU7</button><button data-filter="historical">Measured examples</button></nav>
    <main class="examples">${cards}</main><footer>Publication is unchanged. New code is local only; no X calls, token refresh, production DB writes or deployment are performed by this preview command. Website charts update over time; each post records its dated observation. ${declined.length} historical daily examples were declined by the new significance gate.</footer>
    <script>document.querySelectorAll('button[data-filter]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('button[data-filter]').forEach(b=>b.classList.toggle('active',b===button));document.querySelectorAll('article').forEach(article=>{const f=button.dataset.filter;article.hidden=f==='historical'?article.dataset.measured!=='true':f!=='all'&&article.dataset.type!==f})}));</script></body></html>`;
  fs.writeFileSync(path.join(output, 'index.html'), html);
  console.log(JSON.stringify({ examples: manifest.length, historical: manifest.filter(x => x.originalUrl).length,
    measured: manifest.filter(x => !x.basis.startsWith('Illustrative')).length,
    declinedHistorical: declined.length, gallery: path.join(output, 'index.html') }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
