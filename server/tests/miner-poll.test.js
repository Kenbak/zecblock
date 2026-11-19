const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const server = require('../api/lib/miner-poll');

const code = ts.transpileModule(fs.readFileSync('lib/miner-poll.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', code)(mod, mod.exports);
const web = mod.exports;

const hex = (text) => Buffer.from(text, 'latin1').toString('hex');
const push = (text) => Buffer.concat([Buffer.from([text.length]), Buffer.from(text, 'latin1')]).toString('hex');

// [miner data hex, expected answers or null, reason]
const VECTORS = [
  [hex('zpoll:nu7-1:12-31/'), ['1', '2', '-', '3', '1'], 'terminated ballot'],
  [push('/MyPool/ zpoll:nu7-1:33333/'), ['3', '3', '3', '3', '3'], 'Zebra extra_coinbase_data after pool tag'],
  ['04f09f8cb8' + push('zpoll:nu7-1:1----'), ['1', '-', '-', '-', '-'], 'unterminated at end of data'],
  [hex('zpoll:nu7-1:1---- more'), ['1', '-', '-', '-', '-'], 'ends at first non-answer byte'],
  [hex('zpoll:nu7-1:12312') + '00', ['1', '2', '3', '1', '2'], 'binary byte ends the answer string'],
  [hex('zpoll:nu7-1:123121/'), null, 'six answers'],
  [hex('zpoll:nu7-1:1231/'), null, 'four answers'],
  [hex('zpoll:nu7-1:-----/'), null, 'no question answered'],
  [hex('zpoll:nu7-1:12341/'), null, 'option 4 does not exist'],
  [hex('zpoll:nu7-1:1A--1/'), null, 'letter option 10 does not exist'],
  [hex('zpoll:nu7-1:(12)---/'), null, 'multi-selection on single-choice question'],
  [hex('zpoll:nu7-1:1----2'), null, 'trailing answer character invalidates an unterminated ballot'],
  [hex('ZPOLL:NU7-1:11111/'), null, 'prefix is case-sensitive'],
  [hex('zpoll:nu7-10:11111/'), null, 'different election'],
  [hex('zpoll:nu7-1:11111A/'), null, 'answer run includes A, so six answers'],
  [hex('zpoll:nu7-1:9----/ zpoll:nu7-1:2----/'), ['2', '-', '-', '-', '-'], 'first valid occurrence counts'],
  [hex('zpoll:nu7-1:1----/ zpoll:nu7-1:2----/'), ['1', '-', '-', '-', '-'], 'later ballots have no effect'],
  [hex('zpoll:nu7-1:zpoll:nu7-1:3----/'), ['3', '-', '-', '-', '-'], 'overlapping prefix search'],
  ['', null, 'empty'],
  [null, null, 'missing'],
  ['abc', null, 'odd hex'],
  ['04f09f8cb8102f4d696e6564206279204c75786f722f', null, 'ordinary pool tag'],
];

test('web and server parsers agree with the draft ZIP ballot rules', () => {
  for (const [input, expected, reason] of VECTORS) {
    assert.deepEqual(server.parseMinerPollBallot(input), expected, `server: ${reason}`);
    assert.deepEqual(web.parseMinerPollBallot(input), expected, `web: ${reason}`);
  }
  assert.deepEqual(web.parseMinerPollBallot(hex('zpoll:nu7-1:12-31/').toUpperCase()), ['1', '2', '-', '3', '1']);
});

test('web and server share the poll window', () => {
  assert.equal(web.MINER_POLL.startHeight, server.START_HEIGHT);
  assert.equal(web.MINER_POLL.endHeight, server.END_HEIGHT);
  assert.equal(web.MINER_POLL_BLOCKS, 38451);
  assert.equal(web.MINER_POLL.questions.length, server.QUESTION_COUNT);
  assert.equal(web.isInMinerPollWindow(3591199), false);
  assert.equal(web.isInMinerPollWindow(3591200), true);
  assert.equal(web.isInMinerPollWindow(3629650), true);
  assert.equal(web.isInMinerPollWindow(3629651), false);
});

const getPoolName = (address) => ({ tA: 'Pool A', tB: 'Pool B' })[address] || null;
const row = (height, address, data, shielded = false) => ({
  height: String(height), hash: `h${height}`, miner_address: address, coinbase_hex: data, has_shielded_coinbase: shielded,
});

test('tally counts one vote per block relative to every block in the window', () => {
  const rows = [
    row(3591199, 'tA', hex('zpoll:nu7-1:11111/')), // before the window
    row(3591200, 'tA', hex('zpoll:nu7-1:12-31/')),
    row(3591201, 'tA', hex('zpoll:nu7-1:22222/')),
    row(3591202, 'tB', hex('/B/')),
    row(3591203, null, '', true), // shielded coinbase, no script ballot
    row(3591204, null, hex('zpoll:nu7-1:3----/'), true),
  ];
  const t = server.tallyRows(rows, { tipHeight: 3591204, getPoolName });
  assert.equal(t.state, 'open');
  assert.equal(t.totalBlocks, 38451);
  assert.equal(t.observedBlocks, 5);
  assert.equal(t.expectedObservedBlocks, 5);
  assert.equal(t.blocksWithBallot, 3);
  assert.equal(t.memoUncheckedBlocks, 1);
  assert.deepEqual(t.questions[0].options.map(o => o.count), [1, 1, 1]);
  assert.deepEqual(t.questions[2].options.map(o => o.count), [0, 1, 0]);
  assert.equal(t.questions[2].unanswered, 38451 - 1);
  assert.equal(t.questions[0].options[0].pct, Math.round((1 / 38451) * 1e6) / 1e4);
  assert.deepEqual(t.pools.map(p => [p.pool, p.blocks, p.ballots, p.latest?.ballot ?? null]), [
    ['Pool A', 2, 2, '22222'],
    [null, 2, 1, '3----'], // unattributed sorts after named pools on ties
    ['Pool B', 1, 0, null],
  ]);
  assert.deepEqual(t.recentBallots.map(b => b.height), [3591204, 3591201, 3591200]);
});

test('tally lifecycle follows the 100-confirmation finality rule', () => {
  const state = (tipHeight) => server.tallyRows([], { tipHeight, getPoolName }).state;
  assert.equal(state(3591199), 'upcoming');
  assert.equal(state(3591200), 'open');
  assert.equal(state(3629650), 'confirming');
  assert.equal(state(3629748), 'confirming');
  assert.equal(state(3629749), 'final');
  assert.equal(server.tallyRows([], { tipHeight: 3591199, getPoolName }).expectedObservedBlocks, 0);
  assert.equal(server.tallyRows([], { tipHeight: 3700000, getPoolName }).expectedObservedBlocks, 38451);
});
