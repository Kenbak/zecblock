/**
 * Scan Routes
 *
 * Handles blockchain scanning endpoints:
 * - POST /api/scan/orchard - Scan for Orchard transactions (from PostgreSQL)
 * - POST /api/lightwalletd/scan - Scan blocks for Orchard transactions (via Lightwalletd gRPC)
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { logSafeError } = require('../lib/safe-log');
const { streamInbox } = require('../lib/scan-stream');
const { compactBlockToJSON, isCompleteRange, compactBlockToInbox } = require('../lib/compact-blocks');

// Dependencies injected via app.locals
let pool;
let CompactTxStreamer;
let grpc;

// Compact block cache configuration. Production runtimes must point this at a
// provisioned writable state directory; keeping mutable data inside the source
// checkout conflicts with read-only systemd/Docker filesystems.
const DEFAULT_CACHE_DIR = path.join(__dirname, '..', 'cache', 'compact-blocks');
const CACHE_DIR = path.resolve(process.env.COMPACT_BLOCK_CACHE_DIR || DEFAULT_CACHE_DIR);
const CACHE_CHUNK_SIZE = 10000; // Cache blocks in chunks of 10k
let cacheEnabled = process.env.COMPACT_BLOCK_CACHE_ENABLED !== '0';

// Ensure cache directory exists
if (cacheEnabled) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.accessSync(CACHE_DIR, fs.constants.R_OK | fs.constants.W_OK);
    console.log(`📁 [CACHE] Compact block cache ready: ${CACHE_DIR}`);
  } catch (err) {
    cacheEnabled = false;
    logSafeError(`⚠️ [CACHE] Disabling compact block cache; directory is unavailable: ${CACHE_DIR}`, err);
  }
}

/**
 * Get cache file path for a block range chunk
 */
function getCacheFilePath(chunkStart) {
  // Round down to nearest CACHE_CHUNK_SIZE
  const chunkId = Math.floor(chunkStart / CACHE_CHUNK_SIZE) * CACHE_CHUNK_SIZE;
  return path.join(CACHE_DIR, `blocks_${chunkId}_${chunkId + CACHE_CHUNK_SIZE - 1}.json`);
}

/**
 * Load cached blocks for a range
 * Returns { cachedBlocks, missingRanges }
 */
function loadCachedBlocks(startHeight, endHeight) {
  if (!cacheEnabled) {
    return { cachedBlocks: [], missingRanges: [{ start: startHeight, end: endHeight }] };
  }

  const cachedBlocks = [];
  const missingRanges = [];
  let currentMissingStart = null;

  for (let chunkStart = Math.floor(startHeight / CACHE_CHUNK_SIZE) * CACHE_CHUNK_SIZE;
       chunkStart <= endHeight; chunkStart += CACHE_CHUNK_SIZE) {
    const rangeStart = Math.max(startHeight, chunkStart);
    const rangeEnd = Math.min(endHeight, chunkStart + CACHE_CHUNK_SIZE - 1);
    let blocks = null;
    try {
      const data = JSON.parse(fs.readFileSync(getCacheFilePath(chunkStart), 'utf8'));
      // Older cache files may contain only 90% of a chunk. Never trust those as complete.
      if (isCompleteRange(data.blocks, chunkStart, chunkStart + CACHE_CHUNK_SIZE - 1)) {
        blocks = data.blocks.filter(block => Number(block.height) >= rangeStart && Number(block.height) <= rangeEnd);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') logSafeError('Unable to read compact cache chunk', err);
    }
    if (blocks) {
      if (currentMissingStart !== null) {
        missingRanges.push({ start: currentMissingStart, end: rangeStart - 1 });
        currentMissingStart = null;
      }
      cachedBlocks.push(...blocks);
    } else if (currentMissingStart === null) currentMissingStart = rangeStart;
  }

  // Close any remaining missing range
  if (currentMissingStart !== null) {
    missingRanges.push({ start: currentMissingStart, end: endHeight });
  }

  return { cachedBlocks, missingRanges };
}

/**
 * Save blocks to cache (organized by chunks)
 */
function saveToCache(blocks) {
  if (!cacheEnabled || blocks.length === 0) return;

  // Group blocks by cache chunk
  const chunks = new Map();

  for (const block of blocks) {
    const height = parseInt(block.height);
    const chunkId = Math.floor(height / CACHE_CHUNK_SIZE) * CACHE_CHUNK_SIZE;

    if (!chunks.has(chunkId)) {
      chunks.set(chunkId, []);
    }
    chunks.get(chunkId).push(block);
  }

  // Save each complete chunk
  for (const [chunkId, chunkBlocks] of chunks) {
    chunkBlocks.sort((a, b) => Number(a.height) - Number(b.height));
    if (isCompleteRange(chunkBlocks, chunkId, chunkId + CACHE_CHUNK_SIZE - 1)) {
      const cacheFile = getCacheFilePath(chunkId);
      try {
        fs.writeFileSync(cacheFile, JSON.stringify({ blocks: chunkBlocks }));
        console.log(`💾 [CACHE] Saved ${chunkBlocks.length} blocks to ${path.basename(cacheFile)}`);
      } catch (err) {
        logSafeError(`⚠️ [CACHE] Failed to save cache file ${cacheFile}:`, err);
      }
    }
  }
}

const ORCHARD_SCAN_MAX_RANGE = (() => {
  const configured = Number.parseInt(process.env.V1_SCAN_ORCHARD_MAX_RANGE, 10);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 50_000;
})();

// Middleware to inject dependencies
router.use((req, res, next) => {
  pool = req.app.locals.pool;
  CompactTxStreamer = req.app.locals.CompactTxStreamer;
  grpc = req.app.locals.grpc;
  next();
});

/**
 * POST /api/scan/orchard
 *
 * Batch scan for Orchard transactions (for wallet scanning)
 * Uses PostgreSQL index for fast lookups
 */
router.post('/api/scan/orchard', async (req, res) => {
  try {
    const { startHeight: rawStart, endHeight: rawEnd } = req.body || {};

    if (rawStart == null || rawEnd == null || rawStart === '' || rawEnd === '') {
      return res.status(400).json({ error: 'startHeight and endHeight are required' });
    }

    const startHeight = Number(rawStart);
    const endHeight = Number(rawEnd);
    if (!Number.isSafeInteger(startHeight) || !Number.isSafeInteger(endHeight) || startHeight < 0 || endHeight < 0) {
      return res.status(400).json({ error: 'Invalid block heights' });
    }

    if (startHeight > endHeight) {
      return res.status(400).json({ error: 'startHeight cannot be greater than endHeight' });
    }

    // Same ceiling as /v1/scan/orchard, which proxies here: this legacy path is
    // also reachable directly and returns every matching row.
    if (endHeight - startHeight > ORCHARD_SCAN_MAX_RANGE) {
      return res.status(400).json({ error: `Range too large (max ${ORCHARD_SCAN_MAX_RANGE.toLocaleString('en-US')} blocks)` });
    }

    console.log(`🔍 [SCAN] Scanning Orchard TXs from ${startHeight} to ${endHeight}`);

    // Get all Orchard transactions in this range (SUPER FAST with PostgreSQL index!)
    const result = await pool.query(
      `SELECT
        t.txid,
        t.block_height,
        b.timestamp
      FROM transactions t
      JOIN blocks b ON b.height = t.block_height AND b.hash = t.block_hash
      WHERE t.block_height BETWEEN $1 AND $2
        AND t.has_orchard = true
      ORDER BY t.block_height DESC`,
      [startHeight, endHeight]
    );

    console.log(`✅ [SCAN] Found ${result.rows.length} Orchard transactions`);

    res.json({
      startHeight,
      endHeight,
      totalBlocks: endHeight - startHeight + 1,
      orchardTransactions: result.rows.length,
      transactions: result.rows,
    });
  } catch (error) {
    logSafeError('Error scanning Orchard transactions:', error);
    res.status(500).json({ error: 'Failed to scan transactions' });
  }
});

/**
 * Fetch a range of blocks from Lightwalletd
 * Helper function for parallel fetching
 */
async function fetchBlockRange(CompactTxStreamer, grpc, start, end) {
  return new Promise((resolve, reject) => {
    const client = new CompactTxStreamer(
      '127.0.0.1:9067',
      grpc.credentials.createInsecure()
    );

    const blocks = [];

    const call = client.GetBlockRange({
      start: { height: start },
      end: { height: end },
    });

    call.on('data', (block) => {
      blocks.push(block);
    });

    call.on('end', () => {
      client.close();
      resolve(blocks);
    });

    call.on('error', (error) => {
      client.close();
      reject(error);
    });
  });
}

/**
 * POST /api/lightwalletd/scan
 *
 * Scan blocks for Orchard transactions using Lightwalletd
 * Returns compact blocks for client-side decryption
 * Uses parallel fetching for improved performance
 */
router.post('/api/lightwalletd/scan', async (req, res) => {
  try {
    const { startHeight: rawStart, endHeight: rawEnd, format } = req.body;
    if (format !== undefined && format !== 'inbox-v1' && format !== 'inbox-stream-v1') return res.status(400).json({ error: 'Unsupported scan format' });
    const startHeight = Number(rawStart);
    const endHeight = rawEnd == null ? undefined : Number(rawEnd);

    // Validate inputs
    if (!startHeight) {
      return res.status(400).json({ error: 'startHeight is required' });
    }

    if (!['number', 'string'].includes(typeof rawStart) || !Number.isSafeInteger(startHeight) ||
        (rawEnd != null && (!['number', 'string'].includes(typeof rawEnd) || !Number.isSafeInteger(endHeight) || endHeight < 1))) {
      return res.status(400).json({ error: 'Invalid block heights' });
    }

    if (!CompactTxStreamer) {
      return res.status(503).json({ error: 'Lightwalletd client not initialized' });
    }

    console.log(`🔍 [LIGHTWALLETD] Scanning blocks ${startHeight} to ${endHeight || 'latest'}`);

    // Create temporary client to get latest block if needed
    let finalEndHeight = endHeight;
    if (!finalEndHeight) {
      const tempClient = new CompactTxStreamer(
        '127.0.0.1:9067',
        grpc.credentials.createInsecure()
      );
      finalEndHeight = await new Promise((resolve, reject) => {
        tempClient.GetLatestBlock({}, (error, response) => {
          tempClient.close();
          if (error) {
            reject(error);
            return;
          }
          resolve(parseInt(response.height));
        });
      });
    }

    // Guard against an unbounded scan (memory-exhaustion DoS): a request
    // with no endHeight defaults to the chain tip, and startHeight=1 would
    // otherwise buffer the entire chain into `allBlocks` below.
    if (startHeight < 1) {
      return res.status(400).json({ error: 'startHeight must be >= 1' });
    }
    if (startHeight > finalEndHeight) {
      return res.status(400).json({ error: 'startHeight cannot be greater than endHeight' });
    }
    const MAX_LIGHTWALLETD_SCAN_RANGE = 50000;
    if (finalEndHeight - startHeight + 1 > MAX_LIGHTWALLETD_SCAN_RANGE) {
      return res.status(400).json({
        error: `Range too large (max ${MAX_LIGHTWALLETD_SCAN_RANGE} blocks per request)`,
      });
    }

    if (format === 'inbox-stream-v1') return await streamInbox(res, CompactTxStreamer, grpc, startHeight, finalEndHeight);

    // Check cache first
    const startTime = Date.now();
    const { cachedBlocks, missingRanges } = loadCachedBlocks(startHeight, finalEndHeight);

    let fetchedBlocks = [];

    if (missingRanges.length === 0) {
      // All blocks cached!
      console.log(`✅ [CACHE] All ${cachedBlocks.length} blocks served from cache`);
    } else {
      // Need to fetch missing ranges from lightwalletd
      const totalMissing = missingRanges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
      console.log(`📦 [LIGHTWALLETD] ${cachedBlocks.length} cached, fetching ${totalMissing} missing blocks`);

      // Fetch each missing range in parallel
      const fetchPromises = [];

      for (const range of missingRanges) {
        const rangeSize = range.end - range.start + 1;
        // Determine number of parallel streams for this range
        const NUM_STREAMS = Math.min(8, Math.max(1, Math.ceil(rangeSize / 50000)));
        const blocksPerStream = Math.ceil(rangeSize / NUM_STREAMS);

        for (let i = 0; i < NUM_STREAMS; i++) {
          const chunkStart = range.start + (i * blocksPerStream);
          const chunkEnd = Math.min(chunkStart + blocksPerStream - 1, range.end);

          if (chunkStart <= range.end) {
            fetchPromises.push(fetchBlockRange(CompactTxStreamer, grpc, chunkStart, chunkEnd));
          }
        }
      }

      // Fetch all missing chunks in parallel
      const blockChunks = await Promise.all(fetchPromises);
      fetchedBlocks = blockChunks.flat().map(compactBlockToJSON);

      // Save newly fetched blocks to cache
      if (fetchedBlocks.length > 0) {
        saveToCache(fetchedBlocks);
      }
    }

    // Merge cached and fetched blocks
    const allBlocks = [...cachedBlocks];

    // Reuse the same conversion for both cache and response.
    allBlocks.push(...fetchedBlocks);

    // Sort by height
    const blocks = allBlocks.sort((a, b) => parseInt(a.height) - parseInt(b.height));

    if (!isCompleteRange(blocks, Number(startHeight), Number(finalEndHeight))) {
      return res.status(502).json({ error: 'Incomplete compact block range from upstream' });
    }
    const fetchTime = Date.now() - startTime;
    console.log(`✅ [SCAN] Total ${blocks.length} blocks in ${fetchTime}ms (${cachedBlocks.length} cached, ${fetchedBlocks.length} fetched)`);

    // Return compact blocks (already transformed to hex strings)
    res.json({
      success: true,
      blocksScanned: blocks.length,
      startHeight,
      endHeight: finalEndHeight,
      cachedBlocks: cachedBlocks.length,
      fetchedBlocks: fetchedBlocks.length,
      fetchTimeMs: fetchTime,
      ...(format ? { format } : {}),
      blocks: format === 'inbox-v1' ? blocks.map(compactBlockToInbox) : blocks,
    });

  } catch (error) {
    logSafeError('❌ [LIGHTWALLETD] Error:', error);
    res.status(500).json({
      error: 'Failed to scan blocks',
    });
  }
});

module.exports = router;
