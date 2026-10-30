'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { analysisSchema, resolveShortcut, starters, type AnalysisSpec } from '@/lib/ask/contract';
import { getAskApiUrl, isAuthenticatedAskStaging } from '@/lib/ask/api-base';
import { ApiError, readApiResponse } from '@/lib/api-client';
import styles from './ask.module.css';
import { useResearchTools, type DashboardRefresh, ResearchLibrary, ResearchPanel, ResearchData, ResearchDashboard, SharedResearchDraft } from './ResearchWorkbench';
import type { ResearchDocument, ResearchResult, ResearchNarrative } from '@/lib/ask/research-contract';
import type {ResearchJobStatus,ResearchJobTicket} from '@/lib/ask/research-job-contract';
import {jobTicketSchema} from '@/lib/ask/research-job-contract';
import { runResearch, submitResearch, waitResearch, explainResearch } from '@/lib/ask/research-client';
import { researchResultSchema } from '@/lib/ask/research-contract';
import { suggestResearchChart } from '@/lib/ask/research-display';
import { AskChallenge } from '@/components/ask/AskChallenge';
import { AskTransactions } from '@/components/ask/AskTransactions';
import { AskBlocks } from '@/components/ask/AskBlocks';
import { AskTransfers } from '@/components/ask/AskTransfers';
import { AskSources } from '@/components/ask/AskSources';
import { AskAnalytics } from '@/components/ask/AskAnalytics';
import { askChat, askErrorMessage, peekAskHandoff, clearAskHandoff, type AskCapability } from '@/lib/ask/client';
import type { AskProgressStage, AskReply, AskSource, AskTurnScope } from '@/lib/ask/chat';
import { sqlDraft } from '@/lib/ask/composer';
import { AskFeedback, AskFailureFeedback, useAskFeedback } from '@/components/ask/AskFeedback';
import { AskAnswerRating } from '@/components/ask/AskAnswerRating';
import { describeMetric } from '@/lib/ask/data';
import { AskAnalysis } from './AskAnalysis';
import { readAnyResearchLink, type ResearchShare } from '@/lib/ask/research-share';
import { researchFollowUps } from '@/lib/ask/follow-ups';
import { catalogueFor } from '@/lib/ask/research-catalogue';
import { examplesFor } from '@/lib/ask/sql-examples';
import { displaySQL } from '@/lib/ask/sql-display';
import type { SQLFeedback } from '@/lib/ask/sql-feedback';
import { SQLProblem, SQLStarters, SQLTables, editorPosition, sqlFeedbackFrom } from '@/components/ask/AskSQLTools';
import { CopyButton } from '@/lib/ask/copy-button';
import { ZiftMark } from '@/components/ask/ZiftMark';

// CodeMirror loads only in the browser, and only once SQL mode is opened.
const SQLEditor = dynamic(() => import('@/components/ask/SQLEditor').then(module => module.SQLEditor), { ssr: false, loading: () => <div className="min-h-[140px]" /> });

const categories = ['Featured', 'Pools', 'Ironwood', 'Cross-chain', 'Network'];
// ticket: bearer capability for a finished SQL job, kept in memory only so an
// explanation can be requested later; never saved, shared or sent elsewhere.
// Stages streamed by /v1/ask/chat while the agent works.
const progressTitles: Record<AskProgressStage, string> = { planning: 'Choosing an approach…', checking: 'Checking the SQL…', running: 'Running the query…', repairing: 'Fixing the query…', explaining: 'Explaining the results…', looking_up: 'Looking it up…', reading: 'Reading the guides…' };
type Message = { turnScope?: AskTurnScope; ticket?: ResearchJobTicket; explained?: boolean; narrative?: ResearchNarrative; savedDocumentId?: string; savedSnapshot?: boolean; state?: 'pending' | 'complete' | 'failed' | 'cancelled'; sql?: string; research?: ResearchResult; analytics?: AskReply['analytics']; transactions?: AskReply['transactions']; blocks?: AskReply['blocks']; dataContext?: AskReply['dataContext']; id: number; question: string; answer: string; spec?: AnalysisSpec; viewSpec?: AnalysisSpec; sources?: AskSource[]; transfers?: AskReply['transfers']; locale?: string; scope?: string; route?: string; template?: boolean };
type Session = { transaction?: string; block?: string; id: number; title: string; messages: Message[]; spec: AnalysisSpec | null; page?: string };
type Capability = AskCapability;
const initialSession: Session = { id: 0, title: 'New analysis', messages: [], spec: null };
const analysisScopeKey = (spec: AnalysisSpec | null) => spec ? JSON.stringify([spec.metric, spec.period, spec.pool, spec.start, spec.end]) : '';

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const done = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', done); resolve(); }, ms);
  signal.addEventListener('abort', done, { once: true });
  if (signal.aborted) done();
});

function analysisTitle(question: string) {
  return question.replace(/^\s*Use SQL research[.!:]?\s*/i, '').trim().slice(0, 120) || 'My Zcash analysis';
}
function narrativeFor(message: Pick<Message, 'question' | 'answer' | 'research' | 'sql' | 'locale'>): ResearchNarrative | undefined {
  if (!message.research || !/^[a-f0-9]{64}$/.test(message.research.fingerprint || '') || !message.answer) return undefined;
  return { question: message.sql || message.question, answer: message.answer, fingerprint: message.research.fingerprint, inputMode: message.sql ? 'sql' : 'ask', ...(message.locale ? { locale: message.locale } : {}) };
}
function sameNarrative(a?: ResearchNarrative, b?: ResearchNarrative) {
  return a === b || !!a && !!b && a.question === b.question && a.answer === b.answer && a.fingerprint === b.fingerprint && a.inputMode === b.inputMode && a.locale === b.locale;
}

function AskMark({ small = false }: { small?: boolean }) {
  return <ZiftMark boxed size={small ? 16 : 26} className={small ? 'h-7 w-7 rounded' : 'h-12 w-12 rounded-lg'} />;
}

export function AskWorkspace() {
  const [handoff] = useState(peekAskHandoff);
  const [token, setToken] = useState('');
  const [challengeReset, setChallengeReset] = useState(0);
  const [sessions, setSessions] = useState<Session[]>(() => handoff?.turns.length ? [{ id: 0, title: analysisTitle(handoff.turns[0].question), spec: handoff.spec, page: handoff.page, block: handoff.block, transaction: handoff.transaction, messages: handoff.turns.map((turn, i) => ({ id: i + 1, narrative: narrativeFor(turn), question: turn.question, answer: turn.answer, sources: turn.sources, transfers: turn.transfers, blocks: turn.blocks, transactions: turn.transactions, analytics: turn.analytics, research: turn.research, locale: turn.locale, scope: turn.scope, dataContext: turn.dataContext, spec: turn.spec || undefined, route: turn.route, template: turn.template })) }] : [initialSession]);
  const initialResearch = handoff?.turns.filter(turn => turn.research).at(-1);
  const tools = useResearchTools(initialResearch?.research, initialResearch ? analysisTitle(initialResearch.question) : undefined, initialResearch ? narrativeFor(initialResearch) : undefined);
  const [activeId, setActiveId] = useState(0);
  const [question, setQuestion] = useState(handoff?.question || '');
  const [sharedResearch, setSharedResearch] = useState<ResearchShare | null>(null);
  const [sqlInput, setSQLInput] = useState('');
  const [sqlLimit, setSQLLimit] = useState(100);
  // Last SQL rejection with the text it applies to, so the editor can mark its line.
  const [sqlProblem, setSQLProblem] = useState<{ feedback: SQLFeedback; sql: string } | null>(null);
  const sqlInsert = useRef<((text: string) => boolean) | null>(null);
  const [expanded, setExpanded] = useState<Message | null>(null);
  const resultDialog = useRef<HTMLDialogElement>(null);
  const [inputMode, setInputMode] = useState<'ask' | 'sql'>('ask');
  const [phase, setPhase] = useState<'thinking' | 'submitting' | 'explaining'>('thinking');
  const [notice, setNotice] = useState(handoff?.question ? 'Your question from the page is ready. Press Enter to run it in Zift.' : '');
  const feedback = useAskFeedback(inputMode);
  const aiBlocked = feedback.blockedFor('ask');
  const sqlBlocked = feedback.blockedFor('sql');
  const [busy, setBusy] = useState(false);
  const [jobStatus,setJobStatus]=useState<ResearchJobStatus|null>(null);
  const [progress, setProgress] = useState<AskProgressStage | null>(null);
  const [capability, setCapability] = useState<Capability>({ mode: 'guided', provider: null });
  const authenticatedStaging = isAuthenticatedAskStaging(capability);
  const verified = authenticatedStaging || !!token;
  const [capabilityReady, setCapabilityReady] = useState(false);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const reconnect = useRef<() => void>(() => {});
  const [chatError, setChatError] = useState('');
  const [exampleCategory, setExampleCategory] = useState('Featured');
  const request = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const composerStatus = useRef<HTMLDivElement>(null);
  const serial = useRef(handoff?.turns.length || 0);
  const transcript = useRef<HTMLDivElement>(null);
  const latestTurn = useRef<HTMLDivElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const session = sessions.find(item => item.id === activeId)!;
  const spec = session.spec;
  const ranking = Boolean(spec?.metric.startsWith('chain_'));
  const poolMetric = !spec || ['balances', 'flows', 'activity'].includes(spec.metric);
  const examples = starters.filter(starter => exampleCategory === 'Featured' ? ['balances', 'ironwood-balance', 'swap-volume', 'pulse'].includes(starter.id) : exampleCategory === 'Pools' ? ['balances', 'compare', 'flows', 'activity'].includes(starter.id) : starter.category === exampleCategory);
  const hasMessages = session.messages.length > 0;
  const featured = starters.filter(starter => ['balances', 'flows', 'swap-volume'].includes(starter.id)).slice(0, 3);
  const latestRecords = session.messages.filter(message => message.research || message.analytics || message.transfers || message.blocks || message.transactions).at(-1);
  const blocks = latestRecords?.blocks;
  const transactions = latestRecords?.transactions;
  const analytics = latestRecords?.analytics;
  const research = latestRecords?.research;
  // Associate only the exact saved document with its original turn. A data
  // fingerprint can be shared by different questions and explanations.
  useEffect(() => {
    if (!tools.id || !latestRecords?.research || latestRecords.savedDocumentId === tools.id) return;
    const doc = tools.library.documents.find(item => item.id === tools.id);
    if (!doc?.result || doc.result.fingerprint !== latestRecords.research.fingerprint || doc.query.sql !== latestRecords.research.query.sql || doc.query.limit !== latestRecords.research.query.limit || !sameNarrative(doc.narrative, latestRecords.narrative)) return;
    setSessions(all => all.map(item => item.id === activeId ? { ...item, messages: item.messages.map(message => message.id === latestRecords.id ? { ...message, savedDocumentId: doc.id } : message) } : item));
  }, [tools.id, tools.library, latestRecords, activeId]);

  useEffect(() => {
    // Compact (#r=) and older (#research=) links; neither ever runs SQL.
    const readShare = () => {
      readAnyResearchLink(window.location.hash).then(share => setSharedResearch(share))
        .catch(failure => { setSharedResearch(null); setChatError(failure instanceof Error ? failure.message : 'This research link is invalid.'); });
    };
    readShare(); window.addEventListener('hashchange', readShare);
    return () => window.removeEventListener('hashchange', readShare);
  }, []);
  useEffect(() => { if (expanded && !resultDialog.current?.open) resultDialog.current?.showModal(); else if(!expanded && resultDialog.current?.open) resultDialog.current.close(); }, [expanded]);

  useEffect(() => {
    clearAskHandoff();
    const controller = new AbortController();
    let pending = false;
    const refreshCapability = () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      fetch(getAskApiUrl(), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), cache: 'no-store' })
        .then(res => readApiResponse<Capability>(res))
        .then(({ data, meta }) => {
          if (!controller.signal.aborted && meta.network === 'mainnet' && ['guided', 'ai'].includes(data.mode)) { setCapability(data); setCapabilityReady(true); setConnectionFailed(false); }
        })
        .catch(() => { if (!controller.signal.aborted) setConnectionFailed(true); })
        .finally(() => { pending = false; });
    };
    reconnect.current = refreshCapability;
    refreshCapability();
    const refreshVisible = () => { if (document.visibilityState === 'visible') refreshCapability(); };
    const interval = setInterval(refreshVisible, 30000);
    window.addEventListener('online', refreshCapability);
    window.addEventListener('focus', refreshVisible);
    return () => {
      clearInterval(interval); window.removeEventListener('online', refreshCapability); window.removeEventListener('focus', refreshVisible);
      controller.abort(); request.current?.abort();
    };
  }, []);

  // Explaining an earlier result keeps the reader where they are; only
  // composer-originated work scrolls its status into view.
  const [explainingId, setExplainingId] = useState<number | null>(null);
  const [explainError, setExplainError] = useState<{ id: number; text: string } | null>(null);
  const [refreshStatus, setRefreshStatus] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const tokenRef = useRef('');
  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => {
    if (explainingId !== null) return;
    if (busy || feedback.failure || notice || chatError) composerStatus.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [busy, feedback.failure, notice, chatError, explainingId]);

  useEffect(() => { latestTurn.current?.scrollIntoView({block:'nearest',behavior:'instant'}); }, [session.messages.length]);

  function updateSpec(next: AnalysisSpec, restore = false) {
    if (!restore && (next.metric !== spec?.metric || next.period !== spec?.period || next.pool !== spec?.pool)) next = { ...next, start: null, end: null };
    const validated = analysisSchema.parse(next);
    setSessions(all => all.map(item => item.id === activeId ? { ...item, spec: validated } : item));
  }

  function switchSession(id: number) {
    if (id === activeId) { tools.setBoardId(null); return; }
    request.current?.abort(); request.current = null; setBusy(false); setJobStatus(null); setNotice(''); feedback.clear(); setChatError('');
    setSessions(all => all.map(item => ({ ...item, messages: item.messages.map(message => {
      if (message.state !== 'pending') return message;
      const stopped = { ...message, state: 'cancelled' as const, answer: 'Stopped when you changed conversations.' };
      return { ...stopped, narrative: narrativeFor(stopped) };
    }) })));
    setActiveId(id); setQuestion(''); setSQLInput(''); setExpanded(null); setInputMode('ask');
    const selected = sessions.find(item => item.id === id)?.messages.filter(message => message.research).at(-1);
    const doc = selected?.savedDocumentId ? tools.library.documents.find(item => item.id === selected.savedDocumentId) : undefined;
    if (doc?.result && selected?.research && doc.result.fingerprint === selected.research.fingerprint && doc.query.sql === selected.research.query.sql && doc.query.limit === selected.research.query.limit && sameNarrative(doc.narrative, selected.narrative)) tools.open(doc);
    else if (selected?.research) tools.accept(selected.research, selected.sql ? 'SQL analysis' : analysisTitle(selected.question), true, selected.narrative);
    else tools.reset();
  }

  function newSession() {
    tools.reset();
    if (!hasMessages) { input.current?.focus(); return; }
    const id = ++serial.current;
    setSessions(all => [{ id, title: 'New analysis', messages: [], spec: null }, ...all].slice(0, 12));
    switchSession(id);
    requestAnimationFrame(() => input.current?.focus());
  }

  async function ask(text: string, context: AnalysisSpec | null = spec) {
    const trimmed = text.trim();
    const detected = capability.researchEnabled ? sqlDraft(trimmed) : null;
    if (detected) { selectSQL(detected); return; }
    const next = resolveShortcut(trimmed, context);
    if (!trimmed || trimmed.length > 1000 || feedback.requestBlocked || busy || request.current || !capabilityReady && !next || capability.mode === 'ai' && !verified && !next) return;
    setInputMode('ask'); setQuestion(''); setBusy(true); setPhase('thinking'); setProgress(null); setNotice(''); feedback.clear('ask'); setChatError('');
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), 300000);
    const id = ++serial.current;
    setSessions(all => all.map(item => item.id === activeId ? { ...item, title: item.messages.length ? item.title : analysisTitle(trimmed), messages: [...item.messages, { id, question: trimmed, answer: '', state: 'pending' as const }].slice(-30) } : item));
    const append = (answer: string, next?: AnalysisSpec, sources?: AskSource[], answerLocale?: string, scope?: string, transfers?: AskReply['transfers'], dataContext?: AskReply['dataContext'], blocks?: AskReply['blocks'], transactions?: AskReply['transactions'], analytics?: AskReply['analytics'], research?: ResearchResult, turnScope?: AskTurnScope, rated?: Pick<AskReply, 'route' | 'template'>) => setSessions(all => all.map(item => item.id === activeId ? {
      ...item, title: item.messages.length ? item.title : analysisTitle(trimmed),
      messages: item.messages.map(message => message.id === id ? { id, state: 'complete' as const, question: trimmed, answer, narrative: narrativeFor({ question: trimmed, answer, research, locale: answerLocale }), spec: next, sources, transfers, blocks, transactions, analytics, research, dataContext, locale: answerLocale, scope, turnScope, route: rated?.route, template: rated?.template } : message),
      block: blocks?.rows[0]?.hash || item.block,
      transaction: transactions ? transactions.query.txid || transactions.rows[0]?.txid : item.transaction,
      spec: research || analytics || transfers || blocks || transactions ? null : next ?? item.spec,
    } : item));
    let completedResearch: ResearchResult | undefined;
    try {
      if (!next || capability.mode === 'ai' && verified && !aiBlocked) {
        // The server's scope of the latest answer that ran something, for follow-ups.
        const turnScope = session.messages.findLast(message => message.state === 'complete' && message.turnScope)?.turnScope;
        let reply = await askChat(trimmed, session.page || 'ask', context, 'auto', session.messages.filter(message => !message.sql && (!message.state || message.state === 'complete')).map(message => message.question), token, controller.signal, context ? undefined : session.block, context ? undefined : session.transaction, !context && analytics?.plan.version === 2 ? analytics.plan : undefined, !context && capability.researchEnabled ? research?.query : undefined, { turnScope, onProgress: stage => { if (request.current === controller) setProgress(stage); } });
        const queuedScope = reply.turnScope;
        if(reply.job){
          const ticket=jobTicketSchema.parse(reply.job);
          const result=await waitResearch(ticket,controller.signal,setJobStatus);
          controller.signal.throwIfAborted();
          if (request.current !== controller) return;
          // The checked data is usable while the separate explanation is pending.
          completedResearch = result;
          setSessions(all => all.map(item => item.id === activeId ? { ...item, spec: null, messages: item.messages.map(message => message.id === id ? { ...message, research: result } : message) } : item));
          tools.accept(result,analysisTitle(trimmed),true,undefined,suggestResearchChart(result));
          setPhase('explaining');
          try{reply=await explainResearch(ticket,trimmed,reply.locale,controller.signal);}
          catch(cause){if(controller.signal.aborted)throw cause;reply={answer:'Your query is complete. The results are below; an AI explanation is temporarily unavailable.',sources:[],spec:null,locale:reply.locale,mode:'ai',research:result};}
        }
        controller.signal.throwIfAborted();
        if (request.current !== controller) return;
        const shownResearch = completedResearch || (reply.research ? researchResultSchema.parse(reply.research) : undefined);
        append(reply.answer, reply.spec ? analysisSchema.parse(reply.spec) : undefined, reply.sources, reply.locale, reply.scope, reply.transfers, reply.dataContext, reply.blocks, reply.transactions, reply.analytics, shownResearch, reply.turnScope || queuedScope, { route: reply.route || (completedResearch ? 'run_sql' : undefined), template: reply.template });
        // Preserve any chart changes made while the explanation was being written.
        if (shownResearch) {
          const narrative = narrativeFor({ question: trimmed, answer: reply.answer, research: shownResearch, locale: reply.locale });
          if (!completedResearch) tools.accept(shownResearch, analysisTitle(trimmed), true, narrative, suggestResearchChart(shownResearch));
          else if (narrative) tools.annotate(narrative);
          if (reply.chart) tools.suggest(reply.chart);
        }
      } else {
        append(`Opened ${describeMetric(next.metric).title.toLowerCase()} for ${next.period === '1y' ? 'the past year' : `the past ${next.period.slice(0, -1)} days`}${next.pool === 'all' ? '' : `, filtered to ${next.pool}`}. The analysis shows the source observations and updates as you change the controls.`, next);
      }
      setQuestion(''); setNotice('');

    } catch (cause) {
      if (request.current === controller) {
        setQuestion(trimmed);
        const stopped = controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError';
        const answer = completedResearch ? stopped ? 'Your query results are ready. The explanation was stopped; your question is back in the input.' : 'Your query results are ready, but the explanation did not finish. Your question is back in the input.' : stopped ? 'Stopped. Your question has been restored to the input.' : 'This request did not complete. Your question has been restored to the input; see the error below.';
        const narrative = narrativeFor({ question: trimmed, answer, research: completedResearch });
        if (narrative) tools.annotate(narrative);
        setSessions(all => all.map(item => item.id === activeId ? { ...item, messages: item.messages.map(message => message.id === id ? { ...message, state: stopped ? 'cancelled' as const : 'failed' as const, answer, narrative } : message) } : item));
        if (!controller.signal.aborted || controller.signal.reason?.name === 'TimeoutError') {
          feedback.report(controller.signal.aborted ? controller.signal.reason : cause,'ask');
          if (next && !completedResearch) updateSpec(next, true);
        } else setNotice('Stopped. Your draft is still here.');
      }
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) { request.current = null; setBusy(false); setToken(''); setChallengeReset(value => value + 1); setJobStatus(null); setProgress(null); }
    }
  }

  // A saved analysis that is already open as a recent conversation reopens
  // there instead of adding a duplicate.
  function markSaved(docId: string) {
    setSessions(all => all.map(item => item.id !== activeId ? item : { ...item, title: tools.title, messages: item.messages.map(message => message.id === latestRecords?.id ? { ...message, savedDocumentId: docId } : message) }));
  }
  // A conversation saved to the library shows the saved name, including renames.
  function sessionTitle(item: Session) {
    const docId = item.messages.findLast(message => message.savedDocumentId)?.savedDocumentId;
    return (docId && tools.library.documents.find(doc => doc.id === docId)?.title) || item.title;
  }
  function openSaved(doc: ResearchDocument, shared = false) {
    if (busy || tools.importing) return;
    const existing = shared ? undefined : sessions.find(item => item.messages.some(message => message.savedDocumentId === doc.id));
    if (existing) { tools.setBoardId(null); if (existing.id === activeId) tools.open(doc); else switchSession(existing.id); return; }
    tools.open(doc, shared); const id = ++serial.current;
    const narrative = doc.narrative;
    const sql = narrative?.inputMode === 'sql' ? narrative.question : !narrative ? doc.query.sql : undefined;
    const answer = narrative?.answer || (shared ? 'Shared query draft. Review the SQL before running it.' : doc.result ? 'Saved results. This older file did not include the original question or answer. Run its SQL to refresh the data.' : 'Saved query draft. Review the SQL before running it.');
    setSessions(all => [{ id, title: doc.title, spec: null, messages: [{ id, question: narrative?.question || doc.title, sql, answer, locale: narrative?.locale, narrative, savedDocumentId: shared ? undefined : doc.id, savedSnapshot: !!doc.result, research: doc.result || undefined }] }, ...all].slice(0, 12));
    setActiveId(id); setQuestion(''); setSQLInput(sql ? doc.query.sql : ''); setSQLLimit(doc.query.limit); setInputMode(sql ? 'sql' : 'ask'); setExpanded(null); setNotice(''); feedback.clear(); setChatError('');
  }

  async function runSQL() {
    if(busy||request.current||tools.importing||sqlBlocked||!sqlInput.trim()||!capabilityReady)return;
    if(!verified){setChatError('Verification is still loading. Retry verification before running SQL.');return;}
    const query={version:3 as const,sql:sqlInput,limit:sqlLimit};
    const id=++serial.current, title=tools.title;
    setSQLInput('');setBusy(true);setPhase('submitting');setNotice('');feedback.clear('sql');setChatError('');setSQLProblem(null);
    setSessions(all=>all.map(item=>item.id===activeId?{...item,title:item.messages.length?item.title:title,messages:[...item.messages,{id,question:'SQL query',sql:query.sql,answer:'',state:'pending' as const}].slice(-30)}:item));
    const controller=new AbortController();request.current=controller;
    try{
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(300000)]);
      const ticket=capability.jobsEnabled?await submitResearch(query,token,signal):undefined;
      const result=ticket?await waitResearch(ticket,signal,setJobStatus):await runResearch(query,token,AbortSignal.any([signal,AbortSignal.timeout(20000)]));
      if (request.current !== controller || controller.signal.aborted) return;
      const answer = `${result.rows.length} rows returned. No AI was used.`;
      const narrative = narrativeFor({ question: 'SQL query', sql: query.sql, answer, research: result });
      tools.accept(result, title, false, narrative); setNotice('');
      setSessions(all=>all.map(item=>item.id===activeId?{...item,spec:null,messages:item.messages.map(message=>message.id===id?{...message,state:'complete' as const,answer,narrative,research:result,ticket,route:'sql'}:message)}:item));
    }catch(error){
      if(request.current!==controller)return;
      setSQLInput(query.sql);setSQLLimit(query.limit);
      setSessions(all=>all.map(item=>item.id===activeId?{...item,messages:item.messages.map(message=>message.id===id?{...message,state:controller.signal.aborted?'cancelled' as const:'failed' as const,answer:controller.signal.aborted?'Stopped. Your SQL has been restored to the input.':'This query did not complete. Your SQL has been restored to the input; see the error below.'}:message)}:item));
      const problem=sqlFeedbackFrom(error);
      if(controller.signal.aborted)setNotice('Stopped. Your SQL is still here.');
      else if(problem)setSQLProblem({feedback:problem,sql:query.sql});
      else feedback.report(error,'sql');
    }finally{if(request.current===controller){setBusy(false);setToken('');setChallengeReset(value=>value+1);request.current=null;setJobStatus(null);}}
  }
  // Opt-in AI summary of a finished SQL job. Uses the AI allowance; the server
  // binds every number in the prose to cells of this exact result. Job tickets
  // last an hour and are never saved, so a reopened save or an expired job
  // runs its SQL again first and explains the refreshed result.
  async function explainSQL(message: Message) {
    if (busy || request.current || !message.research || capability.mode !== 'ai' || aiBlocked) return;
    if (!message.ticket && (!capability.jobsEnabled || !verified || sqlBlocked)) return;
    const { answer: previous, id } = message;
    let ticket = message.ticket, research = message.research, rerun = false;
    const latest = id === latestRecords?.id;
    const update = (patch: Partial<Message>) => setSessions(all => all.map(item => item.id === activeId ? { ...item, messages: item.messages.map(turn => turn.id === id ? { ...turn, ...patch } : turn) } : item));
    const controller = new AbortController(); request.current = controller;
    setExplainingId(id); setExplainError(null); setBusy(true); setPhase('explaining'); feedback.clear('ask'); setChatError('');
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]);
      const refresh = async () => {
        setPhase('submitting');
        ticket = await submitResearch(research.query, token, signal);
        research = await waitResearch(ticket, signal, setJobStatus);
        if (request.current !== controller) return;
        rerun = true; setJobStatus(null); setPhase('explaining');
        update({ research, ticket, savedSnapshot: false });
        if (latest) tools.accept(research, tools.title, false);
      };
      if (!ticket) await refresh();
      // Only this result is described: no earlier conversation title or question
      // (observed on staging: a prior question leaked into the explanation).
      const question = 'What are the main findings in these SQL results? Name the leading rows and how they compare.';
      const explain = () => explainResearch(ticket!, question, 'auto', AbortSignal.any([signal, AbortSignal.timeout(60000)]));
      let reply;
      try { reply = await explain(); }
      catch (error) {
        if (rerun || controller.signal.aborted || !(error instanceof ApiError && error.code === 'ask-job')) throw error;
        await refresh(); reply = await explain();
      }
      if (request.current !== controller) return;
      const narrative = narrativeFor({ question: 'SQL query', sql: message.sql, answer: reply.answer, research, locale: reply.locale });
      if (narrative && latest) tools.annotate(narrative);
      update({ state: 'complete', answer: reply.answer, locale: reply.locale, narrative, ticket: undefined, explained: true });
    } catch (error) {
      if (request.current !== controller) return;
      update({ state: 'complete', answer: previous });
      if (controller.signal.aborted) setNotice('Explanation stopped. Your results are unchanged.');
      else {
        // Shown beside the result: the composer may be in SQL mode, where AI errors are not listed.
        setExplainError({ id, text: askErrorMessage(error) });
        feedback.report(error, 'ask');
      }
    } finally {
      if (request.current === controller) {
        request.current = null; setBusy(false); setExplainingId(null); setJobStatus(null);
        if (rerun) { setToken(''); setChallengeReset(value => value + 1); }
      }
    }
  }
  // Dashboard refresh: saved queries run again one at a time, each with its own
  // verification and one SQL run. A per-minute limit pauses and resumes; a
  // daily limit, verification failure or Stop ends the refresh. Results are
  // stored only in this browser's library.
  async function nextChallenge(signal: AbortSignal) {
    if (authenticatedStaging) return '';
    for (let waited = 0; !tokenRef.current; waited += 250) {
      if (waited >= 60000) throw new ApiError('Verification', 403, 'access-denied', undefined, undefined, 'ask-verification');
      await pause(250, signal);
    }
    const challenge = tokenRef.current;
    tokenRef.current = ''; setToken(''); setChallengeReset(value => value + 1);
    return challenge;
  }
  async function refreshCards(docs: ResearchDocument[]) {
    if (busy || request.current || !docs.length || !capability.jobsEnabled || sqlBlocked) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setRefreshing(true); feedback.clear('sql'); setChatError(''); setNotice('');
    let updated = 0, failed = 0, stopped = '';
    try {
      for (const [index, doc] of docs.entries()) {
        const run = async (): Promise<boolean> => {
          setRefreshStatus(`Refreshing ${index + 1} of ${docs.length}: ${doc.title}…`);
          try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]);
            const ticket = await submitResearch(doc.query, await nextChallenge(signal), signal);
            const result = await waitResearch(ticket, signal, setJobStatus);
            return tools.refreshDocument(doc.id, result);
          } catch (error) {
            if (controller.signal.aborted) throw error;
            const wait = error instanceof ApiError && error.status === 429 && /minute/.test(error.code || '') ? Number(error.retryAfter) : NaN;
            if (Number.isFinite(wait) && wait >= 1 && wait <= 60) {
              setRefreshStatus(`Per-minute SQL limit reached. Continuing in ${wait}s…`);
              await pause(wait * 1000, controller.signal);
              return run();
            }
            if (error instanceof ApiError && (error.status === 429 || error.code === 'ask-verification')) { stopped = askErrorMessage(error); feedback.report(error, 'sql'); }
            return false;
          }
        };
        if (await run()) updated++; else failed++;
        if (stopped) break;
      }
      setRefreshStatus(stopped ? `Refreshed ${updated} of ${docs.length}. ${stopped}` : failed ? `Refreshed ${updated} of ${docs.length}. ${failed} could not run; open ${failed === 1 ? 'it' : 'them'} to see the error.` : `Refreshed ${updated === 1 ? 'this analysis' : `all ${updated} analyses`} with current data.`);
    } catch {
      setRefreshStatus(`Refresh stopped. ${updated} of ${docs.length} updated; the rest keep their saved results.`);
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); setRefreshing(false); setJobStatus(null); }
    }
  }
  const dashboardRefresh: DashboardRefresh = { run: docs => void refreshCards(docs), stop: () => request.current?.abort(), running: refreshing, available: capability.researchEnabled === true && capability.jobsEnabled === true && !sqlBlocked, status: refreshStatus, challenge: authenticatedStaging ? undefined : <AskChallenge siteKey={capability.siteKey} onToken={setToken} reset={challengeReset}/> };
  function editQuery(message: Message) {
    const sql=message.sql || (message.research ? displaySQL(message.research.query.sql) : undefined);
    if(!sql||busy)return;
    setSQLInput(sql);setSQLLimit(message.research?.query.limit || 100);setInputMode('sql');setNotice('Query loaded for editing. Choose Run SQL when ready.');
    requestAnimationFrame(()=>{input.current?.focus();input.current?.scrollIntoView({block:'center'});});
  }
  function selectSQL(sql: string) {
    if (busy) return;
    if (sql.length > 8192) { setChatError('SQL can contain up to 8,192 characters. Shorten the query before pasting it.'); return; }
    setSQLInput(sql); setInputMode('sql'); setChatError('');
    setNotice('SQL detected. Review it, then choose Run SQL. No AI request was sent.');
    requestAnimationFrame(() => input.current?.focus());
  }
  function changeMode(mode: 'ask' | 'sql') {
    if (busy) return;
    setInputMode(mode); setChatError(''); setNotice(''); setSQLProblem(null);
    requestAnimationFrame(() => input.current?.focus());
  }
  function editAction(message: Message) {
    return message.research ? <button disabled={busy} onClick={() => editQuery(message)}>Edit SQL</button> : null;
  }
  // Explain sits in the result toolbar with the other result actions.
  function explainAction(message: Message) {
    if (!message.sql || !message.research || message.explained || message.state !== 'complete' || capability.mode !== 'ai' || !(message.ticket || capability.jobsEnabled)) return null;
    const refresh = !message.ticket;
    return <button type="button" data-tone="accent" className={styles.explainAction} disabled={busy || aiBlocked || refresh && (!verified || sqlBlocked)} aria-busy={explainingId === message.id} onClick={() => void explainSQL(message)} aria-describedby={`explain-note-${message.id}`}>{explainingId === message.id ? 'Explaining…' : refresh ? 'Refresh & explain' : 'Explain results'}<span id={`explain-note-${message.id}`} className="sr-only">{refresh ? 'Runs this SQL again for current data, then writes a short summary using only numbers from the new results. Uses your SQL and AI allowances.' : 'Writes a short summary using only numbers from these results. Uses your AI allowance.'}</span></button>;
  }
  function resultActions(message: Message, includeEdit = true) {
    return <>{explainAction(message)}{includeEdit ? editAction(message) : null}<button aria-haspopup="dialog" onClick={() => setExpanded(message)}>Expand results ↗</button></>;
  }
  function renderRecords(message: Message, expandedView = false) {
    const sources = message.sources?.length || message.dataContext ? <AskSources inline sources={message.sources || []} dataContext={message.dataContext} /> : undefined;
    if (message.research) return message.id === latestRecords?.id ? <ResearchPanel embedded={!expandedView} actions={expandedView ? undefined : explainAction(message)} trailing={expandedView ? undefined : <button className={styles.expandAction} aria-haspopup="dialog" onClick={() => setExpanded(message)}>Expand results ↗</button>} editAction={editAction(message)} onSaved={markSaved} sources={sources} saved={message.savedSnapshot} tools={tools} result={message.research} busy={busy} titleId={expandedView ? 'expanded-analysis-title' : undefined}/> : <div className="p-5"><ResearchData result={message.research} sources={sources} savedSnapshot={message.savedSnapshot} chart={message.sql ? {view:'table',x:0,y:0} : suggestResearchChart(message.research)}/></div>;
    return <div className="p-4 sm:p-5"><AskAnalytics result={message.analytics}/><AskBlocks result={message.blocks} expanded/><AskTransactions result={message.transactions} expanded/>{message.transfers ? <AskTransfers result={message.transfers}/> : null}</div>;
  }
  const sqlMode = inputMode === 'sql';
  const datasets = catalogueFor(capability.researchExtended === true);
  const sqlErrorLine = sqlProblem && sqlProblem.sql === sqlInput ? editorPosition(sqlProblem.feedback, sqlInput)?.line ?? null : null;
  const insertSQL = (text: string) => { if (!sqlInsert.current?.(text)) setSQLInput(value => value + text); };
  const canSend = sqlMode ? capabilityReady && verified && !!sqlInput.trim() && !tools.importing && !sqlBlocked : !!question.trim() && !feedback.requestBlocked && ((capabilityReady && (capability.mode !== 'ai' || verified)) || !!resolveShortcut(question, spec));
  const submit = () => sqlMode ? void runSQL() : void ask(question);
  const statusTitle = jobStatus?.state === 'queued' ? 'Waiting to start…' : jobStatus?.state === 'running' ? 'Running your query…' : phase === 'explaining' ? 'Explaining the results…' : phase === 'submitting' ? 'Checking your query…' : progress ? progressTitles[progress] : 'Thinking…';
  const statusDetail = jobStatus?.state === 'queued' ? 'Waiting for an available query slot.' : !jobStatus && phase === 'thinking' && progress === 'repairing' ? 'The first query did not run cleanly, so Zift is correcting it.' : undefined;
  const composer = <div className={styles.composerGroup}><form onSubmit={event => { event.preventDefault(); submit(); }} className={styles.composer} aria-busy={busy}>
    {sqlMode ? <SQLEditor value={sqlInput} onChange={setSQLInput} onRun={() => { if (!busy && canSend) submit(); }} datasets={datasets} errorAt={sqlErrorLine} disabled={busy} autoFocus onInsertReady={insert => { sqlInsert.current = insert; }} /> : <>
    <label htmlFor="ask-question" className="sr-only">Ask a question about Zcash</label>
    <textarea ref={input} id="ask-question" value={sqlMode ? sqlInput : question} dir={sqlMode ? 'ltr' : 'auto'} disabled={busy} onChange={event => sqlMode ? setSQLInput(event.target.value) : setQuestion(event.target.value)} rows={sqlMode && sqlInput ? 9 : hasMessages ? 2 : 3} maxLength={sqlMode ? 8192 : 1000}
      className={sqlMode && sqlInput ? styles.sqlInput : undefined} spellCheck={!sqlMode} autoComplete="off" aria-describedby="ask-input-hint"
      placeholder={sqlMode ? 'SELECT height, transactions FROM blocks ORDER BY height DESC LIMIT 10' : hasMessages ? 'Ask a follow-up, or refine this view…' : 'Ask about Zcash, or paste a SQL query…'}
      onPaste={event => { if (sqlMode || !capability.researchEnabled) return; const sql = sqlDraft(event.clipboardData.getData('text')); if (sql) { event.preventDefault(); selectSQL(sql); } }}
      onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && (sqlMode ? event.metaKey || event.ctrlKey : !event.shiftKey)) { event.preventDefault(); if (!busy && canSend) submit(); } }} /></>}
    <div className={styles.composerActions}><div className={styles.composerModes} role="group" aria-label="Input mode">
      <button type="button" aria-pressed={!sqlMode} disabled={busy} onClick={() => changeMode('ask')}>Ask</button>
      {capability.researchEnabled ? <button type="button" aria-pressed={sqlMode} disabled={busy} onClick={() => changeMode('sql')}>SQL</button> : null}
    </div>{sqlMode ? <label className={styles.rowLimit}>Rows<span className={styles.selectWrap}><select aria-label="Maximum rows" disabled={busy} value={sqlLimit} onChange={event => setSQLLimit(Number(event.target.value))}>{[10,50,100,200].map(value => <option key={value}>{value}</option>)}</select></span></label> : null}
      {busy ? <button type="button" className={styles.submit} onClick={() => request.current?.abort()} aria-label="Stop request">■</button>
        : <button type="submit" className={sqlMode ? styles.runSQL : styles.submit} disabled={!canSend} aria-label={sqlMode ? 'Run SQL' : 'Send question'}>{sqlMode ? 'Run SQL' : '↑'}</button>}
    </div>
  </form>{sqlMode ? <SQLTables datasets={datasets} onInsert={insertSQL} /> : null}<p id="ask-input-hint" className={styles.inputHint}>{sqlMode ? 'Direct SQL · no AI · Ctrl / ⌘ + Enter to run · Ctrl + Space suggests names' : !capabilityReady ? 'Connecting to Zift…' : capability.mode === 'ai' ? 'Ask AI · Enter to send · Shift + Enter for a new line' : 'Guides & public data · Enter to send'}</p>
    <div ref={composerStatus}>{busy && !hasMessages ? <AskFeedback working title={statusTitle} detail={statusDetail}/> : sqlMode && sqlProblem ? <SQLProblem feedback={sqlProblem.feedback} sql={sqlProblem.sql}/> : feedback.failure ? <AskFailureFeedback failure={feedback.failure} blocked={feedback.failureBlocked} onRetry={submit}/> : connectionFailed ? <AskFeedback error title="Could not connect to Zift" detail="Your draft is still here. Check your connection and try again." onRetry={() => {setConnectionFailed(false);reconnect.current();}} retryLabel="Reconnect"/> : chatError ? <AskFeedback error title="Check your request" detail={chatError}/> : notice ? <AskFeedback title={notice}/> : null}</div>
    {authenticatedStaging ? null : <AskChallenge siteKey={capability.siteKey} onToken={setToken} reset={challengeReset}/>}
  </div>;

  return <div className={styles.workspace} ref={workspace}>
    <aside className={styles.sidebar} aria-label="Ask workspace navigation">
      <button type="button" onClick={newSession} className={styles.newButton} disabled={busy || tools.importing}><span aria-hidden="true">＋</span> New analysis</button>
      {sessions.some(item => item.messages.length) ? <label className={styles.mobileSessions}><span className="sr-only">Recent analyses</span><select aria-label="Recent analyses" value={activeId} onChange={event => switchSession(Number(event.target.value))}>{sessions.map(item => <option key={item.id} value={item.id}>{sessionTitle(item)}</option>)}</select></label> : null}
      <div className={styles.sidebarContent}>
        {sessions.some(item => item.messages.length) ? <><p className={styles.sidebarHeading}>RECENT ANALYSES</p>{sessions.filter(item => item.messages.length).map(item => { const title = sessionTitle(item); return <button key={item.id} className={`${styles.session} ${activeId === item.id && !tools.boardId ? styles.selectedSession : ''}`} aria-current={activeId === item.id && !tools.boardId ? 'true' : undefined} onClick={() => switchSession(item.id)} title={title}>{title}</button>; })}</> : null}
        {capability.researchEnabled || tools.library.documents.length ? <section aria-labelledby="ask-saved-heading">
          <p id="ask-saved-heading" className={`${styles.sidebarHeading} ${styles.savedHeading}`}><svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12"><path d="M4 2.5h8v11l-4-2.8-4 2.8z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>SAVED{tools.library.documents.length ? <span className={styles.countPill}>{tools.library.documents.length}</span> : null}</p>
          <ResearchLibrary tools={tools} busy={busy} onOpen={openSaved} compact/>
        </section> : null}
        <details className={styles.sidebarDisclosure}><summary>Explore data</summary>
          <Link href="/pools" className={styles.sourceLink}>Shielded pools <span>↗</span></Link>
          <Link href="/ironwood" className={styles.sourceLink}>Ironwood <span>↗</span></Link>
          <Link href="/crosschain" className={styles.sourceLink}>Cross-chain swaps <span>↗</span></Link>
          <Link href="/pulse" className={styles.sourceLink}>Network Pulse <span>↗</span></Link>
          <Link href="/rich-list" className={styles.sourceLink}>Transparent addresses <span>↗</span></Link>
          <Link href="/privacy" className={styles.sourceLink}>Privacy score <span>↗</span></Link>
          <Link href="/charts" className={styles.sourceLink}>Chart library <span>↗</span></Link>
        </details>
        <Link href="/docs/mcp" className={styles.mcpLink}><span>Use in Claude or Codex <span aria-hidden="true">↗</span></span><small>Via the ZecBlock MCP server</small></Link>
      </div>
      <p className={styles.sessionNote}>Your library stays on this device.</p>
    </aside>
    {capability.researchEnabled || tools.library.documents.length ? <details className={styles.mobileLibraryAccess}><summary>Library{tools.library.documents.length ? ` · ${tools.library.documents.length}` : ''}</summary><ResearchLibrary tools={tools} busy={busy} onOpen={openSaved}/></details> : null}

    <div className={`${styles.main} ${hasMessages && !tools.boardId ? styles.threadMain : ''}`}>
      {sharedResearch ? <SharedResearchDraft share={sharedResearch} tools={tools} busy={busy} enabled={capability.researchEnabled === true} onDismiss={() => setSharedResearch(null)} onOpen={doc => { openSaved(doc, true); setSharedResearch(null); }} /> : null}
      {tools.boardId ? <ResearchDashboard tools={tools} busy={busy} onOpen={openSaved} refresh={dashboardRefresh}/> : !hasMessages ? <div className={styles.welcome}>
        <h2 className={styles.welcomeTitle}>What would you like to explore?</h2>
        {composer}
        {sqlMode ? <SQLStarters examples={examplesFor(capability.researchExtended === true).slice(0, 4)} disabled={busy} onPick={example => { setSQLInput(example.sql); tools.setTitle(example.title); setSQLProblem(null); setNotice(`${example.title}: edit it or press Run SQL.`); }} /> : <>
        <div className={styles.starterQuestions}>{featured.map(starter => <button key={starter.id} className={styles.followup} onClick={() => void ask(starter.title)}>{starter.title}</button>)}</div>
        <details className={styles.moreExamples}><summary>More examples</summary><div className="flex flex-wrap gap-2 mt-4" role="group" aria-label="Example question categories">{categories.map(category => <button type="button" key={category} aria-pressed={exampleCategory === category} onClick={() => setExampleCategory(category)} className={`${styles.followup} ${exampleCategory === category ? styles.selectedCategory : ''}`}>{category}</button>)}</div><div className={styles.starters}>{examples.map(starter => <button key={starter.id} onClick={() => void ask(starter.title)} className={styles.starter}><span className="block text-sm text-primary font-medium">{starter.title}</span><span className="block mt-2 text-xs text-muted leading-relaxed">{starter.detail}</span></button>)}</div></details></>}
        {capability.mode === 'ai' && !sqlMode ? <p className={styles.privacyNote}>Questions and conversation context are sent to {capability.provider}. Use public information only.</p> : null}
      </div> : <>
        <section className={styles.conversation} aria-label="Conversation">
          <div className={`${styles.transcript} ${styles.threadTranscript}`} ref={transcript}>
            {session.messages.map(message => <div key={message.id} ref={message.id === session.messages.at(-1)?.id ? latestTurn : undefined} className="mb-7">
              <div className={styles.sentMessage}>{message.sql ? <><span className={styles.sqlPreview}>{message.sql.split('\n').slice(0,3).join('\n')}</span><details className={styles.sentSQL}><summary>View submitted SQL</summary><div className={styles.sentCode}><pre translate="no">{message.sql}</pre><span className={styles.sentCopy}><CopyButton text={message.sql} label="SQL" className={styles.copyButton} /></span></div></details></> : message.question}</div>
              <article className={styles.assistantReply} aria-label="Zift response"><AskMark small /><div className={styles.replyBody}><p className="text-caption font-mono text-muted mb-2">Zift</p>{message.state === 'pending' ? <AskFeedback working title={statusTitle} detail={statusDetail}/> : null}{explainingId === message.id ? <AskFeedback working title={statusTitle} detail={statusDetail}/> : null}<p dir="auto" lang={message.locale} className="text-sm text-secondary leading-relaxed whitespace-pre-wrap">{message.answer}</p>{explainError?.id === message.id ? <AskFeedback error title="Could not explain these results" detail={explainError.text}/> : null}{message.scope ? <p className="mt-2 text-caption text-muted">{message.scope}</p> : null}
              {message.spec ? <AskAnalysis spec={message.viewSpec || message.spec} changed={!!message.viewSpec && analysisScopeKey(message.viewSpec) !== analysisScopeKey(message.spec)} onChange={next => {
                const previous = message.viewSpec || message.spec!;
                const validated = analysisSchema.parse(next.period !== previous.period || next.pool !== previous.pool || next.metric !== previous.metric ? {...next, start:null, end:null} : next);
                setSessions(all => all.map(item => item.id === activeId ? {...item, spec:validated, messages:item.messages.map(turn => turn.id === message.id ? {...turn, viewSpec:validated} : turn)} : item));
              }} sources={message.sources?.length || message.dataContext ? <AskSources inline sources={message.sources || []} dataContext={message.dataContext} /> : undefined} onExplain={() => void ask('Explain this view', message.viewSpec || message.spec!)} canExplain={capability.mode === 'ai' && verified && !aiBlocked} busy={busy}/> : null}
              {message.research || message.analytics || message.blocks || message.transactions || message.transfers ? <div className={styles.replyResults} role="group" aria-label="Query results">{message.research && message.id === latestRecords?.id ? null : <div className={styles.resultActions}>{resultActions(message)}</div>}{renderRecords(message)}</div> : message.sql && message.state !== 'pending' ? <button className={styles.followup} disabled={busy} onClick={()=>editQuery(message)}>Edit query</button> : null}
              {!message.research && !message.spec ? <AskSources sources={message.sources || []} dataContext={message.dataContext} /> : null}
              {(!message.state || message.state === 'complete') && message.answer ? <AskAnswerRating key={message.id} route={message.sql ? 'sql' : message.route} template={message.template} locale={message.locale} page={session.page || 'ask'} question={message.sql ? 'SQL query' : message.question} answer={message.answer} sql={message.sql || message.research?.query.sql}/> : null}
              </div></article>
            </div>)}

          </div>
          <div className={styles.conversationFooter}>
            <div className="flex flex-wrap gap-2 mb-3">{(spec ? ranking ? ['Show as a bar chart', 'Show as a table'] : ['Show 90 days', poolMetric ? spec.pool === 'ironwood' ? 'Just Orchard' : 'Just Ironwood' : 'Show as a line chart', 'Show as a table'] : transactions ? ['Show the latest 5 transactions', 'Explain this transaction'] : blocks ? ['Tell me about the latest block', 'Explain this block'] : research ? researchFollowUps(research) : starters.slice(0, 2).map(item => item.title)).map(text => <button key={text} disabled={busy} onClick={() => void ask(text)} className={styles.followup}>{text}</button>)}</div>
            {composer}{!sqlMode ? <p className={styles.privacyNote}>{capability.mode === 'ai' ? `Questions and conversation context are sent to ${capability.provider}. Use public information only.` : 'Guided preview · No AI provider connected.'}</p> : null}<p className={styles.privacyNote}>Answer ratings count only the vote, reason, answer type, language and page, for 30 days. The question and answer are kept only when you tick Share on a rating. <a href="/privacy-policy" className="underline">Privacy policy</a></p>
          </div>
        </section>


      </>}
    </div>
    <dialog ref={resultDialog} className={styles.resultDialog} aria-labelledby="expanded-result-title" onClose={()=>setExpanded(null)}>
      {expanded ? <><div className={styles.dialogHeader}><h2 id="expanded-result-title">Results</h2><button autoFocus onClick={()=>resultDialog.current?.close()}>Back to conversation ×</button></div>{renderRecords(expanded, true)}</> : null}
    </dialog>
    <span className="sr-only" role="status" aria-live="polite">{busy ? '' : session.messages.at(-1)?.answer ?? ''}</span>
  </div>;
}
