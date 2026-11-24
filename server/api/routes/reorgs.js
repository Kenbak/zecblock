/**
 * Reorg/Uncle Routes
 * /api/uncles, /api/uncles/forks, /api/uncle/:hash
 */

const express = require('express');
const { getPoolName, getPoolInfo } = require('../mining-pools');
const { firstSeenLateralSql, firstSeenSql } = require('../lib/first-seen');
const { parseSafeListPagination, offsetExceededError } = require('../lib/pagination');
const { logSafeError } = require('../lib/safe-log');
const router = express.Router();

// orphaned_blocks/fork_events are small, bounded tables (one row per reorg
// event), so a deep offset is cheap in absolute terms — but there's no
// reason to allow an unbounded one either, so the same shared cap applies
// here for consistency and defense-in-depth against future table growth.
const MAX_REORGS_OFFSET = 50_000;

// Rows written by the retired unauthenticated tip-report endpoint carried
// source='external' and were never checked against a block header. They are
// excluded from every public read so none can surface as an orphan block.
const TRUSTED_ORPHAN_SQL = "source IS DISTINCT FROM 'external'";

let pool;

router.use((req, res, next) => {
  pool = req.app.locals.pool;
  next();
});

// Competing blocks the observer network received that lost to the indexed
// canonical block at the same height and were never part of a reorg on the
// main node, so they have no orphaned_blocks row. Same capture rule as the
// orphan-rate cards: only heights already indexed, never a hash that is
// canonical now. Observers report receipts only; validation is by our nodes.
const OBSERVER_ONLY_SQL = `
  FROM captured_blocks c
  JOIN blocks r ON r.height = c.height
  WHERE r.hash <> c.hash
    AND NOT EXISTS (SELECT 1 FROM blocks canonical WHERE canonical.hash = c.hash)
    AND NOT EXISTS (SELECT 1 FROM orphaned_blocks ob WHERE ob.hash = c.hash)`;

// GET /api/uncles — List orphaned blocks, most recent first
router.get('/api/uncles', async (req, res) => {
  try {
    const { limit, offset, requestedOffset, offsetExceeded } = parseSafeListPagination(req.query, {
      defaultLimit: 50,
      maxLimit: 200,
      maxOffset: MAX_REORGS_OFFSET,
    });

    if (offsetExceeded) {
      return res.status(400).json(offsetExceededError({ requestedOffset, maxOffset: MAX_REORGS_OFFSET }));
    }

    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT ob.id, ob.height, ob.hash, ob.canonical_hash, ob.timestamp,
                ob.transaction_count, ob.size, ob.difficulty, ob.miner_address,
                ob.previous_block_hash, ob.source, ob.reported_by,
                ob.consensus_valid, ob.detected_at, ob.fork_event_id,
                oo.first_seen_at, oo.source as observation_source, oo.poll_interval_ms,
                co.first_seen_at as canonical_first_seen_at,
                co.source as canonical_observation_source,
                co.poll_interval_ms as canonical_poll_interval_ms,
                ob.coinbase_hex, b.coinbase_hex as canonical_coinbase_hex,
                b.hash as canonical_block_hash,
                b.timestamp as canonical_timestamp,
                b.transaction_count as canonical_transaction_count,
                b.size as canonical_size,
                b.miner_address as canonical_miner_address
         FROM orphaned_blocks ob
         LEFT JOIN blocks b ON b.height = ob.height
         LEFT JOIN ${firstSeenLateralSql('ob.hash')} oo ON true
         LEFT JOIN ${firstSeenLateralSql('b.hash')} co ON true
         WHERE ob.${TRUSTED_ORPHAN_SQL}
         ORDER BY ob.height DESC, ob.detected_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query(`SELECT COUNT(*) as total FROM orphaned_blocks WHERE ${TRUSTED_ORPHAN_SQL}`)
    ]);

    const total = parseInt(countResult.rows[0].total);

    res.json({
      success: true,
      orphanedBlocks: result.rows.map(row => ({
        ...formatOrphanedBlock(row),
        canonicalBlock: formatCanonicalBlockSummary(row),
      })),
      pagination: {
        total,
        limit,
        offset,
        totalPages: Math.ceil(total / limit),
        page: Math.floor(offset / limit) + 1,
        hasMore: offset + limit < total
      }
    });
  } catch (error) {
    logSafeError('Error fetching orphaned blocks:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch orphaned blocks' });
  }
});

// GET /api/uncles/observed — Observer-only orphans, most recent first
router.get('/api/uncles/observed', async (req, res) => {
  try {
    const { limit, offset, requestedOffset, offsetExceeded } = parseSafeListPagination(req.query, {
      defaultLimit: 50,
      maxLimit: 200,
      maxOffset: MAX_REORGS_OFFSET,
    });
    if (offsetExceeded) {
      return res.status(400).json(offsetExceededError({ requestedOffset, maxOffset: MAX_REORGS_OFFSET }));
    }
    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT c.height, c.hash, c.timestamp, c.first_seen_at, c.miner_address, c.coinbase_hex,
                (SELECT count(*) FROM block_capture_receipts br WHERE br.hash = c.hash)::integer AS observer_count,
                r.hash AS canonical_block_hash, r.timestamp AS canonical_timestamp,
                r.transaction_count AS canonical_transaction_count, r.size AS canonical_size,
                r.miner_address AS canonical_miner_address, r.coinbase_hex AS canonical_coinbase_hex,
                ${firstSeenSql('r.hash')} AS canonical_first_seen_at
         ${OBSERVER_ONLY_SQL}
         ORDER BY c.height DESC, c.first_seen_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query(`SELECT count(*) AS total ${OBSERVER_ONLY_SQL}`),
    ]);
    const total = parseInt(countResult.rows[0].total);
    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      success: true,
      orphanedBlocks: result.rows.map(formatObserverOrphan),
      pagination: {
        total,
        limit,
        offset,
        totalPages: Math.ceil(total / limit),
        page: Math.floor(offset / limit) + 1,
        hasMore: offset + limit < total
      }
    });
  } catch (error) {
    logSafeError('Error fetching observer-only orphans:', error);
    res.status(503).set('Cache-Control', 'no-store').json({ success: false, error: 'Observer-only orphans unavailable' });
  }
});

// GET /api/uncles/forks — List fork events with timeline
router.get('/api/uncles/forks', async (req, res) => {
  try {
    const { limit, offset, requestedOffset, offsetExceeded } = parseSafeListPagination(req.query, {
      defaultLimit: 20,
      maxLimit: 100,
      maxOffset: MAX_REORGS_OFFSET,
    });

    if (offsetExceeded) {
      return res.status(400).json(offsetExceededError({ requestedOffset, maxOffset: MAX_REORGS_OFFSET }));
    }

    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT fe.*,
                (SELECT COUNT(*) FROM orphaned_blocks ob WHERE ob.fork_event_id = fe.id) as block_count
         FROM fork_events fe
         ORDER BY fe.detected_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query('SELECT COUNT(*) as total FROM fork_events')
    ]);

    const total = parseInt(countResult.rows[0].total);
    const forkIds = result.rows.map(row => row.id);

    let comparisonsByFork = {};
    if (forkIds.length > 0) {
      const comparisonsResult = await pool.query(
        `SELECT ob.id, ob.height, ob.hash, ob.canonical_hash, ob.timestamp,
                ob.transaction_count, ob.size, ob.miner_address, ob.source,
                ob.detected_at, ob.fork_event_id,
                oo.first_seen_at, oo.source as observation_source, oo.poll_interval_ms,
                co.first_seen_at as canonical_first_seen_at,
                co.source as canonical_observation_source,
                co.poll_interval_ms as canonical_poll_interval_ms,
                ob.coinbase_hex, b.coinbase_hex as canonical_coinbase_hex,
                b.hash as canonical_block_hash,
                b.timestamp as canonical_timestamp,
                b.transaction_count as canonical_transaction_count,
                b.size as canonical_size,
                b.miner_address as canonical_miner_address
         FROM orphaned_blocks ob
         LEFT JOIN blocks b ON b.height = ob.height
         LEFT JOIN ${firstSeenLateralSql('ob.hash')} oo ON true
         LEFT JOIN ${firstSeenLateralSql('b.hash')} co ON true
         WHERE ob.fork_event_id = ANY($1::int[])
         ORDER BY ob.height ASC`,
        [forkIds]
      );

      for (const row of comparisonsResult.rows) {
        const forkId = row.fork_event_id;
        if (!comparisonsByFork[forkId]) comparisonsByFork[forkId] = [];
        comparisonsByFork[forkId].push(formatReorgComparison(row));
      }
    }

    res.json({
      success: true,
      forks: result.rows.map(row => ({
        id: row.id,
        forkHeight: parseInt(row.fork_height),
        depth: row.depth,
        canonicalTip: row.canonical_tip ? parseInt(row.canonical_tip) : null,
        orphanedCount: parseInt(row.block_count),
        source: row.source,
        description: row.description,
        detectedAt: row.detected_at,
        resolvedAt: row.resolved_at,
        comparisons: comparisonsByFork[row.id] || [],
      })),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total
      }
    });
  } catch (error) {
    logSafeError('Error fetching fork events:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch fork events' });
  }
});

// GET /api/uncle/:hash — Detail view of a single orphaned block
router.get('/api/uncle/:hash', async (req, res) => {
  try {
    const hash = req.params.hash;
    if (!/^[a-fA-F0-9]{64}$/.test(hash)) {
      return res.status(400).json({ error: 'Invalid block hash' });
    }

    const result = await pool.query(
      `SELECT ob.*, fe.depth as fork_depth, fe.description as fork_description,
              oo.first_seen_at, oo.source as observation_source, oo.poll_interval_ms
       FROM orphaned_blocks ob
       LEFT JOIN fork_events fe ON ob.fork_event_id = fe.id
       LEFT JOIN ${firstSeenLateralSql('ob.hash')} oo ON true
       WHERE ob.hash = $1 AND ob.${TRUSTED_ORPHAN_SQL}`,
      [hash]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Orphaned block not found' });
    }

    const row = result.rows[0];
    res.json({
      success: true,
      block: {
        ...formatOrphanedBlock(row),
        forkDepth: row.fork_depth,
        forkDescription: row.fork_description
      }
    });
  } catch (error) {
    logSafeError('Error fetching orphaned block:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch orphaned block' });
  }
});

// GET /api/uncles/stats — Summary stats for the dashboard
router.get('/api/uncles/stats', async (req, res) => {
  try {
    const [orphanCount, forkCount, recentReports, deepestFork, observerOnly] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total FROM orphaned_blocks WHERE ${TRUSTED_ORPHAN_SQL}`),
      pool.query('SELECT COUNT(*) as total FROM fork_events'),
      pool.query(
        `SELECT COUNT(*) as total FROM tip_reports
         WHERE reported_at >= NOW() - INTERVAL '24 hours'`
      ),
      pool.query(
        'SELECT MAX(depth) as max_depth FROM fork_events'
      ),
      pool.query(`SELECT count(*) AS total, floor(extract(epoch FROM (SELECT min(collection_started_at) FROM block_capture_observers)))::bigint AS capture_start
        ${OBSERVER_ONLY_SQL}`).catch(error => {
        // Capture tables are optional on older databases; the reorg stats stay available.
        logSafeError('Observer-only orphan count unavailable:', error);
        return null;
      })
    ]);

    res.json({
      success: true,
      totalOrphanedBlocks: parseInt(orphanCount.rows[0].total),
      totalForkEvents: parseInt(forkCount.rows[0].total),
      reportsLast24h: parseInt(recentReports.rows[0].total),
      deepestReorg: parseInt(deepestFork.rows[0].max_depth) || 0,
      observerOnlyOrphanedBlocks: observerOnly ? parseInt(observerOnly.rows[0].total) : null,
      observerCaptureStartedAt: observerOnly?.rows[0].capture_start != null
        ? new Date(Number(observerOnly.rows[0].capture_start) * 1000).toISOString() : null
    });
  } catch (error) {
    logSafeError('Error fetching uncle stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// GET /api/uncles/nodes — Status of monitored external node sources
router.get('/api/uncles/nodes', (req, res) => {
  const forkMonitor = req.app.locals.forkMonitor;
  if (!forkMonitor) {
    return res.json({ success: true, nodes: [], message: 'Fork monitor not initialized' });
  }

  const nodes = forkMonitor.getStatus();
  const online = nodes.filter(n => n.status !== 'offline' && n.status !== 'pending').length;
  const forking = nodes.filter(n => n.status === 'fork').length;

  res.json({
    success: true,
    nodes,
    summary: {
      total: nodes.length,
      online,
      forking,
      lastPoll: nodes[0]?.lastChecked || null,
    },
  });
});

function formatCanonicalBlockSummary(row) {
  const hash = row.canonical_block_hash;
  if (!hash) return null;

  const poolInfo = getPoolInfo(row.canonical_miner_address, row.canonical_coinbase_hex);
  return {
    hash,
    firstSeenAt: row.canonical_first_seen_at || null,
    firstSeenSource: row.canonical_observation_source || null,
    firstSeenPollIntervalMs: row.canonical_poll_interval_ms || null,
    height: parseInt(row.height),
    timestamp: row.canonical_timestamp ? parseInt(row.canonical_timestamp) : null,
    transactionCount: row.canonical_transaction_count ?? null,
    size: row.canonical_size ?? null,
    minerAddress: row.canonical_miner_address || null,
    minerPool: getPoolName(row.canonical_miner_address, row.canonical_coinbase_hex),
    minerPoolUrl: poolInfo?.url || null,
    minerPoolRegion: poolInfo?.region || null,
  };
}

function formatReorgComparison(row) {
  const orphanPool = getPoolInfo(row.miner_address, row.coinbase_hex);
  const canonicalPool = getPoolInfo(row.canonical_miner_address, row.canonical_coinbase_hex);

  return {
    height: parseInt(row.height),
    orphaned: {
      hash: row.hash,
      firstSeenAt: row.first_seen_at || null,
      firstSeenSource: row.observation_source || null,
      firstSeenPollIntervalMs: row.poll_interval_ms || null,
      timestamp: row.timestamp ? parseInt(row.timestamp) : null,
      transactionCount: row.transaction_count,
      size: row.size,
      minerAddress: row.miner_address,
      minerPool: getPoolName(row.miner_address, row.coinbase_hex),
      minerPoolUrl: orphanPool?.url || null,
      source: row.source,
    },
    canonical: formatCanonicalBlockSummary(row) ? {
      ...formatCanonicalBlockSummary(row),
      minerPoolUrl: canonicalPool?.url || null,
      minerPoolRegion: canonicalPool?.region || null,
    } : null,
  };
}

function formatOrphanedBlock(row) {
  return {
    id: row.id,
    height: parseInt(row.height),
    hash: row.hash,
    firstSeenAt: row.first_seen_at || null,
    firstSeenSource: row.observation_source || null,
    firstSeenPollIntervalMs: row.poll_interval_ms || null,
    canonicalHash: row.canonical_hash,
    timestamp: row.timestamp ? parseInt(row.timestamp) : null,
    transactionCount: row.transaction_count,
    size: row.size,
    difficulty: row.difficulty,
    minerAddress: row.miner_address,
    minerPool: getPoolName(row.miner_address, row.coinbase_hex),
    previousBlockHash: row.previous_block_hash,
    source: row.source,
    reportedBy: row.reported_by,
    consensusValid: row.consensus_valid,
    detectedAt: row.detected_at,
    forkEventId: row.fork_event_id
  };
}

function formatObserverOrphan(row) {
  const poolInfo = getPoolInfo(row.miner_address, row.coinbase_hex);
  return {
    height: parseInt(row.height),
    hash: row.hash,
    timestamp: row.timestamp != null ? parseInt(row.timestamp) : null,
    firstSeenAt: row.first_seen_at || null,
    observerCount: row.observer_count ?? null,
    minerAddress: row.miner_address || null,
    minerPool: getPoolName(row.miner_address, row.coinbase_hex),
    minerPoolUrl: poolInfo?.url || null,
    canonicalBlock: formatCanonicalBlockSummary(row),
  };
}

module.exports = router;
