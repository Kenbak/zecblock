#!/usr/bin/env node
'use strict';

// Read-only production replay: no X client, token refresh, outbox writes, or
// Telegram messages. --output writes review evidence to a local JSON file.
//   node server/bot/preview.js [--output=file.json]
//   node server/bot/preview.js --exchange [--output=file.json]   exchange-flow collector only
//   node server/bot/preview.js --exchange-gifs=<dir>              offline: fixture deposit + withdrawal GIFs, no database
const fs = require('fs');
const path = require('path');
const arg = name => process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const has = name => process.argv.some(a => a === `--${name}` || a.startsWith(`--${name}=`));

async function exchangeGifs(dir) {
  const x = require('./lib/exchange-flows');
  const fx = require('./fixtures/exchange-flows');
  const { renderLandingGif } = require('./lib/landing-gif');
  const { renderEditorial } = require('./lib/zecblock-cards');
  fs.mkdirSync(dir, { recursive: true });
  const deposit = x.classifyRows(fx.rows.hyperunitDeposit()).events[0];
  const withdrawal = x.classifyRows(fx.rows.krakenWithdrawal()).events[0];
  // Fixture history: real deposit/withdrawal shapes ranked against a synthetic 30-day sample.
  for (const [name, event] of [['exchange-deposit', deposit], ['exchange-withdrawal', withdrawal]]) {
    const events = [...fx.history(event.blockTime), event];
    const story = x.exchangeFlowStory({ ...event, ...x.rankEvent(event, events), net: x.netFlow(events, event.blockTime, event.entity), price_usd: 500 });
    if (!story) throw new Error(`${name}: fixture did not qualify`);
    const gif = path.join(dir, `${name}.gif`);
    const result = await renderLandingGif(story, story.evidence.distribution, gif);
    const still = await renderEditorial(story);
    fs.renameSync(still, path.join(dir, `${name}.png`));
    fs.writeFileSync(path.join(dir, `${name}.txt`), `${story.content}\n`);
    console.log(JSON.stringify({ name, key: story.key, gif, bytes: result.bytes, seconds: result.seconds, chars: story.content.length }));
  }
}

async function replay() {
  const { loadEnv } = require('../lib/job-utils');
  loadEnv(__dirname);
  const { getPool, getReadPool } = require('../lib/db-pool');
  const pool = getPool(), reader = getReadPool();
  try {
    let result;
    if (has('exchange')) {
      const data = require('./lib/editorial-data');
      const started = Date.now();
      result = await data.exchangeFlowCandidates(reader, new Date());
      result.elapsedMs = Date.now() - started;
    } else {
      const { run } = require('./jobs/editorial');
      result = await run(pool, { dryRun: true }, { reader });
    }
    const file = arg('output');
    if (file) fs.writeFileSync(file, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ candidates: result.candidates?.length, selected: result.selected?.length,
      decisions: result.decisions, ...(result.elapsedMs != null ? { elapsedMs: result.elapsedMs,
        stories: result.candidates.map(c => c.content) } : {}) }, null, 2));
  } finally {
    await pool.end(); if (reader !== pool) await reader.end();
  }
}

(has('exchange-gifs') ? exchangeGifs(arg('exchange-gifs') || '.') : replay())
  .catch(error => { console.error(error.message); process.exitCode = 1; });
