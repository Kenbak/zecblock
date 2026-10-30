/**
 * Reorg/Uncle Routes
 * /api/uncles, /api/uncles/forks, /api/uncle/:hash, /api/uncle/report
 */

const express = require('express');
const crypto = require('crypto');
const { getPoolName, getPoolInfo } = require('../mining-pools');
const { firstSeenLateralSql } = require('../lib/first-seen');
const { parseSafeListPagination, offsetExceededError } = require('../lib/pagination');
const { logSafeError } = require('../lib/safe-log');
const router = express.Router();

// orphaned_blocks/fork_events are small, bounded tables (one row per reorg
// event), so a deep offset is cheap in absolute terms — but there's no
// reason to allow an unbounded one either, so the same shared cap applies
// here for consistency and defense-in-depth against future table growth.
const MAX_REORGS_OFFSET = 50_000;

let pool;
let writePool;

router.use((req, res, next) => {
  pool = req.app.locals.pool;
  writePool = req.app.locals.writePool || req.app.locals.pool;
  next();
});

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
         ORDER BY ob.height DESC, ob.detected_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      pool.query('SELECT COUNT(*) as total FROM orphaned_blocks')
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
       WHERE ob.hash = $1`,
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

// POST /api/uncle/report — External nodes report (height, hash)
// Rate limited: 10 reports per IP per minute
const reportRateLimit = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

router.post('/api/uncle/report', async (req, res) => {
  try {
    // Rate limit by IP
    const clientIp = req.ip || 'unknown';
    const ipKey = crypto.createHash('sha256').update(clientIp).digest('hex').slice(0, 16);
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;

    let hits = reportRateLimit.get(ipKey) || [];
    hits = hits.filter(t => t > windowStart);
    if (hits.length >= RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'Rate limit exceeded. Max 10 reports per minute.' });
    }
    hits.push(now);
    reportRateLimit.set(ipKey, hits);

    // Periodically clean stale entries (every ~100 requests)
    if (Math.random() < 0.01) {
      for (const [key, timestamps] of reportRateLimit) {
        const active = timestamps.filter(t => t > windowStart);
        if (active.length === 0) reportRateLimit.delete(key);
        else reportRateLimit.set(key, active);
      }
    }

    const { height, hash, node_id } = req.body;

    if (!height || !hash) {
      return res.status(400).json({ error: 'height and hash are required' });
    }

    const blockHeight = parseInt(height);
    if (isNaN(blockHeight) || blockHeight < 0 || blockHeight > 100_000_000) {
      return res.status(400).json({ error: 'Invalid height' });
    }

    if (!/^[a-fA-F0-9]{64}$/.test(hash)) {
      return res.status(400).json({ error: 'Invalid block hash (must be 64 hex chars)' });
    }

    // Block hash must start with leading zeros (valid PoW)
    if (!hash.startsWith('000000')) {
      return res.status(400).json({ error: 'Invalid block hash (insufficient proof of work)' });
    }

    const nodeId = node_id ? String(node_id).slice(0, 64) : null;

    // Compare to our canonical block at this height
    const canonical = await pool.query(
      'SELECT hash FROM blocks WHERE height = $1',
      [blockHeight]
    );

    // Only accept reports for heights we have indexed
    if (canonical.rows.length === 0) {
      return res.status(400).json({ error: 'Height not yet indexed' });
    }

    const isMatch = canonical.rows[0].hash === hash;

    // Store the report (ignore duplicates via unique index)
    await writePool.query(
      `INSERT INTO tip_reports (height, hash, node_id, ip_hash, is_match)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (height, hash, COALESCE(node_id, '')) DO NOTHING`,
      [blockHeight, hash, nodeId, ipKey, isMatch]
    );

    // If mismatch, archive as external orphan report
    if (!isMatch) {
      await writePool.query(
        `INSERT INTO orphaned_blocks (height, hash, canonical_hash, source, reported_by)
         VALUES ($1, $2, $3, 'external', $4)
         ON CONFLICT (hash) DO NOTHING`,
        [blockHeight, hash, canonical.rows[0].hash, nodeId || ipKey]
      );
    }

    res.json({
      success: true,
      height: blockHeight,
      isMatch,
      canonicalHash: canonical.rows[0].hash
    });
  } catch (error) {
    logSafeError('Error processing uncle report:', error);
    res.status(500).json({ success: false, error: 'Failed to process report' });
  }
});

// GET /api/uncles/stats — Summary stats for the dashboard
router.get('/api/uncles/stats', async (req, res) => {
  try {
    const [orphanCount, forkCount, recentReports, deepestFork] = await Promise.all([
      pool.query('SELECT COUNT(*) as total FROM orphaned_blocks'),
      pool.query('SELECT COUNT(*) as total FROM fork_events'),
      pool.query(
        `SELECT COUNT(*) as total FROM tip_reports
         WHERE reported_at >= NOW() - INTERVAL '24 hours'`
      ),
      pool.query(
        'SELECT MAX(depth) as max_depth FROM fork_events'
      )
    ]);

    res.json({
      success: true,
      totalOrphanedBlocks: parseInt(orphanCount.rows[0].total),
      totalForkEvents: parseInt(forkCount.rows[0].total),
      reportsLast24h: parseInt(recentReports.rows[0].total),
      deepestReorg: parseInt(deepestFork.rows[0].max_depth) || 0
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

module.exports = router;
