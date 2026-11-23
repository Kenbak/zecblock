'use client';

import { readApiData } from '@/lib/api-client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { getApiUrl } from '@/lib/api-config';
import { Card, CardHeader, CardBody } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';

interface PeriodResult {
  total: number;
  shields: number;
  deshields: number;
}

interface NearbyAmount {
  amount: number;
  count: number;
  blendScore: number;
}

interface CheckResult {
  amount: number;
  amountZat: number;
  periods: {
    '24h': PeriodResult;
    '7d': PeriodResult;
    '30d': PeriodResult;
    'all': PeriodResult;
  };
  blendScore: number;
  blendLabel: string;
  nearbyPopular: NearbyAmount[];
}

interface SplitPiece {
  amount: number;
  blendScore: number;
  blendLabel: string;
  count30d: number;
  isRemainder: boolean;
}

interface SplitPlan {
  pieceCount: number;
  pieces: SplitPiece[];
  minBlendScore: number;
  avgBlendScore: number;
  overallLabel: string;
  recommended?: boolean;
}

interface SplitResult {
  amount: number;
  originalScore: number;
  plans: SplitPlan[];
}

function formatNumber(n: number | undefined): string {
  if (n == null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function formatZec(n: number): string {
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(4);
  return n.toFixed(8);
}

function getScoreColor(score: number): string {
  if (score >= 70) return 'text-cipher-green';
  if (score >= 40) return 'text-cipher-orange';
  return 'text-danger';
}

function getScoreBg(score: number): string {
  if (score >= 70) return 'bg-cipher-green';
  if (score >= 40) return 'bg-cipher-orange';
  return 'bg-danger';
}

function getScoreBadgeColor(score: number): 'green' | 'orange' | 'muted' {
  if (score >= 70) return 'green';
  if (score >= 40) return 'orange';
  return 'muted';
}

function getVerdict(score: number): { headline: string; body: string } {
  if (score >= 70) return {
    headline: 'You blend in',
    body: 'This amount is common on-chain. Your transaction will look like thousands of others.',
  };
  if (score >= 40) return {
    headline: 'You partially blend in',
    body: 'This amount is somewhat common, but a rounder number would give you better cover.',
  };
  return {
    headline: 'You stand out',
    body: 'This amount is rare on-chain. An observer could link your deposit to a future withdrawal.',
  };
}

export default function BlendCheckPage() {
  const [amount, setAmount] = useState('');
  const [result, setResult] = useState<CheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [splitResult, setSplitResult] = useState<SplitResult | null>(null);
  const [selectedPlanIdx, setSelectedPlanIdx] = useState(0);
  const [copied, setCopied] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout>(null);
  const abortRef = useRef<AbortController>(null);

  const fetchCheck = useCallback(async (amt: string) => {
    const parsed = parseFloat(amt);
    if (isNaN(parsed) || parsed <= 0) {
      setResult(null);
      setSplitResult(null);
      setError('');
      return;
    }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError('');

    try {
      const [blendRes, splitRes] = await Promise.all([
        fetch(
          `${getApiUrl()}/v1/privacy/blend-check?amount=${parsed}`,
          { signal: controller.signal }
        ),
        fetch(
          `${getApiUrl()}/v1/privacy/blend-check/split?amount=${parsed}`,
          { signal: controller.signal }
        ),
      ]);

      if (!blendRes.ok) throw new Error(`API error: ${blendRes.status}`);
      const blendData = await readApiData(blendRes);
      setResult(blendData);

      if (splitRes.ok) {
        const splitData = await readApiData(splitRes);
        setSplitResult(splitData);
        setSelectedPlanIdx(0);
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== 'AbortError') {
        setError('Failed to check amount');
        console.error(e);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!amount) { setResult(null); setSplitResult(null); return; }

    debounceRef.current = setTimeout(() => fetchCheck(amount), 500);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [amount, fetchCheck]);

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === '' || /^\d*\.?\d*$/.test(val)) {
      setAmount(val);
    }
  };

  const handleSuggestionClick = (amt: number) => {
    setAmount(formatZec(amt));
  };

  const hasResult = result && !loading;
  const score = result?.blendScore ?? 0;
  const verdict = getVerdict(score);
  const crowd30d = result?.periods['30d'].total ?? 0;

  const bestNearby = hasResult && score < 70
    ? result.nearbyPopular.find(np => np.blendScore > score && Math.abs(np.amount - result.amount) / result.amount < 0.5)
    : null;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      {/* Header */}
      <div className="mb-8 animate-fade-in">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-muted opacity-50 font-mono text-xs">{'>'}</span>
          <span className="text-xs font-mono text-muted uppercase tracking-wider">BLEND_CHECK</span>
        </div>
        <h1 className="type-page text-primary ">
          Blend Check
        </h1>
        <p className="text-sm text-secondary mt-2 max-w-lg">
          Check if your amount blends in with the crowd before shielding.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
        {/* ── Left Column: Input + Score + Split ── */}
        <div className="space-y-6 animate-fade-in-up stagger-2">

          {/* Amount input */}
          <Card>
            <CardHeader>
              <h2 className="text-sm font-semibold text-secondary lowercase tracking-tight">
                How much are you shielding?
              </h2>
            </CardHeader>
            <CardBody>
              <div className="relative">
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={handleAmountChange}
                  placeholder="0.00"
                  className="w-full px-5 py-4 rounded-xl border border-cipher-border bg-cipher-hover text-2xl font-mono text-primary placeholder:text-muted focus:outline-none focus:border-cipher-gold/40 focus:shadow-[0_0_0_3px_rgba(248,188,33,0.06)] transition"
                  autoFocus
                />
                <span className="absolute right-5 top-1/2 -translate-y-1/2 text-muted font-mono text-lg">
                  ZEC
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {[0.1, 1, 2.5, 5, 10, 25, 50, 100].map((q) => (
                  <button
                    key={q}
                    onClick={() => handleSuggestionClick(q)}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-mono transition ${
                      amount === formatZec(q)
                        ? 'border-cipher-gold/40 bg-brand-gold/10 text-cipher-gold'
                        : 'border-cipher-border text-muted hover:text-primary hover:border-white/[0.12]'
                    }`}
                  >
                    {q}
                  </button>
                ))}
              </div>

              {loading && (
                <div className="flex items-center gap-2 text-muted text-xs font-mono mt-5">
                  <div className="animate-spin rounded-full h-3 w-3 border border-cipher-gold border-t-transparent" />
                  Scanning shielded pool...
                </div>
              )}

              {error && (
                <div className="text-danger text-xs font-mono mt-5">{error}</div>
              )}
            </CardBody>
          </Card>

          {/* Verdict */}
          {hasResult && (
            <Card className="animate-fade-in-up stagger-3">
              <CardBody>
                <div className="flex items-start gap-4">
                  <div className={`w-14 h-14 rounded-xl flex items-center justify-center shrink-0 ${getScoreBg(score)}/10 border border-cipher-border`}>
                    <span className={`text-2xl font-semibold font-mono ${getScoreColor(score)}`}>
                      {score}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h2 className={`text-lg font-semibold ${getScoreColor(score)}`}>
                        {verdict.headline}
                      </h2>
                      <Badge color={getScoreBadgeColor(score)}>{score}/100</Badge>
                    </div>
                    <p className="text-sm text-secondary">
                      {verdict.body}
                    </p>
                    <p className="text-xs text-muted font-mono mt-3">
                      <span className="text-primary font-semibold">{formatNumber(crowd30d)}</span> similar transactions in the last 30 days
                    </p>
                  </div>
                </div>
                <div className="mt-4 w-full h-1.5 rounded-full bg-cipher-hover overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-[width,background-color] duration-700 ${getScoreBg(score)}`}
                    style={{ width: `${Math.max(score, 3)}%` }}
                  />
                </div>
              </CardBody>
            </Card>
          )}

          {/* Quick suggestion */}
          {bestNearby && (
            <Card interactive onClick={() => handleSuggestionClick(bestNearby.amount)} className="animate-fade-in-up stagger-4">
              <CardBody>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-primary">
                      Try <span className="font-mono font-semibold text-cipher-gold">{formatZec(bestNearby.amount)} ZEC</span> instead?
                    </p>
                    <p className="text-xs text-muted mt-0.5">
                      {formatNumber(bestNearby.count)} others used this amount recently
                    </p>
                  </div>
                  <svg className="w-4 h-4 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </CardBody>
            </Card>
          )}

          {/* Split Plan */}
          {splitResult && hasResult && (
            <Card className="animate-fade-in-up stagger-5">
              <CardHeader>
                <h2 className="text-sm font-semibold text-secondary lowercase tracking-tight">
                  Split Plan
                </h2>
              </CardHeader>
              <CardBody>
                {splitResult.plans.length === 0 ? (
                  <div className="text-center py-4">
                    <p className="text-sm text-muted">
                      No split improves your privacy for this amount.
                    </p>
                    <p className="text-xs text-muted mt-2">
                      {bestNearby ? (
                        <>Try rounding to <button onClick={() => handleSuggestionClick(bestNearby.amount)} className="text-cipher-gold font-mono hover:underline">{formatZec(bestNearby.amount)} ZEC</button> instead.</>
                      ) : (
                        <>Try a round number like <button onClick={() => handleSuggestionClick(1)} className="text-cipher-gold font-mono hover:underline">1</button>, <button onClick={() => handleSuggestionClick(5)} className="text-cipher-gold font-mono hover:underline">5</button>, or <button onClick={() => handleSuggestionClick(10)} className="text-cipher-gold font-mono hover:underline">10 ZEC</button>.</>
                      )}
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="text-xs text-muted mb-5">
                      {score >= 70
                        ? 'Already blends well — splitting adds extra privacy.'
                        : 'Break your amount into pieces that each blend in better than the original.'}
                    </p>

                    {/* Plan tabs */}
                    <div className="flex flex-wrap gap-2 mb-5">
                      {splitResult.plans.map((plan, i) => (
                        <button
                          key={i}
                          onClick={() => setSelectedPlanIdx(i)}
                          className={`px-3 py-1.5 rounded-lg border text-xs font-mono transition ${
                            selectedPlanIdx === i
                              ? 'border-cipher-gold/40 bg-brand-gold/10 text-cipher-gold'
                              : 'border-cipher-border text-muted hover:text-primary hover:border-white/[0.12]'
                          }`}
                        >
                          {plan.pieceCount} tx{plan.pieceCount !== 1 ? 's' : ''}
                          {plan.recommended && (
                            <span className="ml-1.5 text-cipher-green">best</span>
                          )}
                        </button>
                      ))}
                    </div>

                    {/* Selected plan */}
                    {(() => {
                      const plan = splitResult.plans[selectedPlanIdx];
                      if (!plan) return null;

                      return (
                        <>
                          <div className="space-y-0">
                            {plan.pieces.map((piece, i) => (
                              <div key={i} className="flex items-stretch">
                                {/* Connector */}
                                <div className="w-7 flex flex-col items-center shrink-0">
                                  <div className={`w-2.5 h-2.5 rounded-full shrink-0 border-2 ${
                                    piece.blendScore >= 70
                                      ? 'border-cipher-green bg-cipher-green/20'
                                      : piece.blendScore >= 40
                                      ? 'border-cipher-orange bg-cipher-orange/20'
                                      : 'border-danger bg-danger/20'
                                  }`} />
                                  {i < plan.pieces.length - 1 && (
                                    <div className="w-px flex-1 bg-cipher-border my-0.5" />
                                  )}
                                </div>

                                {/* Piece */}
                                <div className={`flex-1 mb-2 px-4 py-3 rounded-lg border transition ${
                                  piece.isRemainder && piece.blendScore < 40
                                    ? 'border-cipher-orange/20 bg-cipher-orange/5'
                                    : 'border-cipher-border bg-cipher-hover'
                                }`}>
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                      <span className="font-mono text-sm font-semibold text-primary">
                                        {formatZec(piece.amount)} ZEC
                                      </span>
                                      {piece.isRemainder && (
                                        <Badge color="orange">leftover</Badge>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <div className="w-10 h-1 rounded-full bg-cipher-hover overflow-hidden">
                                        <div
                                          className={`h-full rounded-full ${getScoreBg(piece.blendScore)}`}
                                          style={{ width: `${Math.max(piece.blendScore, 5)}%` }}
                                        />
                                      </div>
                                      <span className={`text-caption font-mono ${getScoreColor(piece.blendScore)}`}>
                                        {piece.blendScore}
                                      </span>
                                    </div>
                                  </div>
                                  <p className="text-caption text-muted mt-1 font-mono">
                                    {piece.isRemainder && piece.blendScore < 40
                                      ? 'Shield this separately, at a different time'
                                      : piece.blendScore >= 70
                                      ? `Blends in — ${formatNumber(piece.count30d)} similar txs recently`
                                      : `${formatNumber(piece.count30d)} similar txs recently`
                                    }
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>

                          {/* Footer */}
                          <div className="mt-4 pt-3 border-t border-cipher-border flex items-center justify-between">
                            <p className="text-xs text-muted font-mono">
                              Weakest piece: <span className={getScoreColor(plan.minBlendScore)}>{plan.minBlendScore}/100</span>
                              <span className="text-muted ml-2">
                                (was {score})
                              </span>
                            </p>
                            <button
                              onClick={() => {
                                const text = plan.pieces
                                  .map((p, i) => `${i + 1}. ${formatZec(p.amount)} ZEC${p.isRemainder ? ' (shield later)' : ''}`)
                                  .join('\n');
                                navigator.clipboard.writeText(text);
                                setCopied(true);
                                setTimeout(() => setCopied(false), 2000);
                              }}
                              className="text-xs font-mono text-cipher-gold hover:text-cipher-green transition-colors flex items-center gap-1.5"
                            >
                              {copied ? (
                                <>
                                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                  </svg>
                                  Copied
                                </>
                              ) : (
                                <>
                                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                  </svg>
                                  Copy amounts
                                </>
                              )}
                            </button>
                          </div>
                        </>
                      );
                    })()}
                  </>
                )}
              </CardBody>
            </Card>
          )}
        </div>

        {/* ── Right Column: Results + Nearby + Explainer ── */}
        <div className="space-y-6 animate-fade-in-up stagger-3">

          {hasResult ? (
            <>
              {/* Period breakdown */}
              <Card>
                <CardHeader>
                  <h2 className="text-sm font-semibold text-secondary lowercase tracking-tight">
                    Shielded Pool Matches
                  </h2>
                </CardHeader>
                <CardBody>
                  <div className="grid grid-cols-2 gap-3">
                    {(['24h', '7d', '30d', 'all'] as const).map((p) => {
                      const d = result.periods[p];
                      const labels: Record<string, string> = { '24h': '24 Hours', '7d': '7 Days', '30d': '30 Days', 'all': 'All Time' };
                      return (
                        <div key={p} className="rounded-xl border border-cipher-border bg-cipher-hover p-4">
                          <div className="text-caption font-mono text-muted uppercase tracking-wider mb-2">
                            {labels[p]}
                          </div>
                          <div className="text-xl font-semibold font-mono text-primary">
                            {formatNumber(d.total)}
                          </div>
                          <div className="flex items-center gap-3 mt-2">
                            <div className="flex items-center gap-1">
                              <div className="w-1.5 h-1.5 rounded-full bg-cipher-green/60" />
                              <span className="text-caption font-mono text-muted">
                                {formatNumber(d.shields)} in
                              </span>
                            </div>
                            <div className="flex items-center gap-1">
                              <div className="w-1.5 h-1.5 rounded-full bg-cipher-purple/60" />
                              <span className="text-caption font-mono text-muted">
                                {formatNumber(d.deshields)} out
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-4 pt-3 border-t border-cipher-border flex items-center gap-4 text-caption font-mono text-muted">
                    <div className="flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-cipher-green/60" />
                      <span>in = shielding (t → z)</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-cipher-purple/60" />
                      <span>out = deshielding (z → t)</span>
                    </div>
                  </div>
                </CardBody>
              </Card>

              {/* Popular amounts nearby */}
              {result.nearbyPopular.length > 0 && (
                <Card>
                  <CardHeader>
                    <h2 className="text-sm font-semibold text-secondary lowercase tracking-tight">
                      Popular Nearby
                    </h2>
                  </CardHeader>
                  <CardBody>
                    <div className="space-y-1">
                      {result.nearbyPopular.slice(0, 8).map((np, i) => {
                        const isSelected = Math.abs(np.amount - result.amount) / result.amount < 0.02;
                        return (
                          <button
                            key={i}
                            onClick={() => handleSuggestionClick(np.amount)}
                            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border transition text-left group ${
                              isSelected
                                ? 'border-cipher-gold/30 bg-brand-gold/5'
                                : 'border-transparent hover:border-cipher-border hover:bg-cipher-hover'
                            }`}
                          >
                            <span className={`font-mono text-sm w-24 shrink-0 ${isSelected ? 'text-cipher-gold font-semibold' : 'text-primary'}`}>
                              {formatZec(np.amount)}
                            </span>
                            <div className="flex-1 h-1.5 rounded-full bg-cipher-hover overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-[width,background-color] duration-500 ${getScoreBg(np.blendScore)}`}
                                style={{ width: `${Math.max(np.blendScore, 4)}%` }}
                              />
                            </div>
                            <span className={`text-xs font-mono w-8 text-right ${getScoreColor(np.blendScore)}`}>
                              {np.blendScore}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-caption text-muted font-mono mt-3">
                      Ranked by blend score. Click any amount to check it.
                    </p>
                  </CardBody>
                </Card>
              )}
            </>
          ) : !loading && (
            <Card className="flex items-center justify-center min-h-[300px]">
              <CardBody className="text-center">
                <p className="text-sm text-muted font-mono">
                  Enter an amount to see<br />how well it blends on-chain
                </p>
              </CardBody>
            </Card>
          )}

        </div>
      </div>

    </div>
  );
}
