'use strict';

// Exchange deposits and withdrawals, at the level of the entity behind the
// labels (owner request 2026-11-22). Shared by the bot, the
// refresh-exchange-flows job and the API (the API image ships server/lib).
//
// Every address labelled with an exchange or custodian name belongs to that
// entity: hot wallets, cold wallets, deposit addresses, custody. Per
// transaction and entity:
//   - deposit:    no input is the entity's; value reaches the entity's addresses.
//   - withdrawal: every input is the entity's; value leaves to addresses that
//                 are not the entity's (or into a shielded pool).
//   - internal:   hot <-> cold moves, deposit-address sweeps into the hot
//                 wallet, change back to the entity. Never an event.
// Value moving between two different labelled exchanges, inputs mixing the
// entity with unlabelled addresses, Sprout and unresolved inputs are skipped,
// never guessed. Amounts are exact zatoshi integers (BigInt / decimal strings).
//
// Attribution is only as good as the labels: an unlabelled deposit address
// swept into a labelled hot wallet reads as one deposit (the sweep), and a
// move to an unlabelled wallet the exchange owns reads as a withdrawal.
// Shielded deposits and withdrawals that never touch a labelled transparent
// address are invisible.

const crypto = require('crypto');

// Bump when classify() or the SQL legs change meaning: stored rows from an
// older classifier are then stale and need `refresh-exchange-flows --rebuild`.
const CLASSIFIER_VERSION = 1;

// Explicit label -> entity aliases, matching lib/entity-logos.ts. A label that
// is not listed here still belongs to its own entity (so it is never mistaken
// for a customer), but it is never stored or posted about.
const ENTITIES = Object.freeze({
  binance: { name: 'Binance', logo: 'binance.png', kind: 'exchange',
    labels: ['Binance', 'Binance Cold Wallet', 'Binance Hot Wallet'] },
  kraken: { name: 'Kraken', logo: 'kraken.png', kind: 'exchange',
    labels: ['Kraken', 'Kraken Cold Wallet', 'Kraken Deposit', 'Kraken Hot Wallet'] },
  coinbase: { name: 'Coinbase', logo: 'coinbase.png', kind: 'exchange',
    labels: ['Coinbase', 'Coinbase Cold Wallet'] },
  coinbase_prime: { name: 'Coinbase Prime', logo: 'coinbase.png', kind: 'custody',
    labels: ['Coinbase Prime Custody'] },
  gemini: { name: 'Gemini', logo: 'gemini.png', kind: 'exchange',
    labels: ['Gemini', 'Gemini Cold Wallet', 'Gemini Custody'] },
  grayscale: { name: 'Grayscale', logo: 'grayscale.png', kind: 'custody',
    labels: ['Grayscale Zcash Trust'] },
  kucoin: { name: 'KuCoin', logo: 'kucoin.png', kind: 'exchange',
    labels: ['Kucoin Cold Wallet', 'KuCoin Cold Wallet'] },
  // Per-user deposit addresses carry "Hyperunit Deposit"; each one sweeps only to the hot wallet.
  hyperunit: { name: 'Hyperunit', logo: 'hyperunit.png', kind: 'exchange',
    labels: ['Hyperunit Hot Wallet', 'Hyperunit Deposit'] },
});
const ENTITY_IDS = Object.freeze(Object.keys(ENTITIES));
const LABEL_ENTITY = new Map(Object.entries(ENTITIES).flatMap(([id, e]) => e.labels.map(l => [l.toLowerCase(), id])));

/** Entity id for an exchange-category label; unknown labels form their own unnamed entity. */
function entityOfLabel(label) {
  const key = String(label || '').trim().toLowerCase();
  if (!key) return null;
  return LABEL_ENTITY.get(key) || `other:${key}`;
}
/** Named entities are stored, served and posted; `other:*` entities only shape classification. */
const postable = entity => Object.hasOwn(ENTITIES, entity);

/** Version string for stored rows: classifier version plus the address -> entity fingerprint. */
function fingerprintOf(addresses, entities) {
  const hash = crypto.createHash('sha256').update(addresses.map((a, i) => `${a}=${entities[i]}`).join('\n')).digest('hex').slice(0, 16);
  return { fingerprint: hash, version: `c${CLASSIFIER_VERSION}:${hash}` };
}

/** Labels from parallel arrays (sorted by address), with fingerprint and version. */
function labelSet(addresses, entities) {
  return { addresses, entities, ...fingerprintOf(addresses, entities) };
}

/** Exchange-category labels as parallel arrays for the SQL, plus a fingerprint that changes when any label does. */
async function loadLabels(db) {
  const { rows } = await db.query(`SELECT address, label FROM address_labels
    WHERE category='exchange' ORDER BY address`);
  const addresses = [], entities = [];
  for (const row of rows) {
    const entity = entityOfLabel(row.label);
    if (!entity || !row.address) continue;
    addresses.push(row.address); entities.push(entity);
  }
  return labelSet(addresses, entities);
}

// The shared tail of every flow read: canonical transactions (block hash must
// match the canonical block at that height) with their transparent legs summed
// per side and per entity (NULL = unlabelled). `hits` supplies (txid, block_height).
const FLOW_TAIL = `, tx AS MATERIALIZED (
    SELECT t.txid, t.block_height, t.block_hash, t.block_time, t.is_coinbase, COALESCE(t.has_sprout, false) AS has_sprout,
      (COALESCE(t.value_balance_sapling,0) + COALESCE(t.value_balance_orchard,0) + COALESCE(t.value_balance_ironwood,0))::text AS value_balance
    FROM hits h JOIN transactions t ON t.txid = h.txid AND t.block_height = h.block_height
    JOIN blocks b ON b.height = t.block_height AND b.hash = t.block_hash
    WHERE TRUE /*TIME*/
  ), legs AS (
    SELECT i.txid, 'in' AS side, i.address, i.value FROM tx JOIN transaction_inputs i ON i.txid = tx.txid
    UNION ALL
    SELECT o.txid, 'out', o.address, o.value FROM tx JOIN transaction_outputs o ON o.txid = tx.txid
  )
  SELECT tx.txid, tx.block_height, tx.block_hash, tx.block_time, tx.is_coinbase, tx.has_sprout, tx.value_balance,
    g.side, g.entity, g.zat, g.unknown
  FROM tx JOIN (
    SELECT legs.txid, legs.side, lab.entity, COALESCE(sum(legs.value), 0)::text AS zat,
      count(*) FILTER (WHERE legs.value IS NULL)::int AS unknown
    FROM legs LEFT JOIN lab ON lab.address = legs.address
    GROUP BY 1, 2, 3
  ) g ON g.txid = tx.txid
  ORDER BY tx.block_height, tx.txid, g.side, g.entity NULLS FIRST`;
const LAB = 'WITH lab AS (SELECT * FROM unnest($1::text[], $2::text[]) AS l(address, entity))';

// Time window [$3, $4): the bot's original read. The height bound uses the
// address_transactions primary key; time bounds it exactly.
const FLOW_ROWS = `${LAB},
  start AS (SELECT COALESCE(min(height), 0) AS height FROM blocks WHERE timestamp >= $3),
  hits AS MATERIALIZED (
    SELECT DISTINCT at.txid, at.block_height FROM lab
    JOIN address_transactions at ON at.address = lab.address
    WHERE at.block_height >= (SELECT height FROM start) AND at.block_time >= $3 AND at.block_time < $4
  )${FLOW_TAIL.replace('TRUE /*TIME*/', 't.block_time >= $3 AND t.block_time < $4')}`;

// Height window [$3, $4]: the job's incremental and rebuild batches.
const FLOW_ROWS_BY_HEIGHT = `${LAB},
  hits AS MATERIALIZED (
    SELECT DISTINCT at.txid, at.block_height FROM lab
    JOIN address_transactions at ON at.address = lab.address
    WHERE at.block_height BETWEEN $3 AND $4
  )${FLOW_TAIL.replace('TRUE /*TIME*/', 't.block_height BETWEEN $3 AND $4')}`;

// Explicit transactions $3: re-classifying history affected by a label change.
const FLOW_ROWS_BY_TXIDS = `${LAB},
  hits AS MATERIALIZED (SELECT DISTINCT t.txid, t.block_height FROM transactions t WHERE t.txid = ANY($3::text[]))${FLOW_TAIL.replace(' /*TIME*/', '')}`;

/** Group flow rows into one record per transaction. */
function groupRows(rows) {
  const byTx = new Map();
  for (const row of rows) {
    let tx = byTx.get(row.txid);
    if (!tx) {
      tx = { txid: row.txid, blockHeight: Number(row.block_height), blockTime: Number(row.block_time),
        blockHash: row.block_hash ?? null,
        isCoinbase: Boolean(row.is_coinbase), hasSprout: Boolean(row.has_sprout), valueBalance: BigInt(row.value_balance ?? 0),
        legs: [], unknown: 0 };
      byTx.set(row.txid, tx);
    }
    tx.legs.push({ side: row.side, entity: row.entity ?? null, zat: BigInt(row.zat) });
    tx.unknown += Number(row.unknown || 0);
  }
  return [...byTx.values()];
}

/**
 * Classify one grouped transaction. Returns { events, skipped } where each
 * event is { txid, entity, direction, amountZat (string), blockHeight,
 * blockTime, counterparty } and skipped is a reason string or null.
 */
function classify(tx) {
  if (tx.isCoinbase) return { events: [], skipped: 'coinbase' };
  if (tx.hasSprout) return { events: [], skipped: 'sprout' };
  if (tx.unknown > 0) return { events: [], skipped: 'unresolved-legs' };
  const sum = (side, test) => tx.legs.filter(l => l.side === side && test(l.entity)).reduce((a, l) => a + l.zat, 0n);
  const inEntities = [...new Set(tx.legs.filter(l => l.side === 'in' && l.entity && l.zat > 0n).map(l => l.entity))];
  const outEntities = [...new Set(tx.legs.filter(l => l.side === 'out' && l.entity && l.zat > 0n).map(l => l.entity))];
  const unlabelledIn = sum('in', e => !e), unlabelledOut = sum('out', e => !e);
  // valueBalance > 0: value left a shielded pool into this transaction; < 0: value entered one.
  const fromShielded = tx.valueBalance > 0n ? tx.valueBalance : 0n;
  const toShielded = tx.valueBalance < 0n ? -tx.valueBalance : 0n;
  const base = { txid: tx.txid, blockHeight: tx.blockHeight, blockTime: tx.blockTime, ...(tx.blockHash ? { blockHash: tx.blockHash } : {}) };

  if (inEntities.length > 1) return { events: [], skipped: 'inputs-from-several-entities' };
  if (inEntities.length === 1) {
    const entity = inEntities[0];
    // A co-spend with unlabelled inputs suggests an unlabelled entity wallet, or a joint transaction. Not guessed.
    if (unlabelledIn > 0n) return { events: [], skipped: 'mixed-inputs' };
    if (outEntities.some(e => e !== entity)) return { events: [], skipped: 'between-entities' };
    const amount = unlabelledOut + toShielded;
    if (amount <= 0n) return { events: [], skipped: 'internal' };
    const counterparty = unlabelledOut > 0n && toShielded > 0n ? 'mixed' : toShielded > 0n ? 'shielded' : 'transparent';
    return { events: [{ ...base, entity, direction: 'withdrawal', amountZat: amount.toString(), counterparty }], skipped: null };
  }
  if (!outEntities.length) return { events: [], skipped: 'no-entity-value' };
  // No entity input: each entity receiving value got a deposit.
  const counterparty = unlabelledIn > 0n && fromShielded > 0n ? 'mixed' : fromShielded > 0n ? 'shielded' : 'transparent';
  const events = outEntities.map(entity => ({ ...base, entity, direction: 'deposit',
    amountZat: sum('out', e => e === entity).toString(), counterparty }));
  return { events, skipped: null };
}

/** Classify every transaction in flow-row output. */
function classifyRows(rows) {
  const events = [], skipped = {};
  for (const tx of groupRows(rows)) {
    const result = classify(tx);
    events.push(...result.events);
    if (result.skipped) skipped[result.skipped] = (skipped[result.skipped] || 0) + 1;
  }
  return { events, skipped };
}

async function readEvents(db, labels, fromS, toS) {
  if (!labels.addresses.length) return { events: [], skipped: {} };
  const { rows } = await db.query(FLOW_ROWS, [labels.addresses, labels.entities, fromS, toS]);
  return classifyRows(rows);
}

async function readEventsByHeight(db, labels, fromHeight, toHeight) {
  if (!labels.addresses.length || toHeight < fromHeight) return { events: [], skipped: {} };
  const { rows } = await db.query(FLOW_ROWS_BY_HEIGHT, [labels.addresses, labels.entities, fromHeight, toHeight]);
  return classifyRows(rows);
}

async function readEventsByTxids(db, labels, txids) {
  if (!labels.addresses.length || !txids.length) return { events: [], skipped: {} };
  const { rows } = await db.query(FLOW_ROWS_BY_TXIDS, [labels.addresses, labels.entities, txids]);
  return classifyRows(rows);
}

module.exports = { CLASSIFIER_VERSION, ENTITIES, ENTITY_IDS, entityOfLabel, postable, fingerprintOf, labelSet, loadLabels,
  FLOW_ROWS, FLOW_ROWS_BY_HEIGHT, FLOW_ROWS_BY_TXIDS, groupRows, classify, classifyRows,
  readEvents, readEventsByHeight, readEventsByTxids };
