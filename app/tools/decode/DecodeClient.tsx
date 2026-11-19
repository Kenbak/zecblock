'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/SectionHeader';
import { Card, CardBody } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { TxTypeBadge } from '@/components/ui/TxTypeBadge';
import { Tooltip } from '@/components/Tooltip';
import { parseZcashTransaction, type ParsedTransaction } from '@/lib/zcash-tx-parser';

// Icon components (same pattern as tx detail page)
const Icons = {
  Code: () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
    </svg>
  ),
  Shield: () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  ),
  Clock: () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  Database: () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
    </svg>
  ),
  ArrowLeft: () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 17l-5-5m0 0l5-5m-5 5h12" />
    </svg>
  ),
  ArrowRight: () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
    </svg>
  ),
  Currency: () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  Hash: () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
    </svg>
  ),
};

type TxType = 'COINBASE' | 'SHIELDED' | 'TRANSPARENT' | 'MIXED';

function deriveTxType(tx: ParsedTransaction): TxType {
  const isCoinbase = tx.vin.some((v) => !!v.coinbase);
  if (isCoinbase) return 'COINBASE';

  const hasTransparent = tx.vin.length > 0 || tx.vout.length > 0;
  const hasShielded = tx.nSpendsSapling > 0 || tx.nOutputsSapling > 0 || tx.orchardActions > 0 || tx.ironwoodActions > 0;

  if (hasTransparent && hasShielded) return 'MIXED';
  if (hasShielded) return 'SHIELDED';
  return 'TRANSPARENT';
}

function txTypeBadge(txType: TxType) {
  switch (txType) {
    case 'COINBASE':
      return <TxTypeBadge category="coinbase" icon={<Icons.Currency />} />;
    case 'SHIELDED':
      return <TxTypeBadge category="shielded" icon={<Icons.Shield />} />;
    case 'TRANSPARENT':
      return <TxTypeBadge category="transparent" />;
    case 'MIXED':
      return <TxTypeBadge category="mixed" icon={<Icons.Shield />} />;
  }
}

function generateSummary(tx: ParsedTransaction, txType: TxType): string {
  const parts: string[] = [];

  if (txType === 'COINBASE') {
    const totalOut = tx.vout.reduce((sum, o) => sum + o.value, 0);
    parts.push(`Coinbase transaction with ${tx.vout.length} output${tx.vout.length !== 1 ? 's' : ''}`);
    if (totalOut > 0) parts.push(`totaling ${totalOut.toFixed(4)} ZEC`);
    return parts.join(' ');
  }

  if (txType === 'SHIELDED') {
    if (tx.ironwoodActions > 0) return `Fully shielded transaction with ${tx.ironwoodActions} Ironwood actions, ${tx.orchardActions} Orchard actions and ${tx.nSpendsSapling + tx.nOutputsSapling} Sapling components`;
    if (tx.orchardActions > 0 && (tx.nSpendsSapling > 0 || tx.nOutputsSapling > 0)) {
      return `Fully shielded transaction with ${tx.orchardActions} Orchard action${tx.orchardActions !== 1 ? 's' : ''} and ${tx.nSpendsSapling + tx.nOutputsSapling} Sapling component${(tx.nSpendsSapling + tx.nOutputsSapling) !== 1 ? 's' : ''}`;
    }
    if (tx.orchardActions > 0) {
      return `Fully shielded transaction with ${tx.orchardActions} Orchard action${tx.orchardActions !== 1 ? 's' : ''}`;
    }
    return `Fully shielded Sapling transaction with ${tx.nSpendsSapling} spend${tx.nSpendsSapling !== 1 ? 's' : ''} and ${tx.nOutputsSapling} output${tx.nOutputsSapling !== 1 ? 's' : ''}`;
  }

  if (txType === 'MIXED') {
    const transparentIn = tx.vin.length;
    const transparentOut = tx.vout.length;
    const shieldedParts: string[] = [];
    if (tx.ironwoodActions > 0) shieldedParts.push(`${tx.ironwoodActions} Ironwood actions`);
    if (tx.orchardActions > 0) shieldedParts.push(`${tx.orchardActions} Orchard action${tx.orchardActions !== 1 ? 's' : ''}`);
    if (tx.nSpendsSapling > 0) shieldedParts.push(`${tx.nSpendsSapling} Sapling spend${tx.nSpendsSapling !== 1 ? 's' : ''}`);
    if (tx.nOutputsSapling > 0) shieldedParts.push(`${tx.nOutputsSapling} Sapling output${tx.nOutputsSapling !== 1 ? 's' : ''}`);

    return `Mixed transaction: ${transparentIn} transparent input${transparentIn !== 1 ? 's' : ''}, ${transparentOut} transparent output${transparentOut !== 1 ? 's' : ''} + ${shieldedParts.join(', ')}`;
  }

  // TRANSPARENT
  const totalOut = tx.vout.reduce((sum, o) => sum + o.value, 0);
  parts.push(`Transparent transaction: ${tx.vin.length} input${tx.vin.length !== 1 ? 's' : ''}, ${tx.vout.length} output${tx.vout.length !== 1 ? 's' : ''}`);
  if (totalOut > 0) parts.push(`totaling ${totalOut.toFixed(4)} ZEC`);
  return parts.join(' ');
}

// InfoRow component (same pattern as tx detail page)
function InfoRow({
  icon: Icon,
  label,
  value,
  tooltip,
  valueClass = 'text-primary',
}: {
  icon: React.ComponentType;
  label: string;
  value: React.ReactNode;
  tooltip?: string;
  valueClass?: string;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start py-3 border-b block-info-border last:border-0 gap-2 sm:gap-0">
      <div className="flex items-center min-w-[140px] sm:min-w-[200px] text-secondary">
        <span className="mr-2">
          <Icon />
        </span>
        <span className="text-xs sm:text-sm">{label}</span>
        {tooltip && (
          <span className="ml-2">
            <Tooltip content={tooltip} />
          </span>
        )}
      </div>
      <div className={`flex-1 font-mono text-xs sm:text-sm ${valueClass} break-all`}>{value}</div>
    </div>
  );
}

export default function DecodeClient() {
  const [rawHex, setRawHex] = useState('');
  const [result, setResult] = useState<ParsedTransaction | null>(null);
  const [error, setError] = useState('');
  const [showInputs, setShowInputs] = useState(false);
  const [showOutputs, setShowOutputs] = useState(false);
  const [jsonCopied, setJsonCopied] = useState(false);

  const handleDecode = () => {
    const hex = rawHex.trim().replace(/\s/g, '');
    if (!hex) {
      setError('Please enter a raw transaction hex.');
      return;
    }
    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      setError('Invalid hex string. Only characters 0-9 and a-f are allowed.');
      return;
    }

    setError('');
    setResult(null);

    try {
      const parsed = parseZcashTransaction(hex);
      setResult(parsed);
    } catch (err: any) {
      setError(err.message || 'Failed to parse transaction.');
    }
  };

  const handleClear = () => {
    setRawHex('');
    setResult(null);
    setError('');
  };

  const versionLabel = (tx: ParsedTransaction) => {
    if (tx.version === 6) return 'v6 (Ironwood)';
    if (tx.version === 5) return 'v5 (NU5)';
    if (tx.version === 4 && tx.fOverwintered) return 'v4 (Sapling)';
    if (tx.version === 3 && tx.fOverwintered) return 'v3 (Overwinter)';
    return `v${tx.version}`;
  };

  const txType = result ? deriveTxType(result) : null;

  // Compute totals for I/O summary
  const totalTransparentOutput = result
    ? result.vout.reduce((sum, o) => sum + o.value, 0)
    : 0;
  const totalInputCount = result
    ? result.vin.length + result.nSpendsSapling + result.orchardActions + result.ironwoodActions
    : 0;
  const totalOutputCount = result
    ? result.vout.length + result.nOutputsSapling + result.orchardActions + result.ironwoodActions
    : 0;
  const hasShielded = result
    ? (result.nSpendsSapling > 0 || result.nOutputsSapling > 0 || result.orchardActions > 0 || result.ironwoodActions > 0)
    : false;

  // Composition bar percentages (rough estimate based on component counts)
  const computeComposition = (tx: ParsedTransaction) => {
    const totalSize = tx.size;
    const hasShieldedData = tx.nSpendsSapling > 0 || tx.nOutputsSapling > 0 || tx.orchardActions > 0 || tx.ironwoodActions > 0;

    if (!hasShieldedData) {
      return { transparentBytes: totalSize, shieldedBytes: 0, transparentPct: 100, shieldedPct: 0 };
    }

    // Estimate: header ~12 bytes, each vin ~148 bytes, each vout ~34 bytes
    const headerBytes = 12;
    const vinBytes = tx.vin.length * 148;
    const voutBytes = tx.vout.length * 34;
    const transparentBytes = Math.min(headerBytes + vinBytes + voutBytes, totalSize);
    const shieldedBytes = Math.max(totalSize - transparentBytes, 0);

    const transparentPct = totalSize > 0 ? (transparentBytes / totalSize) * 100 : 100;
    const shieldedPct = totalSize > 0 ? (shieldedBytes / totalSize) * 100 : 0;

    return { transparentBytes, shieldedBytes, transparentPct, shieldedPct };
  };

  return (
    <>
      <PageHeader eyebrow="TOOLS" eyebrowHref="/tools" title="Decode Raw Transaction" subtitle="Parse a raw transaction hex into human-readable fields" />

      {/* Info */}
      <div className="mb-6 flex items-start gap-3 rounded-lg border border-cipher-border bg-cipher-card p-4 text-secondary">
        <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div>
          <p className="font-medium text-primary">Decoded in your browser</p>
          <p className="text-sm text-secondary mt-1">
            Transaction hex stays in your browser. Decoding works offline once this page has loaded.
          </p>
        </div>
      </div>

      {/* Input */}
      <Card>
        <CardBody>
          <div className="space-y-4">
            <div>
              <label htmlFor="raw-transaction-hex" className="input-label mb-2 block font-mono uppercase tracking-wider text-xs">
                Raw Transaction Hex
              </label>
              <textarea
                id="raw-transaction-hex"
                name="raw-transaction-hex"
                autoComplete="off"
                value={rawHex}
                onChange={(e) => setRawHex(e.target.value)}
                placeholder="Paste raw transaction hex here (e.g., 050000800a27a726...)"
                className="textarea-field"
                spellCheck={false}
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleDecode}
                disabled={!rawHex.trim()}
                className="btn btn-primary px-6 py-3 text-sm"
              >
                Decode Transaction
              </button>
              {(rawHex || result || error) && (
                <button
                  onClick={handleClear}
                  className="btn btn-secondary px-4 py-3 text-sm"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Error */}
      {error && (
        <div className="alert alert-error mt-6">
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p>{error}</p>
        </div>
      )}

      {/* Results */}
      {result && txType && (
        <div className="mt-6 space-y-6 animate-fade-in">
          {/* Success banner */}
          <div className="alert alert-success">
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p>Transaction decoded ({result.size.toLocaleString()} bytes)</p>
          </div>

          {/* Human-readable summary box */}
          <div className="tx-summary-box border border-cipher-border rounded-lg p-3 md:p-4">
            <div className="flex items-start gap-2 md:gap-3">
              <svg className="w-4 h-4 md:w-5 md:h-5 text-cipher-gold flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-secondary text-xs md:text-sm leading-relaxed">
                {generateSummary(result, txType)}
              </p>
            </div>
          </div>

          {/* Transaction Info + Composition -- side by side on large screens */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
            {/* Transaction Info Card with InfoRows -- takes 2/3 */}
            <Card className="lg:col-span-2">
              <CardBody className="space-y-0">
                <InfoRow
                  icon={Icons.Shield}
                  label="Type"
                  value={txTypeBadge(txType)}
                  tooltip="Transaction type based on the presence of transparent and shielded components"
                />

                <InfoRow
                  icon={Icons.Code}
                  label="Version"
                  value={versionLabel(result)}
                  tooltip="Transaction format version"
                />

                {result.consensusBranchName && (
                  <InfoRow
                    icon={Icons.Shield}
                    label="Network Upgrade"
                    value={<Badge color="gold">{result.consensusBranchName}</Badge>}
                    tooltip="The consensus branch this transaction targets"
                  />
                )}

                {result.versionGroupName && (
                  <InfoRow
                    icon={Icons.Hash}
                    label="Version Group"
                    value={
                      <span className="flex items-center gap-2">
                        {result.versionGroupName}
                        <span className="text-muted text-xs">({result.versionGroupId})</span>
                      </span>
                    }
                    tooltip="Version group identifier for transaction format"
                  />
                )}

                <InfoRow
                  icon={Icons.Clock}
                  label="Lock Time"
                  value={result.locktime}
                  tooltip="Block height or timestamp at which this transaction is unlocked"
                />

                {result.expiryHeight !== undefined && (
                  <InfoRow
                    icon={Icons.Clock}
                    label="Expiry Height"
                    value={result.expiryHeight === 0 ? 'None (no expiry)' : result.expiryHeight.toLocaleString()}
                    tooltip="Block height after which this transaction is no longer valid"
                  />
                )}

                <InfoRow
                  icon={Icons.Database}
                  label="Size"
                  value={`${result.size.toLocaleString()} bytes (${(result.size / 1024).toFixed(2)} KB)`}
                  tooltip="Raw transaction size in bytes"
                />
              </CardBody>
            </Card>

            {/* Composition Bar -- takes 1/3 */}
            {(() => {
              const comp = computeComposition(result);
              return (
                <Card variant="compact" className="lg:col-span-1">
                  <CardBody>
                    <div className="mb-3">
                      <span className="text-xs font-mono text-muted uppercase tracking-wider">
                        Data Breakdown
                      </span>
                    </div>
                    <div className="text-2xl font-semibold font-mono text-primary mb-1">
                      {result.size.toLocaleString()}
                    </div>
                    <div className="text-xs text-muted mb-4">bytes total</div>
                    <div className="h-3 rounded-full overflow-hidden flex bg-cipher-elevated">
                      {comp.transparentPct > 0 && (
                        <div
                          className="h-full bg-brand-gold/70 transition-[width] duration-700"
                          style={{ width: `${comp.transparentPct}%` }}
                          title={`Public: ${comp.transparentBytes.toLocaleString()} bytes`}
                        />
                      )}
                      {comp.shieldedPct > 0 && (
                        <div
                          className="h-full bg-cipher-purple/70 transition-[width] duration-700"
                          style={{ width: `${comp.shieldedPct}%` }}
                          title={`Encrypted: ${comp.shieldedBytes.toLocaleString()} bytes`}
                        />
                      )}
                    </div>
                    <div className="space-y-1.5 mt-3">
                      <div className="flex items-center gap-1.5">
                        <div className="w-2.5 h-2.5 rounded-sm bg-brand-gold/70" />
                        <span className="text-xs text-muted">
                          Public data ({comp.transparentPct.toFixed(0)}%)
                        </span>
                      </div>
                      {comp.shieldedPct > 0 && (
                        <div className="flex items-center gap-1.5">
                          <div className="w-2.5 h-2.5 rounded-sm bg-cipher-purple/70" />
                          <span className="text-xs text-muted">
                            Encrypted data ({comp.shieldedPct.toFixed(0)}%)
                          </span>
                        </div>
                      )}
                    </div>
                  </CardBody>
                </Card>
              );
            })()}
          </div>

          {/* Inputs / Outputs -- flip cards (summary <-> details) */}
          <div className="grid md:grid-cols-2 gap-4 md:gap-6">
            {/* Inputs Card */}
            <Card variant="compact">
              <CardBody>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-primary flex items-center gap-2">
                    <Icons.ArrowLeft />
                    Inputs
                    <Badge color="gold" className="ml-1">{totalInputCount}</Badge>
                  </h3>
                  {result.vin.length > 0 && (
                    <button
                      onClick={() => setShowInputs(!showInputs)}
                      className="text-sm text-cipher-gold hover:text-cipher-green transition-colors font-mono"
                    >
                      {showInputs ? 'Summary' : 'Details'}
                    </button>
                  )}
                </div>

                {/* Summary view */}
                {!showInputs && (
                  <>
                    {hasShielded && result.vin.length === 0 ? (
                      <div className="flex items-center gap-2">
                        <Badge color="purple" icon={<Icons.Shield />}>(amount hidden)</Badge>
                        <span className="text-xs text-muted">
                          {result.orchardActions > 0
                            ? `Orchard action${result.orchardActions !== 1 ? 's' : ''}`
                            : `Shielded input${result.nSpendsSapling > 1 ? 's' : ''}`}
                        </span>
                      </div>
                    ) : result.vin.length > 0 ? (
                      <div>
                        <div className="text-2xl font-semibold font-mono text-primary">
                          {result.vin.some((v) => !!v.coinbase) ? 'COINBASE' : `${result.vin.length} transparent`}
                        </div>
                        {(result.nSpendsSapling > 0 || result.orchardActions > 0 || result.ironwoodActions > 0) && (
                          <Badge color="purple" className="mt-2">
                            + {result.nSpendsSapling + result.orchardActions + result.ironwoodActions} shielded (hidden)
                          </Badge>
                        )}
                      </div>
                    ) : (
                      <span className="text-sm text-muted font-mono">No transparent inputs</span>
                    )}
                  </>
                )}

                {/* Details view */}
                {showInputs && result.vin.length > 0 && (
                  <div className="space-y-3">
                    {result.vin.map((vin, i) => (
                      <div
                        key={i}
                        className="block-tx-row p-4 rounded-lg border border-cipher-border"
                      >
                        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start mb-3 gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted font-mono">INPUT #{i}</span>
                            {vin.coinbase ? (
                              <TxTypeBadge category="coinbase" />
                            ) : (
                              <TxTypeBadge category="transparent" />
                            )}
                          </div>
                        </div>
                        {vin.coinbase ? (
                          <div>
                            <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1">
                              Coinbase Data
                            </label>
                            <div className="block-hash-bg px-3 py-2 rounded border border-cipher-border">
                              <code className="text-xs text-cipher-yellow break-all block">
                                {vin.coinbase.length > 120
                                  ? `${vin.coinbase.slice(0, 120)}...`
                                  : vin.coinbase}
                              </code>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <div>
                              <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1">
                                Previous TX
                              </label>
                              <div className="block-hash-bg px-3 py-2 rounded border border-cipher-border">
                                <Link href={`/tx/${vin.txid}`} prefetch={false}>
                                  <code className="text-xs text-cipher-gold hover:underline break-all block">
                                    {vin.txid}
                                  </code>
                                </Link>
                              </div>
                            </div>
                            <div className="flex items-center gap-4 text-sm font-mono">
                              <span>
                                <span className="text-muted text-xs">vout: </span>
                                <span className="text-primary">{vin.vout}</span>
                              </span>
                              <span>
                                <span className="text-muted text-xs">seq: </span>
                                <span className="text-primary">0x{vin.sequence.toString(16)}</span>
                              </span>
                            </div>
                            {vin.scriptSig.hex && (
                              <div>
                                <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1">
                                  ScriptSig
                                </label>
                                <div className="block-hash-bg px-3 py-2 rounded border border-cipher-border">
                                  <code className="text-xs text-secondary break-all block">
                                    {vin.scriptSig.hex.length > 100
                                      ? `${vin.scriptSig.hex.slice(0, 100)}...`
                                      : vin.scriptSig.hex}
                                  </code>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardBody>
            </Card>

            {/* Outputs Card */}
            <Card variant="compact">
              <CardBody>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-primary flex items-center gap-2">
                    <Icons.ArrowRight />
                    Outputs
                    <Badge color="green" className="ml-1">{totalOutputCount}</Badge>
                  </h3>
                  {result.vout.length > 0 && (
                    <button
                      onClick={() => setShowOutputs(!showOutputs)}
                      className="text-sm text-cipher-gold hover:text-cipher-green transition-colors font-mono"
                    >
                      {showOutputs ? 'Summary' : 'Details'}
                    </button>
                  )}
                </div>

                {/* Summary view */}
                {!showOutputs && (
                  <>
                    {hasShielded && result.vout.length === 0 ? (
                      <div className="flex items-center gap-2">
                        <Badge color="purple" icon={<Icons.Shield />}>(amount hidden)</Badge>
                        <span className="text-xs text-muted">
                          {result.orchardActions > 0
                            ? `Orchard action${result.orchardActions !== 1 ? 's' : ''}`
                            : `Shielded output${result.nOutputsSapling > 1 ? 's' : ''}`}
                        </span>
                      </div>
                    ) : result.vout.length > 0 ? (
                      <div>
                        <div className="text-2xl font-semibold font-mono text-primary">
                          {totalTransparentOutput.toFixed(8)}
                        </div>
                        <div className="text-sm text-muted font-mono">ZEC</div>
                        {(result.nOutputsSapling > 0 || result.orchardActions > 0 || result.ironwoodActions > 0) && (
                          <Badge color="purple" className="mt-2">
                            + {result.nOutputsSapling + result.orchardActions + result.ironwoodActions} shielded (hidden)
                          </Badge>
                        )}
                      </div>
                    ) : (
                      <span className="text-sm text-muted font-mono">No transparent outputs</span>
                    )}
                  </>
                )}

                {/* Details view */}
                {showOutputs && result.vout.length > 0 && (
                  <div className="space-y-3">
                    {result.vout.map((vout, i) => (
                      <div
                        key={i}
                        className="block-tx-row p-4 rounded-lg border border-cipher-border"
                      >
                        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start mb-3 gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted font-mono">OUTPUT #{vout.n}</span>
                            <TxTypeBadge category="transparent" />
                          </div>
                          <span className="text-sm font-mono text-primary font-semibold">
                            {vout.value.toFixed(8)} ZEC
                          </span>
                        </div>
                        {vout.scriptPubKey.address && (
                          <div>
                            <label className="text-xs font-mono text-muted uppercase tracking-wider block mb-1">
                              To
                            </label>
                            <div className="block-hash-bg px-3 py-2 rounded border border-cipher-border">
                              <Link href={`/address/${vout.scriptPubKey.address}`} prefetch={false}>
                                <code className="text-xs text-cipher-gold hover:underline break-all block">
                                  {vout.scriptPubKey.address}
                                </code>
                              </Link>
                            </div>
                          </div>
                        )}
                        <div className="flex items-center gap-4 text-sm font-mono mt-2">
                          <span>
                            <span className="text-muted text-xs">type: </span>
                            <span className="text-primary">{vout.scriptPubKey.type}</span>
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardBody>
            </Card>
          </div>

          {/* Shielded Data + Raw JSON -- side by side when shielded exists */}
          <div className={`grid grid-cols-1 ${hasShielded ? 'lg:grid-cols-2' : ''} gap-4 lg:gap-6`}>
            {/* Shielded Data Section */}
            {hasShielded && (
              <Card>
                <CardBody>
                  <div className="flex items-center gap-2 mb-4">
                    <Icons.Shield />
                    <h3 className="text-lg font-semibold text-primary">Shielded Data</h3>
                    <Tooltip content="Encrypted transaction components using zero-knowledge proofs. Addresses and amounts are hidden." />
                  </div>

                {/* Privacy notice */}
                <div className="flex items-start gap-3 p-3 rounded-lg border border-cipher-shielded/20 bg-cipher-shielded/5 mb-4">
                  <span className="text-cipher-shielded mt-0.5"><Icons.Shield /></span>
                  <div>
                    <p className="text-sm font-semibold text-cipher-shielded mb-0.5">Privacy Protection Active</p>
                    <p className="text-xs text-secondary">
                      Addresses and amounts are encrypted using zero-knowledge proofs.
                    </p>
                  </div>
                </div>

                  <div className="space-y-3">
                    {/* Sapling Spends */}
                    {result.nSpendsSapling > 0 && (
                      <div className="shielded-input-row p-4 rounded-lg border border-cipher-gold/20">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <TxTypeBadge category="sapling" icon={<Icons.Shield />} label="SAPLING SPENDS" />
                          </div>
                          <span className="text-xl font-semibold font-mono text-primary">{result.nSpendsSapling}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-2">
                          <Badge color="muted">(amount hidden)</Badge>
                        </div>
                      </div>
                    )}

                    {/* Sapling Outputs */}
                    {result.nOutputsSapling > 0 && (
                      <div className="shielded-input-row p-4 rounded-lg border border-cipher-gold/20">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <TxTypeBadge category="sapling" icon={<Icons.Shield />} label="SAPLING OUTPUTS" />
                          </div>
                          <span className="text-xl font-semibold font-mono text-primary">{result.nOutputsSapling}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-2">
                          <Badge color="muted">(amount hidden)</Badge>
                        </div>
                      </div>
                    )}

                    {/* Sapling Value Balance */}
                    {result.valueBalanceSapling !== undefined && result.valueBalanceSapling !== 0 && (
                      <div className="shielded-input-row p-4 rounded-lg border border-cipher-gold/20">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <TxTypeBadge category="sapling" icon={<Icons.Currency />} label="SAPLING VALUE BALANCE" />
                          </div>
                          <span className="text-lg font-semibold font-mono text-primary">
                            {result.valueBalanceSapling.toFixed(8)} ZEC
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Ironwood bundle */}
                    {result.ironwoodActions > 0 && <div className="shielded-input-row p-4 rounded-lg border border-cipher-ironwood/20">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <TxTypeBadge category="ironwood" icon={<Icons.Shield />} label="IRONWOOD ACTIONS" />
                        <span className="text-xl font-semibold font-mono text-primary tabular-nums">{result.ironwoodActions}</span>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
                        <span className="text-sm text-muted">Value balance</span>
                        <span className="font-mono text-sm text-primary tabular-nums break-all">{result.valueBalanceIronwood != null ? `${result.valueBalanceIronwood.toFixed(8)} ZEC` : 'Unavailable'}</span>
                      </div>
                    </div>}
                    {/* Orchard Actions */}
                    {result.orchardActions > 0 && (
                      <div className="shielded-input-row p-4 rounded-lg border border-cipher-shielded/20">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <TxTypeBadge category="orchard" icon={<Icons.Shield />} label="ORCHARD ACTIONS" />
                          </div>
                          <span className="text-xl font-semibold font-mono text-primary">{result.orchardActions}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-2">
                          <Badge color="muted">(amount hidden)</Badge>
                          {result.orchardFlags !== undefined && (
                            <span className="text-xs text-muted font-mono">flags: 0x{result.orchardFlags.toString(16).padStart(2, '0')}</span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Orchard Value Balance */}
                    {result.valueBalanceOrchard !== undefined && result.valueBalanceOrchard !== 0 && (
                      <div className="shielded-input-row p-4 rounded-lg border border-cipher-shielded/20">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <TxTypeBadge category="orchard" icon={<Icons.Currency />} label="ORCHARD VALUE BALANCE" />
                          </div>
                          <span className="text-lg font-semibold font-mono text-primary">
                            {result.valueBalanceOrchard.toFixed(8)} ZEC
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </CardBody>
              </Card>
            )}

            {/* Raw JSON */}
            <Card variant="dark">
              <CardBody>
                <details className="group">
                  <summary className="text-xs font-mono text-muted cursor-pointer hover:text-primary transition-colors select-none flex items-center justify-between">
                    <span>&gt; VIEW_PARSED_JSON</span>
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        navigator.clipboard.writeText(JSON.stringify(result, null, 2));
                        setJsonCopied(true);
                        setTimeout(() => setJsonCopied(false), 2000);
                      }}
                      className={`ml-3 p-1 rounded transition-colors ${jsonCopied ? 'text-cipher-green' : 'text-muted hover:text-primary'}`}
                      title="Copy JSON"
                    >
                      {jsonCopied ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      )}
                    </button>
                  </summary>
                  <pre className="mt-4 text-xs font-mono text-primary overflow-x-auto max-h-96 overflow-y-auto leading-relaxed">
                    {JSON.stringify(result, null, 2)}
                  </pre>
                </details>
              </CardBody>
            </Card>
          </div>
        </div>
      )}

      {/* Help */}
      <Card variant="glass" className="mt-8">
        <CardBody>
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-brand-gold/10 flex items-center justify-center flex-shrink-0">
              <svg className="w-5 h-5 text-cipher-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-primary mb-2">What is a raw transaction?</h3>
              <p className="text-sm text-secondary leading-relaxed mb-3">
                A raw transaction is a hex-encoded representation of a Zcash transaction containing all
                inputs, outputs, and signatures. You can obtain one from a wallet, the{' '}
                <code className="text-xs font-mono text-cipher-gold">getrawtransaction</code>{' '}
                RPC call, or by constructing one programmatically.
              </p>
              <div className="flex flex-wrap gap-3 text-xs">
                <Link href="/tools/broadcast" className="text-cipher-gold hover:underline font-mono">
                  &gt; Broadcast a transaction
                </Link>
                <Link href="/docs" className="text-cipher-gold hover:underline font-mono">
                  &gt; API documentation
                </Link>
              </div>
            </div>
          </div>
        </CardBody>
      </Card>
    </>
  );
}
