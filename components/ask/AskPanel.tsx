'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { describePage } from '@/lib/ask/pages';
import { ZiftMark } from './ZiftMark';
import { askCapability, askChat, saveAskHandoff, type AskCapability } from '@/lib/ask/client';
import { isAuthenticatedAskStaging } from '@/lib/ask/api-base';
import type { AnalysisSpec } from '@/lib/ask/contract';
import type { AskTurn } from '@/lib/ask/chat';
import { AskFeedback, AskFailureFeedback, useAskFeedback } from './AskFeedback';
import { AskChallenge } from './AskChallenge';
import { AskTransactions } from './AskTransactions';
import { AskBlocks } from './AskBlocks';
import { AskTransfers } from './AskTransfers';
import { AskSources } from './AskSources';
import { AskAnalytics } from './AskAnalytics';
import { analysisFollowUps } from '@/lib/ask/follow-ups';
import { AskAnswerRating } from './AskAnswerRating';

export default function AskPanel({ pathname, open, onClose, initialSpec }: { pathname: string; open: boolean; onClose: () => void; initialSpec?: AnalysisSpec }) {
  const page = describePage(pathname);
  const [transaction, setTransaction] = useState<string | undefined>(() => pathname.match(/^\/tx\/([a-fA-F0-9]{64})$/)?.[1]);
  const [block, setBlock] = useState<string | undefined>(() => pathname.match(/^\/block\/(0|[1-9]\d{0,8}|[a-fA-F0-9]{64})$/)?.[1]);
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [question, setQuestion] = useState('');
  const [spec, setSpec] = useState<AnalysisSpec | null>(initialSpec || page.spec || null);
  const [capability, setCapability] = useState<AskCapability>({ mode: 'guided', provider: null });
  const [busy, setBusy] = useState(false);
  const feedback = useAskFeedback();
  const [notice, setNotice] = useState('');
  const [token, setToken] = useState('');
  const authenticatedStaging = isAuthenticatedAskStaging(capability);
  const verified = authenticatedStaging || !!token;
  const [reset, setReset] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const autoStarted = useRef(false);
  const [capabilityLoaded, setCapabilityLoaded] = useState(false);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const router = useRouter();
  useEffect(() => {
    const controller = new AbortController();
    askCapability(AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])).then(value => { if (!controller.signal.aborted) { setCapability(value); setCapabilityLoaded(true); setConnectionFailed(false); } }).catch(() => { if (!controller.signal.aborted) setConnectionFailed(true); });
    return () => { controller.abort(); request.current?.abort(); request.current = null; };
  }, [connectionAttempt]);
  useEffect(() => {
    if (!open) { dialog.current?.close(); request.current?.abort(); return; }
    dialog.current?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);
  useEffect(() => { transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: 'instant' }); }, [turns.length, busy]);
  const send = useCallback(async (text: string) => {
    if (request.current || feedback.requestBlocked || !capabilityLoaded || !text.trim() || text.trim().length > 1000) return;
    const controller = new AbortController(); request.current = controller;
    const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), 45000);
    setBusy(true); setQuestion(text.trim()); feedback.clear(); setNotice('');
    try {
      const previousAnalytics = turns.at(-1)?.analytics;
      const reply = await askChat(text.trim(), page.id, spec, 'auto', turns.map(turn => turn.question), token, controller.signal, block, /^explain this (page|view)[?.!]?$/i.test(text.trim()) ? pathname.match(/^\/tx\/([a-fA-F0-9]{64})$/)?.[1] || transaction : transaction, previousAnalytics?.plan.version === 2 ? previousAnalytics.plan : undefined);
      if (controller.signal.aborted) return;
      setTurns(all => [...all, { ...reply, question: text.trim() }].slice(-12));
      if (reply.transactions) setTransaction(reply.transactions.query.txid || reply.transactions.rows[0]?.txid);
      if (reply.blocks?.rows[0]) setBlock(reply.blocks.rows[0].hash);
      if (reply.analytics || reply.transfers || reply.blocks || reply.transactions) setSpec(null); else if (reply.spec) setSpec(reply.spec);
      setQuestion(''); setNotice('Answer ready.');
    } catch (cause) {
      if (request.current === controller && (!controller.signal.aborted || controller.signal.reason?.name === 'TimeoutError')) {
        setQuestion(text.trim());
        feedback.report(controller.signal.aborted ? controller.signal.reason : cause);
      } else if (request.current === controller) setNotice('Stopped. Your question is still here.');
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) { request.current = null; setBusy(false); setToken(''); setReset(value => value + 1); }
    }
  }, [page.id, pathname, spec, token, turns, block, transaction, capabilityLoaded, feedback]);
  useEffect(() => {
    if (!initialSpec || !open || !capabilityLoaded || autoStarted.current || capability.mode === 'ai' && !verified) return;
    autoStarted.current = true;
    void send('Explain this chart');
  }, [initialSpec, open, capabilityLoaded, capability.mode, verified, send]);
  function expand() { saveAskHandoff({ turns, spec, page: page.id, block, transaction }); onClose(); router.push('/zift'); }
  // Hands an unanswered question to Zift as a draft; the refused turn stays here.
  function runInZift(index: number) { saveAskHandoff({ turns: turns.slice(0, index), spec: null, page: page.id, block, transaction, question: turns[index].question }); onClose(); router.push('/zift'); }
  const suggestions = page.questions?.length ? ['Explain this page', ...page.questions] : page.id === 'transaction' || page.id === 'transactions' ? ['Explain this page', 'Show the latest 5 transactions'] : page.id === 'blocks' || page.id === 'block' ? ['Explain this page', 'Tell me about the latest block'] : page.id === 'ironwood' ? ['Explain this page', 'What does migration progress measure?'] : page.id === 'crosschain' ? ['Explain this page', 'Does this include every exchange?'] : page.id === 'pulse' ? ['Explain this page', 'Does an anomaly mean something is wrong?'] : ['Explain this page'];
  const latestAnalytics = turns.at(-1)?.analytics;
  const blocked = busy || feedback.requestBlocked || !capabilityLoaded || capability.mode === 'ai' && !verified;
  return <dialog ref={dialog} id="ask-page-panel" aria-labelledby="ask-panel-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) onClose(); }} className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-dvh w-full max-w-md border-l border-cipher-border bg-cipher-bg p-0 text-primary shadow-2xl backdrop:bg-black/40">
    <div className="flex h-full min-h-0 flex-col" onClick={event => event.stopPropagation()}>
      <header className="flex items-center justify-between gap-3 border-b border-cipher-border p-4"><h2 id="ask-panel-title" className="text-base font-medium"><span className="mr-2 inline-flex align-[-3px]"><ZiftMark size={16} /></span>Zift</h2><div className="flex items-center gap-4"><button onClick={expand} disabled={busy} className="text-xs text-muted hover:text-primary">Open in Zift ↗</button><button onClick={onClose} aria-label="Close Zift" className="p-2 text-secondary">✕</button></div></header>
      <div className="border-b border-cipher-border px-4 py-3"><p className="text-xs text-secondary">{page.title} · Mainnet</p><p className="mt-1 text-caption text-muted">{latestAnalytics ? `Custom analysis: ${latestAnalytics.label}` : spec ? `${initialSpec ? 'Chart analysis' : 'Analysis'}: ${spec.period} · ${spec.pool === 'all' ? 'all pools / network' : spec.pool}` : page.id === 'blocks' || page.id === 'block' ? 'Public block lookups' : page.id === 'transaction' || page.id === 'transactions' ? 'Public transaction lookups' : 'Page guide · controls & methodology'}</p></div>
      <div ref={transcript} className="min-h-0 flex-1 overflow-y-auto p-4" aria-live="polite">
        {!turns.length ? <div className="py-6"><h3 className="text-xl font-medium tracking-tight">Make sense of what you see.</h3><p className="mt-3 text-sm leading-relaxed text-secondary">Understand this page’s metrics and controls, or ask a follow-up.</p><div className="mt-5 flex flex-wrap gap-2">{suggestions.map(text => <button key={text} onClick={() => void send(text)} disabled={blocked} className="rounded-lg border border-cipher-border px-3 py-2 text-left text-xs text-secondary hover:border-cipher-gold disabled:opacity-50">{text}</button>)}</div></div> : null}
        {turns.map((turn, index) => <article key={index} className="mb-6"><p dir="auto" className="ml-6 rounded-lg border border-cipher-border bg-cipher-surface p-3 text-sm">{turn.question}</p><div dir="auto" lang={turn.locale} className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-secondary">{turn.answer}</div><AskAnalytics result={turn.analytics} /><AskBlocks result={turn.blocks} /><AskTransactions result={turn.transactions} /><AskTransfers result={turn.transfers} /><AskSources sources={turn.sources} dataContext={turn.dataContext} />{turn.scope ? <p className="mt-2 text-caption text-muted">{turn.scope}</p> : null}<AskAnswerRating route={turn.route} template={turn.template} locale={turn.locale} page={page.id} question={turn.question} answer={turn.answer} sql={turn.research?.query.sql}/>{turn.spec ? <button onClick={expand} className="mt-3 text-xs text-cipher-gold">Explore this analysis →</button> : null}{turn.handoff ? <button onClick={() => runInZift(index)} disabled={busy} className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-cipher-gold/50 px-3 py-1.5 text-xs text-cipher-gold hover:bg-cipher-gold/10"><ZiftMark size={12} /> {turn.handoff === 'zift' ? 'Run it in Zift' : 'Try it in Zift'} ↗</button> : null}</article>)}

      </div>
      <footer className="border-t border-cipher-border p-4" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
        {capability.mode === 'ai' && turns.length > 0 && turns.at(-1)?.locale === 'en' && spec ? <div className="mb-3 flex flex-wrap gap-2" aria-label="Explore next">{analysisFollowUps(spec).map(text => <button key={text} type="button" disabled={blocked} onClick={() => void send(text)} className="rounded-lg border border-cipher-border px-3 py-2 text-left text-xs text-secondary hover:border-cipher-gold disabled:opacity-50">{text}</button>)}</div> : null}
        <form onSubmit={event => { event.preventDefault(); void send(question); }} aria-busy={busy} className="rounded-xl border border-cipher-border bg-cipher-surface p-3 focus-within:border-cipher-gold"><label htmlFor="ask-widget-question" className="sr-only">Ask about this page</label><textarea id="ask-widget-question" disabled={busy} dir="auto" value={question} onChange={event => setQuestion(event.target.value)} maxLength={1000} rows={2} placeholder="Ask about this page…" className="w-full resize-none bg-transparent text-sm outline-none" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!blocked) void send(question); } }} /><div className="flex items-center justify-between gap-2"><span className="text-caption text-muted">{capability.mode === 'ai' ? 'Ask AI · public data' : 'Guides & public lookups'}</span>{busy ? <button type="button" onClick={() => request.current?.abort()} className="text-xs text-secondary">Stop</button> : <button disabled={blocked || !question.trim()} aria-label="Send question" className="rounded bg-brand-gold px-3 py-1 text-black disabled:opacity-40">↑</button>}</div></form>
        {busy ? <AskFeedback working title="Thinking…" detail="Checking this page’s public data and preparing your answer."/> : feedback.failure ? <AskFailureFeedback failure={feedback.failure} blocked={feedback.failureBlocked} onRetry={() => void send(question)}/> : notice ? <AskFeedback title={notice}/> : connectionFailed ? <AskFeedback error title="Could not connect to Zift" detail="Check your connection and try again." onRetry={() => {setConnectionFailed(false);setConnectionAttempt(value => value + 1);}} retryLabel="Reconnect"/> : !capabilityLoaded ? <AskFeedback working title="Connecting to Zift…"/> : null}
        {authenticatedStaging ? null : <AskChallenge siteKey={capability.siteKey} onToken={setToken} reset={reset} />}
        <p className="mt-2 text-caption leading-relaxed text-muted">{capability.mode === 'ai' ? `Questions and recent context go to ${capability.provider}. Never share wallet secrets.` : 'AI is not connected. Guides, block and transaction lookups are available in English.'}</p>
      </footer>
    </div>
  </dialog>;
}
