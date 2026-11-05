'use strict';

// Resolve shortened transaction ids and block hashes, including the
// "5b34c8b44d...ec9e77" form the explorer displays, to complete identifiers.

const HEX = '0123456789abcdef';
const MIN_PREFIX = 8;
const MIN_PREFIX_WITH_SUFFIX = 6;
const MIN_SUFFIX = 4;
const MAX_RESULTS = 5;

/** Returns { prefix, suffix } for a searchable shortened id, or null. */
function parseIdQuery(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value.length > 140) return null;

  const plain = value.match(/^[0-9a-f]+$/);
  if (plain) {
    return value.length >= MIN_PREFIX && value.length < 64 ? { prefix: value, suffix: null } : null;
  }

  const shortened = value.match(/^([0-9a-f]+)\s*(?:\.{2,3}|…)\s*([0-9a-f]+)$/);
  if (!shortened) return null;
  const [, prefix, suffix] = shortened;
  if (prefix.length < MIN_PREFIX_WITH_SUFFIX || suffix.length < MIN_SUFFIX) return null;
  if (prefix.length + suffix.length > 64) return null;
  return { prefix, suffix };
}

/** Smallest hex string greater than every string starting with prefix, or null. */
function nextHexPrefix(prefix) {
  const chars = prefix.split('');
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const position = HEX.indexOf(chars[i]);
    if (position < HEX.length - 1) {
      chars[i] = HEX[position + 1];
      return chars.slice(0, i + 1).join('');
    }
  }
  return null;
}

/**
 * Builds a bounded index range scan for one identifier column. The range uses
 * the column's btree index; the left()/right() predicates keep results exact.
 */
function prefixSearchSql(table, column, extraColumns, parsed, limit = MAX_RESULTS) {
  const upper = nextHexPrefix(parsed.prefix);
  const params = [parsed.prefix, parsed.prefix.length];
  const where = [`${column} >= $1`, `left(${column}, $2) = $1`];
  if (upper) {
    params.push(upper);
    where.push(`${column} < $${params.length}`);
  }
  if (parsed.suffix) {
    params.push(parsed.suffix.length, parsed.suffix);
    where.push(`right(${column}, $${params.length - 1}) = $${params.length}`);
  }
  params.push(limit + 1);
  return {
    sql: `SELECT ${[column, ...extraColumns].join(', ')} FROM ${table} WHERE ${where.join(' AND ')} ORDER BY ${column} LIMIT $${params.length}`,
    params,
  };
}

async function searchIdPrefix(query, parsed, limit = MAX_RESULTS) {
  const tx = prefixSearchSql('transactions', 'txid', ['block_height'], parsed, limit);
  const blocks = prefixSearchSql('blocks', 'hash', ['height'], parsed, limit);
  const [txResult, blockResult] = await Promise.all([
    query(tx.sql, tx.params),
    query(blocks.sql, blocks.params),
  ]);
  return {
    transactions: txResult.rows.slice(0, limit).map((row) => ({
      txid: row.txid,
      blockHeight: Number(row.block_height),
    })),
    blocks: blockResult.rows.slice(0, limit).map((row) => ({
      hash: row.hash,
      height: Number(row.height),
    })),
    truncated: txResult.rows.length > limit || blockResult.rows.length > limit,
  };
}

module.exports = { parseIdQuery, nextHexPrefix, prefixSearchSql, searchIdPrefix, MAX_RESULTS };
