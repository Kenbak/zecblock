/**
 * Fork monitor — chain alignment checks, node registry, and block hash lookup.
 */

const express = require('express');
const crosslinkNetwork = require('../../../../lib/crosslink-network.json');
const crypto = require('crypto');
const { ipKeyGenerator } = require('express-rate-limit');
const { logSafeError } = require('../../lib/safe-log');
const { constantTimeEqual, isKnownServiceKey } = require('../../service-auth');
const router = express.Router();
// New names have a separate, bounded, short-lived quota. Existing owners can
// continue reporting even when this budget or registry capacity is exhausted.
const registrationBudgets = new Map();
const registrationHashKey = crypto.randomBytes(32);
const REGISTRATION_WINDOW_MS = 15 * 60 * 1000;
function reserveRegistration(ip) {
  const now = Date.now();
  for (const [key, budget] of registrationBudgets) {
    if (budget.until <= now) registrationBudgets.delete(key);
  }
  const key = crypto.createHmac('sha256', registrationHashKey).update(ipKeyGenerator(ip || 'unknown')).digest('hex');
  const budget = registrationBudgets.get(key);
  if (budget && budget.count >= 5) return false;
  if (!budget && registrationBudgets.size >= 10_000) return false;
  registrationBudgets.set(key, budget
    ? { ...budget, count: budget.count + 1 }
    : { count: 1, until: now + REGISTRATION_WINDOW_MS });
  return true;
}

const {
  deps,
  normalizeHash,
  usableForkReference,
  matchKnownSamples,
  pruneAndFetchNodes,
  fetchCtazForkMap,
  FORK_MONITOR_CACHE_KEY,
  FORK_MONITOR_CACHE_DURATION,
  ANCHOR_HEIGHTS,
  KNOWN_REFERENCE_HASHES,
  NODE_TTL_OPTIONS,
  DEFAULT_TTL,
  MAX_REGISTERED_NODES,
  REPORT_COOLDOWN_MS,
  MAX_REPORT_SAMPLES,
  MAX_TIP_HEIGHT,
  MAX_PEER_COUNT,
  NODE_NAME_RE,
  reportTimestamps,
} = require('./_helpers');

/**
 * GET /api/crosslink/fork-monitor
 * Aggregated chain health: our node vs cTAZ, anchor comparisons, registered nodes.
 */
router.get('/api/crosslink/fork-monitor', async (req, res) => {
  try {
    if (deps.redisClient && deps.redisClient.isOpen) {
      try {
        const cached = await deps.redisClient.get(FORK_MONITOR_CACHE_KEY);
        if (cached) return res.json(JSON.parse(cached));
      } catch {}
    }

    // Fetch base stats + cTAZ in parallel (only 2 RPC calls + 1 HTTP)
    const [tipHeight, ctaz] = await Promise.all([
      deps.callZebraRPC('getblockcount').catch(() => null),
      fetchCtazForkMap(),
    ]);

    if (tipHeight === null) {
      return res.status(503).json({ success: false, error: 'Crosslink RPC unavailable' });
    }

    // Sequential RPC calls to avoid overwhelming zebrad
    const finalityInfo = await deps.callZebraRPC('get_tfl_final_block_height_and_hash').catch(() => null);
    const peerInfo = await deps.callZebraRPC('getpeerinfo').catch(() => []);

    const finalizedHeight = tipHeight >= crosslinkNetwork.crosslinkActivationHeight ? finalityInfo?.height ?? finalityInfo?.[0] ?? null : null;
    const peerCount = Array.isArray(peerInfo) ? peerInfo.length : 0;

    // Fetch anchor hashes sequentially to avoid "Too many connections".
    // getblockhash is much cheaper than getblock and returns exactly what we need.
    const eligible = ANCHOR_HEIGHTS.filter((a) => a.height <= tipHeight);
    const anchorChecks = [];
    for (const a of eligible) {
      const hash = await deps.callZebraRPC('getblockhash', [a.height]).catch(() => null);
      anchorChecks.push({
        height: a.height,
        label: a.label,
        cipherscan_hash: normalizeHash(hash),
      });
    }

    // Fetch our tip hash
    const tipHash = normalizeHash(
      await deps.callZebraRPC('getblockhash', [tipHeight]).catch(() => null)
    );

    // Build cTAZ reference from their API, with verified fallbacks
    let ctazRef = { tip: null, tip_hash: null, finalized: null, finality_gap: null };
    let ctazAnchors = { ...KNOWN_REFERENCE_HASHES };
    if (ctaz && ctaz.reference) {
      ctazRef = {
        tip: ctaz.reference.tip,
        tip_hash: normalizeHash(ctaz.reference.tip_hash),
        peers: ctaz.reference.peers,
        finalized: ctaz.reference.finalized ?? null,
        finality_gap: ctaz.reference.finality_gap ?? null,
      };
      if (Array.isArray(ctaz.anchors)) {
        for (const a of ctaz.anchors) {
          ctazAnchors[a.height] = normalizeHash(a.observed_hash || a.expected_hash);
        }
      }
    }

    // Compare anchors
    const anchors = anchorChecks.map((a) => ({
      height: a.height,
      label: a.label,
      cipherscan_hash: a.cipherscan_hash,
      ctaz_hash: ctazAnchors[a.height] || null,
      match:
        a.cipherscan_hash && ctazAnchors[a.height]
          ? a.cipherscan_hash === ctazAnchors[a.height]
          : null,
    }));

    // Determine overall alignment
    const mismatches = anchors.filter((a) => a.match === false);
    let status = 'aligned';
    let firstDivergence = null;
    const referenceUsable = usableForkReference(ctaz);
    if (!referenceUsable || !anchors.some((a) => a.match !== null)) {
      status = 'ctaz_unavailable';
    } else if (mismatches.length > 0) {
      status = 'diverged';
      firstDivergence = mismatches[0].height;
    }

    // Registered nodes (from DB, with TTL pruning)
    const dbNodes = await pruneAndFetchNodes();
    const nodes = dbNodes.map((node) => {
      let branch = 'unknown';
      if (node.sample_hashes && node.sample_hashes.length > 0) {
        const csMatch = matchKnownSamples(node.sample_hashes, (height) => {
          return anchors.find((a) => a.height === height)?.cipherscan_hash;
        }) === true;
        const ctazMatch = referenceUsable
          && matchKnownSamples(node.sample_hashes, (height) => ctazAnchors[height]) === true;
        if (csMatch && ctazMatch) branch = 'reference';
        else if (csMatch) branch = 'cipherscan';
        else if (ctazMatch) branch = 'ctaz';
        else branch = matchKnownSamples(node.sample_hashes, (height) =>
          anchors.find((a) => a.height === height)?.cipherscan_hash) === false ? 'other' : 'unknown';
      } else if (
        node.tip_hash &&
        node.tip === tipHeight &&
        tipHash &&
        node.tip_hash === tipHash
      ) {
        branch = referenceUsable && ctazRef.tip === tipHeight && ctazRef.tip_hash === tipHash
          ? 'reference'
          : 'cipherscan';
      } else if (
        node.tip_hash &&
        referenceUsable &&
        node.tip === ctazRef.tip &&
        node.tip_hash === ctazRef.tip_hash
      ) {
        branch = 'ctaz';
      }
      return { ...node, branch };
    });

    const result = {
      generated_at: new Date().toISOString(),
      cipherscan: {
        tip: tipHeight,
        tip_hash: tipHash,
        peers: peerCount,
        finalized: finalizedHeight,
        finality_gap: finalizedHeight == null ? null : tipHeight - finalizedHeight,
      },
      ctaz: ctazRef,
      status,
      first_divergence: firstDivergence,
      anchors,
      nodes,
      split_hints: ['Compare the v14 genesis and network epoch before comparing tips. Legacy Round 2 anchors do not apply.'],
    };

    if (deps.redisClient && deps.redisClient.isOpen) {
      try {
        await deps.redisClient.set(FORK_MONITOR_CACHE_KEY, JSON.stringify(result), {
          EX: FORK_MONITOR_CACHE_DURATION,
        });
      } catch {}
    }

    res.json(result);
  } catch (error) {
    logSafeError('Fork monitor error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch fork monitor data' });
  }
});

/**
 * POST /api/crosslink/fork-monitor/check
 * Live hash lookup at arbitrary heights. Accepts { heights: [number] },
 * returns our hash + cTAZ hash for each.
 */
router.post('/api/crosslink/fork-monitor/check', async (req, res) => {
  try {
    const { heights } = req.body || {};
    if (!Array.isArray(heights) || heights.length === 0) {
      return res.status(400).json({ success: false, error: 'heights must be a non-empty array' });
    }
    if (heights.length > 10) {
      return res.status(400).json({ success: false, error: 'max 10 heights per request' });
    }

    const parsed = heights.map((h) => parseInt(h)).filter((h) => !isNaN(h) && h >= 0);
    if (parsed.length === 0) {
      return res.status(400).json({ success: false, error: 'no valid heights provided' });
    }

    const ctaz = await fetchCtazForkMap();
    const ctazAnchors = { ...KNOWN_REFERENCE_HASHES };
    if (ctaz && Array.isArray(ctaz.anchors)) {
      for (const a of ctaz.anchors) {
        ctazAnchors[a.height] = normalizeHash(a.observed_hash || a.expected_hash);
      }
    }
    if (ctaz && ctaz.reference) {
      ctazAnchors[ctaz.reference.tip] = normalizeHash(ctaz.reference.tip_hash);
    }

    const results = [];
    for (const height of parsed) {
      const csHash = normalizeHash(
        await deps.callZebraRPC('getblockhash', [height]).catch(() => null)
      );
      const ctazHash = ctazAnchors[height] || null;
      results.push({
        height,
        cipherscan_hash: csHash,
        ctaz_hash: ctazHash,
        match: csHash && ctazHash ? csHash === ctazHash : null,
      });
    }

    res.json({ success: true, results });
  } catch (error) {
    logSafeError('Fork monitor check error:', error);
    res.status(500).json({ success: false, error: 'Failed to check hashes' });
  }
});

/**
 * GET /api/crosslink/block-hash/:height
 * Returns the block hash at a given height. Used by external fork-finder scripts.
 */
router.get('/api/crosslink/block-hash/:height', async (req, res) => {
  try {
    const height = parseInt(req.params.height);
    if (isNaN(height) || height < 0) {
      return res.status(400).json({ success: false, error: 'invalid height' });
    }
    const hash = normalizeHash(
      await deps.callZebraRPC('getblockhash', [height]).catch(() => null)
    );
    if (!hash) {
      return res.status(404).json({ success: false, error: 'block not found' });
    }
    res.json({ success: true, height, hash });
  } catch (error) {
    logSafeError('Block hash lookup error:', error);
    res.status(500).json({ success: false, error: 'Failed to get block hash' });
  }
});

/**
 * POST /api/crosslink/fork-monitor/report
 * Voluntary node registration. Persisted to PostgreSQL with configurable TTL.
 */
router.post('/api/crosslink/fork-monitor/report', async (req, res) => {
  let client;
  let committed = false;
  try {
    const { name, tip, tip_hash, sample_hashes, peers, mining, ttl } = req.body || {};

    const cleanName = typeof name === 'string' ? name.trim() : '';
    if (!NODE_NAME_RE.test(cleanName)) {
      return res.status(400).json({
        success: false,
        error: 'name must be 1-32 chars: letters, numbers, spaces, _, -, .',
      });
    }
    if (!Number.isInteger(tip) || tip < 0 || tip > MAX_TIP_HEIGHT) {
      return res.status(400).json({ success: false, error: 'tip must be a non-negative number' });
    }
    if (tip_hash && !normalizeHash(tip_hash)) {
      return res.status(400).json({ success: false, error: 'tip_hash must be a 64-char hex string' });
    }
    if (peers !== undefined && peers !== null && (!Number.isInteger(peers) || peers < 0 || peers > MAX_PEER_COUNT)) {
      return res.status(400).json({ success: false, error: 'peers must be a non-negative integer' });
    }
    if (mining !== undefined && mining !== null && typeof mining !== 'boolean') {
      return res.status(400).json({ success: false, error: 'mining must be boolean' });
    }
    if (sample_hashes && !Array.isArray(sample_hashes)) {
      return res.status(400).json({ success: false, error: 'sample_hashes must be an array' });
    }
    if (sample_hashes) {
      if (sample_hashes.length > MAX_REPORT_SAMPLES) {
        return res.status(400).json({ success: false, error: `max ${MAX_REPORT_SAMPLES} sample hashes` });
      }
      for (const s of sample_hashes) {
        if (!Number.isInteger(s.height) || s.height < 0 || s.height > MAX_TIP_HEIGHT || !normalizeHash(s.hash)) {
          return res.status(400).json({ success: false, error: 'each sample_hash needs { height: number, hash: 64-char hex }' });
        }
      }
    }

    const validTtl = typeof ttl === 'string' && Object.hasOwn(NODE_TTL_OPTIONS, ttl) ? ttl : DEFAULT_TTL;

    // Rate limit per name (still in-memory — ephemeral by design)
    const lastReport = reportTimestamps.get(cleanName);
    if (lastReport && Date.now() - lastReport < REPORT_COOLDOWN_MS) {
      const wait = Math.ceil((REPORT_COOLDOWN_MS - (Date.now() - lastReport)) / 1000);
      return res.status(429).json({ success: false, error: `wait ${wait}s before reporting again` });
    }

    // Serialize registration across API processes: capacity and ownership must
    // be checked against the same transaction that writes the report.
    client = await deps.writePool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('cipherscan:fork-monitor:registration'))");
    await client.query(
      `DELETE FROM fork_monitor_nodes
       WHERE (ttl = '1h' AND reported_at < $1)
          OR ((ttl IS NULL OR ttl <> '1h') AND reported_at < $2)`,
      [Date.now() - NODE_TTL_OPTIONS['1h'], Date.now() - NODE_TTL_OPTIONS['24h']]
    );
    const { rows: countRows } = await client.query('SELECT COUNT(*)::int AS cnt FROM fork_monitor_nodes');
    const existing = await client.query('SELECT owner_token_hash FROM fork_monitor_nodes WHERE name = $1', [cleanName]);
    const suppliedToken = req.headers['x-node-token'];
    const serviceKeys = (process.env.SERVICE_API_KEYS || '').split(',').filter(Boolean);
    const isService = isKnownServiceKey(req.headers['x-service-key'], serviceKeys);
    let ownerToken = null;
    let ownerTokenHash;

    if (existing.rows.length > 0) {
      ownerTokenHash = existing.rows[0].owner_token_hash;
      const ownsName = typeof suppliedToken === 'string'
        && suppliedToken.length <= 200
        && typeof ownerTokenHash === 'string'
        && constantTimeEqual(
          crypto.createHash('sha256').update(suppliedToken).digest('hex'),
          ownerTokenHash,
        );
      if (!isService && !ownsName) {
        return res.status(409).json({
          success: false,
          error: 'Node name is already registered; provide its ownership token or wait for it to expire',
        });
      }
    } else {
      ownerToken = crypto.randomBytes(32).toString('base64url');
      ownerTokenHash = crypto.createHash('sha256').update(ownerToken).digest('hex');
    }
    if (countRows[0].cnt >= MAX_REGISTERED_NODES && existing.rows.length === 0) {
      return res.status(409).json({ success: false, error: 'Node registry is full; retry after a registration expires' });
    }
    if (existing.rows.length === 0 && !isService && !reserveRegistration(req.ip)) {
      res.set('Retry-After', String(REGISTRATION_WINDOW_MS / 1000));
      return res.status(429).json({ success: false, error: 'Too many new node registrations; retry later' });
    }

    const cleanSamples = (sample_hashes || []).map((s) => ({
      height: s.height,
      hash: normalizeHash(s.hash),
    }));

    await client.query(
      `INSERT INTO fork_monitor_nodes (name, tip, tip_hash, sample_hashes, peers, mining, ttl, reported_at, owner_token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (name) DO UPDATE SET
         tip = EXCLUDED.tip,
         tip_hash = EXCLUDED.tip_hash,
         sample_hashes = EXCLUDED.sample_hashes,
         peers = EXCLUDED.peers,
         mining = EXCLUDED.mining,
         ttl = EXCLUDED.ttl,
         reported_at = EXCLUDED.reported_at,
         owner_token_hash = COALESCE(fork_monitor_nodes.owner_token_hash, EXCLUDED.owner_token_hash)`,
      [
        cleanName,
        tip,
        tip_hash ? normalizeHash(tip_hash) : null,
        JSON.stringify(cleanSamples),
        Number.isInteger(peers) ? peers : null,
        typeof mining === 'boolean' ? mining : null,
        validTtl,
        Date.now(),
        ownerTokenHash,
      ]
    );
    await client.query('COMMIT');
    committed = true;
    client.release();
    client = null;
    reportTimestamps.set(cleanName, Date.now());

    // Invalidate fork-monitor cache so fresh GET picks up new node
    if (deps.redisClient && deps.redisClient.isOpen) {
      try { await deps.redisClient.del(FORK_MONITOR_CACHE_KEY); } catch {}
    }

    const { rows: nodeCount } = await deps.writePool.query('SELECT COUNT(*)::int AS cnt FROM fork_monitor_nodes');
    res.json({
      success: true,
      registered: cleanName,
      node_count: nodeCount[0].cnt,
      ownershipToken: ownerToken || undefined,
    });
  } catch (error) {
    logSafeError('Fork monitor report error:', error);
    res.status(500).json({ success: false, error: 'Failed to register node' });
  } finally {
    if (client) {
      if (!committed) await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }
});

/**
 * DELETE /api/crosslink/fork-monitor/report/:name
 * Remove a node report by name.
 */
router.delete('/api/crosslink/fork-monitor/report/:name', async (req, res) => {
  try {
    const cleanName = typeof req.params.name === 'string' ? req.params.name.trim() : '';
    if (!NODE_NAME_RE.test(cleanName)) {
      return res.status(400).json({ success: false, error: 'Invalid node name' });
    }

    const suppliedToken = req.headers['x-node-token'];
    const serviceKeys = (process.env.SERVICE_API_KEYS || '').split(',').filter(Boolean);
    const isService = isKnownServiceKey(req.headers['x-service-key'], serviceKeys);
    const tokenHash = typeof suppliedToken === 'string' && suppliedToken.length <= 200
      ? crypto.createHash('sha256').update(suppliedToken).digest('hex')
      : null;

    const { rowCount } = await deps.writePool.query(
      `DELETE FROM fork_monitor_nodes
       WHERE name = $1
         AND ($2::boolean OR owner_token_hash = $3)`,
      [cleanName, isService, tokenHash]
    );

    if (rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Node not found or ownership token invalid' });
    }

    if (deps.redisClient && deps.redisClient.isOpen) {
      try { await deps.redisClient.del(FORK_MONITOR_CACHE_KEY); } catch {}
    }

    res.json({ success: true, deleted: cleanName });
  } catch (error) {
    logSafeError('Fork monitor delete error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete node' });
  }
});

module.exports = router;
