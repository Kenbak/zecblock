/**
 * Curated Coinholder-Directed Retroactive Grants Program (CDRGP) rounds.
 *
 * Schedules come from FPF's official forum posts. Proposal metadata is the
 * round's locked review-period list; FPF summarizes each applicant's own
 * claims. Nothing here is a vote result: registered ballots, snapshots and
 * tallies still come only from the voting chain (lib/governance.ts).
 */

export type GrantCategory = 'security' | 'core' | 'wallets' | 'payments' | 'tools' | 'community' | 'admin';

export const GRANT_CATEGORIES: Record<GrantCategory, { label: string; short: string }> = {
  security: { label: 'Security & Vulnerability Disclosures', short: 'Security' },
  core: { label: 'Core Protocol, Nodes & Voting Infrastructure', short: 'Core protocol' },
  wallets: { label: 'Wallets & Hardware Signing', short: 'Wallets' },
  payments: { label: 'Payments, Swaps & Integrations', short: 'Payments' },
  tools: { label: 'Explorers, Developer & Privacy Tools', short: 'Tools' },
  community: { label: 'Community, Media & Mining', short: 'Community' },
  admin: { label: 'Program Administration (2027)', short: 'Administration' },
};

export type GrantProposal = {
  /** GitHub issue number in the FPF program repository; null when not filed there. */
  github: number | null;
  title: string;
  applicant: string;
  /** Requested amount in whole US dollars, as submitted (paid in ZEC if approved). */
  requestedUsd: number;
  category: GrantCategory;
  summary: string;
  /** The team behind this explorer is the applicant. */
  ownApplication?: boolean;
};

/** Every phase boundary is an official UTC instant or an official calendar date. */
export type GrantRoundSchedule = {
  submissionsOpen: string;
  /** Exact: deadlines are announced at 20:00 UTC. */
  submissionsClose: string;
  reviewOpen: string;
  reviewClose: string;
  /** Date only: no opening hour is announced, so no exact instant is invented. */
  votingOpensOn: string;
  votingClose: string;
};

export type GrantRound = {
  slug: string;
  quarter: string;
  title: string;
  description: string;
  /** Forum topics accepted as the registered ballot's official discussion identity. */
  topicIds: readonly number[];
  source: string;
  callForProposals: string;
  schedule: GrantRoundSchedule;
  ballotOptions: readonly string[];
  ballotNote: string;
  proposals: readonly GrantProposal[];
  /** Totals stated by the organizer; tests keep the itemized list consistent with them. */
  statedTotals?: { proposals: number; requestedUsd: number };
};

export const GRANTS_REPO = 'https://github.com/Financial-Privacy-Foundation/ZcashCoinholderGrantsProgram';
export const PARTICIPATION_MINIMUM_ZEC = 420_000;

const Q4_2026_PROPOSALS: GrantProposal[] = [
  // Security & Vulnerability Disclosures
  { github: 93, category: 'security', requestedUsd: 75_000, applicant: 'Julian Abraham', title: 'Zebra 6.2.0 High Severity Remote DoS (CVE-2026-104423)', summary: 'Reports a High-severity remote DoS in Zebra 6.2.0 where peer-pushed transactions with fake proofs could stall block verification. Fixed in Zebra 6.2.1; the ZF advisory credits the applicant as sole reporter.' },
  { github: 111, category: 'security', requestedUsd: 37_500, applicant: 'Julian Abraham', title: 'Zebra Block Suppression (Low) and IPv6 Ban Evasion Fix (Medium)', summary: 'A Low-severity disclosure letting a peer repeatedly delay new blocks (credited in Zebra 6.4.0) and a Medium-severity IPv6 ban-evasion fix, August–September 2026.' },
  { github: 106, category: 'security', requestedUsd: 37_500, applicant: 'Rowan (piatoss3612)', title: 'Ledger Zcash App Vulnerability Disclosure: Memo Crash and Device Wipe', summary: 'Certain shielded memo characters crashed Ledger’s Zcash app and factory-reset the test device; rated Critical by Ledger and fixed within 13 hours before its shielded launch.' },
  { github: 84, category: 'security', requestedUsd: 25_000, applicant: 'asafmod', title: 'Zebra Vulnerability Bounty: Reporter Share of GHSA-j4cw-58mj-7w6v', summary: 'ZIP-244 signature hashing recomputed transparent digests per input, letting one large transaction stall block verification for minutes. Fixed in Zebra 7.0.0; one-third share of a High base.' },
  { github: 83, category: 'security', requestedUsd: 25_000, applicant: 'Xifeng Jin', title: 'Zebra Malformed v6 Transaction Crash (GHSA-h5rr-8pqv-grp9)', summary: 'Independent rediscovery of a crash from a single malformed v6 transaction in Zebra 6.4.0/6.4.1. Rated High, fixed in 6.4.2; requests one-third of the High base.' },
  { github: 82, category: 'security', requestedUsd: 75_000, applicant: 'Xifeng Jin', title: 'Three Zebra Security Vulnerability Disclosures (One High, Two Medium)', summary: 'A High-severity checkpoint-sync stall from forged checkpoint blocks, plus two Medium issues. All fixed in Zebra 7.0.0.' },
  { github: 81, category: 'security', requestedUsd: 40_000, applicant: 'Francesco Giannicola', title: 'Independent Security Audit of FROST v3 (ZIP-312)', summary: 'Audit of frost-core v3.0.0, the RedPallas/RedJubjub ciphersuites and frost-tools. No critical issues; one confirmed memory-growth DoS in frostd.' },
  { github: 79, category: 'security', requestedUsd: 100_000, applicant: 'x15-eth', title: 'Zebra Vulnerability Bounty: Shares of Three High-Severity Zebra 7.0.0 Advisories', summary: 'Shared-reporter payouts for three High-severity advisories fixed in Zebra 7.0.0, net of a prior $37,500 payment for a fourth advisory.' },
  { github: 78, category: 'security', requestedUsd: 75_000, applicant: 'ouicate (Quorint)', title: 'Zebra High and Medium Severity Sync Vulnerabilities (GHSA-jq45, GHSA-3c94)', summary: 'Forged block bodies under valid hashes could hold a syncing node behind the tip (High) or force verification of blocks that never commit (Medium).' },
  { github: 77, category: 'security', requestedUsd: 300_000, applicant: 'ouicate (Quorint)', title: 'Two Critical Zebra Consensus Vulnerabilities', summary: 'Two consensus bugs in unreleased Zebra code that could have split the network if shipped. Fixed before release; $150,000 per Critical finding.' },
  { github: 75, category: 'security', requestedUsd: 56_250, applicant: 'sangsoo-osec', title: 'Two Medium Severity Security Findings in zcashd and Zebra', summary: 'A zcashd V4 Sapling parsing mismatch fixed in v6.12.2, and a report and adopted fix for Zebra’s lock-time peer-ban issue.' },
  { github: 74, category: 'security', requestedUsd: 75_000, applicant: 'sangsoo-osec', title: 'Zebra High Severity Consensus Vulnerability (CVE-2026-40880)', summary: 'A cached mempool verification result could let blocks skip lock-time checks. Fixed in zebrad 4.3.1; the advisory credits the applicant.' },
  { github: 71, category: 'security', requestedUsd: 150_000, applicant: 'shieldedonly', title: 'Critical Zebra Block Discovery DoS (CVE-2026-44499)', summary: 'One unauthenticated peer could halt a Zebra node’s block discovery. Fixed in Zebra 4.4.0; the applicant notes they are not named in the published credits.' },
  { github: 69, category: 'security', requestedUsd: 75_000, applicant: 'j12s team (linceu.xyz)', title: 'Zebra High-Severity Mempool DoS Disclosure (GHSA-7jp4-mq53-4cvq)', summary: 'A crafted, unsigned transaction could stall Zebra verification through costly mempool coinbase-maturity checks. Fixed in zebrad 7.0.0.' },
  { github: 127, category: 'security', requestedUsd: 67_500, applicant: 'Valargroup', title: 'Zakura Audits and Bug Bounties', summary: 'Reimbursement for an external Zakura audit and bug bounty payouts, October 2 to November 5, 2026.' },
  // Core Protocol, Nodes & Voting Infrastructure
  { github: 126, category: 'core', requestedUsd: 950_000, applicant: 'Zcash Open Development Lab (ZODL)', title: 'ZODL Q3 2026 Core Protocol Development', summary: 'Core protocol engineering from July 1 to September 30, 2026, centered on its share of NU6.3 (Ironwood).' },
  { github: 124, category: 'core', requestedUsd: 840_000, applicant: 'Valargroup', title: 'Token Holder Voting', summary: 'Design, build, audits, deployment and operation of the shielded coinholder voting system, February to November 2026.' },
  { github: 128, category: 'core', requestedUsd: 349_650, applicant: 'Zec.rocks', title: 'zecd: An Audited zcashd Alternative by Zec.rocks', summary: 'An audited wallet server for exchanges, payment processors and other integrators that relied on the deprecated zcashd wallet.' },
  { github: 96, category: 'core', requestedUsd: 47_200, applicant: 'Mohak Malhotra', title: 'Zallet: Deadlock Fix, Wallet Reliability Fixes, New Features and zcashd RPC Parity', summary: 'Thirteen merged PRs to Zallet and related repositories, led by a connection-pool deadlock fix.' },
  { github: 121, category: 'core', requestedUsd: 15_000, applicant: 'jiehuo100net', title: 'Zebra Peer Enforcement and Operational Reliability', summary: 'Five merged Zebra fixes covering peer bans, misbehavior scoring, RPC metadata and block-invalidation errors.' },
  { github: 117, category: 'core', requestedUsd: 15_000, applicant: 'Robust', title: 'Zebra Fuzzing Maintenance and Upstream CI Integration', summary: 'Five merged PRs keeping Zebra’s fuzzing tools current and integrating them into upstream CI.' },
  { github: 103, category: 'core', requestedUsd: 4_500, applicant: 'PulseHawk (Vizora Digital UG)', title: 'Independent NU7 Block Timing Measurement (PulseHawk)', summary: 'Independent measurement of NU7 block timing on testnet and around mainnet activation, with open data and scripts.' },
  { github: 85, category: 'core', requestedUsd: 16_000, applicant: 'Andrew Arnott (nerdcash)', title: 'Nerdbank.Cryptocurrencies Upkeep and librustzcash Fork Improvements', summary: 'Kept the .NET Zcash light-wallet library current through NU6, Ironwood and NU7.' },
  // Wallets & Hardware Signing
  { github: 107, category: 'wallets', requestedUsd: 520_000, applicant: 'Vizor (chainapsis)', title: 'Vizor', summary: 'An Apache-2.0 self-custody wallet for desktop and mobile with Keystone and Ledger signing and a coinholder voting client.' },
  { github: 116, category: 'wallets', requestedUsd: 115_000, applicant: 'LEONINE DAO', title: 'Nozy Wallet', summary: 'An MIT-licensed self-custody wallet (CLI, desktop and Chrome extension) with Ironwood, NU7 and voting support.' },
  { github: 101, category: 'wallets', requestedUsd: 45_000, applicant: 'Anmol Bansal', title: 'Zafe', summary: 'An open-source multisig for shielded ZEC on Google Play, approved asynchronously from members’ phones.' },
  { github: 99, category: 'wallets', requestedUsd: 15_000, applicant: 'Jason Key', title: 'zec_wallet: Shielded Zcash for Any Flutter App', summary: 'A Flutter package for shielded ZEC with a librustzcash-based Rust core and NU7 support.' },
  { github: 123, category: 'wallets', requestedUsd: 16_875, applicant: 'wh00hw', title: 'Open-Source Zcash Hardware-Wallet SDK', summary: 'A Rust SDK and a C11 signing library for microcontrollers supporting shielded PCZT signing.' },
  { github: 98, category: 'wallets', requestedUsd: 6_770, applicant: '0xOucan', title: 'LeekWallet Zcash', summary: 'A DIY hardware wallet from about $25 of ESP32-S3 parts that signs shielded transactions as a PCZT signer.' },
  { github: 112, category: 'wallets', requestedUsd: 4_800, applicant: 'Sofiia', title: 'zec-agent-wallet: Shielded Zcash Payments for AI Agents', summary: 'A local shielded light wallet with an MCP server that lets an AI agent pay owner-approved bills without seeing keys.' },
  { github: 91, category: 'wallets', requestedUsd: 5_000, applicant: 'Danya Molodetskii', title: 'Any Wallet Kit: Zcash in an Open-Source Multichain Wallet SDK', summary: 'Added transparent Zcash and ZEC swaps to an Apache-2.0 TypeScript multichain wallet SDK.' },
  { github: 118, category: 'wallets', requestedUsd: 900, applicant: 'vikions / tallyhuhu', title: 'Zodl Android Wallet OSS Improvements', summary: 'Screen-reader accessibility and exact zatoshi conversion in swap proposals for the Zodl Android wallet.' },
  // Payments, Swaps & Integrations
  { github: 129, category: 'payments', requestedUsd: 325_000, applicant: 'Strahn Cryptography Pte. Ltd.', title: 'ELSA: Recurring Subscriptions for Zcash, ZIP R&D and Stripe Layer', summary: 'Mandates that let merchants take recurring Zcash payments with auto-billing and refunds.' },
  { github: 70, category: 'payments', requestedUsd: 50_000, applicant: 'Maya Protocol', title: 'Maya Protocol: Zcash Upstream Contributions, NU6.2/NU6.3 Ironwood and Zebra Migration', summary: 'Upstream contributions, Ironwood support on Maya mainnet and migration to official Zebra.' },
  { github: 113, category: 'payments', requestedUsd: 40_000, applicant: 'LeoDex', title: 'LeoDex', summary: 'A no-account cross-chain swap app focused on getting ZEC into shielded addresses.' },
  { github: 102, category: 'payments', requestedUsd: 22_380, applicant: 'ShapeShift DAO', title: 'ShapeShift', summary: 'Ledger and Trezor transparent ZEC signing, ZEC swaps via NEAR Intents and a pay-by-deposit widget.' },
  { github: 90, category: 'payments', requestedUsd: 20_000, applicant: 'Andrew Arnott (nerdcash)', title: 'zcash-payment-service', summary: 'A self-hosted service that lets merchants accept shielded ZEC with a viewing key, with e-commerce plugins.' },
  { github: 97, category: 'payments', requestedUsd: 10_500, applicant: 'Jethro Adamu', title: 'PetraPay', summary: 'A non-custodial gateway where customers pay in many tokens and businesses receive shielded ZEC.' },
  { github: 109, category: 'payments', requestedUsd: 2_500, applicant: 'Predge (Amir Latypov)', title: 'Shielded 2-of-3 FROST Escrow on Zcash Testnet', summary: 'A shielded escrow where buyer, seller and arbiter each hold a FROST key share.' },
  // Explorers, Developer & Privacy Tools
  { github: 92, category: 'tools', requestedUsd: 125_000, applicant: 'Kenbak', title: 'Zecblock', ownApplication: true, summary: 'Aug–Nov 2026 work on ZecBlock, a Zcash block explorer and data platform, including research tools, a public API with an MCP server and network observability.' },
  { github: 89, category: 'tools', requestedUsd: 50_000, applicant: 'Agent Embassy', title: 'zpop: Zcash Proof-of-Production Receipts', summary: 'Signed, hash-chained receipts of Zcash mining production that anyone can re-verify from chain data.' },
  { github: 105, category: 'tools', requestedUsd: 10_000, applicant: 'ShieldedScan', title: 'ShieldedScan', summary: 'An open-source Zcash explorer and analytics platform with a public API, an MCP server and a daily dataset.' },
  { github: 87, category: 'tools', requestedUsd: 16_000, applicant: 'Cryppit (Anirudh Tumuluru)', title: 'Zcash Address Fixes, NU7 Readiness Board and ZEC Refund Tools (Cryppit)', summary: 'Upstream fixes, ZIP 320 test vectors, an NU7 readiness board and two read-only tools.' },
  { github: 80, category: 'tools', requestedUsd: 15_000, applicant: 'Dmytro Sysoliatin', title: 'Void Market', summary: 'A sealed-bid auction app combining confidential bid comparison with shielded payment settlement.' },
  { github: 110, category: 'tools', requestedUsd: 13_326, applicant: 'Michael', title: 'Zecpy: Private Payments for the Python Ecosystem', summary: 'A Python SDK with a Rust core for shielded Zcash payments.' },
  { github: 104, category: 'tools', requestedUsd: 4_817, applicant: 'David Peluola', title: 'Can I Shield?', summary: 'A live board showing whether 40 exchanges, wallets and swaps accept shielded ZEC deposits.' },
  { github: 108, category: 'tools', requestedUsd: 3_000, applicant: 'Kylne700', title: 'zcrowd', summary: 'An offline tool showing how many earlier transactions look like yours before shielding or unshielding.' },
  { github: 115, category: 'tools', requestedUsd: 2_000, applicant: 'Ella Victor', title: 'ZTrace', summary: 'A scanner that finds where private Zcash wallet data leaks into logs, analytics and network requests.' },
  { github: 94, category: 'tools', requestedUsd: 1_500, applicant: 'Anukul Pandey', title: 'Zcash Testnet Developer Suite', summary: 'A proof-of-work testnet faucet and a testnet wallet setup tool.' },
  { github: 76, category: 'tools', requestedUsd: 1_690, applicant: 'tidelit4', title: 'ZecHub Bounty Board Security & Maintenance', summary: 'Thirteen merged fixes to the ZecHub Bounty Board backend, a Namada dashboard price feed and wiki links.' },
  { github: 95, category: 'tools', requestedUsd: 200, applicant: 'Veevaa Bajaj', title: 'Zcash Testnet Donation Widget', summary: 'A zero-backend browser widget for shielded testnet donations via ZIP-321.' },
  // Community, Media & Mining
  { github: 72, category: 'community', requestedUsd: 550_000, applicant: 'RUH Youth Sports Foundation', title: 'Zcash Community Mining Lab: Privacy Infrastructure + Youth Leadership', summary: 'A Houston mining facility running nine Antminer Z15/Z15 Pro units mining ZEC.' },
  { github: 120, category: 'community', requestedUsd: 352_000, applicant: 'sudo_ml, nominating mineZcash', title: 'Minezcash: Zcash Forum Moderation Long Service Award', summary: 'A nomination recognizing about 88 active months of Zcash Community Forum moderation since 2016.' },
  { github: 86, category: 'community', requestedUsd: 14_067, applicant: 'OLA (ola_olu)', title: 'The Zcash Daily', summary: 'A daily sourced digest of Zcash ecosystem news, including editions projected through December 31, 2026.' },
  // Program Administration
  { github: null, category: 'admin', requestedUsd: 58_000, applicant: 'Financial Privacy Foundation (FPF)', title: 'FPF Administrative & Operational Role for the CDRGP: 2027 Renewal', summary: 'Not a retroactive grant: a one-year pre-paid fee for administering the program in 2027, unchanged from FPF’s first term.' },
];

export const GRANT_ROUNDS: readonly GrantRound[] = [
  {
    slug: 'retroactive-grants-q4-2026',
    quarter: 'Q4 2026',
    title: 'Q4 2026 Retroactive Grants',
    description: '55 proposals for completed Zcash work are in community review. Coinholders vote December 17–29, 2026.',
    topicIds: [59298, 58598],
    source: 'https://forum.zcashcommunity.com/t/q4-2026-coinholder-directed-retroactive-grant-program-cdrgp-review-period/59298',
    callForProposals: 'https://forum.zcashcommunity.com/t/q4-2026-coinholder-directed-retroactive-grant-program-call-for-proposals/58598',
    schedule: {
      submissionsOpen: '2026-10-30', submissionsClose: '2026-11-13T20:00:00Z',
      reviewOpen: '2026-11-16', reviewClose: '2026-12-16T20:00:00Z',
      votingOpensOn: '2026-12-17', votingClose: '2026-12-29T20:00:00Z',
    },
    ballotOptions: ['Yes — fund the proposal', 'No — do not fund the proposal', 'Abstain'],
    ballotNote: 'Each proposal is voted on individually. A proposal needs at least 420,000 ZEC participating (Yes, No and Abstain combined) and more Yes than No to pass.',
    proposals: Q4_2026_PROPOSALS,
    statedTotals: { proposals: 55, requestedUsd: 5_867_425 },
  },
  {
    slug: 'retroactive-grants-q3-2026',
    quarter: 'Q3 2026',
    title: 'Q3 2026 Retroactive Grants',
    description: 'Coinholder polling on completed work across the Zcash ecosystem.',
    topicIds: [57056],
    source: 'https://forum.zcashcommunity.com/t/30-day-review-period-coinholder-directed-retroactive-grants-program-q3/57056',
    callForProposals: 'https://forum.zcashcommunity.com/t/call-for-proposals-coinholder-directed-retroactive-grants-program-q3/56885',
    schedule: {
      submissionsOpen: '2026-07-31', submissionsClose: '2026-08-14T20:00:00Z',
      reviewOpen: '2026-08-17', reviewClose: '2026-09-16T20:00:00Z',
      votingOpensOn: '2026-09-17', votingClose: '2026-09-29T20:00:00Z',
    },
    ballotOptions: ['Accept', 'Reject — do not support the project', 'Reject — reconsider in a future round at a lower amount', 'Abstain'],
    ballotNote: 'Both rejection options count as “no.”',
    proposals: [],
  },
];

/** The round the site announces: the latest configured round. */
export const CURRENT_GRANT_ROUND = GRANT_ROUNDS[0];

export type GrantPhase = 'submissions' | 'between' | 'review' | 'awaiting-vote' | 'voting' | 'closed';
export type GrantPhaseInfo = { phase: GrantPhase; step: 0 | 1 | 2 | 3 };

const dayStart = (date: string) => Date.parse(`${date}T00:00:00Z`);

/**
 * Schedule phase from the official calendar. Voting is "scheduled" here; only
 * a registered on-chain round can say voting is actually open.
 */
export function grantPhase(round: GrantRound, now: number): GrantPhaseInfo {
  const s = round.schedule;
  if (now < Date.parse(s.submissionsClose)) return { phase: 'submissions', step: 0 };
  if (now < dayStart(s.reviewOpen)) return { phase: 'between', step: 1 };
  if (now < Date.parse(s.reviewClose)) return { phase: 'review', step: 1 };
  if (now < dayStart(s.votingOpensOn)) return { phase: 'awaiting-vote', step: 2 };
  if (now < Date.parse(s.votingClose)) return { phase: 'voting', step: 2 };
  return { phase: 'closed', step: 3 };
}

export function grantTotals(round: GrantRound) {
  const byCategory = new Map<GrantCategory, { count: number; requestedUsd: number }>();
  for (const p of round.proposals) {
    const entry = byCategory.get(p.category) ?? { count: 0, requestedUsd: 0 };
    entry.count++;
    entry.requestedUsd += p.requestedUsd;
    byCategory.set(p.category, entry);
  }
  return {
    count: round.proposals.length,
    requestedUsd: round.proposals.reduce((sum, p) => sum + p.requestedUsd, 0),
    byCategory: [...byCategory.entries()].map(([category, value]) => ({ category, ...value })).sort((a, b) => b.requestedUsd - a.requestedUsd),
  };
}

export function grantRoundBySlug(slug: string) {
  return GRANT_ROUNDS.find(round => round.slug === slug);
}

/** Exact official discussion identity; never associate a ballot by title alone. */
export function grantRoundForDiscussion(discussionUrl: string): GrantRound | undefined {
  try {
    const url = new URL(discussionUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'forum.zcashcommunity.com') return undefined;
    const topic = url.pathname.match(/^\/t\/(?:[^/]+\/)?(\d+)(?:\/|$)/)?.[1];
    return topic ? GRANT_ROUNDS.find(round => round.topicIds.includes(Number(topic))) : undefined;
  } catch { return undefined; }
}

export const formatUsd = (value: number) => `$${value.toLocaleString('en-US')}`;
export const formatUsdCompact = (value: number) => value >= 1_000_000 ? `$${(value / 1_000_000).toFixed(2)}M` : value >= 1_000 ? `$${Math.round(value / 1_000)}K` : `$${value}`;
