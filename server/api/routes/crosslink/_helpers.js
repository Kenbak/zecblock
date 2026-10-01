/**
 * Shared helpers, constants, and request-scoped deps for Crosslink routes.
 */

const deps = {
  callZebraRPC: null,
  redisClient: null,
  pool: null,
  writePool: null,
};

function attachLocals(req, res, next) {
  deps.callZebraRPC = req.app.locals.callZebraRPC;
  deps.redisClient = req.app.locals.redisClient;
  deps.pool = req.app.locals.pool;
  deps.writePool = req.app.locals.writePool || req.app.locals.pool;
  next();
}

// ---------------------------------------------------------------------------
// Staking day
// ---------------------------------------------------------------------------
const STAKING_DAY_PERIOD = 150;
const STAKING_DAY_WINDOW = 70;

function computeStakingDay(tipHeight) {
  const periodNumber = Math.floor(tipHeight / STAKING_DAY_PERIOD);
  const positionInPeriod = tipHeight % STAKING_DAY_PERIOD;
  const isStakingOpen = positionInPeriod < STAKING_DAY_WINDOW;

  const windowStart = periodNumber * STAKING_DAY_PERIOD;
  const windowEnd = windowStart + STAKING_DAY_WINDOW - 1;

  const blocksRemaining = isStakingOpen
    ? STAKING_DAY_WINDOW - positionInPeriod
    : 0;

  const blocksUntilNextWindow = isStakingOpen
    ? 0
    : STAKING_DAY_PERIOD - positionInPeriod;

  return {
    tipHeight,
    positionInPeriod,
    isStakingOpen,
    blocksRemaining,
    blocksUntilNextWindow,
    periodNumber,
    windowStart,
    windowEnd,
  };
}

// ---------------------------------------------------------------------------
// Finalizer pubkey helpers
// ---------------------------------------------------------------------------

/**
 * Reverse the byte order of a 64-char hex string. zebrad's fat-pointer
 * signer pub_keys come through in one byte order; the Crosslink GUI
 * displays them in the opposite order. Frontend prefers the GUI form.
 * Non-64-char input is returned unchanged.
 */
function reverseHex(hex) {
  if (typeof hex !== 'string' || hex.length !== 64) return hex;
  let out = '';
  for (let i = 62; i >= 0; i -= 2) out += hex.slice(i, i + 2);
  return out;
}

/**
 * Resolve a user-supplied pubkey against our DB. The user may paste a
 * GUI-form hex or a raw-RPC form; we try both and use whichever one
 * matches a known finalizer. Returns the form that's actually stored
 * in the DB (raw form), or null if neither exists.
 */
async function resolveFinalizerPubkey(input) {
  const lower = input.toLowerCase();
  const candidates = [lower];
  const reversed = reverseHex(lower);
  if (reversed !== lower) candidates.push(reversed);

  const r = await deps.pool.query(
    'SELECT pub_key FROM finalizers WHERE pub_key = ANY($1) LIMIT 1',
    [candidates]
  );
  return r.rows[0]?.pub_key || null;
}

// ---------------------------------------------------------------------------
// Fork Monitor — constants and helpers
// ---------------------------------------------------------------------------
const FORK_MONITOR_CACHE_KEY = 'crosslink:fork-monitor';
const CTAZ_CACHE_KEY = 'crosslink:ctaz-fork-map';
const CTAZ_CACHE_DURATION = 30;
const NODE_TTL_OPTIONS = { '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 };
const DEFAULT_TTL = '24h';
const MAX_REGISTERED_NODES = 100;
const REPORT_COOLDOWN_MS = 30 * 1000;
const MAX_REPORT_SAMPLES = 12;
const MAX_TIP_HEIGHT = 100_000_000;
const MAX_PEER_COUNT = 10_000;
const NODE_NAME_RE = /^[a-zA-Z0-9_. -]{1,32}$/;
const CTAZ_FETCH_TIMEOUT_MS = 7500;
const CTAZ_FORK_MAP_URLS = [
  'https://ctaz.cash/api/fork-map',
  'https://ctaz.zat-explorer.cash/api/fork-map',
  'https://frontiercompute.io/ctaz/api/fork-map',
];

const reportTimestamps = new Map();

const ANCHOR_HEIGHTS = [
  { height: 19138, label: 'BFT finalized' },
  { height: 37657, label: 'fixed branch check' },
  { height: 39574, label: 'split marker' },
  { height: 41898, label: 'May 2 split' },
  { height: 54777, label: 'OG fork point' },
  { height: 57298, label: 'Roman drift' },
  { height: 57352, label: 'May 7 last match' },
  // Preserve the legacy explorer's historical comparison points. These are
  // ancestry samples, not an assertion of present network authority.
  { height: 131171, label: 'Jun split sample' },
  { height: 147413, label: 'historic checkpoint sample' },
  { height: 163975, label: 'h163k split' },
  { height: 174587, label: 'h174k divergence' },
  { height: 177217, label: 'h177k fork' },
  { height: 178541, label: 'h178k split' },
  { height: 187572, label: 'historic Round 2 checkpoint' },
  { height: 655350, label: 'Monday17 burn height' },
  { height: 655357, label: 'reported Monday17 branch split' },
];

// Verified reference hashes for heights cTAZ's API doesn't cover.
// Source: community cross-checks (Zk_nd3r, OrchardGuardian) + CipherScan RPC.
const KNOWN_REFERENCE_HASHES = {
  54777: '00ca9de28f9833038781a91c27a6a61870a46fd54632f4d4b49e454c6c956113',
  57298: '0002b61601c22263ee80c3c8c15c8aea2cfb9e585d6729359d885bdd1caa0ba5',
  57352: '00fca2639b6bda9466e425e05fdde428038133e5aee06381900c45771af6fc5c',
  131171: '0475347574dd744be5ee328e639c010beca408352b669096660bda9f9235db2b',
  147413: '0283519f81ace36fb622c634b43eed63ff784f0966cd7d5c45fbd97051710c26',
  163975: '01d78ab4f298fd733d4a22db015d90752aab58d380506fd35aa0ce491cfacfe3',
  174587: '008a5f976f7e1fa18488ab0132fb7221949909e7a32fbb1234f5143ad4e6f20c',
  177217: '012bb8ff4be1122d44794754a855f3ddb16dc3590761add516dd530e53e21dce',
  178541: '00a9f626fd3f85d6d1c965a94965cba560bba11b4ada90ca7e11bd0b1d9e8682',
  187572: '02fc9aa7652b2a9a9f6196a446265fed6012227373ed34e0b17c7a3298db005e',
};

function normalizeHash(hash) {
  return typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash)
    ? hash.toLowerCase()
    : null;
}

function usableForkReference(data) {
  const ref = data?.reference;
  return !!ref && data.degraded !== true && ref.degraded !== true
    && ref.authority !== false && Number.isSafeInteger(ref.tip) && ref.tip > 0
    && normalizeHash(ref.tip_hash) !== null;
}

// Unknown samples supply no evidence. Array.every() over unmatched samples
// used to label arbitrary registrations as belonging to our/reference branch.
function matchKnownSamples(samples, hashAtHeight) {
  let compared = 0;
  for (const sample of samples) {
    const expected = normalizeHash(hashAtHeight(sample.height));
    const observed = normalizeHash(sample.hash);
    if (!expected || !observed) continue;
    compared++;
    if (expected !== observed) return false;
  }
  return compared > 0 ? true : null;
}

/** Prune expired rows by TTL, then return all remaining nodes. */
async function pruneAndFetchNodes() {
  if (!deps.pool) return [];
  if (!deps.writePool) throw new Error('Crosslink write pool is unavailable');
  await deps.writePool.query(
    `DELETE FROM fork_monitor_nodes
     WHERE (ttl = '1h'  AND reported_at < $1)
        OR ((ttl IS NULL OR ttl <> '1h') AND reported_at < $2)`,
    [Date.now() - NODE_TTL_OPTIONS['1h'], Date.now() - NODE_TTL_OPTIONS['24h']]
  );
  const { rows } = await deps.pool.query(
    `SELECT name, tip, tip_hash, sample_hashes, peers, mining, ttl, reported_at
     FROM fork_monitor_nodes ORDER BY reported_at DESC`
  );
  return rows.map((r) => ({
    ...r,
    sample_hashes: r.sample_hashes || [],
    reported_at: Number(r.reported_at),
  }));
}

async function fetchCtazForkMap() {
  if (deps.redisClient && deps.redisClient.isOpen) {
    try {
      const cached = await deps.redisClient.get(CTAZ_CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch {}
  }
  for (const url of CTAZ_FORK_MAP_URLS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CTAZ_FETCH_TIMEOUT_MS);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok && resp.status !== 503) continue;
      const data = await resp.json();
      // The current public observer returns an explicit degraded JSON payload
      // with 503. Keep its diagnostics while usableForkReference denies it
      // authority; never accept an arbitrary upstream error as a reference.
      if (!resp.ok && data?.degraded !== true) continue;
      if (deps.redisClient && deps.redisClient.isOpen) {
        try {
          await deps.redisClient.set(CTAZ_CACHE_KEY, JSON.stringify(data), { EX: CTAZ_CACHE_DURATION });
        } catch {}
      }
      return data;
    } catch {
      // Try the next mirror.
    }
  }
  return null;
}

module.exports = {
  deps,
  attachLocals,
  computeStakingDay,
  reverseHex,
  resolveFinalizerPubkey,
  normalizeHash,
  usableForkReference,
  matchKnownSamples,
  pruneAndFetchNodes,
  fetchCtazForkMap,
  FORK_MONITOR_CACHE_KEY,
  FORK_MONITOR_CACHE_DURATION: 15,
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
};
