'use strict';

// The standard SDK expiry default depends on the block's era: 40 blocks before
// NU7 and 120 since (Zakura Common 4). The observed delta is the configured
// value minus the blocks waited before mining, so each window sits just below
// its peak. Both windows span the same wall-clock wait: 5 blocks at 75 s and
// 15 blocks at 25 s.
const SDK_EXPIRY_WINDOWS = Object.freeze({
  beforeNu7: Object.freeze({ min: 36, max: 40 }),
  sinceNu7: Object.freeze({ min: 106, max: 120 }),
});

// $2 is the serving node's NU7 height, or NULL where NU7 is not scheduled.
const delta = '(expiry_height - block_height)';
const { beforeNu7, sinceNu7 } = SDK_EXPIRY_WINDOWS;
const SDK_EXPIRY_MATCH = `((${delta} BETWEEN ${beforeNu7.min} AND ${beforeNu7.max} AND ($2::integer IS NULL OR block_height < $2::integer))
            OR (${delta} BETWEEN ${sinceNu7.min} AND ${sinceNu7.max} AND block_height >= $2::integer))`;

module.exports = { SDK_EXPIRY_WINDOWS, SDK_EXPIRY_MATCH };
