'use strict';

// Read-only NU7 observations for the bot. The activation height comes from the
// serving node's upgrade schedule as stored with each canonical accounting
// observation; NSM amounts are the node's signed counter, joined to canonical
// blocks by height AND hash and kept as exact zatoshi strings.
const { networkSchedule, halvingIndex, halvingHeight, targetSeconds } = require('../../api/lib/network-schedule');
const { referenceProtocol } = require('../../api/lib/upgrade-protocol');
const { getPoolName, getPoolTagSql, POOL_BY_TAG } = require('../../api/mining-pools');
const { censusTable } = require('../../lib/node-census');
const s = require('./nu7-stories');

const CANONICAL_OBSERVATIONS = `node_accounting_observations a
  JOIN blocks b ON b.height=a.height AND b.hash=a.hash WHERE a.chain='main'`;

async function optional(db, name, decisions, work) {
  await db.query(`SAVEPOINT ${name}`);
  try {
    const result = await work();
    await db.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await db.query(`ROLLBACK TO SAVEPOINT ${name}`);
    decisions.push({ key: `nu7:${name}`, reason: 'context-unavailable', detail: error.code || error.message });
    return null;
  }
}

async function nodeReadiness(db) {
  const { protocol, upgrade } = referenceProtocol({ NETWORK: 'mainnet' });
  const { rows: [row] } = await db.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE protocol_version::bigint >= $1)::int AS ready
    FROM ${censusTable(process.env.NODE_SOURCE || 'peer')} census
    WHERE census_active = TRUE AND protocol_version IS NOT NULL`, [protocol]);
  if (!row?.total) return null;
  return { referenceUpgrade: upgrade, latestProtocol: protocol, latestCount: row.ready, totalActive: row.total,
    readinessPct: Number((100 * row.ready / row.total).toFixed(1)) };
}

async function windowStats(db, sql, params) {
  const { rows: [row] } = await db.query(sql, params);
  const blocks = Number(row?.blocks);
  const span = Number(row?.span);
  return blocks > 1 && span > 0 ? { blocks, averageSeconds: span / (blocks - 1) } : null;
}

/** Candidates for whichever NU7 phase the canonical chain is in. */
async function nu7Candidates(db, now) {
  const candidates = [], decisions = [];
  const { rows: [obs] } = await db.query(`SELECT a.height, a.chain, a.upgrades FROM ${CANONICAL_OBSERVATIONS}
    AND a.upgrades IS NOT NULL ORDER BY a.height DESC LIMIT 1`);
  const schedule = obs ? networkSchedule({ chain: obs.chain, upgrades: obs.upgrades }) : null;
  if (!schedule) return { candidates, decisions: [{ key: 'nu7', reason: 'schedule-unavailable' }] };
  const { rows: [tipRow] } = await db.query('SELECT height, timestamp FROM blocks ORDER BY height DESC LIMIT 1');
  const tip = { height: Number(tipRow.height), timestamp: Number(tipRow.timestamp) };
  const halving = s.halvingCountdownStory({ schedule, tip, halvingIndex, halvingHeight, targetSeconds });
  if (halving) candidates.push(halving);
  if (!schedule.nu7Height) return { candidates, decisions: [...decisions, { key: 'nu7', reason: 'nu7-unscheduled' }] };
  const nu7Height = schedule.nu7Height;

  if (tip.height < nu7Height) {
    const readiness = await optional(db, 'readiness', decisions, () => nodeReadiness(db));
    const story = s.countdownStory({ nu7Height, tip, readiness });
    if (story) candidates.push(story);
    return { candidates, decisions };
  }

  const { rows: [act] } = await db.query(`SELECT height, hash, timestamp, miner_address, coinbase_hex,
      ${getPoolTagSql('coinbase_hex')} AS tag FROM blocks WHERE height=$1`, [nu7Height]);
  const { rows: [prev] } = await db.query('SELECT height, timestamp FROM blocks WHERE height=$1', [nu7Height - 1]);
  if (!act || !prev) return { candidates, decisions: [{ key: 'nu7', reason: 'activation-block-unavailable' }] };
  const block = { height: Number(act.height), hash: act.hash, timestamp: Number(act.timestamp) };
  const start = { height: Number(prev.height), timestamp: Number(prev.timestamp) };
  const pool = getPoolName(act.miner_address, act.coinbase_hex) || POOL_BY_TAG[act.tag]?.name || null;

  // Twenty minutes of 75-second blocks, then every NU7 block so far.
  const { rows: recent } = await db.query(`SELECT height, timestamp FROM blocks
    WHERE height > $1 - 400 AND height <= $1 AND timestamp >= $2 - 1200 ORDER BY height`, [tip.height, block.timestamp]);
  const activation = s.activationStory({ nu7Height, block, tip, pool,
    recent: recent.map(r => ({ height: Number(r.height), timestamp: Number(r.timestamp) })), now });
  if (activation) candidates.push(activation);

  // Height bounds keep these reads on the primary key; header times decide membership.
  const after = await windowStats(db, `SELECT count(*) AS blocks, max(timestamp) - $2 AS span FROM blocks
    WHERE height BETWEEN $1 AND $1 + 6000 AND timestamp >= $2 AND timestamp < $2 + 86400`, [nu7Height, block.timestamp]);
  const before = await windowStats(db, `SELECT count(*) AS blocks, max(timestamp) - min(timestamp) AS span FROM blocks
    WHERE height BETWEEN $1 - 3000 AND $1 - 1 AND timestamp >= $2 - 86400 AND timestamp < $2`, [nu7Height, block.timestamp]);
  const firstDay = s.firstDayStory({ nu7Height, activationTime: block.timestamp, after, before, now });
  if (firstDay) candidates.push(firstDay);

  const mined = tip.height - nu7Height + 1;
  const level = [...s.BLOCK_LEVELS].reverse().find(l => l <= mined);
  if (level) {
    const { rows: [crossing] } = await db.query('SELECT height, timestamp FROM blocks WHERE height=$1', [nu7Height + level - 1]);
    const milestone = crossing && s.blockMilestoneStory({ nu7Height, tip, start,
      crossing: { height: Number(crossing.height), timestamp: Number(crossing.timestamp) }, now });
    if (milestone) candidates.push(milestone);
  }

  // NSM stories need a spot quote, fetched after the snapshot is released.
  const nsm = await optional(db, 'nsm', decisions, () => nsmContext(db, nu7Height, now));
  return { candidates, decisions, nsm };
}

async function nsmContext(db, nu7Height, now) {
  const { rows: [baseline] } = await db.query(`SELECT a.height, a.nsm_balance_zat::text AS nsm FROM ${CANONICAL_OBSERVATIONS}
    AND a.height < $1 AND a.nsm_balance_zat IS NOT NULL ORDER BY a.height DESC LIMIT 1`, [nu7Height]);
  const { rows: [current] } = await db.query(`SELECT a.height, a.nsm_balance_zat::text AS nsm FROM ${CANONICAL_OBSERVATIONS}
    AND a.height >= $1 AND a.nsm_balance_zat IS NOT NULL ORDER BY a.height DESC LIMIT 1`, [nu7Height]);
  if (!baseline || !current) return null;
  const growth = BigInt(current.nsm) - BigInt(baseline.nsm);
  const level = [...s.NSM_LEVELS_ZEC].reverse().find(l => growth >= BigInt(l) * 100_000_000n);
  const { rows: [crossing] } = !level ? { rows: [] } : await db.query(`SELECT a.height, b.timestamp, a.nsm_balance_zat::text AS nsm FROM ${CANONICAL_OBSERVATIONS}
    AND a.height >= $1 AND a.nsm_balance_zat - $2::bigint >= $3::bigint ORDER BY a.height LIMIT 1`,
  [nu7Height, baseline.nsm, (BigInt(level || 0) * 100_000_000n).toString()]);
  const { rows: daily } = await db.query(`SELECT DISTINCT ON (day) day::text AS date, nsm FROM (
      SELECT (to_timestamp(b.timestamp) AT TIME ZONE 'UTC')::date AS day, a.height, a.nsm_balance_zat::text AS nsm
      FROM ${CANONICAL_OBSERVATIONS} AND a.height >= $1 AND a.nsm_balance_zat IS NOT NULL) d
    ORDER BY day, height DESC`, [nu7Height]);
  return { nu7Height, now,
    baseline: { height: Number(baseline.height), nsmZat: baseline.nsm },
    current: { height: Number(current.height), nsmZat: current.nsm },
    crossing: crossing ? { height: Number(crossing.height), timestamp: Number(crossing.timestamp), nsmZat: crossing.nsm } : null,
    daily: daily.map(d => ({ date: d.date, nsmZat: d.nsm })) };
}

module.exports = { nu7Candidates, nodeReadiness };
