export interface AttestationCheck {
  checkedAt: string;
  reachable: boolean;
  evidence: 'verified' | 'failed' | 'not_checked';
  tlsBinding: 'matched' | 'mismatch' | 'not_checked';
  release: 'unconfirmed' | 'published_match' | 'reproduced_match' | 'mismatch';
  errorCode: string | null;
  attestedAt: string | null;
  pcrs: Record<string, string> | null;
  certificateFingerprint: string | null;
  documentSha256: string | null;
  claimedCommit: string | null;
  verifier: string;
}
export interface CanaryCheck {
  checkedAt: string | null;
  verified: boolean;
  status: string;
  reason?: string;
  observedAt: string | null;
  expiresAt: string | null;
  transportWarning: string | null;
  displayStatus?: string;
}
export interface AttestationEndpoint {
  canary?: CanaryCheck | null;
  id: string;
  name: string;
  role: 'shim' | 'hub';
  network: string;
  hostname: string;
  attestationUrl: string;
  sourceUrl: string | null;
  referenceUrl: string;
  hubId: string | null;
  experimental: boolean;
  configurationAuthority: string;
  baseline: { authority: string; commit: string; referenceUrl: string; tag?: string | null; tagReferenceUrl?: string | null } | null;
  hubConfiguration?: { authority: 'reproduced'; hostname: string; address: string; referenceUrl: string } | null;
  pinnedHub?: { address: string; hostname: string; latest: AttestationCheck; listedHub: 'same' | 'different' | 'unknown' } | null;
  latest: AttestationCheck | null;
  lastSuccessful: AttestationCheck | null;
  status: string;
}
export interface AttestationData {
  network: string;
  generatedAt: string | null;
  servedAt: string;
  freshForMs: number;
  pollIntervalMs: number;
  available: boolean;
  endpoints: AttestationEndpoint[];
}
