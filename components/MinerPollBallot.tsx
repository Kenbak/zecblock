import Link from 'next/link';
import { MINER_POLL, isInMinerPollWindow, type MinerPollAnswer } from '@/lib/miner-poll';

export const MINER_POLL_PATH = '/governance/nu7-1-miner-poll';

const ANSWER: Record<MinerPollAnswer, { short: string; label: string; className: string }> = {
  '1': { short: 'S', label: 'Support', className: 'border-cipher-green/40 bg-cipher-green/10 text-cipher-green' },
  '2': { short: 'O', label: 'Oppose', className: 'border-danger/40 bg-danger/10 text-danger' },
  '3': { short: 'A', label: 'Abstain', className: 'border-cipher-border bg-glass-3 text-secondary' },
  '-': { short: '–', label: 'No answer', className: 'border-dashed border-cipher-border text-muted' },
};

export function answerLabel(answer: MinerPollAnswer): string {
  return ANSWER[answer].label;
}

/** Five answer chips, one per question, in ballot order. */
export function BallotChips({ answers }: { answers: readonly MinerPollAnswer[] }) {
  return (
    <span className="inline-flex gap-1" role="list" aria-label="Ballot answers">
      {answers.map((answer, i) => (
        <abbr
          key={i}
          role="listitem"
          title={`Q${i + 1} ${MINER_POLL.questions[i].short}: ${ANSWER[answer].label}`}
          className={`inline-flex h-5 w-5 items-center justify-center rounded border font-mono text-caption font-semibold no-underline ${ANSWER[answer].className}`}
        >
          {ANSWER[answer].short}
        </abbr>
      ))}
    </span>
  );
}

/** A coinbase ballot, labelled with whether this block's height counts in the poll. */
export function MinerPollBallotBadge({ answers, height }: { answers: readonly MinerPollAnswer[]; height?: number | string | null }) {
  // v1 serialises heights as decimal strings.
  const h = height == null || height === '' ? NaN : Number(height);
  const note = !Number.isSafeInteger(h) ? null
    : isInMinerPollWindow(h) ? 'counts'
      : h < MINER_POLL.startHeight ? 'before voting opens' : 'after voting closed';
  return (
    <Link
      href={MINER_POLL_PATH}
      prefetch={false}
      className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-brand-gold/25 bg-brand-gold/5 px-2 py-1 text-xs text-secondary transition-colors hover:border-brand-gold/50"
    >
      <span className="font-medium text-brand-gold">NU7.1 miner ballot</span>
      <BallotChips answers={answers} />
      {note && <span className="text-muted">{note}</span>}
    </Link>
  );
}
