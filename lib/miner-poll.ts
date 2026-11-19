/**
 * NU7.1 miner sentiment poll (pilot), from the Zcash Foundation poll definition
 * and the draft ZIP "Miner Sentiment Polling" (zcash/zips#1421, f0ef6117).
 * Heights are authoritative; times are the organizer's 25-second estimates.
 *
 * Keep the ballot parser in step with server/api/lib/miner-poll.js; the
 * miner-poll test runs both over the same vectors.
 */

export type MinerPollAnswer = '1' | '2' | '3' | '-';

export const MINER_POLL = {
  electionId: 'nu7-1',
  startHeight: 3_591_200,
  endHeight: 3_629_650,
  estimatedStart: '2026-11-20T00:00:00Z',
  estimatedEnd: '2026-12-01T02:59:00Z',
  options: ['Support', 'Oppose', 'Abstain'],
  // Verbatim from the ZCAP NU7.1 poll, in ballot order.
  questions: [
    { short: 'Wind down ZCG', text: 'Do you support the Wind Down Zcash Community Grants proposal?' },
    { short: 'Future Dev & Legal Defense Fund', text: 'Do you support the Future Dev and Legal Defense Fund proposal?' },
    { short: 'Zcash Adoption Pool (ZAP)', text: 'Do you support the Zcash Adoption Pool (ZAP) proposal?' },
    { short: 'Keep ZCG as is', text: 'Do you support maintaining Zcash Community Grants’ existing funding and operations?' },
    { short: '20-second blocks', text: 'Assuming it can be done safely in a network upgrade, do you support reducing Zcash’s target block time from 25 seconds to 20 seconds?' },
  ],
  links: {
    announcement: 'https://forum.zcashcommunity.com/t/miner-sentiment-poll-pilot-nu7-1/59465',
    definition: 'https://hackmd.io/@upbqdn/nu7-1-miner-poll',
    zip: 'https://github.com/zcash/zips/pull/1421',
    builder: 'https://upbqdn.github.io/miner-poll/',
    officialTally: 'https://miner-poll.zfnd.org/',
    zcapPoll: 'https://forum.zcashcommunity.com/t/zcap-poll-now-open-nu7-1/59366',
  },
} as const;

export const MINER_POLL_BLOCKS = MINER_POLL.endHeight - MINER_POLL.startHeight + 1;

const PREFIX = Array.from('zpoll:nu7-1:', (char) => char.charCodeAt(0));
const QUESTION_COUNT = 5;
const OPTION_COUNT = 3;

function isAnswerByte(byte: number): boolean {
  return byte === 0x2d || byte === 0x28 || byte === 0x29 // - ( )
    || (byte >= 0x31 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a);
}

function optionValue(byte: number): number {
  return byte <= 0x39 ? byte - 0x30 : byte - 0x41 + 10;
}

/** Validate one answer string for this single-choice, 3-option, 5-question poll. */
function parseAnswers(bytes: Uint8Array, start: number, end: number): MinerPollAnswer[] | null {
  const answers: MinerPollAnswer[] = [];
  for (let i = start; i < end; i += 1) {
    const byte = bytes[i];
    // Parenthesised multi-selections are well-formed syntax but invalid for single-choice questions.
    if (byte === 0x28 || byte === 0x29) return null;
    if (byte === 0x2d) answers.push('-');
    else if (optionValue(byte) <= OPTION_COUNT) answers.push(String.fromCharCode(byte) as MinerPollAnswer);
    else return null;
  }
  if (answers.length !== QUESTION_COUNT || answers.every((answer) => answer === '-')) return null;
  return answers;
}

/**
 * First valid NU7.1 ballot in coinbase Miner Data (script bytes after the height,
 * which is what coinbase_hex stores), searched as raw bytes. null when none.
 */
export function parseMinerPollBallot(hex: string | null | undefined): MinerPollAnswer[] | null {
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
  outer: for (let at = 0; at + PREFIX.length <= bytes.length; at += 1) {
    for (let k = 0; k < PREFIX.length; k += 1) if (bytes[at + k] !== PREFIX[k]) continue outer;
    const start = at + PREFIX.length;
    let end = start;
    while (end < bytes.length && isAnswerByte(bytes[end])) end += 1;
    const answers = parseAnswers(bytes, start, end);
    if (answers) return answers;
  }
  return null;
}

export function isInMinerPollWindow(height: number | null | undefined): boolean {
  return typeof height === 'number' && height >= MINER_POLL.startHeight && height <= MINER_POLL.endHeight;
}
