'use client';

import { readApiData } from '@/lib/api-client';
import { useState } from 'react';
import Link from 'next/link';
import { getApiUrl } from '@/lib/api-config';

interface AnchorResult {
  height: number;
  hash: string;
  timestamp: number;
  matchedField: 'sapling' | 'orchard';
  minerAddress: string;
  minerPool: string;
  chain: 'canonical' | 'orphaned';
  detectedAt?: string;
}

interface SearchResponse {
  root: string;
  found: boolean;
  canonical: AnchorResult[];
  orphaned: AnchorResult[];
  diagnosis: string;
}

export default function AnchorSearchClient() {
  const [root, setRoot] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState('');

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = root.trim().toLowerCase();

    if (!/^[a-f0-9]{64}$/.test(trimmed)) {
      setError('Invalid anchor root. Must be a 64-character hex string.');
      setResult(null);
      return;
    }

    setLoading(true);
    setError('');
    setResult(null);

    try {
      const res = await fetch(`${getApiUrl()}/v1/search/anchors/${trimmed}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await readApiData(res);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const formatTime = (ts: number) => {
    return new Date(ts * 1000).toLocaleString();
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="type-page text-primary mb-2">Anchor Root Search</h1>
        <p className="text-secondary text-sm sm:text-base max-w-2xl">
          Search for Sapling or Orchard commitment tree roots across canonical and orphaned (reorg'd) blocks.
          Useful for debugging wallet sync issues — if a wallet references a root that only exists on an orphaned fork,
          it needs to rescan.
        </p>
      </div>

      <form onSubmit={handleSearch} className="mb-8">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            aria-label="Anchor root"
            autoComplete="off"
            spellCheck={false}
            type="text"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder="Enter 64-char hex anchor root (Sapling or Orchard)..."
            className="flex-1 px-4 py-3 bg-cipher-surface border border-cipher-border rounded-lg text-primary font-mono text-sm placeholder:text-muted focus:outline-none focus:border-cipher-gold/50"
          />
          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary btn-md"
          >
            {loading ? 'Searching...' : 'Search'}
          </button>
        </div>
        {error && <p className="mt-2 text-danger text-sm">{error}</p>}
      </form>

      {result && (
        <div className="space-y-6">
          {/* Diagnosis */}
          <div className={`p-4 rounded-lg border ${
            result.orphaned.length > 0 && result.canonical.length === 0
              ? 'bg-danger/5 border-danger/30'
              : result.found
                ? 'bg-brand-gold/5 border-cipher-gold/30'
                : 'bg-cipher-card border-cipher-border'
          }`}>
            <div className="flex items-start gap-3">
              <span className="text-lg">
                {result.orphaned.length > 0 && result.canonical.length === 0
                  ? '⚠️'
                  : result.found
                    ? '✓'
                    : '?'}
              </span>
              <div>
                <p className="text-primary font-medium text-sm">{result.diagnosis}</p>
                <p className="text-muted text-xs mt-1 font-mono break-all">{result.root}</p>
              </div>
            </div>
          </div>

          {/* Canonical matches */}
          {result.canonical.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-primary mb-3 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-cipher-green" />
                Canonical Chain ({result.canonical.length} blocks)
              </h3>
              <div className="space-y-2">
                {result.canonical.map((block) => (
                  <div key={block.hash} className="p-3 bg-cipher-card border border-cipher-border rounded-lg flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                    <Link href={`/block/${block.height}`} prefetch={false} className="text-cipher-gold hover:underline font-mono text-sm">
                      #{block.height.toLocaleString()}
                    </Link>
                    <span className={`text-xs px-2 py-0.5 rounded font-mono ${
                      block.matchedField === 'orchard'
                        ? 'bg-cipher-purple/10 text-cipher-purple'
                        : 'bg-cipher-yellow/10 text-cipher-yellow'
                    }`}>
                      {block.matchedField}
                    </span>
                    <span className="text-muted text-xs">{formatTime(block.timestamp)}</span>
                    <span className="text-secondary text-xs ml-auto">{block.minerPool || block.minerAddress?.slice(0, 12) + '...'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Orphaned matches */}
          {result.orphaned.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-primary mb-3 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-danger" />
                Orphaned / Reorg'd Blocks ({result.orphaned.length})
              </h3>
              <div className="space-y-2">
                {result.orphaned.map((block) => (
                  <div key={block.hash} className="p-3 bg-danger/5 border border-danger/20 rounded-lg flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                    <span className="text-danger font-mono text-sm">
                      #{block.height.toLocaleString()}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded font-mono ${
                      block.matchedField === 'orchard'
                        ? 'bg-cipher-purple/10 text-cipher-purple'
                        : 'bg-cipher-yellow/10 text-cipher-yellow'
                    }`}>
                      {block.matchedField}
                    </span>
                    <span className="text-muted text-xs font-mono truncate max-w-[200px]">{block.hash}</span>
                    <span className="text-secondary text-xs ml-auto">{block.minerPool || 'Unknown'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!result.found && (
            <div className="p-4 bg-cipher-card border border-cipher-border rounded-lg">
              <p className="text-muted text-sm">
                No blocks found with this anchor root. This could mean:
              </p>
              <ul className="mt-2 text-muted text-xs space-y-1 list-disc list-inside">
                <li>The root is from a block that hasn't been backfilled yet (backfill in progress for Orchard roots)</li>
                <li>The root is invalid or corrupted in the wallet state</li>
                <li>The root is a per-transaction anchor (currently only block-level roots are indexed)</li>
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
