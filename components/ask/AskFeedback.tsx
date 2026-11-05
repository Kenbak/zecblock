'use client';
import { useEffect, useState } from 'react';
import { askFailure, type AskFailure, type AskFailureScope } from '@/lib/ask/client';
import styles from './AskFeedback.module.css';

type InputMode = 'ask' | 'sql';
type ReportedFailure = AskFailure & { origin?: InputMode };
export function useAskFeedback(mode: InputMode = 'ask') {
  const [failures, setFailures] = useState<Partial<Record<AskFailureScope, ReportedFailure>>>({});
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const now = Date.now();
    const nextReset = Math.min(...Object.values(failures).map(failure => failure.retryAt || 0).filter(reset => reset > now));
    if (!Number.isFinite(nextReset)) return;
    // Browser timers overflow after about 24.8 days. Recheck long monthly
    // windows in bounded steps, without clearing an unexpired allowance.
    const timer = setTimeout(() => setClock(Date.now()), Math.min(nextReset - now, 2147483647));
    return () => clearTimeout(timer);
  }, [failures, clock]);
  const scopeFor = (selected: InputMode): AskFailureScope => selected === 'sql' ? 'sql' : 'ai';
  const applicable = (selected: InputMode) => [failures[scopeFor(selected)], failures.request].filter((failure): failure is ReportedFailure => !!failure);
  const blockedFor = (selected: InputMode) => applicable(selected).some(failure => (failure.retryAt || 0) > Date.now());
  const selectedFailures = applicable(mode);
  const originFailures = Object.values(failures).filter(item => item.origin === mode && !selectedFailures.includes(item));
  const activeFailure = (items: ReportedFailure[]) => items.filter(item => (item.retryAt || 0) > Date.now()).sort((a,b) => (b.retryAt || 0) - (a.retryAt || 0))[0];
  const failure = activeFailure(selectedFailures) || activeFailure(originFailures) || selectedFailures[0] || originFailures[0] || null;
  return { failure, failureBlocked: (failure?.retryAt || 0) > Date.now(), blocked: blockedFor(mode), blockedFor, requestBlocked: (failures.request?.retryAt || 0) > Date.now(), clear: (selected: InputMode = mode) => {
    const now = Date.now();
    setFailures(previous => {
      const next = {...previous};
      for (const scope of ['request','ai','sql'] as const) {
        const item = next[scope];
        if (!item || scope !== 'request' && scope !== scopeFor(selected) && item.origin !== selected) continue;
        if ((item.retryAt || 0) <= now) delete next[scope];
        // A fresh request acknowledges a foreign-bucket error at its origin,
        // while preserving that bucket's earned restriction and its own UI.
        else if (scope !== 'request' && scope !== scopeFor(selected)) next[scope] = {...item,origin:undefined};
      }
      return next;
    });
  }, report: (error: unknown, selected: InputMode = mode) => {
    const now = Date.now();
    const next = askFailure(error,now);
    const scope = next.scope || scopeFor(selected);
    setClock(now);
    setFailures(previous => ({...previous,[scope]:(previous[scope]?.retryAt || 0) > now && (previous[scope]?.retryAt || 0) > (next.retryAt || 0) ? {...previous[scope]!,origin:selected} : {...next,scope,origin:selected}}));
  } };
}
export function AskFeedback({ title, detail, working = false, error = false, onRetry, retryLabel = 'Try again' }: { title: string; detail?: string; working?: boolean; error?: boolean; onRetry?: () => void; retryLabel?: string }) {
  return <div className={`${styles.feedback} ${error ? styles.error : ''}`} role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'} aria-atomic="true">
    <span className={styles.mark} aria-hidden="true">{working ? <span className={styles.dots}><i/><i/><i/></span> : error ? '!' : '›'}</span>
    <div className={styles.content}><p className={styles.title}>{title}</p>{detail ? <p className={styles.detail}>{detail}</p> : null}{onRetry ? <button type="button" onClick={onRetry} className={styles.retry}>{retryLabel} →</button> : null}</div>
  </div>;
}
export function AskFailureFeedback({ failure, blocked, onRetry }: { failure: AskFailure; blocked: boolean; onRetry: () => void }) {
  const reset = failure.retryAt ? new Intl.DateTimeFormat(undefined, { ...(failure.retryAt - Date.now() >= 86400000 ? { year: 'numeric', month: 'short', day: 'numeric' } as const : {}), hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(failure.retryAt)) : null;
  return <AskFeedback error={blocked || !failure.retryAt} title={failure.retryAt && !blocked ? 'You can try again' : failure.title} detail={`${failure.detail}${reset ? blocked ? ` Try again after ${reset}. Your draft is kept here.` : ' You can try again now. Your draft is kept here.' : ' Your draft is kept here.'}`} onRetry={failure.retryable || failure.retryAt && !blocked ? onRetry : undefined}/>;
}
