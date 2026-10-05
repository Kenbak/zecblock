/**
 * Address Routes
 *
 * Handles address-related endpoints:
 * - GET /api/labels - Get all official address labels
 * - GET /api/label/:address - Get label for a specific address
 * - GET /api/address/:address - Get address details and transactions
 */

const express = require('express');
const { networkName } = require('../lib/network-features');
const { AddressPaginationError, withAddressSnapshot, prepareAddressPage, addressPageSql, addressPagination } = require('../lib/address-pagination');
const { getFirstFunding } = require('../lib/address-first-funding');
const router = express.Router();
const { validate } = require('../validation');
const { applyListCacheHeaders, createListCache } = require('../list-cache');
const { parseSafeListPagination, offsetExceededError } = require('../lib/pagination');
const { logSafeError } = require('../lib/safe-log');
const {
  isValidBase58CheckAddress,
  isValidSaplingAddress,
  isValidUnifiedAddress,
} = require('../lib/zcash-address');

const disabledListCache = createListCache({ enabled: false });

// addresses.balance>0 can grow to a large row count; an unbounded OFFSET
// walks and discards every row before it. There is no cursor alternative
// for rich-list today, so deep requests are rejected outright rather than
// silently returning a different page than requested.
const MAX_RICH_LIST_OFFSET = 100_000;

function isCanonicalIntegerQuery(value) {
  if (value === undefined) return true;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return false;
  return Number.isSafeInteger(Number.parseInt(value, 10));
}

function hasConsistentAddressSummary(summary) {
  try {
    const balance = BigInt(summary.balance);
    const totalReceived = BigInt(summary.total_received);
    const totalSent = BigInt(summary.total_sent);
    const txCount = BigInt(summary.tx_count);

    return balance >= 0n
      && totalReceived >= 0n
      && totalSent >= 0n
      && txCount >= 0n
      && totalReceived >= totalSent
      && balance === totalReceived - totalSent;
  } catch {
    return false;
  }
}

// Dependencies injected via app.locals
let pool;
let listCache;
let chainTip;

// Middleware to inject dependencies
router.use((req, res, next) => {
  pool = req.app.locals.pool;
  listCache = req.app.locals.listCache || disabledListCache;
  chainTip = req.app.locals.chainTip || { height: 0, hash: '' };
  next();
});

/**
 * GET /api/labels
 * Get all official address labels from the database
 */
router.get('/api/labels', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT address, label, category, description, verified, logo_url
       FROM address_labels
       ORDER BY category, label`
    );

    res.json({
      labels: result.rows.map(row => ({
        address: row.address,
        label: row.label,
        category: row.category,
        description: row.description,
        verified: row.verified,
        logoUrl: row.logo_url,
      })),
      count: result.rows.length,
    });
  } catch (error) {
    logSafeError('Error fetching labels:', error);
    res.status(500).json({ error: 'Failed to fetch labels', labels: [] });
  }
});

/**
 * GET /api/label/:address
 * Get label for a specific address
 */
router.get('/api/label/:address', async (req, res) => {
  try {
    const { address } = req.params;

    const result = await pool.query(
      `SELECT address, label, category, description, verified, logo_url
       FROM address_labels
       WHERE address = $1`,
      [address]
    );

    if (result.rows.length === 0) {
      return res.json({ label: null });
    }

    const row = result.rows[0];
    res.json({
      address: row.address,
      label: row.label,
      category: row.category,
      description: row.description,
      verified: row.verified,
      logoUrl: row.logo_url,
    });
  } catch (error) {
    logSafeError('Error fetching label:', error);
    res.status(500).json({ error: 'Failed to fetch label', label: null });
  }
});

/**
 * GET /api/rich-list
 * Get top addresses by balance with optional labels
 *
 * Query params:
 * - limit: Number of addresses (default 100, max 500)
 * - offset: Pagination offset (default 0)
 */
router.get('/api/rich-list', async (req, res) => {
  try {
    const { limit, offset, requestedOffset, offsetExceeded } = parseSafeListPagination(req.query, {
      defaultLimit: 100,
      maxLimit: 500,
      maxOffset: MAX_RICH_LIST_OFFSET,
    });

    if (offsetExceeded) {
      return res.status(400).json(offsetExceededError({
        requestedOffset,
        maxOffset: MAX_RICH_LIST_OFFSET,
      }));
    }

    const cacheable = isCanonicalIntegerQuery(req.query.limit)
      && isCanonicalIntegerQuery(req.query.offset);

    const cached = await listCache.getOrLoad({
      family: 'rich-list',
      params: { limit, offset, tipHeight: chainTip.height },
      freshTtlSeconds: 60,
      staleTtlSeconds: 600,
      cacheable,
      shouldCache: value => value?.success === true,
      load: async ({ measure }) => {
        const [listResult, countResult, concentrationResult] = await measure(
          'db_rich_list',
          () => Promise.all([
            pool.query(
              `SELECT a.address, a.balance, a.total_received, a.total_sent,
                      a.tx_count, a.first_seen, a.last_seen,
                      l.label, l.category, l.description, l.verified, l.logo_url
               FROM addresses a
               LEFT JOIN address_labels l ON a.address = l.address
               WHERE a.balance > 0
               ORDER BY a.balance DESC
               LIMIT $1 OFFSET $2`,
              [limit, offset]
            ),
            pool.query(`SELECT COUNT(*) FROM addresses WHERE balance > 0`),
            pool.query(
              `${networkName() === 'crosslink-testnet' ? `WITH direct_addressless AS (
                 SELECT COALESCE(SUM(o.value), 0) AS balance
                 FROM transaction_outputs o
                 WHERE o.address IS NULL AND o.value > 0
                   AND NOT EXISTS (
                     SELECT 1 FROM transaction_inputs i
                     WHERE i.prev_txid = o.txid AND i.prev_vout = o.vout_index
                   )
               ),` : `WITH direct_outputs AS (
                 SELECT txid, vout_index
                 FROM transparent_key_exposures
                 WHERE script_type IN ('pubkey', 'multisig')
                 GROUP BY txid, vout_index
               ),
               direct_addressless AS (
                 SELECT COALESCE(SUM(o.value), 0) AS balance
                 FROM direct_outputs d
                 JOIN transaction_outputs o
                   ON o.txid = d.txid AND o.vout_index = d.vout_index
                 WHERE o.address IS NULL
                   AND NOT EXISTS (
                     SELECT 1
                     FROM transaction_inputs i
                     WHERE i.prev_txid = d.txid AND i.prev_vout = d.vout_index
                   )
               ),
               `}
               address_concentration AS (
                 SELECT
                   (SELECT COALESCE(SUM(balance), 0) FROM (SELECT balance FROM addresses WHERE balance > 0 ORDER BY balance DESC LIMIT 10) t) AS top10,
                   (SELECT COALESCE(SUM(balance), 0) FROM (SELECT balance FROM addresses WHERE balance > 0 ORDER BY balance DESC LIMIT 100) t) AS top100,
                   COALESCE(SUM(balance), 0) AS total_addressed
                 FROM addresses
                 WHERE balance > 0
               )
               SELECT a.top10, a.top100, a.total_addressed,
                      d.balance AS direct_addressless,
                      a.total_addressed + d.balance AS total_transparent
               FROM address_concentration a
               CROSS JOIN direct_addressless d`
            ),
          ])
        );

        const totalAddresses = parseInt(countResult.rows[0].count);
        const {
          top10,
          top100,
          total_addressed,
          direct_addressless,
          total_transparent,
        } = concentrationResult.rows[0];
        const totalTransparent = parseFloat(total_transparent) / 1e8;

        return {
          success: true,
          addresses: listResult.rows.map((row, i) => ({
            rank: offset + i + 1,
            address: row.address,
            balance: parseFloat(row.balance) / 1e8,
            balanceZat: String(row.balance),
            totalReceived: parseFloat(row.total_received) / 1e8,
            totalReceivedZat: String(row.total_received),
            totalSent: parseFloat(row.total_sent) / 1e8,
            totalSentZat: String(row.total_sent),
            txCount: parseInt(row.tx_count),
            firstSeen: row.first_seen,
            lastSeen: row.last_seen,
            label: row.label || null,
            category: row.category || null,
            description: row.description || null,
            verified: row.verified || false,
            logoUrl: row.logo_url || null,
          })),
          pagination: {
            total: totalAddresses,
            limit,
            offset,
            totalPages: Math.ceil(totalAddresses / limit),
            page: Math.floor(offset / limit) + 1,
            hasNext: offset + limit < totalAddresses,
            hasPrev: offset > 0,
          },
          concentration: {
            top10: parseFloat(top10) / 1e8,
            top10Zat: String(top10),
            top100: parseFloat(top100) / 1e8,
            top100Zat: String(top100),
            totalTransparent: totalTransparent,
            totalTransparentZat: String(total_transparent),
            totalAddressed: parseFloat(total_addressed) / 1e8,
            totalAddressedZat: String(total_addressed),
            directAddressless: parseFloat(direct_addressless) / 1e8,
            directAddresslessZat: String(direct_addressless),
            top10Pct: totalTransparent > 0 ? (parseFloat(top10) / 1e8 / totalTransparent) * 100 : 0,
            top100Pct: totalTransparent > 0 ? (parseFloat(top100) / 1e8 / totalTransparent) * 100 : 0,
          },
        };
      },
    });

    applyListCacheHeaders(res, cached);
    res.json(cached.value);
  } catch (error) {
    logSafeError('Error fetching rich list:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch rich list' });
  }
});

/**
 * GET /api/address/:address
 * Get address details including balance and transactions
 *
 * Query params:
 * - page: Page number (1-based, default 1)
 * - limit: Transactions per page (default 25, max 100)
 *
 * - cursor: Opaque signed snapshot cursor from pagination (Next/Previous/Last)
 * Numeric page URLs near either end remain supported; deep traversal uses cursors.
 */
router.get('/api/address/:address', validate('addressById'), async (req, res) => {
  try {
    const { address } = req.params;
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 25);

    // Unified addresses can contain transparent and/or shielded receivers.
    // Their receiver composition and activity cannot be inferred from the
    // prefix, so do not claim they are fully shielded.
    if (address.startsWith('u')) {
      if (!isValidUnifiedAddress(address)) {
        return res.status(404).json({ error: 'Invalid unified address' });
      }
      return res.status(200).json({
        address,
        type: 'unified',
        balance: null,
        transactions: [],
        note: 'Unified address - receiver composition, balance, and transaction history are not publicly inferable from the address alone'
      });
    }

    // Check if it's a shielded-only address family.
    const isShielded = address.startsWith('zs') ||
                       address.startsWith('zc') ||
                       address.startsWith('ztestsapling');

    if (isShielded) {
      if ((address.startsWith('zs') || address.startsWith('ztestsapling'))
          && !isValidSaplingAddress(address)) {
        return res.status(404).json({ error: 'Invalid shielded address' });
      }
      if (address.startsWith('zc') && !isValidBase58CheckAddress(address)) {
        return res.status(404).json({ error: 'Invalid shielded address' });
      }
      const addressType = 'shielded';
      const noteMessage = 'Shielded address - balance and transactions are private';

      return res.status(200).json({
        address,
        type: addressType,
        balance: null,
        transactions: [],
        note: noteMessage
      });
    }

    const isTransparent = /^(t1|t3|tm|t2)/.test(address);
    if (!isTransparent || !isValidBase58CheckAddress(address)) {
      return res.status(404).json({ error: 'Invalid transparent address' });
    }

    const payload = await withAddressSnapshot(pool, async query => {
      // Summary, tip and transaction data share one database snapshot.
      const summaryResult = await query(
        `SELECT
          address,
          total_received,
          total_sent,
          balance,
          tx_count,
          first_seen,
          last_seen
        FROM addresses
        WHERE address = $1`,
        [address]
      );

      if (summaryResult.rows.length === 0) {
        // Check if this is a valid Zcash address format
        const isValidTransparent = /^t[13][a-zA-Z0-9]{32,34}$/.test(address) || // mainnet t1/t3
                                    /^tm[a-zA-Z0-9]{32,34}$/.test(address);      // testnet

        if (!isValidTransparent) {
          throw new AddressPaginationError('Invalid address format', 'ADDRESS_INVALID', 404);
        }

        // Address is valid but has no transactions yet
        return {
          address,
          type: 'transparent',
          balance: 0,
          totalReceived: 0,
          totalSent: 0,
          txCount: 0,
          firstSeen: null,
          lastSeen: null,
          transactions: [],
          pagination: {
            page: 1,
            limit,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
          note: 'This address has no transaction history yet.'
        };
      }

      const summary = summaryResult.rows[0];
      if (!hasConsistentAddressSummary(summary)) {
        // Do not include the address or query error details in logs.
        console.error('Address summary integrity check failed');
        throw new AddressPaginationError('Address data integrity check failed', 'ADDRESS_SUMMARY_INCONSISTENT', 500);
      }

      const totalTxCount = parseInt(summary.tx_count) || 0;
      const plan = await prepareAddressPage(query, { address, page, limit, total: totalTxCount, cursor: req.query.cursor });

      // Earliest inbound output — who first funded this address
      let firstFunding = null;
      await query('SAVEPOINT first_funding');
      try {
        const { rows: fundingRows } = await getFirstFunding(query, address);
        if (fundingRows[0]) {
          const row = fundingRows[0];
          firstFunding = {
            txid: row.txid,
            blockTime: parseInt(row.block_time),
            amountZec: parseFloat(row.amount_zat) / 1e8,
            funderAddress: row.funder_address || null,
            funderLabel: row.funder_label || null,
            isCoinbase: row.is_coinbase === true,
          };
        }
      } catch (fundingErr) {
        await query('ROLLBACK TO SAVEPOINT first_funding');
        logSafeError('Error fetching first funding for address:', fundingErr);
      }

      await query('RELEASE SAVEPOINT first_funding');
      const pageQuery = addressPageSql(plan);
      const txResult = await query(pageQuery.sql, pageQuery.params);
      const pagination = addressPagination(plan, txResult.rows);

      const transactions = txResult.rows.map(tx => {
        const netChange = parseFloat(tx.output_value) - parseFloat(tx.input_value);
        const isReceiving = netChange > 0;

        let counterparty = null;
        if (isReceiving && tx.sender_addresses && tx.sender_addresses.length > 0) {
          counterparty = tx.sender_addresses[0];
        } else if (!isReceiving && tx.recipient_addresses && tx.recipient_addresses.length > 0) {
          counterparty = tx.recipient_addresses[0];
        }

        return {
          txid: tx.txid,
          blockHeight: tx.block_height,
          blockTime: tx.block_time,
          size: tx.size,
          txIndex: tx.tx_index,
          hasSapling: tx.has_sapling,
          hasOrchard: tx.has_orchard,
          hasIronwood: tx.has_ironwood,
          inputValue: parseFloat(tx.input_value),
          outputValue: parseFloat(tx.output_value),
          netChange,
          counterparty,
          senderCount: tx.sender_addresses?.length || 0,
          recipientCount: tx.recipient_addresses?.length || 0,
        };
      });

      return {
        address: summary.address,
        balance: parseFloat(summary.balance),
        balanceZat: String(summary.balance),
        totalReceived: parseFloat(summary.total_received),
        totalReceivedZat: String(summary.total_received),
        totalSent: parseFloat(summary.total_sent),
        totalSentZat: String(summary.total_sent),
        txCount: totalTxCount,
        firstSeen: summary.first_seen,
        lastSeen: summary.last_seen,
        firstFunding,
        transactions,
        pagination,
      };
    });
    res.json(payload);
  } catch (error) {
    if (error instanceof AddressPaginationError) return res.status(error.status).json({ error: error.publicMessage, code: error.code });
    logSafeError('Error fetching address:', error);
    res.status(500).json({ error: 'Failed to fetch address' });
  }
});

/**
 * GET /api/address/:address/graph
 * Bounded entity graph neighborhood for a transparent address.
 *
 * Returns:
 * - cluster: entity cluster info from common-input analysis (or null)
 * - peers: cluster members (all if cluster ≤64 addresses, else top 20 by balance)
 * - counterparties: top addresses by value exchanged in recent txs (max 20)
 *
 * Counterparties are sampled from the 300 most recent transactions to keep
 * the query bounded for high-activity addresses (exchanges, pools).
 */
router.get('/api/address/:address/graph', validate('addressGraph'), async (req, res) => {
  try {
    const { address } = req.params;

    // Graph analysis only applies to transparent addresses
    if (!/^t[13m]/.test(address)) {
      return res.json({
        success: true,
        address,
        cluster: null,
        peers: [],
        counterparties: [],
        note: 'Entity graphs are only available for transparent addresses.',
      });
    }

    const cached = await listCache.getOrLoad({
      family: 'address-graph',
      params: { address },
      freshTtlSeconds: 300,
      staleTtlSeconds: 1800,
      cacheable: true,
      shouldCache: value => value?.success === true,
      load: async () => {
        // 1. Cluster membership
        const { rows: clusterRows } = await pool.query(
          `SELECT c.cluster_id, m.member_count
           FROM address_clusters c
           JOIN address_cluster_meta m ON m.cluster_id = c.cluster_id
           WHERE c.address = $1`,
          [address]
        );
        const cluster = clusterRows[0] || null;
        const memberCount = cluster ? parseInt(cluster.member_count) : 0;
        const FULL_CLUSTER_GRAPH_LIMIT = 64;
        const showFullCluster = memberCount > 0 && memberCount <= FULL_CLUSTER_GRAPH_LIMIT;

        // 2. Cluster peers — all members for small clusters, else top 20 by balance
        let peers = [];
        if (cluster) {
          const peerSql = `SELECT c.address, a.balance, a.tx_count, l.label, l.category
             FROM address_clusters c
             JOIN addresses a ON a.address = c.address
             LEFT JOIN address_labels l ON l.address = c.address
             WHERE c.cluster_id = $1 AND c.address != $2
             ORDER BY a.balance DESC NULLS LAST
             ${showFullCluster ? '' : 'LIMIT 20'}`;
          const { rows } = await pool.query(peerSql, [cluster.cluster_id, address]);
          peers = rows.map(r => ({
            address: r.address,
            balanceZec: parseFloat(r.balance) / 1e8,
            txCount: parseInt(r.tx_count) || 0,
            label: r.label || null,
            category: r.category || null,
          }));
        }

        // 3. Top counterparties from recent transactions (bounded sample)
        const { rows: cpRows } = await pool.query(
          `WITH recent_txs AS (
            SELECT txid, COALESCE(value_in, 0) AS my_in, COALESCE(value_out, 0) AS my_out
            FROM address_transactions
            WHERE address = $1
            ORDER BY block_height DESC, tx_index DESC
            LIMIT 300
          ),
          sent AS (
            SELECT o.address AS cp, SUM(o.value) AS value, COUNT(DISTINCT o.txid) AS txs
            FROM recent_txs r
            JOIN transaction_outputs o ON o.txid = r.txid
            WHERE r.my_in > 0 AND o.address IS NOT NULL AND o.address != $1
            GROUP BY o.address
          ),
          received AS (
            SELECT i.address AS cp, SUM(i.value) AS value, COUNT(DISTINCT i.txid) AS txs
            FROM recent_txs r
            JOIN transaction_inputs i ON i.txid = r.txid
            WHERE r.my_out > 0 AND r.my_in = 0 AND i.address IS NOT NULL AND i.address != $1
            GROUP BY i.address
          )
          SELECT COALESCE(s.cp, rc.cp) AS address,
                 COALESCE(s.value, 0) AS sent_value,
                 COALESCE(rc.value, 0) AS received_value,
                 COALESCE(s.txs, 0) + COALESCE(rc.txs, 0) AS tx_count
          FROM sent s
          FULL OUTER JOIN received rc ON s.cp = rc.cp
          ORDER BY COALESCE(s.value, 0) + COALESCE(rc.value, 0) DESC
          LIMIT 20`,
          [address]
        );

        // 4. Enrich counterparties with labels and cluster membership
        const cpAddresses = cpRows.map(r => r.address);
        let labelMap = new Map();
        let cpClusterMap = new Map();
        if (cpAddresses.length > 0) {
          const [labelsRes, clustersRes] = await Promise.all([
            pool.query(
              `SELECT address, label, category FROM address_labels WHERE address = ANY($1)`,
              [cpAddresses]
            ),
            pool.query(
              `SELECT ac.address, ac.cluster_id, m.member_count
               FROM address_clusters ac
               JOIN address_cluster_meta m ON m.cluster_id = ac.cluster_id
               WHERE ac.address = ANY($1)`,
              [cpAddresses]
            ),
          ]);
          labelMap = new Map(labelsRes.rows.map(r => [r.address, r]));
          cpClusterMap = new Map(clustersRes.rows.map(r => [r.address, r]));
        }

        const counterparties = cpRows.map(r => {
          const labelInfo = labelMap.get(r.address);
          const clusterInfo = cpClusterMap.get(r.address);
          return {
            address: r.address,
            sentZec: parseFloat(r.sent_value) / 1e8,
            receivedZec: parseFloat(r.received_value) / 1e8,
            txCount: parseInt(r.tx_count) || 0,
            label: labelInfo?.label || null,
            category: labelInfo?.category || null,
            clusterId: clusterInfo ? parseInt(clusterInfo.cluster_id) : null,
            clusterSize: clusterInfo ? parseInt(clusterInfo.member_count) : null,
            sameEntity: cluster && clusterInfo
              ? parseInt(clusterInfo.cluster_id) === parseInt(cluster.cluster_id)
              : false,
          };
        });

        return {
          success: true,
          address,
          cluster: cluster
            ? { clusterId: parseInt(cluster.cluster_id), memberCount: parseInt(cluster.member_count) }
            : null,
          peers,
          peerSelection: showFullCluster ? 'full' : 'top_by_balance',
          counterparties,
          sampledRecentTxs: 300,
        };
      },
    });

    applyListCacheHeaders(res, cached);
    res.json(cached.value);
  } catch (error) {
    logSafeError('Error fetching address graph:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch address graph' });
  }
});

module.exports = router;
