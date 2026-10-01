/**
 * Finalizer roster, detail, and BFT participation endpoints.
 */

const express = require('express');
const router = express.Router();
const { deps, resolveFinalizerPubkey } = require('./_helpers');
const { logSafeError } = require('../../lib/safe-log');

/**
 * GET /api/finalizers
 * List all finalizers (active + historical) from DB, ordered by current voting power desc.
 * Falls back to live RPC if DB is empty.
 */
router.get('/api/finalizers', async (req, res) => {
  try {
    const activeOnly = req.query.active !== 'false';
    const result = await deps.pool.query(
      `SELECT
        pub_key,
        voting_power_zats,
        first_seen_height,
        last_seen_height,
        is_active,
        EXTRACT(EPOCH FROM updated_at)::bigint AS updated_at
      FROM finalizers
      ${activeOnly ? 'WHERE is_active = true' : ''}
      ORDER BY voting_power_zats DESC`
    );

    const finalizers = result.rows.map(r => ({
      pub_key: r.pub_key,
      voting_power_zats: parseInt(r.voting_power_zats),
      voting_power_zec: parseInt(r.voting_power_zats) / 1e8,
      first_seen_height: r.first_seen_height ? parseInt(r.first_seen_height) : null,
      last_seen_height: r.last_seen_height ? parseInt(r.last_seen_height) : null,
      is_active: r.is_active,
      updated_at: r.updated_at,
    }));

    const totalStakeZats = finalizers.reduce((s, f) => s + f.voting_power_zats, 0);

    res.json({
      success: true,
      count: finalizers.length,
      totalStakeZats,
      totalStakeZec: totalStakeZats / 1e8,
      finalizers,
    });
  } catch (error) {
    logSafeError('Finalizers list error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch finalizers' });
  }
});

/**
 * GET /api/finalizer/:pubkey/participation
 * Per-finalizer BFT participation over the last N blocks. Reads
 * `blocks.bft_signer_keys` (populated by the Rust indexer from each PoW
 * block's fat_pointer_to_bft_block) and counts how many blocks in the
 * window include this pubkey.
 *
 * Response:
 *   {
 *     pubkey, window_start, window_end, window_size,
 *     signed_blocks, participation_pct,
 *     recent: [{ height, signed: true|false }, ...]  // for sparkline
 *   }
 */
router.get('/api/finalizer/:pubkey/participation', async (req, res) => {
  try {
    const raw = req.params.pubkey.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(raw)) {
      return res.status(400).json({ success: false, error: 'Invalid pubkey' });
    }
    // Accept either byte order from the URL — resolve to the form stored in DB.
    const pubkey = (await resolveFinalizerPubkey(raw)) || raw;
    const windowSize = Math.min(Math.max(parseInt(req.query.window) || 1000, 1), 5000);

    // Window = last N blocks that actually carry BFT data (i.e. bft_signer_keys IS NOT NULL)
    const result = await deps.pool.query(
      `WITH win AS (
         SELECT height, bft_signer_keys, bft_signature_count
         FROM blocks
         WHERE bft_signer_keys IS NOT NULL
         ORDER BY height DESC
         LIMIT $2
       )
       SELECT
         COALESCE(MIN(height), 0)::bigint AS window_start,
         COALESCE(MAX(height), 0)::bigint AS window_end,
         COUNT(*)::int AS window_size,
         COUNT(*) FILTER (WHERE $1 = ANY(bft_signer_keys))::int AS signed_blocks
       FROM win`,
      [pubkey, windowSize]
    );
    const row = result.rows[0];
    const signed = row.signed_blocks || 0;
    const total = row.window_size || 0;

    // For a sparkline: which of the last 50 blocks did this pubkey sign?
    const recentResult = await deps.pool.query(
      `SELECT height, ($1 = ANY(bft_signer_keys)) AS signed
       FROM blocks
       WHERE bft_signer_keys IS NOT NULL
       ORDER BY height DESC
       LIMIT 50`,
      [pubkey]
    );

    res.json({
      success: true,
      pubkey,
      window_start: parseInt(row.window_start),
      window_end: parseInt(row.window_end),
      window_size: total,
      signed_blocks: signed,
      participation_pct: total > 0 ? (signed / total) * 100 : 0,
      recent: recentResult.rows.map(r => ({
        height: parseInt(r.height),
        signed: r.signed,
      })),
    });
  } catch (error) {
    logSafeError('Finalizer participation error:', error);
    res.status(500).json({ success: false, error: 'Failed to compute participation' });
  }
});

/**
 * GET /api/crosslink/participation
 * Returns ALL active finalizers with their stake, share, and per-block
 * BFT participation (signed count + rate) over the same observation
 * window. Single query — perfect for rendering a participation table
 * without N round trips from the client.
 *
 * More accurate than poll-based approaches because bft_signer_keys is
 * extracted from every PoW block header's fat_pointer_to_bft_block,
 * not sampled at a fixed interval.
 *
 * Response includes a metadata block with the observation window
 * (first/last block height, count, tracking_since timestamp).
 */
router.get('/api/crosslink/participation', async (req, res) => {
  try {
    const windowSize = Math.min(Math.max(parseInt(req.query.window) || 500, 1), 5000);

    // 1) The observation window — last N blocks that carry BFT data.
    // A single CTE shared by the aggregate and per-finalizer queries.
    const result = await deps.pool.query(
      `WITH win AS (
         SELECT height, timestamp, bft_signer_keys
         FROM blocks
         WHERE bft_signer_keys IS NOT NULL
         ORDER BY height DESC
         LIMIT $1
       ),
       win_stats AS (
         SELECT
           COALESCE(MIN(height), 0)::bigint  AS first_height,
           COALESCE(MAX(height), 0)::bigint  AS last_height,
           COUNT(*)::int                     AS observed_blocks,
           COALESCE(MIN(timestamp), 0)::bigint AS tracking_since
         FROM win
       )
       SELECT
         f.pub_key,
         f.voting_power_zats,
         f.is_active,
         f.last_seen_height,
         (
           SELECT COUNT(*)
           FROM win
           WHERE f.pub_key = ANY(bft_signer_keys)
         )::int AS signed_blocks,
         (SELECT observed_blocks FROM win_stats) AS window_size,
         (SELECT first_height   FROM win_stats) AS window_first_height,
         (SELECT last_height    FROM win_stats) AS window_last_height,
         (SELECT tracking_since FROM win_stats) AS tracking_since
       FROM finalizers f
       WHERE f.is_active = true
       ORDER BY f.voting_power_zats DESC`,
      [windowSize]
    );

    const rows = result.rows;
    if (rows.length === 0) {
      return res.json({
        success: true,
        finalizers: [],
        window: { size: 0, first_height: 0, last_height: 0, tracking_since: 0 },
      });
    }

    const total = rows.reduce((s, r) => s + parseInt(r.voting_power_zats), 0);
    const windowSizeActual = rows[0].window_size || 0;

    res.json({
      success: true,
      window: {
        size: windowSizeActual,
        first_height: parseInt(rows[0].window_first_height),
        last_height: parseInt(rows[0].window_last_height),
        tracking_since: parseInt(rows[0].tracking_since),
      },
      total_stake_zats: total,
      total_stake_zec: total / 1e8,
      finalizers: rows.map((r, i) => {
        const vp = parseInt(r.voting_power_zats);
        return {
          rank: i + 1,
          pub_key: r.pub_key,
          voting_power_zats: vp,
          voting_power_zec: vp / 1e8,
          share_pct: total > 0 ? (vp / total) * 100 : 0,
          signed_blocks: r.signed_blocks,
          participation_pct: windowSizeActual > 0
            ? (r.signed_blocks / windowSizeActual) * 100
            : 0,
          last_seen_height: r.last_seen_height ? parseInt(r.last_seen_height) : null,
        };
      }),
    });
  } catch (error) {
    logSafeError('Participation overview error:', error);
    res.status(500).json({ success: false, error: 'Failed to compute participation' });
  }
});

/**
 * GET /api/crosslink/bft-chain
 * Returns the historical BFT chain reconstructed from PoW block fat
 * pointers. Groups consecutive PoW blocks by their (referenced_hash,
 * signer_set) so each row is one unique BFT decision with the range of
 * PoW blocks that observed it.
 *
 * This is what makes the /chain dual-chain graph actually show history
 * instead of just a single current-tip node.
 */
router.get('/api/crosslink/bft-chain', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 200);

    // Aggregate scalar history first, then fetch the latest row's signer set.
    // Carrying signer arrays through full-history window sorts spills to disk
    // and can exceed the public API deadline on a recovered database.
    const result = await deps.pool.query(
      `WITH decisions AS (
         SELECT bft_referenced_hash,
                COUNT(*)::int AS pow_blocks_in_decision,
                MIN(height) AS first_seen,
                MAX(height) AS last_seen
         FROM blocks
         WHERE bft_referenced_hash IS NOT NULL
         GROUP BY bft_referenced_hash
         ORDER BY MAX(height) DESC
         LIMIT $1
       )
       SELECT d.bft_referenced_hash AS referenced_hash,
              b.bft_signature_count AS signature_count,
              b.bft_signer_keys AS signer_keys,
              d.pow_blocks_in_decision,
              d.first_seen::bigint AS first_seen_at_pow_height,
              d.last_seen::bigint AS last_seen_at_pow_height
       FROM decisions d
       JOIN blocks b ON b.height = d.last_seen
       ORDER BY d.last_seen DESC`,
      [limit]
    );

    res.json({
      success: true,
      count: result.rows.length,
      decisions: result.rows.map(r => ({
        referenced_hash: r.referenced_hash,
        signature_count: r.signature_count,
        pow_blocks_in_decision: r.pow_blocks_in_decision,
        first_seen_at_pow_height: parseInt(r.first_seen_at_pow_height),
        last_seen_at_pow_height: parseInt(r.last_seen_at_pow_height),
        signer_keys: r.signer_keys || [],
      })),
    });
  } catch (error) {
    logSafeError('BFT chain history error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch BFT chain' });
  }
});

/**
 * GET /api/finalizer/:pubkey
 * Get finalizer detail: current state + staking action history (who delegated).
 */
router.get('/api/finalizer/:pubkey', async (req, res) => {
  try {
    const raw = req.params.pubkey.toLowerCase();

    // 64 hex chars = 32-byte pubkey
    if (!/^[a-f0-9]{64}$/.test(raw)) {
      return res.status(400).json({ success: false, error: 'Invalid finalizer pubkey' });
    }

    // Accept either byte order: try raw, then reversed. The GUI displays
    // pubkeys in reversed byte order from what zebrad's RPCs return, so
    // users pasting a pubkey from their desktop wallet must still land
    // on the right detail page.
    const pubkey = (await resolveFinalizerPubkey(raw)) || raw;

    const finalizerResult = await deps.pool.query(
      `SELECT pub_key, voting_power_zats, first_seen_height, last_seen_height, is_active,
              EXTRACT(EPOCH FROM updated_at)::bigint AS updated_at
       FROM finalizers WHERE pub_key = $1`,
      [pubkey]
    );

    if (finalizerResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Finalizer not found' });
    }

    const row = finalizerResult.rows[0];

    // Rank among active finalizers
    const rankResult = await deps.pool.query(
      `SELECT COUNT(*) AS rank FROM finalizers
       WHERE is_active = true AND voting_power_zats > $1`,
      [row.voting_power_zats]
    );
    const rank = parseInt(rankResult.rows[0].rank) + 1;

    // Associated staking actions (stakes + retargets targeting this finalizer)
    const actionsResult = await deps.pool.query(
      `SELECT txid, block_height, staking_action_type, staking_bond_key,
              staking_amount_zats, block_time
       FROM transactions
       WHERE staking_delegatee = $1
       ORDER BY block_height DESC
       LIMIT 100`,
      [pubkey]
    );

    res.json({
      success: true,
      finalizer: {
        pub_key: row.pub_key,
        voting_power_zats: parseInt(row.voting_power_zats),
        voting_power_zec: parseInt(row.voting_power_zats) / 1e8,
        first_seen_height: row.first_seen_height ? parseInt(row.first_seen_height) : null,
        last_seen_height: row.last_seen_height ? parseInt(row.last_seen_height) : null,
        is_active: row.is_active,
        updated_at: row.updated_at,
        rank: row.is_active ? rank : null,
      },
      stakeActions: actionsResult.rows.map(a => ({
        txid: a.txid,
        block_height: parseInt(a.block_height),
        block_time: a.block_time ? parseInt(a.block_time) : null,
        action_type: a.staking_action_type,
        bond_key: a.staking_bond_key,
        amount_zats: a.staking_amount_zats ? parseInt(a.staking_amount_zats) : null,
        amount_zec: a.staking_amount_zats ? parseInt(a.staking_amount_zats) / 1e8 : null,
      })),
    });
  } catch (error) {
    logSafeError('Finalizer detail error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch finalizer' });
  }
});

module.exports = router;
