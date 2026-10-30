'use client';
import { useId, useRef, useState } from 'react';
import { answerReasons, answerRoute, feedbackLocale, sendAnswerFeedback, SHARED_ANSWER_LIMIT, SHARED_SQL_LIMIT, type AnswerReason, type AnswerRating, type AnswerVote } from '@/lib/ask/feedback';
import styles from './AskAnswerRating.module.css';

export const reasonLabels: Record<AnswerReason, string> = {
  wrong_number: 'Wrong number', misunderstood: 'Misunderstood the question', should_answer: 'Should have answered',
  refused_wrongly: 'Refused wrongly', unclear: 'Too vague or hard to read', chart_not_useful: 'Chart not useful',
};
const thumb = (down: boolean) => <svg className={down ? styles.down : undefined} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3Zm0 0 4-7a2 2 0 0 1 2.9 2.2L13 9h6a2 2 0 0 1 2 2.3l-1.3 7.5A2.6 2.6 0 0 1 17.1 21H7"/></svg>;
const newId = () => globalThis.crypto?.randomUUID?.() ?? '';

// One vote per answer. Each change replaces the previous vote, so counts move
// rather than add up. Text leaves the browser only while "share" is ticked.
export function AskAnswerRating({ route, template = false, locale, page, question, answer, sql }: { route?: string; template?: boolean; locale?: string; page: string; question: string; answer: string; sql?: string }) {
  const [rating, setRating] = useState<AnswerRating | null>(null);
  const [share, setShare] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'shared' | 'error'>('idle');
  const confirmed = useRef<AnswerRating | null>(null), sharedSent = useRef(false), shareId = useRef(''), queue = useRef(Promise.resolve());
  const id = useId();
  const submit = (next: AnswerRating, nextShare: boolean) => {
    const previous = { rating, share };
    setRating(next); setShare(nextShare); setStatus('saving');
    queue.current = queue.current.then(async () => {
      if (nextShare && !shareId.current) shareId.current = newId();
      const withdraw = !nextShare && sharedSent.current;
      try {
        const result = await sendAnswerFeedback({
          ...next, route: answerRoute(route), template, locale: feedbackLocale(locale), page,
          ...(confirmed.current ? { replaces: confirmed.current } : {}),
          ...(nextShare && shareId.current ? { shareId: shareId.current, shared: { question: question.slice(0, 1000), answer: answer.slice(0, SHARED_ANSWER_LIMIT), ...(sql ? { sql: sql.slice(0, SHARED_SQL_LIMIT) } : {}) } } : withdraw ? { shareId: shareId.current } : {}),
        });
        confirmed.current = next; sharedSent.current = nextShare && result.shared;
        // The daily shared-answer cap can refuse the text while keeping the vote.
        if (nextShare && !result.shared) setShare(false);
        setStatus(nextShare && result.shared ? 'shared' : 'saved');
      } catch {
        setRating(previous.rating); setShare(previous.share); setStatus('error');
      }
    });
  };
  const vote = (value: AnswerVote) => submit({ vote: value }, share);
  const saving = status === 'saving';
  return <div className={styles.rating} role="group" aria-labelledby={`${id}-prompt`}>
    <div className={styles.row}>
      <span id={`${id}-prompt`} className={styles.prompt}>Was this answer useful?</span>
      <button type="button" className={styles.vote} aria-pressed={rating?.vote === 'up'} aria-label="Useful" title="Useful" disabled={saving} onClick={() => vote('up')}>{thumb(false)}</button>
      <button type="button" className={styles.vote} aria-pressed={rating?.vote === 'down'} aria-label="Not useful" title="Not useful" disabled={saving} onClick={() => vote('down')}>{thumb(true)}</button>
    </div>
    {rating?.vote === 'down' ? <fieldset className={styles.reasons}>
      <legend>What went wrong? (optional)</legend>
      {answerReasons.map(reason => <button key={reason} type="button" className={styles.reason} aria-pressed={rating.reason === reason} disabled={saving} onClick={() => submit({ vote: 'down', ...(rating.reason === reason ? {} : { reason }) }, share)}>{reasonLabels[reason]}</button>)}
    </fieldset> : null}
    {rating ? <label className={styles.share}>
      <input type="checkbox" checked={share} disabled={saving} onChange={event => submit(rating, event.target.checked)}/>
      <span>Share this question, Zift&apos;s answer{sql ? ' and its SQL' : ''} with the ZecBlock team so we can fix it. Kept for 30 days, without your IP address. Leave unticked to send the vote only.</span>
    </label> : null}
    <p className={`${styles.status} ${status === 'error' ? styles.error : ''}`} role="status" aria-live="polite">{status === 'saved' ? share ? 'Thanks, your vote was recorded. Shared answers are full for today, so the text was not kept.' : 'Thanks, your vote was recorded.' : status === 'shared' ? 'Thanks, your vote and this answer were shared.' : status === 'error' ? 'Feedback could not be sent. Try again.' : ''}</p>
  </div>;
}
