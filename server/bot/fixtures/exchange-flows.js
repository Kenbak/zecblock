'use strict';

// Exchange-flow fixtures in the shape FLOW_ROWS returns. The deposit, sweep and
// withdrawal mirror real mainnet transactions (values exact, from
// /v1/transactions on 2026-11-22); the history behind them is synthetic and
// only exists so previews and tests have a 30-day sample to rank against.

const HYPERUNIT_DEPOSIT = 'b81e9166ad83c599ed70971b2bfd9f8814a9b87cc9a81f7c31ed8b0511c8c2c3';
const HYPERUNIT_SWEEP = 'be45cac5d65b11c0d0f565821197d8ed175a55202bb4546b12ecfd25e3648a24';
const KRAKEN_WITHDRAWAL = '3b8f3e205bb6dfa8ed26149f8953a0e6e8bd1116bd263c3b969dd54548d94b7e';

const row = (txid, time, side, entity, zat, extra = {}) => ({ txid, block_height: 3600000 + (time % 100000), block_time: time,
  is_coinbase: false, has_sprout: false, value_balance: '0', side, entity, zat: String(zat), unknown: 0, ...extra });

const rows = {
  // User t1ejN4… pays 602 ZEC to Hyperunit deposit address t1Tos7… with change to itself.
  hyperunitDeposit: (time = 1795371364) => [
    row(HYPERUNIT_DEPOSIT, time, 'in', null, '134299980000'),
    row(HYPERUNIT_DEPOSIT, time, 'out', null, '74099970000'),
    row(HYPERUNIT_DEPOSIT, time, 'out', 'hyperunit', '60200000000'),
  ],
  // The deposit address sweeps into the Hyperunit hot wallet: internal.
  hyperunitSweep: (time = 1795378930) => [
    row(HYPERUNIT_SWEEP, time, 'in', 'hyperunit', '60200000000'),
    row(HYPERUNIT_SWEEP, time, 'out', 'hyperunit', '60199990000'),
  ],
  // Kraken hot wallet: 85 inputs, 4 × 5,000 ZEC to an unlabelled address, change back to itself.
  krakenWithdrawal: (time = 1795211090) => [
    row(KRAKEN_WITHDRAWAL, time, 'in', 'kraken', '2014865455163'),
    row(KRAKEN_WITHDRAWAL, time, 'out', null, '2000000000000'),
    row(KRAKEN_WITHDRAWAL, time, 'out', 'kraken', '14864383239'),
  ],
  // Address poisoning: a lookalike address sends 0 ZEC to an exchange wallet.
  poisoning: (time = 1795371400) => [
    row('d'.repeat(64), time, 'in', null, '10000'),
    row('d'.repeat(64), time, 'out', 'binance', '0'),
  ],
};

/** Deterministic history: `count` events per direction spread over the 30 days before `end`, log-spread 1–398 ZEC (mostly small, like real exchange traffic). */
function history(end, count = 400) {
  const events = [];
  for (let i = 0; i < count; i++) {
    for (const direction of ['deposit', 'withdrawal']) {
      const u = ((i * 0.6180339887 + (direction === 'deposit' ? 0.13 : 0.71)) % 1);
      const zec = Math.max(1, Math.floor(10 ** (2.6 * u)));
      events.push({ txid: (direction === 'deposit' ? 'a' : 'b') + String(i).padStart(63, '0'), entity: ['binance', 'kraken', 'coinbase', 'hyperunit'][i % 4],
        direction, amountZat: String(zec * 1e8), blockHeight: 3500000 + i, blockTime: end - 1 - Math.floor(i * 30 * 86400 / count), counterparty: 'transparent' });
    }
  }
  return events.sort((a, b) => a.blockTime - b.blockTime);
}

module.exports = { HYPERUNIT_DEPOSIT, HYPERUNIT_SWEEP, KRAKEN_WITHDRAWAL, rows, history };
