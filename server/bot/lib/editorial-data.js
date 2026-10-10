'use strict';

const { addDays, readActivity, HISTORY_START } = require('../../lib/transaction-activity');
const { completedWeekEnd, makeDraft } = require('../../lib/activity-milestones');
const { loadHashrateHistory } = require('../../api/lib/hashrate');
const policy = require('./editorial-policy');
const { fetchSpotPrice } = require('./spot-price');

// Flows already represent net movement across pools. Never subtract an
// unrelated Orchard withdrawal from an Ironwood deposit as a "migration".
const VALID_FLOWS = `SELECT sf.* FROM shielded_flows sf
  JOIN transactions t ON t.txid=sf.txid AND t.block_height=sf.block_height
  JOIN blocks b ON b.height=sf.block_height AND b.timestamp=sf.block_time
  WHERE NOT t.is_coinbase AND (t.vin_count>0 OR t.vout_count>0)
    AND COALESCE(t.value_balance_sapling,0)+COALESCE(t.value_balance_orchard,0)+COALESCE(t.value_balance_ironwood,0)
        = CASE WHEN sf.flow_type='shield' THEN -sf.amount_zat ELSE sf.amount_zat END
    AND sf.flow_type IN ('shield','deshield') AND sf.amount_zat>0`;
const VALID_SWAPS = `SELECT * FROM cross_chain_swaps WHERE status='SUCCESS'
  AND source_chain IS NOT NULL AND dest_chain IS NOT NULL AND source_chain<>dest_chain
  AND (source_chain='zec' OR dest_chain='zec') AND source_amount_usd>0`;

async function snapshot(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function assertMainnetFresh(db, now) {
  const { rows: [row] } = await db.query(`SELECT current_database() AS name,
    (SELECT timestamp FROM blocks ORDER BY height DESC LIMIT 1) AS timestamp`);
  if (row?.name !== 'zcash_explorer_mainnet') throw new Error('Editorial bot is mainnet-only');
  const age = now.getTime() / 1000 - Number(row.timestamp);
  if (row.timestamp == null || !Number.isFinite(age) || age > 1800 || age < -7200) throw new Error('Editorial source tip unavailable or stale');
}

async function liveCandidates(pool, now, { fetchPrice = fetchSpotPrice } = {}) {
  const result = await snapshot(pool, async db => {
    await assertMainnetFresh(db, now);
    const at = Math.floor(now.getTime() / 1000);
    const { rows: flows } = await db.query(`WITH valid AS MATERIALIZED (
      ${VALID_FLOWS} AND sf.block_time >= $1-90*86400-3600 AND sf.block_time < $1-120
    ), candidates AS (
      SELECT * FROM valid WHERE block_time >= $1-3600 AND amount_zat >= 50000000000
      ORDER BY amount_zat DESC,txid LIMIT 20
    ) SELECT c.*, s.* FROM candidates c CROSS JOIN LATERAL (
      SELECT count(*) AS sample_count,
        count(*) FILTER(WHERE h.amount_zat>c.amount_zat) AS greater_count,
        count(*) FILTER(WHERE h.amount_zat=c.amount_zat) AS equal_count
      FROM valid h WHERE h.flow_type=c.flow_type AND h.block_time<c.block_time
        AND h.block_time>=c.block_time-90*86400
    ) s`, [at]);
    const context = await eventContext(db, now);
    const candidates = flows.map(flow => policy.flowStory(withContext(flow, context))).filter(Boolean);
    const decisions = flows.filter(f => !candidates.some(c => c.key === `large_flow:${f.txid}`))
      .map(f => ({ key: `large_flow:${f.txid}`, reason: 'flow-baseline-or-significance' }));
    if (context.unavailable) decisions.push({ key: 'event-context', reason: 'context-unavailable', detail: context.unavailable });

    const { rows: [sync] } = await db.query(`SELECT updated_at FROM sync_state WHERE job_name='crosschain_swaps'`);
    const syncAge = now - new Date(sync?.updated_at || 0);
    if (syncAge >= 0 && syncAge <= 20 * 60000) {
      const { rows: swaps } = await db.query(`WITH valid AS MATERIALIZED (
        ${VALID_SWAPS} AND swap_created_at >= $1::timestamptz-interval '31 days' AND swap_created_at < $1
      ), candidates AS (
        SELECT * FROM valid WHERE swap_created_at >= $1::timestamptz-interval '1 hour'
          AND source_amount_usd>=50000 ORDER BY source_amount_usd DESC,id LIMIT 20
      ) SELECT c.*,s.* FROM candidates c CROSS JOIN LATERAL (
        SELECT count(*) AS sample_count,
          count(*) FILTER(WHERE h.source_amount_usd>c.source_amount_usd) AS greater_count,
          count(*) FILTER(WHERE h.source_amount_usd=c.source_amount_usd) AS equal_count
        FROM valid h WHERE h.swap_created_at<c.swap_created_at
          AND h.swap_created_at>=c.swap_created_at-interval '30 days'
      ) s`, [now.toISOString()]);
      candidates.push(...swaps.map(policy.swapStory).filter(Boolean));
      decisions.push(...swaps.filter(s => !candidates.some(c => c.key === `cross_chain:${s.id}`))
        .map(s => ({ key: `cross_chain:${s.id}`, reason: 'swap-baseline-or-significance' })));
    } else decisions.push({ key: 'crosschain', reason: 'sync-unavailable-or-stale' });

    const { rows: migrations } = await db.query(`SELECT t.txid,t.block_time,abs(t.value_balance_ironwood)::text AS amount_zat
      FROM transactions t JOIN blocks b ON b.height=t.block_height AND b.timestamp=t.block_time
      WHERE t.block_time >= $1-3600 AND t.block_time<$1-120
        AND NOT t.is_coinbase AND t.vin_count=0 AND t.vout_count=0
        AND t.value_balance_orchard>0 AND t.value_balance_ironwood<=-1000000000000
      ORDER BY abs(t.value_balance_ironwood) DESC LIMIT 1`, [at]);
    for (const row of migrations) {
      const story = policy.migrationStory({ ...row, price_usd: null,
        ironwood_zat: context.pools?.ironwood_pool_size, orchard_zat: context.pools?.orchard_pool_size });
      if (story) candidates.push(story);
    }
    candidates.push(...await reorgCandidates(db,now));
    return { candidates, decisions };
  });
  // Release the DB snapshot before waiting on an external quote. Only events
  // that qualify need pricing, and all events in this scan share one response.
  if (result.candidates.some(c => c.type.startsWith('flow_') || c.type === 'migration')) {
    const { quote, unavailable } = await fetchPrice();
    if (unavailable) result.decisions.push({ key: 'event-price', reason: 'price-unavailable', detail: unavailable });
    result.candidates = result.candidates.map(story => {
      if (!story.type.startsWith('flow_') && story.type !== 'migration') return story;
      const evidence = { ...story.evidence, price_usd: quote?.usd ?? null, price_quote: quote };
      return story.type === 'migration' ? policy.migrationStory(evidence) : policy.flowStory(evidence);
    });
  }
  return result;
}

async function reorgCandidates(db,now) {
  const { rows } = await db.query(`SELECT id,depth,fork_height,detected_at FROM fork_events
    WHERE detected_at >= $1::timestamptz-interval '1 hour' AND detected_at<=$1 AND depth>=2
    ORDER BY detected_at DESC LIMIT 3`, [now.toISOString()]);
  return rows.map(policy.reorgStory).filter(Boolean);
}

// Balances are context, never qualification: when missing or stale the story
// still posts, just without that sentence. Spot pricing happens after snapshot.
// A failed lookup is reported as a decision and rolled back to a savepoint so
// the surrounding snapshot transaction stays usable.
async function eventContext(db, now) {
  await db.query('SAVEPOINT editorial_context');
  try {
    const { rows: [pools] } = await db.query(`SELECT sapling_pool_size::text, orchard_pool_size::text,
        COALESCE(ironwood_pool_size,0)::text AS ironwood_pool_size, transparent_pool_size::text,
        shielded_pool_size::text, updated_at FROM privacy_stats ORDER BY updated_at DESC LIMIT 1`);
    await db.query('RELEASE SAVEPOINT editorial_context');
    const fresh = pools && now - new Date(pools.updated_at) <= 3 * 3600000 && now - new Date(pools.updated_at) >= -600000;
    return { pools: fresh ? pools : null, unavailable: null };
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT editorial_context');
    return { pools: null, unavailable: error.code || 'query-failed' };
  }
}

function withContext(flow, context) {
  const column = { sapling: 'sapling_pool_size', orchard: 'orchard_pool_size', ironwood: 'ironwood_pool_size', mixed: 'shielded_pool_size' }[flow.pool];
  return { ...flow, price_usd: null,
    pool_zat: column ? context.pools?.[column] : null, transparent_zat: context.pools?.transparent_pool_size };
}

async function activityCandidates(pool, now, includeWeekly) {
  const end = now.toISOString().slice(0, 10), target = addDays(end, -1);
  const activity = await readActivity(pool, addDays(target, -30), end, { now });
  const candidates = [policy.dailyActivity(activity, target)].filter(Boolean);
  if (includeWeekly) {
    const weekEnd = completedWeekEnd(now);
    const all = await readActivity(pool, HISTORY_START, weekEnd, { now, requireGenesis: true });
    const story = policy.weeklyActivity(makeDraft(all, weekEnd));
    if (story) candidates.push(story);
  }
  return candidates;
}

async function hashrateCandidate(pool, now) {
  return snapshot(pool, async db => {
    await assertMainnetFresh(db, now);
    const { rows: [coverage] } = await db.query('SELECT min(height) AS first,max(height) AS last,count(*) AS count FROM blocks');
    const genesisComplete = Number(coverage.first) === 0 && Number(coverage.count) === Number(coverage.last) + 1;
    const history = await loadHashrateHistory(db, 'all', '7d');
    return policy.hashStory(history, { target: addDays(now.toISOString().slice(0,10), -1), genesisComplete });
  });
}

async function signalCandidates(pool, now) {
  return snapshot(pool, async db => {
    await assertMainnetFresh(db, now);
    const end = now.toISOString().slice(0, 10), target = addDays(end, -1), start = addDays(target, -30);
    const candidates = [];
    const queries = {
      mvrv: `SELECT date::text,mvrv AS value FROM mvrv_daily WHERE date >= $1::date AND date < $2::date ORDER BY date`,
      exchange_deposit_zat: `SELECT date::text,sum(exchange_zat)::text AS value FROM turnstile_daily WHERE date >= $1::date AND date < $2::date GROUP BY date ORDER BY date`,
      daily_fees_zat: `SELECT (to_timestamp(timestamp) AT TIME ZONE 'UTC')::date::text AS date,
        CASE WHEN count(total_fees)=count(*) THEN sum(total_fees)::text END AS value FROM blocks
        WHERE timestamp >= extract(epoch FROM $1::date::timestamp AT TIME ZONE 'UTC')
          AND timestamp < extract(epoch FROM $2::date::timestamp AT TIME ZONE 'UTC') GROUP BY 1 ORDER BY 1`,
    };
    for (const [metric, sql] of Object.entries(queries)) {
      const { rows } = await db.query(sql, [start, end]);
      const c = policy.signalStory(metric, rows, target);
      if (c) candidates.push(c);
    }
    const { rows: flows } = await db.query(`WITH valid AS (${VALID_FLOWS}
      AND sf.block_time >= extract(epoch FROM $1::date::timestamp AT TIME ZONE 'UTC')
      AND sf.block_time < extract(epoch FROM $2::date::timestamp AT TIME ZONE 'UTC'))
      SELECT (to_timestamp(block_time) AT TIME ZONE 'UTC')::date::text AS date,
        sum(amount_zat) FILTER(WHERE flow_type='shield')::text AS shield_volume_zat,
        sum(amount_zat) FILTER(WHERE flow_type='deshield')::text AS deshield_volume_zat
      FROM valid GROUP BY 1 ORDER BY 1`, [start, end]);
    for (const metric of ['shield_volume_zat','deshield_volume_zat']) {
      const c = policy.signalStory(metric, flows.map(r => ({ date: r.date, value: r[metric] })), target);
      if (c) candidates.push(c);
    }
    return candidates;
  });
}

async function crosschainDaily(pool, now) {
  return snapshot(pool, async db => {
    const { rows: [sync] } = await db.query(`SELECT updated_at FROM sync_state WHERE job_name='crosschain_swaps'`);
    const age = now - new Date(sync?.updated_at || 0);
    if (age < 0 || age > 20 * 60000) return null;
    const end = now.toISOString().slice(0,10), target = addDays(end,-1);
    const { rows: [row] } = await db.query(`WITH valid AS (${VALID_SWAPS}
      AND swap_created_at >= $1::date::timestamp AT TIME ZONE 'UTC'
      AND swap_created_at < $2::date::timestamp AT TIME ZONE 'UTC')
      SELECT count(*) AS count,
        sum(source_amount_usd) FILTER(WHERE dest_chain='zec')::text AS inflow,
        sum(source_amount_usd) FILTER(WHERE source_chain='zec')::text AS outflow,
        max(source_amount_usd)::text AS largest,
        (SELECT source_chain||' -> '||dest_chain FROM valid GROUP BY source_chain,dest_chain ORDER BY sum(source_amount_usd) DESC,source_chain,dest_chain LIMIT 1) AS top_route
      FROM valid`, [target,end]);
    // Missing direction/value stays unavailable, never converted into a zero.
    if (!row || row.inflow == null || row.outflow == null || Number(row.count) < 10) return null;
    return policy.crosschainStory(row, target);
  });
}

// Completed-day closes from the hourly privacy snapshots, priced on the same
// UTC date. Only days up to the target are read; today's partial row is not.
async function milestoneCandidates(pool, now) {
  return snapshot(pool, async db => {
    await assertMainnetFresh(db, now);
    const target = addDays(now.toISOString().slice(0, 10), -1);
    const { rows } = await db.query(`SELECT t.date::text AS date, t.pool_size::text, t.chain_supply::text,
        t.ironwood_pool_size::text, p.price_usd::float8 AS price_usd
      FROM privacy_trends_daily t LEFT JOIN zec_price_daily p ON p.date=t.date
      WHERE t.date <= $1::date ORDER BY t.date`, [target]);
    return policy.milestoneStories(rows, target);
  });
}

module.exports = { VALID_FLOWS, VALID_SWAPS, snapshot, assertMainnetFresh, liveCandidates, activityCandidates, hashrateCandidate, signalCandidates, crosschainDaily, reorgCandidates, milestoneCandidates, eventContext };
