/**
 * Transaction detail routes — get by txid and SEO metadata.
 */

const express = require('express');
const router = express.Router();
const { isNonMainnet } = require('../../lib/network-features');
const { validate } = require('../../validation');
const { decodeCoinbaseText } = require('../../coinbase-data');
const { deps, checkStakingColumns } = require('./_helpers');
const { logSafeError } = require('../../lib/safe-log');

// Lightweight transaction metadata for server-rendered titles and JSON-LD.
// Keep this separate from the detail endpoint, which loads inputs, outputs,
// bridge matches, coinbase data, and optional staking columns.
router.get('/api/seo/tx/:txid', validate('txById'), async (req, res) => {
  try {
    const { txid } = req.params;

    if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid)) {
      return res.status(400).json({ error: 'Invalid transaction ID' });
    }

    const result = await deps.pool.query(
      `WITH chain AS (
        SELECT MAX(height) AS max_height FROM blocks
      )
      SELECT
        t.txid,
        t.block_height,
        t.block_hash,
        t.block_time,
        t.is_coinbase,
        t.has_sapling,
        t.has_orchard,
        t.has_ironwood,
        t.orchard_actions,
        t.sapling_spend_count,
        t.sapling_output_count,
        t.fee,
        t.size,
        t.vin_count,
        t.vout_count,
        t.has_sprout,
        (b.hash IS NOT NULL) AS is_canonical,
        CASE
          WHEN b.hash IS NOT NULL AND chain.max_height >= t.block_height
            THEN chain.max_height - t.block_height + 1
          ELSE 0
        END AS confirmations
      FROM transactions t
      CROSS JOIN chain
      LEFT JOIN blocks b ON b.height = t.block_height AND b.hash = t.block_hash
      WHERE t.txid = $1`,
      [txid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const tx = result.rows[0];
    const isCanonical = tx.is_canonical === true;

    res.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=300');
    return res.json({
      txid: tx.txid,
      blockHeight: parseInt(tx.block_height) || 0,
      blockHash: tx.block_hash,
      blockTime: parseInt(tx.block_time) || 0,
      confirmations: isCanonical ? (parseInt(tx.confirmations) || 0) : 0,
      isCanonical,
      status: isCanonical ? 'confirmed' : (tx.block_hash ? 'stale' : 'unknown'),
      isCoinbase: tx.is_coinbase || false,
      hasSapling: tx.has_sapling || false,
      hasOrchard: tx.has_orchard || false,
      hasIronwood: tx.has_ironwood || false,
      hasShielded: Boolean(tx.has_sprout || tx.has_sapling || tx.has_orchard || tx.has_ironwood),
      orchardActions: parseInt(tx.orchard_actions) || 0,
      saplingSpendCount: parseInt(tx.sapling_spend_count) || 0,
      saplingOutputCount: parseInt(tx.sapling_output_count) || 0,
      fee: tx.fee ? Number(tx.fee) / 100000000 : 0,
      feeZat: tx.fee == null ? null : String(tx.fee),
      size: tx.size == null ? null : Number(tx.size),
      vinCount: tx.vin_count == null ? null : Number(tx.vin_count),
      voutCount: tx.vout_count == null ? null : Number(tx.vout_count),
      hasSprout: tx.has_sprout == null ? null : tx.has_sprout,
    });
  } catch (error) {
    logSafeError('Error fetching transaction metadata:', error);
    return res.status(500).json({ error: 'Failed to fetch transaction metadata' });
  }
});

// Get transaction by txid
router.get('/api/tx/:txid', validate('txById'), async (req, res) => {
  try {
    const { txid } = req.params;

    if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid)) {
      return res.status(400).json({ error: 'Invalid transaction ID' });
    }

    // checkStakingColumns is memoized after the first call (a single
    // information_schema lookup for the process lifetime), so resolving it
    // before the batch below costs nothing in steady state but lets the main
    // tx query be built with the right column list up front.
    const hasStaking = await checkStakingColumns(deps.pool);
    const stakingCols = hasStaking
      ? ', t.staking_action_type, t.staking_bond_key, t.staking_delegatee, t.staking_amount_zats'
      : '';

    // The tx row, its inputs, its outputs, the chain tip height, and any
    // cross-chain bridge match are all independent lookups keyed only on the
    // request's txid — none of them depend on each other's results. Run them
    // concurrently instead of five sequential round trips. The bridge lookup
    // keeps its own error boundary (non-critical, matches prior behavior of
    // never failing the whole request on a bridge-table error).
    const [txResult, inputsResult, outputsResult, currentHeightResult, bridgeResult] = await Promise.all([
      deps.pool.query(
        `SELECT
          t.txid,
          t.block_height,
          t.block_hash,
          t.block_time,
          t.size,
          t.version,
          t.locktime,
          t.vin_count,
          t.vout_count,
          t.value_balance,
          t.value_balance_sapling,
          t.value_balance_orchard,
          t.value_balance_ironwood,
          t.has_sapling,
          t.has_orchard,
          t.has_ironwood,
          t.has_sprout,
          t.orchard_actions,
          t.ironwood_actions,
          t.sapling_spend_count,
          t.sapling_output_count,
          t.tx_index,
          t.fee,
          t.total_input,
          t.total_output,
          t.is_coinbase,
          t.expiry_height,
          t.orchard_anchor,
          (b.hash IS NOT NULL) AS is_canonical${stakingCols}
        FROM transactions t
        LEFT JOIN blocks b ON b.height = t.block_height AND b.hash = t.block_hash
        WHERE t.txid = $1`,
        [txid]
      ),
      deps.pool.query(
        `SELECT
          prev_txid,
          prev_vout,
          address,
          value,
          vout_index
        FROM transaction_inputs
        WHERE txid = $1
        ORDER BY vout_index`,
        [txid]
      ),
      deps.pool.query(
        `SELECT
          address,
          value,
          vout_index,
          spent
        FROM transaction_outputs
        WHERE txid = $1
        ORDER BY vout_index`,
        [txid]
      ),
      deps.pool.query('SELECT MAX(height) as max_height FROM blocks'),
      isNonMainnet() ? Promise.resolve({ rows: [] }) : deps.pool.query(
        `SELECT id, direction, source_chain, source_token, source_amount, source_amount_usd,
                source_tx_hashes, dest_chain, dest_token, dest_amount, dest_amount_usd,
                dest_tx_hashes, swap_created_at, matched, zec_address
         FROM cross_chain_swaps
         WHERE zec_txid = $1`,
        [txid]
      ).catch((bridgeErr) => {
        logSafeError('❌ [TX] Bridge lookup error:', bridgeErr);
        return { rows: [] };
      }),
    ]);

    if (txResult.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const tx = txResult.rows[0];

    // Confirmations are meaningful only when both recorded identity fields
    // match the canonical block row. Null/stale hashes stay at zero.
    const currentHeight = parseInt(currentHeightResult.rows[0]?.max_height) || 0;
    const transactionHeight = parseInt(tx.block_height) || 0;
    const confirmations = tx.is_canonical && currentHeight >= transactionHeight
      ? currentHeight - transactionHeight + 1
      : 0;

    // Get value balances (in ZEC)
    const valueBalanceSapling = tx.value_balance_sapling == null ? null : Number(tx.value_balance_sapling) / 100000000;
    const valueBalanceOrchard = tx.value_balance_orchard == null ? null : Number(tx.value_balance_orchard) / 100000000;
    const valueBalanceIronwood = tx.value_balance_ironwood == null ? null : Number(tx.value_balance_ironwood) / 100000000;
    const totalValueBalance = tx.value_balance == null ? null : Number(tx.value_balance) / 100000000;

    // Fee from DB (in zatoshis, convert to ZEC)
    const fee = tx.fee == null ? null : Number(tx.fee) / 100000000;

    // Total input/output from DB (Rust indexer, in zatoshis)
    const totalInput = tx.total_input == null ? null : Number(tx.total_input) / 100000000;
    const totalOutput = tx.total_output == null ? null : Number(tx.total_output) / 100000000;

    // Bridge / cross-chain data (NEAR Intents)
    // Supports multiple swaps batched in one txid
    let bridge = null;
    let bridges = [];
    try {
      const explorerUrls = {
        eth: 'https://etherscan.io/tx/',
        sol: 'https://solscan.io/tx/',
        btc: 'https://mempool.space/tx/',
        near: 'https://nearblocks.io/txns/',
        doge: 'https://dogechain.info/tx/',
        xrp: 'https://xrpscan.com/tx/',
        arb: 'https://arbiscan.io/tx/',
        base: 'https://basescan.org/tx/',
        pol: 'https://polygonscan.com/tx/',
        avax: 'https://snowtrace.io/tx/',
        bsc: 'https://bscscan.com/tx/',
        op: 'https://optimistic.etherscan.io/tx/',
        tron: 'https://tronscan.org/#/transaction/',
      };

      for (const b of bridgeResult.rows) {
        const isInflow = b.direction === 'inflow';
        const otherChain = isInflow ? b.source_chain : b.dest_chain;
        const otherToken = isInflow ? b.source_token : b.dest_token;
        const otherAmount = isInflow ? parseFloat(b.source_amount) : parseFloat(b.dest_amount);
        const otherAmountUsd = isInflow ? parseFloat(b.source_amount_usd) : parseFloat(b.dest_amount_usd);
        const zecAmount = isInflow ? parseFloat(b.dest_amount) : parseFloat(b.source_amount);
        const otherHashes = isInflow ? (b.source_tx_hashes || []) : (b.dest_tx_hashes || []);
        const otherHash = otherHashes.length > 0 ? otherHashes[0] : null;

        bridges.push({
          direction: isInflow ? 'entry' : 'exit',
          sourceChain: isInflow ? otherChain : 'zec',
          sourceToken: isInflow ? otherToken : 'ZEC',
          sourceAmount: isInflow ? otherAmount : null,
          destChain: isInflow ? 'zec' : otherChain,
          destToken: isInflow ? 'ZEC' : otherToken,
          destAmount: isInflow ? null : otherAmount,
          otherChain,
          otherToken,
          otherAmount,
          otherAmountUsd,
          otherTxHash: otherHash,
          explorerUrl: otherHash && explorerUrls[otherChain]
            ? explorerUrls[otherChain] + otherHash
            : null,
          swapTimestamp: b.swap_created_at,
          zecAmount,
          zecAddress: b.zec_address,
        });
      }
      if (bridges.length > 0) bridge = bridges[0];
    } catch (bridgeErr) {
      logSafeError('❌ [TX] Bridge lookup error:', bridgeErr);
    }

    // Coinbase data for coinbase transactions
    let coinbaseHex = null;
    let coinbaseText = null;
    if (tx.is_coinbase) {
      try {
        const cbResult = await deps.pool.query(
          'SELECT coinbase_hex FROM blocks WHERE hash = $1',
          [tx.block_hash]
        );
        if (cbResult.rows[0]?.coinbase_hex) {
          coinbaseHex = cbResult.rows[0].coinbase_hex;
          coinbaseText = decodeCoinbaseText(coinbaseHex);
        }
      } catch (e) { /* non-critical */ }
    }

    // ZIP-318 compliance for migrations (Orchard/Sapling → Ironwood)
    let zip318 = null;
    const isMigrationTx = tx.has_ironwood && !tx.is_coinbase
      && (parseFloat(tx.value_balance_ironwood) || 0) < 0
      && ((parseFloat(tx.value_balance_orchard) || 0) > 0 || (parseFloat(tx.value_balance_sapling) || 0) > 0);
    if (isMigrationTx) {
      const iwActions = parseInt(tx.ironwood_actions) || 0;
      const oActions = parseInt(tx.orchard_actions) || 0;
      const ironwoodInZec = Math.abs(parseFloat(tx.value_balance_ironwood) || 0) / 1e8;

      const COMMON_DENOMS = [
        0.001, 0.002, 0.005,
        0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
        1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000,
      ];
      let matchedDenomination = null;
      for (const d of COMMON_DENOMS) {
        if (Math.abs(ironwoodInZec - d) / d <= 0.001) { matchedDenomination = d; break; }
      }

      const isDenominated = matchedDenomination !== null;
      const correctActions = oActions === 2 && iwActions === 1;

      let anchorCompliant = false;
      if (tx.orchard_anchor) {
        try {
          const anchorCheck = await deps.pool.query(
            `SELECT 1 FROM blocks WHERE final_orchard_root = $1 AND height % 144 = 0 LIMIT 1`,
            [tx.orchard_anchor]
          );
          anchorCompliant = anchorCheck.rows.length > 0;
        } catch (e) { /* non-critical */ }
      }

      const checks = (isDenominated ? 1 : 0) + (correctActions ? 1 : 0) + (anchorCompliant ? 1 : 0);
      zip318 = {
        compliant: checks === 3,
        checks,
        denomination: isDenominated,
        matchedDenomination,
        correctActions,
        orchardActions: oActions,
        ironwoodActions: iwActions,
        anchorCompliant,
      };
    }

    const status = tx.is_canonical ? 'confirmed' : (tx.block_hash ? 'stale' : 'unknown');

    // Lifecycle-aware caching, additive only (header, not body):
    //  - 'unknown' (no recorded block at all) must never be cached — nothing
    //    to key a reorg-safe revalidation on.
    //  - 'stale' (orphaned) blocks rarely change again but can be corrected
    //    by a later reorg-monitor pass; cache briefly.
    //  - 'confirmed' with few confirmations still carries reorg risk; once a
    //    tx is buried deep it is safe to cache aggressively.
    let cacheControl;
    if (status === 'unknown') {
      cacheControl = 'no-store';
    } else if (status === 'stale') {
      cacheControl = 'public, s-maxage=30, stale-while-revalidate=300';
    } else if (confirmations >= 100) {
      // Confirmed transactions can still become stale after an exceptional
      // deep reorg. Cache them for a long time, but never mark them immutable.
      cacheControl = 'public, s-maxage=3600, stale-while-revalidate=86400';
    } else {
      cacheControl = 'public, s-maxage=15, stale-while-revalidate=120';
    }
    res.set('Cache-Control', cacheControl);

    res.json({
      txid: tx.txid,
      blockHeight: tx.block_height,
      // Preserve the transaction's recorded block identity across reorgs.
      blockHash: tx.block_hash,
      blockTime: tx.block_time,
      confirmations,
      isCanonical: tx.is_canonical,
      status,
      size: tx.size,
      version: tx.version,
      locktime: tx.locktime,
      expiryHeight: tx.expiry_height ? parseInt(tx.expiry_height) : null,
      valueBalance: totalValueBalance,
      valueBalanceZat: tx.value_balance == null ? null : String(tx.value_balance),
      valueBalanceSapling,
      valueBalanceSaplingZat: tx.value_balance_sapling == null ? null : String(tx.value_balance_sapling),
      valueBalanceOrchard,
      valueBalanceOrchardZat: tx.value_balance_orchard == null ? null : String(tx.value_balance_orchard),
      valueBalanceIronwood,
      valueBalanceIronwoodZat: tx.value_balance_ironwood == null ? null : String(tx.value_balance_ironwood),
      fee,
      feeZat: tx.fee == null ? null : String(tx.fee),
      totalInput,
      totalInputZat: tx.total_input == null ? null : String(tx.total_input),
      totalOutput,
      totalOutputZat: tx.total_output == null ? null : String(tx.total_output),
      isCoinbase: tx.is_coinbase || false,
      hasSapling: tx.has_sapling,
      hasOrchard: tx.has_orchard,
      hasIronwood: tx.has_ironwood || false,
      hasSprout: tx.has_sprout,
      orchardActions: tx.orchard_actions || 0,
      ironwoodActions: tx.ironwood_actions || 0,
      saplingSpendCount: tx.sapling_spend_count || 0,
      saplingOutputCount: tx.sapling_output_count || 0,
      inputs: inputsResult.rows,
      outputs: outputsResult.rows,
      inputCount: inputsResult.rows.length,
      outputCount: outputsResult.rows.length,
      coinbaseHex,
      coinbaseText,
      bridge,
      bridges: bridges.length > 0 ? bridges : undefined,
      zip318,
      stakingAction: tx.staking_action_type ? {
        type: tx.staking_action_type,
        bondKey: tx.staking_bond_key,
        delegatee: tx.staking_delegatee,
        // Keep the legacy numeric field for existing consumers and expose the
        // exact integer contract under the singular `amountZat` name.
        amountZats: tx.staking_amount_zats == null ? null : Number(tx.staking_amount_zats),
        amountZat: tx.staking_amount_zats == null ? null : String(tx.staking_amount_zats),
        amountZec: tx.staking_amount_zats == null ? null : Number(tx.staking_amount_zats) / 1e8,
      } : null,
    });
  } catch (error) {
    logSafeError('Error fetching transaction:', error);
    res.status(500).json({ error: 'Failed to fetch transaction' });
  }
});

module.exports = router;
