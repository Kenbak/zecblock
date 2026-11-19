/**
 * NU7.1 miner sentiment poll (pilot) ballot parsing and tally.
 *
 * Rules follow the Zcash Foundation poll definition and the draft ZIP "Miner
 * Sentiment Polling" (zcash/zips#1421, f0ef6117). Keep the parser in step with
 * lib/miner-poll.ts; server/tests/miner-poll.test.js runs both over one vector set.
 *
 * coinbase_hex holds the coinbase input's Miner Data (script bytes after the
 * height encoding), which is exactly what the ZIP searches. Ballots carried in
 * shielded coinbase memos are not decrypted here; blocks whose coinbase has
 * shielded outputs and no script ballot are reported as memoUnchecked.
 */

const ELECTION_ID = 'nu7-1';
const START_HEIGHT = 3591200;
const END_HEIGHT = 3629650;
const QUESTION_COUNT = 5;
const OPTION_COUNT = 3;
const RECENT_BALLOTS = 50;
const PREFIX = Buffer.from(`zpoll:${ELECTION_ID}:`, 'ascii');

function isAnswerByte(byte) {
  return byte === 0x2d || byte === 0x28 || byte === 0x29
    || (byte >= 0x31 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a);
}

function optionValue(byte) {
  return byte <= 0x39 ? byte - 0x30 : byte - 0x41 + 10;
}

function parseAnswers(bytes, start, end) {
  const answers = [];
  for (let i = start; i < end; i += 1) {
    const byte = bytes[i];
    if (byte === 0x28 || byte === 0x29) return null;
    if (byte === 0x2d) answers.push('-');
    else if (optionValue(byte) <= OPTION_COUNT) answers.push(String.fromCharCode(byte));
    else return null;
  }
  if (answers.length !== QUESTION_COUNT || answers.every(answer => answer === '-')) return null;
  return answers;
}

function parseMinerPollBallot(hex) {
  if (typeof hex !== 'string' || !hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = Buffer.from(hex, 'hex');
  let at = bytes.indexOf(PREFIX);
  while (at !== -1) {
    const start = at + PREFIX.length;
    let end = start;
    while (end < bytes.length && isAnswerByte(bytes[end])) end += 1;
    const answers = parseAnswers(bytes, start, end);
    if (answers) return answers;
    at = bytes.indexOf(PREFIX, at + 1);
  }
  return null;
}

// One row per canonical block in [START_HEIGHT, LEAST(END_HEIGHT, $1)].
// has_shielded_coinbase lets us flag blocks whose memo might carry a ballot.
const TALLY_SQL = `
  SELECT b.height, b.hash, b.miner_address, b.coinbase_hex,
         COALESCE(cb.has_shielded_data, false) AS has_shielded_coinbase
  FROM blocks b
  LEFT JOIN LATERAL (
    SELECT t.has_shielded_data FROM transactions t
    WHERE t.block_height = b.height AND t.is_coinbase = true
    LIMIT 1
  ) cb ON true
  WHERE b.height BETWEEN $1 AND $2
  ORDER BY b.height
`;

/**
 * Tally rows as the ZIP defines: every block in the window is one vote, the
 * percentages are relative to N (all blocks in the Voting Period), and a block
 * without a ballot answers no question.
 */
function tallyRows(rows, { tipHeight, getPoolName }) {
  const n = END_HEIGHT - START_HEIGHT + 1;
  const counts = Array.from({ length: QUESTION_COUNT }, () => [0, 0, 0]);
  const pools = new Map();
  const ballots = [];
  let observed = 0;
  let withBallot = 0;
  let memoUnchecked = 0;

  for (const row of rows) {
    const height = Number(row.height);
    if (!Number.isSafeInteger(height) || height < START_HEIGHT || height > END_HEIGHT) continue;
    observed += 1;
    const pool = getPoolName(row.miner_address, row.coinbase_hex) || null;
    const poolKey = pool || '';
    if (!pools.has(poolKey)) pools.set(poolKey, { pool, blocks: 0, ballots: 0, latest: null });
    const entry = pools.get(poolKey);
    entry.blocks += 1;

    const answers = parseMinerPollBallot(row.coinbase_hex);
    if (!answers) {
      if (row.has_shielded_coinbase) memoUnchecked += 1;
      continue;
    }
    withBallot += 1;
    entry.ballots += 1;
    const ballot = answers.join('');
    entry.latest = { height, ballot };
    answers.forEach((answer, q) => { if (answer !== '-') counts[q][Number(answer) - 1] += 1; });
    ballots.push({ height, hash: row.hash, pool, ballot });
  }

  const pct = value => Math.round((value / n) * 1e6) / 1e4;
  const lastHeight = tipHeight == null ? null : Math.min(Number(tipHeight), END_HEIGHT);
  const state = lastHeight == null || lastHeight < START_HEIGHT ? 'upcoming'
    : Number(tipHeight) >= END_HEIGHT + 99 ? 'final'
      : Number(tipHeight) >= END_HEIGHT ? 'confirming' : 'open';

  return {
    electionId: ELECTION_ID,
    startHeight: START_HEIGHT,
    endHeight: END_HEIGHT,
    tipHeight: tipHeight == null ? null : Number(tipHeight),
    state,
    totalBlocks: n,
    observedBlocks: observed,
    expectedObservedBlocks: lastHeight == null || lastHeight < START_HEIGHT ? 0 : lastHeight - START_HEIGHT + 1,
    blocksWithBallot: withBallot,
    participationPct: pct(withBallot),
    memoUncheckedBlocks: memoUnchecked,
    questions: counts.map((options, q) => {
      const answered = options.reduce((sum, value) => sum + value, 0);
      return {
        index: q + 1,
        options: options.map((count, o) => ({ option: o + 1, count, pct: pct(count) })),
        unanswered: n - answered,
        unansweredPct: pct(n - answered),
      };
    }),
    pools: [...pools.values()].sort((a, b) => b.blocks - a.blocks
      || (a.pool === null) - (b.pool === null) || String(a.pool).localeCompare(String(b.pool))),
    // Bounded, most recent first. Each block page shows its own ballot.
    recentBallots: ballots.slice(-RECENT_BALLOTS).reverse(),
  };
}

module.exports = {
  ELECTION_ID, START_HEIGHT, END_HEIGHT, QUESTION_COUNT, OPTION_COUNT,
  parseMinerPollBallot, tallyRows, TALLY_SQL,
};
