'use strict';

// Weekly replay: one animated card a week, the rest of the feed stays as it is.
//
// The rule is deliberately small. Each Sunday from 21:00 UTC the bot posts the
// animation it has gone longest without posting. One post per week at most, and
// a week with no usable source or no working renderer posts nothing: a missed
// week is never made up later.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ANIMATIONS, renderVideo } = require('../lib/animated-card');
const { assertMainnetFresh } = require('../lib/editorial-data');

// Same sender lock as the editorial job: one process posts at a time.
const LOCK = 839307;
const BASE = 'https://zecblock.com';
const MARK = '🟨';
const API = 'https://api.zecblock.com';
const POST_TYPE = 'replay';
// First rotation order; afterwards the least recently posted animation goes next.
const ORDER = ['software', 'swaps', 'pools', 'pool-race', 'shielded-share', 'hashrate', 'supply'];
const WINDOW_START_HOUR = 21;
const PACING_MS = 20 * 60_000;
// A failing renderer or upload must not retry on every five-minute tick.
const MAX_ATTEMPTS = 3;
const HELD = ['posted', 'posting', 'uncertain'];

/** The Sunday slot `now` falls in, or null outside Sunday 21:00–24:00 UTC. */
function replaySlot(now) {
  if (now.getUTCDay() !== 0 || now.getUTCHours() < WINDOW_START_HOUR) return null;
  const date = now.toISOString().slice(0, 10);
  return { date, key: `replay:v1:${date}` };
}

/** Animations in the order they should be tried: never posted first, then oldest post first. */
function rotation(history) {
  const last = new Map();
  for (const row of history) {
    const id = row.metadata?.animation;
    const at = Date.parse(row.created_at);
    if (row.post_type === POST_TYPE && HELD.includes(row.status) && ORDER.includes(id) && Number.isFinite(at)) last.set(id, Math.max(last.get(id) ?? 0, at));
  }
  return [...ORDER].sort((a, b) => (last.get(a) ?? 0) - (last.get(b) ?? 0) || ORDER.indexOf(a) - ORDER.indexOf(b));
}

/** Post copy from the same model the video is drawn from, so the two cannot disagree. */
function replayCopy(id, model) {
  const { lead, context } = model.post();
  const content = `${MARK} ${lead}\n\n${context}\n\n${BASE}${ANIMATIONS[id].page}`;
  if (content.length > 280) throw new Error(`Replay copy exceeds 280 characters: ${id}`);
  return content;
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${new URL(url).pathname} returned ${response.status}`);
  return response.json();
}

const attempts = new Map();

async function run(pool, xClient, {
  now = new Date(), logger = console, api = process.env.BOT_API_BASE || API,
  load = fetchJson, render = renderVideo, assertFresh = assertMainnetFresh, tries = attempts,
} = {}) {
  const slot = replaySlot(now);
  if (!slot) return { skipped: 'outside-window' };
  const { rows: history } = await pool.query(`SELECT post_type,dedup_key,status,created_at,metadata
    FROM social_post_outbox WHERE post_type=$1 OR created_at >= $2::timestamptz-interval '20 minutes'`, [POST_TYPE, now.toISOString()]);
  if (history.some(row => row.dedup_key === slot.key)) return { skipped: 'already-claimed' };
  // Stay clear of a post that has just gone out; the next tick tries again.
  if (history.some(row => row.post_type !== 'source_reply' && HELD.includes(row.status) && now - new Date(row.created_at) < PACING_MS)) return { skipped: 'paced' };
  if ((tries.get(slot.key) || 0) >= MAX_ATTEMPTS) return { skipped: 'attempts-exhausted' };
  tries.set(slot.key, (tries.get(slot.key) || 0) + 1);

  const lock = await pool.connect();
  let locked = false, file;
  try {
    const { rows: [row] } = await lock.query('SELECT pg_try_advisory_lock($1) AS acquired', [LOCK]);
    locked = row.acquired;
    if (!locked) return { skipped: 'another-run-active' };
    await assertFresh(pool, now);

    let chosen;
    for (const id of rotation(history)) {
      try {
        const model = ANIMATIONS[id].build(await load(`${api}${ANIMATIONS[id].path}`), { network: 'mainnet' }, now);
        if (model) { chosen = { id, model }; break; }
        logger.info(`[Replay decision] ${JSON.stringify({ key: slot.key, animation: id, reason: 'source-incomplete' })}`);
      } catch (error) {
        logger.warn(`[Replay] ${id} skipped: ${error.message}`);
      }
    }
    if (!chosen) return { skipped: 'no-usable-source' };
    const { id, model } = chosen;
    const content = replayCopy(id, model);
    const metadata = { animation: id, from: model.dates[0], to: model.dates.at(-1), points: model.dates.length,
      source: ANIMATIONS[id].path, editorialVersion: 1, editorial: { topic: `replay:${id}` } };

    file = path.join(os.tmpdir(), `zecblock-replay-${id}-${process.pid}-${now.getTime()}.mp4`);
    await render(model, file);
    if (xClient.dryRun) {
      logger.info(`[Replay preview] ${slot.key} ${id}\n${content}`);
      return { key: slot.key, status: 'preview', animation: id, content };
    }

    // Upload before claiming: a failed upload has posted nothing and may be retried.
    const mediaId = await xClient.uploadVideo(file);
    const { rows: [claim] } = await pool.query(`INSERT INTO social_post_outbox
      (post_type,dedup_key,content,metadata,status) VALUES ($1,$2,$3,$4::jsonb,'posting')
      ON CONFLICT(dedup_key) DO NOTHING RETURNING id`, [POST_TYPE, slot.key, content, JSON.stringify(metadata)]);
    if (!claim) return { key: slot.key, status: 'duplicate' };
    try {
      const result = await xClient.postUploaded(content, mediaId);
      if (!result?.id || String(result.id).startsWith('dry_run')) throw new Error('Missing real X post ID');
      logger.info(`[Replay] X accepted ${slot.key} (${id}): ${result.id}`);
      await pool.query(`UPDATE social_post_outbox SET status='posted',x_post_id=$2,
        posted_at=NOW(),attempts=attempts+1,updated_at=NOW() WHERE id=$1`, [claim.id, result.id]);
      return { key: slot.key, status: 'posted', animation: id, id: result.id };
    } catch (error) {
      // As with editorial posts: X may have accepted it, so never retry blindly.
      await pool.query(`UPDATE social_post_outbox SET status='uncertain',error_message=$2,
        attempts=attempts+1,updated_at=NOW() WHERE id=$1`, [claim.id, String(error.message).slice(0, 500)]);
      logger.error(`[Replay] Delivery needs reconciliation: ${slot.key}: ${error.message}`);
      return { key: slot.key, status: 'uncertain', animation: id };
    }
  } finally {
    if (file) try { fs.unlinkSync(file); } catch { /* temporary artifact */ }
    if (locked) await lock.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    lock.release();
  }
}

module.exports = { run, replaySlot, rotation, replayCopy, ORDER, MAX_ATTEMPTS };
