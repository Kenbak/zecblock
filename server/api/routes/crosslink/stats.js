/**
 * Crosslink stats, BFT tip, bootstrap info, and divergence history.
 */

const express = require('express');
const router = express.Router();
const { deps, computeStakingDay } = require('./_helpers');
const { logSafeError } = require('../../lib/safe-log');

const CROSSLINK_CACHE_KEY = 'crosslink:stats';
const CROSSLINK_CACHE_DURATION = 30; // 30 seconds (includes slow recency RPC)

// In-flight dedup for the heavy /api/crosslink endpoint
let crosslinkInflight = null;

router.get('/api/crosslink', async (req, res) => {
  try {
    // Check fresh cache
    if (deps.redisClient && deps.redisClient.isOpen) {
      try {
        const cached = await deps.redisClient.get(CROSSLINK_CACHE_KEY);
        if (cached) {
          return res.json(JSON.parse(cached));
        }
      } catch (e) { /* ignore cache miss */ }
    }

    // Dedup: if another request is already fetching, wait for it
    if (crosslinkInflight) {
      const result = await crosslinkInflight;
      return res.json(result);
    }

    crosslinkInflight = (async () => {

    // Fast RPCs sequentially -- zebrad is single-threaded for RPC under load
    const tipHeight = await deps.callZebraRPC('getblockcount', [], { timeout: 12000 }).catch(() => null);
    if (tipHeight === null) {
      return { success: false, error: 'Crosslink RPC unavailable', _status: 503, _degraded: true };
    }
    const finalityInfo = await deps.callZebraRPC('get_tfl_final_block_height_and_hash', [], { timeout: 12000 }).catch(() => null);
    const roster = await deps.callZebraRPC('get_tfl_roster_zats', [], { timeout: 12000 }).catch(() => []);
    const peerInfo = await deps.callZebraRPC('getpeerinfo', [], { timeout: 12000 }).catch(() => []);

    // Slow RPC (~5s) -- call sequentially after fast ones complete
    const tflRecency = await deps.callZebraRPC('get_tfl_recency_status', [], { timeout: 20000 }).catch(() => null);

    const parsedRoster = Array.isArray(roster)
      ? roster.map((m, idx) => {
          const stakeZats = m.stake_zats ?? m.stake ?? m.voting_power ?? 0;
          return {
            identity: m.identity || m.pub_key || m.public_key || '',
            stake_zats: stakeZats,
            stake_zec: stakeZats / 1e8,
            _rosterIdx: idx,
          };
        }).sort((a, b) => b.stake_zats - a.stake_zats)
      : [];

    // Positional match: roster[i] corresponds to recency.finalizer_statuses[i]
    const statuses = tflRecency?.finalizer_statuses || [];
    let bftHeight = tflRecency?.my_height ?? null;
    let bftRound = tflRecency?.my_round ?? null;
    const nowUtc = tflRecency?.now_utc ?? Math.floor(Date.now() / 1000);
    let onlineCount = 0;
    let onlineStake = 0;
    let connectedCount = 0;
    let connectedStake = 0;
    for (const f of parsedRoster) {
      const entry = statuses[f._rosterIdx];
      if (entry) {
        const [, status] = entry;
        const votes = status.no_yes_votes_in_my_height || [[0,0],[0,0]];
        const prevoteYes = votes[0]?.[1] || 0;
        const precommitYes = votes[1]?.[1] || 0;
        f.voted = prevoteYes > 0 || precommitYes > 0;
        f.highest_round = status.highest_round_vote || 0;
        f.last_connected_utc = status.last_direct_connection_utc ?? status.last_connected_utc ?? null;
        f.connected = f.last_connected_utc == null ? null : (nowUtc - f.last_connected_utc) < 300;
      } else {
        f.voted = null;
        f.highest_round = null;
        f.last_connected_utc = null;
        f.connected = null;
      }
      if (f.voted) {
        onlineCount++;
        onlineStake += f.stake_zats;
      }
      if (f.connected) {
        connectedCount++;
        connectedStake += f.stake_zats;
      }
      delete f._rosterIdx;
    }

    const totalStakeZats = parsedRoster.reduce((sum, m) => sum + m.stake_zats, 0);
    const finalizedHeight = finalityInfo?.height ?? finalityInfo?.[0] ?? 0;

    const peerCount = Array.isArray(peerInfo) ? peerInfo.length : 0;

    const result = {
      success: true,
      tipHeight,
      finalizedHeight,
      finalityGap: tipHeight - finalizedHeight,
      finalizerCount: parsedRoster.length,
      totalStakeZats,
      totalStakeZec: totalStakeZats / 1e8,
      peerCount,
      stakingDay: computeStakingDay(tipHeight),
      liveness: {
        bftHeight: bftHeight,
        bftRound: bftRound,
        onlineCount,
        offlineCount: parsedRoster.length - onlineCount,
        onlineStakeZec: onlineStake / 1e8,
        offlineStakeZec: (totalStakeZats - onlineStake) / 1e8,
        onlinePercent: totalStakeZats > 0 ? Math.round((onlineStake / totalStakeZats) * 100) : 0,
        connectedCount,
        connectedStakeZec: connectedStake / 1e8,
        connectedPercent: totalStakeZats > 0 ? Math.round((connectedStake / totalStakeZats) * 100) : 0,
      },
      roster: parsedRoster,
    };

    // Cache result
    if (deps.redisClient && deps.redisClient.isOpen) {
      try {
        await deps.redisClient.set(CROSSLINK_CACHE_KEY, JSON.stringify(result), {
          EX: CROSSLINK_CACHE_DURATION,
        });
      } catch (e) { /* ignore cache write failure */ }
    }

    return result;
    })();

    try {
      const result = await crosslinkInflight;
      const status = result._status || 200;
      delete result._status;
      res.status(status).json(result);
    } finally {
      crosslinkInflight = null;
    }
  } catch (error) {
    crosslinkInflight = null;
    logSafeError('Crosslink stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch crosslink stats',
    });
  }
});

/**
 * GET /api/crosslink/bft-tip
 * Returns the current BFT chain tip pointer: which PoW block is being voted on
 * and how many finalizers have signed so far. Cached 5s in Redis.
 */
router.get('/api/crosslink/bft-tip', async (req, res) => {
  const CACHE_KEY = 'crosslink:bft-tip';
  try {
    if (deps.redisClient && deps.redisClient.isOpen) {
      try {
        const cached = await deps.redisClient.get(CACHE_KEY);
        if (cached) return res.json(JSON.parse(cached));
      } catch {}
    }

    const fatPtr = await deps.callZebraRPC('get_tfl_fat_pointer_to_bft_chain_tip').catch(() => null);
    if (!fatPtr) {
      return res.status(503).json({ success: false, error: 'BFT tip unavailable' });
    }

    // Field name varies across serializations; accept either.
    const voteBytes =
      fatPtr.vote_for_block_without_finalizer_public_key ??
      fatPtr.voteForBlockWithoutFinalizerPublicKey ??
      [];
    // First 32 bytes are the PoW block hash the BFT is voting on.
    // Zebra stores hashes in internal byte order; reverse for the display hex.
    const blockHashInternal = voteBytes.slice(0, 32);
    const votedBlockHash = Buffer.from(blockHashInternal).reverse().toString('hex');
    const signatures = Array.isArray(fatPtr.signatures) ? fatPtr.signatures : [];

    const result = {
      success: true,
      votedBlockHash: votedBlockHash || null,
      signatureCount: signatures.length,
      signers: signatures.map((s) => ({
        pub_key: Array.isArray(s.pub_key)
          ? Buffer.from(s.pub_key).toString('hex')
          : typeof s.pub_key === 'string' ? s.pub_key : null,
      })),
      timestamp: Date.now(),
    };

    if (deps.redisClient && deps.redisClient.isOpen) {
      try { await deps.redisClient.set(CACHE_KEY, JSON.stringify(result), { EX: 5 }); } catch {}
    }

    res.json(result);
  } catch (error) {
    logSafeError('BFT tip error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch BFT tip' });
  }
});

/**
 * GET /api/crosslink/bootstrap-info
 * Returns metadata about the currently-published public Zebra cache
 * snapshot (the "bootstrap" archive that others can download to skip a
 * genesis resync). Reads /var/www/crosslink.cipherscan.app/bootstrap/bootstrap.json
 * written by zebra-public-snapshot.sh.
 */
router.get('/api/crosslink/bootstrap-info', async (req, res) => {
  try {
    const fs = require('fs').promises;
    const path = process.env.BOOTSTRAP_META_PATH
      || '/var/www/crosslink.cipherscan.app/bootstrap/bootstrap.json';

    let meta;
    try {
      const raw = await fs.readFile(path, 'utf8');
      meta = JSON.parse(raw);
    } catch (err) {
      // File may not exist yet (first publish not done). Return a predictable
      // "not available" response instead of 500 so the frontend can display
      // a friendly message.
      return res.json({ success: true, available: false });
    }

    res.json({
      success: true,
      available: true,
      generated_at: meta.generated_at,
      tip_height: meta.tip_height,
      tip_hash: meta.tip_hash,
      finalized_height: meta.finalized_height,
      finalized_hash: meta.finalized_hash,
      size_bytes: meta.size_bytes,
      sha256: meta.sha256,
      cache_dir_name: meta.cache_dir_name,
      reference_hashes: meta.reference_hashes || [],
      contents: meta.contents || ['state/', 'pos.chain'],
      excludes: meta.excludes || ['secret.seed', 'zaino/'],
      download_url: process.env.BOOTSTRAP_DOWNLOAD_URL
        || 'https://api.crosslink.cipherscan.app/bootstrap/bootstrap.tar.gz',
      sha256_url: process.env.BOOTSTRAP_DOWNLOAD_URL
        ? `${process.env.BOOTSTRAP_DOWNLOAD_URL}.sha256`
        : 'https://api.crosslink.cipherscan.app/bootstrap/bootstrap.tar.gz.sha256',
    });
  } catch (error) {
    logSafeError('bootstrap-info error:', error);
    res.status(500).json({ success: false, error: 'Failed to read bootstrap metadata' });
  }
});

/**
 * GET /api/crosslink/divergence-history
 * Returns the history of chain divergences (times our node drifted from the
 * finalized network tip). Useful for spotting patterns across resets.
 */
router.get('/api/crosslink/divergence-history', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const result = await deps.pool.query(
      `SELECT
        id,
        EXTRACT(EPOCH FROM start_time)::bigint AS start_time,
        start_tip_height,
        start_finalized_height,
        start_gap,
        peak_gap,
        peak_tip_height,
        EXTRACT(EPOCH FROM end_time)::bigint AS end_time,
        end_tip_height,
        end_finalized_height,
        severity,
        notes,
        CASE WHEN end_time IS NULL
             THEN NULL
             ELSE EXTRACT(EPOCH FROM (end_time - start_time))::bigint
        END AS duration_seconds
      FROM divergence_events
      ORDER BY start_time DESC
      LIMIT $1`,
      [limit]
    );

    const events = result.rows.map(r => ({
      id: parseInt(r.id),
      start_time: parseInt(r.start_time),
      end_time: r.end_time ? parseInt(r.end_time) : null,
      duration_seconds: r.duration_seconds ? parseInt(r.duration_seconds) : null,
      is_open: r.end_time === null,
      severity: r.severity,
      start_tip_height: parseInt(r.start_tip_height),
      start_finalized_height: parseInt(r.start_finalized_height),
      start_gap: r.start_gap,
      peak_gap: r.peak_gap,
      peak_tip_height: parseInt(r.peak_tip_height),
      end_tip_height: r.end_tip_height ? parseInt(r.end_tip_height) : null,
      end_finalized_height: r.end_finalized_height ? parseInt(r.end_finalized_height) : null,
      notes: r.notes,
    }));

    res.json({
      success: true,
      count: events.length,
      openEvent: events.find(e => e.is_open) || null,
      events,
    });
  } catch (error) {
    logSafeError('Divergence history error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch divergence history' });
  }
});

module.exports = router;
