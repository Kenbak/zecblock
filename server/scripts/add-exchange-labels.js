#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'api', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const NEW_LABELS = [
  { address: 't1NV4euoqYjnutzS9Lr9VvjBD2LLNuXtXXZ', label: 'Coinbase', category: 'exchange', description: 'Coinbase hot wallet' },
  { address: 't1HwLQtvGCNfdpGpPUmK6MURTaW8Ujf6hU8', label: 'Coinbase', category: 'exchange', description: 'Coinbase hot wallet' },
  { address: 't1cByqDRogv9vb7fsYRq4PHgH43cpUxxWSz', label: 'Coinbase', category: 'exchange', description: 'Coinbase hot wallet' },
  { address: 't1cB2VWdTNV9eW37GQwkj2nvyMdGzECoaiw', label: 'Coinbase', category: 'exchange', description: 'Coinbase hot wallet' },
  { address: 't1aEbXVxdZasZjcXqYnKJD2N7s12y6Dqp3Z', label: 'Coinbase', category: 'exchange', description: 'Coinbase hot wallet' },
  { address: 't1MtYxFayfPrDmMUHDk7vV8bqD7z8MdbS4T', label: 'Coinbase', category: 'exchange', description: 'Coinbase hot wallet' },
  { address: 't1cyAGaYcwWMdsu8Spfm6zUVynSrLMpTY64', label: 'Coinbase Cold Wallet', category: 'exchange', description: 'Coinbase cold storage' },
  { address: 't1g42kALKk1ZkjNL6hcrW4oRLgUE7Hps7sm', label: 'Coinbase Cold Wallet', category: 'exchange', description: 'Coinbase cold storage' },
  { address: 't1RGtQw8T6pfxG9zJNP5U2dRfC7jggaVPjA', label: 'Coinbase Cold Wallet', category: 'exchange', description: 'Coinbase cold storage' },
  { address: 't1boLLzTf7ddKJoT7PpVUgqUaoPdDgxWzGc', label: 'Coinbase Cold Wallet', category: 'exchange', description: 'Coinbase cold storage' },
  { address: 't1bxF7oetZt2EqWDndzsisTCz4CJhmsjvzL', label: 'Coinbase Cold Wallet', category: 'exchange', description: 'Coinbase cold storage' },
  { address: 't1d2gBnDusuHU8gbbuNcY2xfDxoyQYqeHAv', label: 'Coinbase Cold Wallet', category: 'exchange', description: 'Coinbase cold storage' },
  { address: 't1gw1BUJoLS2SqTHAbE6ghj3dKeb8sEJPea', label: 'Coinbase Cold Wallet', category: 'exchange', description: 'Coinbase cold storage' },
  { address: 't1M64HCu4RhT5h5GJrWQL7WcMq6pzLdusWp', label: 'Coinbase Cold Wallet', category: 'exchange', description: 'Coinbase cold storage' },
  { address: 't1N8Q3EmVSo891V3LTaHijeBK4aMPE4HjGz', label: 'Coinbase Cold Wallet', category: 'exchange', description: 'Coinbase cold storage' },
  { address: 't1TDwC91tn1zny8EMhBDK2YWiGJ6TCEPjcS', label: 'Coinbase Cold Wallet', category: 'exchange', description: 'Coinbase cold storage' },
  { address: 't1ZtktN6KNQhHkuWXfhWnJEn99p1Gm4ZvQr', label: 'Coinbase Cold Wallet', category: 'exchange', description: 'Coinbase cold storage' },
  { address: 't1cKRdxdeqRFzLGiyHB2KnScMnPTMLBMpx2', label: 'Coinbase Cold Wallet', category: 'exchange', description: 'Coinbase cold storage' },
  { address: 't1eevo7Gz5KGdRR5w989Gx71yU1v4f4zRsX', label: 'Coinbase Prime Custody', category: 'exchange', description: 'Coinbase Prime institutional custody' },
  { address: 't1TocTvTDv6dX8CsCPL7JvxDC8PYChF6Vco', label: 'Coinbase Prime Custody', category: 'exchange', description: 'Coinbase Prime institutional custody' },
  { address: 't1ahNXYP7HFi3oJ8G26rjc9wWe5j4ryxxDL', label: 'Coinbase Prime Custody', category: 'exchange', description: 'Coinbase Prime institutional custody' },
  { address: 't1bd55vRgLcBpBxJQFHodH9wb8uTkym6dqc', label: 'Coinbase Prime Custody', category: 'exchange', description: 'Coinbase Prime institutional custody' },
  { address: 't1bjJUUESDGx57t146rd5oFdGkN6meUzg7S', label: 'Coinbase Prime Custody', category: 'exchange', description: 'Coinbase Prime institutional custody' },
  { address: 't1e1BVBDt3HTca4M8T9BWRApaBXKETDwWHz', label: 'Coinbase Prime Custody', category: 'exchange', description: 'Coinbase Prime institutional custody' },
  { address: 't1KuoWCFjRcbG7HKhtVARCgBv7PcxRfMmQd', label: 'Coinbase Prime Custody', category: 'exchange', description: 'Coinbase Prime institutional custody' },
  { address: 't3SvZNJqBJZQx5t7o4nDb9YP1VqJ2R2md88', label: 'Gemini Custody', category: 'exchange', description: 'Gemini institutional custody' },
  { address: 't3WGhZh3QV9Wgj9Xb6MrrhLZhpdyVa8QqLG', label: 'Gemini Custody', category: 'exchange', description: 'Gemini institutional custody' },
  { address: 't3LpoiUrHwkgpWA5KVY7LVAKzHKE9qox3Cj', label: 'Gemini Custody', category: 'exchange', description: 'Gemini institutional custody' },
  { address: 't1am2oFofYswreeeKTN2G2NLiuW9DQvR5DV', label: 'Grayscale Zcash Trust', category: 'exchange', description: 'Grayscale ZCSH fund custody' },
  { address: 't1ewXTvioNXo9fRZfjhnwnayQRYBJ5P4ebX', label: 'Grayscale Zcash Trust', category: 'exchange', description: 'Grayscale ZCSH fund custody' },
  { address: 't1d3xisKP7tfdmNtXr2oDqFToBn1K1gKjSi', label: 'Grayscale Zcash Trust', category: 'exchange', description: 'Grayscale ZCSH fund custody' },
  { address: 't1e2ivMHX7shmSBhBmGzWxeVN3F9MPvDk8R', label: 'Grayscale Zcash Trust', category: 'exchange', description: 'Grayscale ZCSH fund custody' },
  { address: 't1YjihZAttWbUQJYGgwhEvdGJLbTVcVGGez', label: 'Kucoin Cold Wallet', category: 'exchange', description: 'Kucoin cold storage' },
  { address: 't1Ku2KLyndDPsR32jwnrTMd3yvi9tfFP8ML', label: 'NEAR Intent Bridge', category: 'bridge', description: 'NEAR Intent cross-chain bridge' },

  // Binance
  { address: 't1RyCw14wRXrh3mp21uxgr9ynjem7cNUkMH', label: 'Binance Cold Wallet', category: 'exchange', description: 'Binance cold storage' },
  { address: 't1VxyLUKaK2tvj5iMRQagued6qpxPNvRkk7', label: 'Binance Cold Wallet', category: 'exchange', description: 'Binance cold storage' },
  { address: 't1XP8Pjju5eMYVfXiFNNjkjY8kt5ZLL4maJ', label: 'Binance', category: 'exchange', description: 'Binance hot wallet' },
  { address: 't1PaCpkUPc5cM6FH9jSfFTUVC3DgrYRgxfj', label: 'Binance', category: 'exchange', description: 'Binance hot wallet' },

  // Gemini
  { address: 't3aPMe94jMKyrgkbH5SSukimvdMFJ59EFhP', label: 'Gemini Cold Wallet', category: 'exchange', description: 'Gemini cold storage / custody' },
  { address: 't3hdTwzcVVGEqDdNKJTBfWvWyaFYNJv7KkA', label: 'Gemini Custody', category: 'exchange', description: 'Gemini institutional custody' },

  // Kraken
  { address: 't1g47g7wNA55q5PWYHWb6X5JxzhMqwaknjC', label: 'Kraken Hot Wallet', category: 'exchange', description: 'Kraken hot wallet' },
  { address: 't1e4VsqHKoMNbFp1RdnzXnedfher8gGA5kJ', label: 'Kraken Cold Wallet', category: 'exchange', description: 'Kraken cold storage' },
  { address: 't1QGQUHitjvXhZLJXgp7772CTEwAfYBRQXr', label: 'Kraken Deposit', category: 'exchange', description: 'Kraken deposit address' },

  // Gemini (additional)
  { address: 't3fygNh4yTRdhirVn6qu1QAtTUvZNFmGtbH', label: 'Gemini Custody', category: 'exchange', description: 'Gemini institutional custody' },

  // Binance (additional)
  { address: 't1PKBiv7mtzD9bNafYaqyxaENeiNDbpKxxQ', label: 'Binance Hot Wallet', category: 'exchange', description: 'Binance hot wallet (retired 2026-10-29; swept to t1RyCw cold storage after the Binance hack)' },

  // Binance post-hack wallet rotation (2026-10-29 to 2026-11-14). Evidence:
  // tx 570f54fe… co-spends t1RyCw/t1XP8/t1Rmpqyu/t1cLXe/t1M1j1 (common-input
  // ownership) into t1Vscjx + t1Szbu; t1gsBr was funded by t1RyCw in tx
  // 0baba4e4… (change to t1Rmpqyu) and since then only refills t1Szbu.
  { address: 't1SzbuFRuPa5upV6c9ZgKb9V7fxn2b8NAKg', label: 'Binance Hot Wallet', category: 'exchange', description: 'Binance hot wallet (active since 2026-10-31; refilled from Binance cold storage)' },
  { address: 't1VscjxQX2pvPjXCyUAFZxXMAU4BtKr9KGv', label: 'Binance Cold Wallet', category: 'exchange', description: 'Binance cold storage (received the 2026-11-01 cold-wallet consolidation)' },
  { address: 't1gsBrGZGMyDGZw2icGnMpVBuEGVWip5kH8', label: 'Binance Cold Wallet', category: 'exchange', description: 'Binance cold storage (funded by t1RyCw; refills the Binance hot wallet)' },
  { address: 't1Rmpqyu1jTXrjU8SEw6GmdRXdxCdPbmj6k', label: 'Binance Cold Wallet', category: 'exchange', description: 'Binance cold storage change address' },
  { address: 't1cLXeZt4mWKohk51N3Vhy7cWJtfz6fgANF', label: 'Binance Cold Wallet', category: 'exchange', description: 'Binance cold storage change address' },
  { address: 't1M1j1rPwUFGz8GDFrgi8rs9R3c7XtCH4Gv', label: 'Binance Cold Wallet', category: 'exchange', description: 'Binance cold storage change address' },

  // Coinbase
  { address: 't1L3mP83QYtcVc5r48sB4tYaPiA31z78WPw', label: 'Coinbase Cold Wallet', category: 'exchange', description: 'Coinbase cold storage' },

  // Other
  { address: 't3ev37Q2uL1sfTsiJQJiWJoFzQpDhmnUwYo', label: 'ZIP-271 Disbursement Multisig', category: 'foundation', description: 'Zcash protocol disbursement multisig (ZIP-271)' },
  { address: 't1KbKkQ7WisJF52sSepMjYokQJbkJCJ1i3C', label: 'Hyperunit Hot Wallet', category: 'exchange', description: 'Hyperunit exchange hot wallet' },

  // Funding streams (ZIP-214). These are not mining-pool addresses. The
  // separate deferred-development lockbox does not have an output address.
  { address: 't3cFfPt1Bcvgez9ZbMBFWeZsskxTkPzGCow', label: 'FPF / Zcash Community Grants', category: 'funding-stream', description: 'ZIP-214 FPF/ZCG funding-stream payout address (mainnet)' },
  { address: 't2HifwjUj9uyxr9bknR8LFuQbc98c3vkXtu', label: 'FPF / Zcash Community Grants (Testnet)', category: 'funding-stream', description: 'ZIP-214 FPF/ZCG funding-stream payout address (testnet)' },
];

// Hyperunit per-user deposit addresses: each one only ever sweeps its full
// balance into the Hyperunit hot wallet. Method and evidence are in the file.
const HYPERUNIT_DEPOSITS = require('./data/hyperunit-deposit-addresses.json');
for (const address of HYPERUNIT_DEPOSITS.addresses) {
  NEW_LABELS.push({
    address,
    label: HYPERUNIT_DEPOSITS.label,
    category: HYPERUNIT_DEPOSITS.category,
    description: 'Hyperunit deposit address (sweeps only into the Hyperunit hot wallet)',
  });
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let inserted = 0, updated = 0;

    for (const row of NEW_LABELS) {
      const result = await client.query(
        `INSERT INTO address_labels (address, label, category, description, verified, source)
         VALUES ($1, $2, $3, $4, true, 'community-verified')
         ON CONFLICT (address) DO UPDATE SET
           label = EXCLUDED.label, category = EXCLUDED.category,
           description = EXCLUDED.description, verified = EXCLUDED.verified,
           source = EXCLUDED.source, updated_at = NOW()
         RETURNING (xmax = 0) AS is_insert`,
        [row.address, row.label, row.category, row.description]
      );
      if (result.rows[0].is_insert) inserted++; else updated++;
    }

    await client.query('COMMIT');
    console.log(`Done: ${inserted} inserted, ${updated} updated`);

    const counts = await client.query(
      'SELECT category, COUNT(*) as count FROM address_labels GROUP BY category ORDER BY count DESC'
    );
    console.log('\nLabel counts by category:');
    for (const row of counts.rows) console.log(`  ${row.category}: ${row.count}`);
    console.log(`\nTotal: ${counts.rows.reduce((s, r) => s + parseInt(r.count), 0)} labels`);
    console.log('\nNext: node /root/cipherscan/server/jobs/refresh-turnstile.js --rebuild');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
