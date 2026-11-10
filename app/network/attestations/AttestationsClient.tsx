'use client';

import { useEffect, useState } from 'react';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { useApiQuery } from '@/hooks/useApiQuery';
import type { AttestationData, AttestationEndpoint } from '@/lib/attestations';
import { canaryStatus } from '@/lib/canary-status';
import { attestationStatus, matchesReproducedBuild } from '@/lib/attestation-status';

const STATES: Record<string, { label: string; color: string }> = {
  verified: { label: 'Evidence verified', color: 'text-cipher-green' },
  failed: { label: 'Check failed', color: 'text-danger' },
  stale: { label: 'Stale observation', color: 'text-cipher-yellow' },
  unreachable: { label: 'Endpoint unreachable', color: 'text-cipher-yellow' },
  unavailable: { label: 'Observation unavailable', color: 'text-muted' },
  not_checked: { label: 'Not checked yet', color: 'text-muted' },
};
const ERRORS: Record<string, string> = {
  invalid_attestation: 'The signature or challenge could not be verified.',
  invalid_certificate_chain: 'The attestation certificate chain could not be validated.',
  invalid_measurements: 'Required measurements are missing, invalid or from a debug enclave.',
  invalid_timestamp: 'The signed timestamp is too old or ahead of the observer’s clock.',
  tls_binding_mismatch: 'The attested certificate or domain differs from the observed connection.',
  verifier_unavailable: 'The observer’s certificate verifier is unavailable.',
  invalid_baseline: 'The configured release baseline is invalid.',
  invalid_document: 'The endpoint returned an invalid attestation document.',
  invalid_response: 'The endpoint did not return valid JSON.',
  response_too_large: 'The endpoint exceeded the response size limit.',
  private_address: 'The endpoint resolved to a disallowed network address.',
  timeout: 'The endpoint did not finish responding before the deadline.',
  http_error: 'The endpoint returned an unsuccessful HTTP response.',
  connection_failed: 'A secure connection could not be completed.',
};
function timestamp(value: string | null | undefined) {
  const time = value ? new Date(value) : null;
  return time && Number.isFinite(time.getTime()) ? `${time.toISOString().replace('T', ' ').slice(0, 19)} UTC` : 'Not available';
}
function CheckValue({ label, value, color = 'text-secondary' }: { label: string; value: string; color?: string }) {
  return <div className="flex justify-between gap-4 sm:block"><dt className="type-label text-muted sm:mb-2">{label}</dt><dd className={`text-sm font-mono text-right sm:text-left ${color}`}>{value}</dd></div>;
}
function EndpointCard({ endpoint, endpoints, now, apiUrl }: { endpoint: AttestationEndpoint; endpoints: AttestationEndpoint[]; now: number; apiUrl: string }) {
  const check = endpoint.latest;
  const canary = canaryStatus(endpoint.canary, now);
  const canaryLabels: Record<string, string> = { verified: 'Signed checks verified', warning: 'Recent check passed · connection warning', failed: 'Signed check failed', unreachable: 'Endpoint unreachable', stale: 'Observation expired', unavailable: 'Verification unavailable', not_configured: 'Awaiting trusted build measurements' };
  const buildMatches = matchesReproducedBuild(endpoint, now);
  const status = attestationStatus(check, now);
  const state = STATES[status] ?? STATES.unavailable;
  const current = !['stale', 'unavailable', 'not_checked'].includes(status);
  const hub = endpoints.find((item) => item.id === endpoint.hubId);
  const pinned = endpoint.pinnedHub ?? null;
  const pinnedStatus = pinned ? attestationStatus(pinned.latest, now) : null;
  const hubDiffers = pinned?.listedHub === 'different' && !['stale', 'unavailable', 'not_checked', null].includes(pinnedStatus);
  const releaseLabels = { unconfirmed: 'Unconfirmed', published_match: 'Published measurements match', reproduced_match: 'Reproduced build matches', mismatch: 'Measurements differ' };
  return <article id={endpoint.id} className="card card-static @container p-0! overflow-hidden scroll-mt-36">
    <div className="p-5 sm:p-6">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div className="min-w-0">
        <div><div className="flex items-center gap-2 mb-1"><h3 className="font-mono text-base text-primary">{endpoint.name}</h3><span className="type-label font-mono uppercase text-muted">{endpoint.role}</span></div>
          <p className="font-mono text-xs sm:text-sm text-secondary break-all">{endpoint.hostname}:443</p></div>
        <span className={`text-caption mt-3 flex items-center gap-2 ${state.color}`}><span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-current" />{state.label}</span>
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 border-t lg:border-t-0 lg:border-l border-cipher-border pt-4 lg:pt-0 lg:pl-6">
        <CheckValue label="Enclave evidence" value={current ? (check?.evidence === 'verified' ? 'Verified' : check?.evidence === 'failed' ? 'Failed' : 'Not checked') : status === 'stale' ? 'Stale' : 'Not checked'} color={current && check?.evidence === 'verified' ? 'text-cipher-green' : current && check?.evidence === 'failed' ? 'text-danger' : 'text-secondary'} />
        <CheckValue label="TLS certificate" value={current ? (check?.tlsBinding === 'matched' ? 'Matched' : check?.tlsBinding === 'mismatch' ? 'Mismatch' : 'Not checked') : status === 'stale' ? 'Stale' : 'Not checked'} color={current && check?.tlsBinding === 'matched' ? 'text-cipher-green' : current && check?.tlsBinding === 'mismatch' ? 'text-danger' : 'text-secondary'} />
        <CheckValue label="Software release" value={current && check ? releaseLabels[check.release] : 'Unconfirmed'} color={current && check?.release === 'mismatch' ? 'text-danger' : 'text-secondary'} />
      </dl>
      </div>
      <div className="mt-5 border-t border-cipher-border pt-4 text-xs">
        <div className="flex flex-wrap justify-between gap-2"><span className="font-medium text-secondary">Canary observer</span><span className={canary === 'verified' ? 'text-cipher-green' : canary === 'failed' ? 'text-danger' : canary === 'warning' || canary === 'stale' || canary === 'unreachable' ? 'text-cipher-yellow' : 'text-muted'}>{canaryLabels[canary]}</span></div>
        {endpoint.canary ? <p className="mt-2 text-muted">Observed {timestamp(endpoint.canary.observedAt)} · expires {timestamp(endpoint.canary.expiresAt)}</p> : null}
        {endpoint.canary?.transportWarning ? <p className="mt-2 text-cipher-yellow">Latest connection attempt has a warning; a recent signed result may still be retained.</p> : null}
      </div>
      {check?.errorCode ? <p className="mt-4 text-sm text-secondary" role="status">{ERRORS[check.errorCode] ?? 'The check could not be completed.'}</p> : null}
      {check?.release === 'mismatch' ? <p className="mt-4 text-sm text-danger">The measurements differ from the configured release baseline.</p> : null}
      <p className="mt-5 border-t border-cipher-border pt-3 text-xs text-muted leading-relaxed">
        Last attempt <time className="tabular-nums" dateTime={check?.checkedAt}>{timestamp(check?.checkedAt)}</time>
      </p>
    </div>
    <details className="border-t border-cipher-border">
      <summary className="cursor-pointer px-5 sm:px-6 py-3 text-caption font-mono text-secondary hover:bg-glass-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cipher-gold">Build, configuration &amp; evidence</summary>
      <div className="px-5 sm:px-6 pb-5 text-caption space-y-4">
      <dl className="grid gap-5 @min-[36rem]:grid-cols-2 border-b border-cipher-border pb-5 pt-2">
        <div className="min-w-0">
          <dt className="text-xs font-medium text-muted mb-2">{!endpoint.baseline ? 'Build version' : buildMatches ? 'Running build' : 'Reviewed build'}</dt>
          <dd className="text-sm text-secondary">
            {endpoint.baseline ? <>
              {endpoint.baseline.tag && endpoint.baseline.tagReferenceUrl
                ? <a href={endpoint.baseline.tagReferenceUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-cipher-gold hover:underline break-all">{endpoint.baseline.tag}<span aria-hidden="true" className="ml-1">↗</span></a>
                : <span>No tagged release identified</span>}
              <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className={buildMatches ? 'text-cipher-green' : 'text-cipher-yellow'}>{buildMatches ? 'Reproduced match' : 'Current match unconfirmed'}</span>
                <span className="text-muted">Commit <code title={endpoint.baseline.commit} className="text-secondary">{endpoint.baseline.commit.slice(0, 12)}</code></span>
              </span>
            </> : <span className="text-muted">Source/build version not confirmed</span>}
          </dd>
        </div>
        {endpoint.role === 'shim' ? <div className="min-w-0 border-t border-cipher-border pt-5 @min-[36rem]:border-t-0 @min-[36rem]:border-l @min-[36rem]:pl-5 @min-[36rem]:pt-0">
          <dt className="text-xs font-medium text-muted mb-2">Configured hub</dt>
          <dd className="text-sm text-secondary">
            {endpoint.hubConfiguration ? <>
              <span className="font-mono break-all">{endpoint.hubConfiguration.hostname}</span>
              <span className={`block text-xs mt-2 ${buildMatches ? 'text-cipher-green' : 'text-cipher-yellow'}`}>{buildMatches ? 'Confirmed by reproduced build' : 'Reviewed configuration · current match unconfirmed'}</span>
            </> : hub ? <><span className="font-mono break-all">{hub.hostname}</span><span className="block text-xs text-muted mt-2">Published configuration · not build-confirmed</span></> : <span className="text-muted">Not confirmed</span>}
            {pinned && pinnedStatus ? <span className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"><span className="text-muted">Configured address <span className="font-mono">{pinned.address}</span>:</span><span className={STATES[pinnedStatus]?.color}>{STATES[pinnedStatus]?.label}</span></span> : null}
            {hub ? <a href={`#${hub.id}`} className={`${pinned ? 'mt-1' : 'mt-3'} flex flex-wrap items-center gap-x-2 gap-y-1 text-xs hover:underline`}><span className="text-muted">{pinned && pinned.listedHub !== 'same' ? 'Deployment at this hub’s DNS name:' : 'Hub’s own check:'}</span><span className={STATES[attestationStatus(hub.latest, now)]?.color}>{STATES[attestationStatus(hub.latest, now)]?.label} <span aria-hidden="true">↓</span></span></a> : null}
            {hubDiffers ? <span className="block text-xs text-cipher-yellow leading-relaxed mt-2">A different hub deployment answers this name in DNS. The hub card describes that deployment, not this shim’s configured address.</span> : null}
            <span className="block text-xs text-muted leading-relaxed mt-2">{pinned ? 'Evidence at the configured address does not prove live routing.' : 'Configuration does not prove live routing or hub availability.'}</span>
          </dd>
        </div> : null}
      </dl>

        <p className="text-muted">Measurements below describe the last attempt. Unsigned source claims are separate from the reviewed build and configuration evidence above.</p>
        {endpoint.baseline ? <div className="space-y-2">
          <p className="text-muted">Deployment source tag; pinned to the reviewed commit. {buildMatches ? 'Running build · reproduced match' : 'Reviewed build · current match unconfirmed'}.</p>
          <dl><dt className="text-muted mb-1">Reviewed source commit</dt><dd className="font-mono text-secondary break-all">{endpoint.baseline.commit}</dd></dl>
        </div> : null}
        {endpoint.hubConfiguration ? <p className="text-muted">{buildMatches ? 'Confirmed by matching reproduced build' : 'Reviewed configuration · current match unconfirmed'}. <a href={endpoint.hubConfiguration.referenceUrl} target="_blank" rel="noopener noreferrer" className="text-cipher-gold hover:underline">Configuration evidence ↗</a></p> : null}
        <dl className="space-y-3">
          {['PCR0', 'PCR1', 'PCR2'].map((key) => <div key={key}><dt className="text-muted mb-1">{key}</dt><dd className="text-secondary font-mono break-all">{check?.pcrs?.[key] ?? 'Not available'}</dd></div>)}
          <div><dt className="text-muted mb-1">TLS certificate SHA-256</dt><dd className="text-secondary font-mono break-all">{check?.certificateFingerprint ?? 'Not available'}</dd></div>
          {pinned ? <div><dt className="text-muted mb-1">Configured hub address TLS certificate SHA-256</dt><dd className="text-secondary font-mono break-all">{pinned.latest.certificateFingerprint ?? 'Not available'}</dd></div> : null}
          <div><dt className="text-muted mb-1">Attestation document SHA-256</dt><dd className="text-secondary font-mono break-all">{check?.documentSha256 ?? 'Not available'}</dd></div>
          <div><dt className="text-muted mb-1">Claimed source commit · unverified metadata</dt><dd className="text-secondary font-mono break-all">{check?.claimedCommit ?? 'Not provided for the registered source'}</dd></div>
          <div><dt className="text-muted mb-1">Signed timestamp</dt><dd className="text-secondary">{timestamp(check?.attestedAt)}</dd></div>
          <div><dt className="text-muted mb-1">Last successful evidence and TLS check</dt><dd className="text-secondary">{timestamp(endpoint.lastSuccessful?.checkedAt)}</dd></div>
          <div><dt className="text-muted mb-1">Verifier</dt><dd className="text-secondary font-mono break-all">{check?.verifier ?? 'Not checked'}</dd></div>
        </dl>
        {endpoint.canary ? <div className="space-y-2 text-muted">
          <p>Canary runs on ZecBlock’s server. Its signing keys are pinned by ZecBlock; the monitor itself is not enclave-attested. Both signatures, target evidence, reproduced measurements and TLS binding are checked separately.</p>
          <div className="flex flex-wrap gap-4 text-cipher-gold"><a href={`${apiUrl}/targets/${endpoint.id}/statement`} className="hover:underline">Signed statement ↗</a><a href={`${apiUrl}/targets/${endpoint.id}/evidence`} className="hover:underline">Evidence ↗</a><a href={`${apiUrl}/keys.json`} className="hover:underline">Public signing keys ↗</a><a href={`${apiUrl}/config.json`} className="hover:underline">Canary policy ↗</a><a href="https://github.com/Kenbak/zecblock/tree/main/server/canary" target="_blank" rel="noopener noreferrer" className="hover:underline">Source &amp; verification guide ↗</a></div>
        </div> : null}
        <div className="flex flex-wrap gap-4 text-cipher-gold">
          {endpoint.sourceUrl ? <a href={endpoint.sourceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">Registered source ↗</a> : null}
          {endpoint.baseline ? <a href={endpoint.baseline.referenceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">Release baseline ↗</a> : null}
          <a href={endpoint.referenceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">Endpoint reference ↗</a>
          <a href={`${apiUrl}/v1/network/attestations/${endpoint.id}`} className="hover:underline">Observation JSON ↗</a>
        </div>
      </div>
    </details>
  </article>;
}

export default function AttestationsClient({ initialData, initialNow, network, apiUrl }: { initialData: AttestationData | null; initialNow: number; network: string; apiUrl: string }) {
  const [now, setNow] = useState(initialNow);
  const query = useApiQuery<AttestationData>('/v1/network/attestations', undefined, {
    initialData: initialData ?? undefined, initialFetchedAt: initialNow, refreshInterval: 60_000,
  });
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 15_000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, []);
  const data = query.data?.network === network && Array.isArray(query.data.endpoints) ? query.data : null;
  const endpoints = data?.endpoints ?? [];
  const verified = endpoints.filter((endpoint) => attestationStatus(endpoint.latest, now) === 'verified').length;
  const releaseVerified = endpoints.filter((endpoint) => attestationStatus(endpoint.latest, now) === 'verified' && ['published_match', 'reproduced_match'].includes(endpoint.latest?.release ?? '')).length;
  return <>
    <dl className="grid sm:grid-cols-3 border border-cipher-border rounded-lg divide-y sm:divide-y-0 sm:divide-x divide-cipher-border mb-4">
      {[{ value: endpoints.length, label: 'Registered endpoints', note: 'Curated registry' }, { value: verified, label: 'Evidence + TLS verified', note: 'Fresh within 15 minutes' }, { value: releaseVerified, label: 'Software releases matched', note: 'Independent build baseline' }].map((item) => <div key={item.label} className="grid grid-cols-[1fr_auto] items-center gap-x-3 sm:block p-5 sm:p-6">
        <dt className="type-label text-muted sm:mb-3">{item.label}</dt><dd className="type-metric font-mono text-primary tabular-nums">{data?.available ? item.value : '—'}</dd><p className="col-span-2 text-caption text-muted mt-2">{item.note}</p>
      </div>)}
    </dl>
    <p className="text-caption text-muted mb-8">Valid enclave evidence and a matching connection do not confirm the software release. Each check is reported separately.</p>
    {query.error || !data?.available ? <p role="status" className="mb-5 text-sm text-cipher-yellow">{data?.available ? 'Could not refresh observations. Retained results expire after 15 minutes.' : 'Observations are currently unavailable. No endpoint is being reported as verified.'}</p> : null}
    <section id="endpoint-observations" className="scroll-mt-36">
    <SectionHeader label="ENDPOINT_OBSERVATIONS" actions={<p className="text-caption text-muted">Primary · 5 min <span className="mx-2">/</span> Canary · 1 min</p>} />
    {endpoints.length ? <div className="space-y-4">{endpoints.map((endpoint) => <EndpointCard key={endpoint.id} endpoint={endpoint} endpoints={endpoints} now={now} apiUrl={apiUrl} />)}</div>
      : <div className="card p-6 text-sm text-muted">{query.loading ? 'Loading the endpoint registry…' : 'The endpoint registry could not be loaded. Please try again shortly.'}</div>}
    </section>
  </>;
}
