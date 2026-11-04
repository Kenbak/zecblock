import type { UpgradeChange } from './upgrade-changes';

/** Historical protocol changes and labeled wallet standards; tools show their current supported view. */
export const HISTORICAL_UPGRADE_CHANGES: Record<string, UpgradeChange[]> = {
  overwinter: [
    {
      id: 'upgrade-mechanism', title: 'Coordinated network upgrades',
      description: 'Introduced activation heights and consensus branch IDs, with peer rules that separate incompatible upgrade branches.',
      sources: [{ label: 'ZIP 200', href: 'https://zips.z.cash/zip-0200' }, { label: 'ZIP 201', href: 'https://zips.z.cash/zip-0201' }],
      links: [],
    },
    {
      id: 'v3-transactions', title: 'Upgrade-aware transactions', value: 'v3 transactions',
      description: 'Replaced v1 and v2 transactions with upgrade-aware v3 transactions using version-group identifiers and branch replay protection.',
      sources: [{ label: 'ZIP 202', href: 'https://zips.z.cash/zip-0202' }, { label: 'ZIP 143', href: 'https://zips.z.cash/zip-0143' }],
      links: [{ label: 'Inspect transaction versions', href: '/tools/decode', note: 'Current decoder; paste a historical transaction to inspect its format.' }],
    },
    {
      id: 'transaction-expiry', title: 'Transaction expiry',
      description: 'Allowed transactions to specify the last block height at which they can be mined.',
      sources: [{ label: 'ZIP 203', href: 'https://zips.z.cash/zip-0203' }],
      links: [{ label: 'Inspect an expiry height', href: '/tools/decode', note: 'Current decoder; expiry is a transaction field, not a confirmation estimate.' }],
    },
    {
      id: 'signature-digest', title: 'More efficient signature validation',
      description: 'Changed signature hashing to reuse intermediate hashes and commit to transparent input amounts.',
      sources: [{ label: 'ZIP 143', href: 'https://zips.z.cash/zip-0143' }],
      links: [],
    },
  ],
  sapling: [
    {
      id: 'sapling-pool', title: 'A more efficient shielded pool', value: 'Sapling',
      description: 'Added Sapling shielded spends and outputs with faster, lower-memory proof creation.',
      sources: [{ label: 'ZIP 205', href: 'https://zips.z.cash/zip-0205' }, { label: 'Sapling specification', href: 'https://zips.z.cash/protocol/sapling.pdf' }],
      links: [{ label: 'See Sapling pool supply', href: '/pools#supply', note: 'Current pool history; this link does not select the Sapling activation period.' }],
    },
    {
      id: 'spend-authority', title: 'Separate proving and spending authority',
      description: 'Allowed proof construction and transaction signing to run on separate hardware without sharing spending authority.',
      sources: [{ label: 'ZIP 205', href: 'https://zips.z.cash/zip-0205' }, { label: 'Sapling specification', href: 'https://zips.z.cash/protocol/sapling.pdf' }],
      links: [],
    },
    {
      id: 'viewing-and-addresses', title: 'Viewing keys and diversified addresses',
      description: 'Added full viewing keys for incoming and outgoing details and multiple unlinkable receiving addresses under one viewing key.',
      sources: [{ label: 'ZIP 205', href: 'https://zips.z.cash/zip-0205' }, { label: 'Sapling specification', href: 'https://zips.z.cash/protocol/sapling.pdf' }],
      links: [],
    },
    {
      id: 'v4-transactions', title: 'Sapling transaction format', value: 'v4 transactions',
      description: 'Replaced v3 transactions with v4 transactions and signature digests that bind the new Sapling spends and outputs.',
      sources: [{ label: 'ZIP 205', href: 'https://zips.z.cash/zip-0205' }, { label: 'ZIP 243', href: 'https://zips.z.cash/zip-0243' }],
      links: [{ label: 'Inspect Sapling transaction components', href: '/tools/decode', note: 'Current decoder; paste a v4 transaction to inspect its public components.' }],
    },
    {
      id: 'sprout-groth16', title: 'Updated Sprout proofs', value: 'Groth16',
      description: 'Replaced the original Sprout JoinSplit proving system with Groth16 while retaining the Sprout pool.',
      sources: [{ label: 'ZIP 205', href: 'https://zips.z.cash/zip-0205' }, { label: 'Sapling specification', href: 'https://zips.z.cash/protocol/sapling.pdf' }],
      links: [],
    },
  ],
  blossom: [
    {
      id: 'block-spacing', title: 'Shorter block target', value: '150s → 75s',
      description: 'Halved the target spacing between blocks to reduce expected confirmation latency.',
      sources: [{ label: 'ZIP 206', href: 'https://zips.z.cash/zip-0206' }, { label: 'ZIP 208', href: 'https://zips.z.cash/zip-0208' }],
      links: [{ label: 'Compare current block intervals', href: '/network/block-speed', note: 'Recent observations and current targets; this chart does not replay Blossom activation.' }],
    },
    {
      id: 'subsidy-clock', title: 'Preserved issuance over time',
      description: 'Halved subsidy per block and adjusted halving and Founders’ Reward block counting to preserve approximately the same calendar-time issuance.',
      sources: [{ label: 'ZIP 208', href: 'https://zips.z.cash/zip-0208' }],
      links: [{ label: 'Inspect current issuance and halvings', href: '/network#issuance', note: 'Current subsidy and schedule; this view is not a historical Blossom comparison.' }],
    },
    {
      id: 'wallet-expiry-default', title: 'Wallet transaction-expiry default', value: '20 → 40 blocks',
      description: 'Changed the wallet transaction-creation default to 40 blocks to retain roughly 50 minutes at the shorter target; the consensus expiry limit was unchanged.',
      sources: [{ label: 'ZIP 203', href: 'https://zips.z.cash/zip-0203' }],
      links: [{ label: 'Inspect a transaction’s expiry height', href: '/tools/decode', note: 'Current decoder shows the chosen expiry height; it does not identify which wallet default was used.' }],
    },
  ],
  heartwood: [
    {
      id: 'shielded-coinbase', title: 'Shielded mining rewards',
      description: 'Allowed coinbase funds to be created directly in Sapling outputs while retaining transparent coinbase outputs.',
      sources: [{ label: 'ZIP 250', href: 'https://zips.z.cash/zip-0250' }, { label: 'ZIP 213', href: 'https://zips.z.cash/zip-0213' }],
      links: [{ label: 'Inspect shielded coinbase outputs', href: '/tools/decode', note: 'Current decoder; paste a coinbase transaction to inspect its public composition.' }],
    },
    {
      id: 'chain-history', title: 'Chain-history commitments',
      description: 'Added block-header commitments to chain history to support FlyClient proofs.',
      sources: [{ label: 'ZIP 250', href: 'https://zips.z.cash/zip-0250' }, { label: 'ZIP 221', href: 'https://zips.z.cash/zip-0221' }],
      links: [],
    },
  ],
  canopy: [
    {
      id: 'development-fund', title: 'Development funding streams', value: '20% of block subsidy',
      description: 'Replaced the Founders’ Reward with funding streams allocating 7% to BP/ECC, 5% to ZF and 8% to Major Grants at Canopy activation.',
      sources: [{ label: 'ZIP 251', href: 'https://zips.z.cash/zip-0251' }, { label: 'ZIP 207', href: 'https://zips.z.cash/zip-0207' }, { label: 'ZIP 214', href: 'https://zips.z.cash/zip-0214' }],
      links: [{ label: 'Inspect current subsidy allocations', href: '/network#issuance', note: 'Current issuance and miner allocation; the original Canopy funding streams have ended.' }],
    },
    {
      id: 'sprout-inflows', title: 'No new value entering Sprout',
      description: 'Prevented new value from being added to Sprout while allowing its existing balance to leave.',
      sources: [{ label: 'ZIP 251', href: 'https://zips.z.cash/zip-0251' }, { label: 'ZIP 211', href: 'https://zips.z.cash/zip-0211' }],
      links: [{ label: 'See remaining Sprout pool supply', href: '/pools#supply', note: 'Current pool history; this link does not select Canopy-era flows.' }],
    },
    {
      id: 'sapling-note-plaintext', title: 'Stronger Sapling address privacy',
      description: 'Changed Sapling note plaintexts so recipients can verify the sender’s ephemeral key and protect diversified-address privacy.',
      sources: [{ label: 'ZIP 251', href: 'https://zips.z.cash/zip-0251' }, { label: 'ZIP 212', href: 'https://zips.z.cash/zip-0212' }],
      links: [],
    },
    {
      id: 'ed25519-validation', title: 'Explicit Ed25519 validation rules',
      description: 'Specified consistent Sprout signature-validity rules that also support batch verification.',
      sources: [{ label: 'ZIP 251', href: 'https://zips.z.cash/zip-0251' }, { label: 'ZIP 215', href: 'https://zips.z.cash/zip-0215' }],
      links: [],
    },
  ],
  nu5: [
    {
      id: 'orchard-pool', title: 'Orchard and Halo 2', value: 'No trusted setup',
      description: 'Introduced the Orchard shielded pool using Halo 2 proofs without a trusted setup.',
      sources: [{ label: 'ZIP 252', href: 'https://zips.z.cash/zip-0252' }, { label: 'ZIP 224', href: 'https://zips.z.cash/zip-0224' }],
      links: [{ label: 'See current Orchard pool supply', href: '/pools#supply', note: 'Current pool history after later upgrades; this is not an NU5 activation comparison.' }],
    },
    {
      id: 'v5-transactions', title: 'Version 5 transactions', value: 'v5 transactions',
      description: 'Added v5 transactions with separate transparent, Sapling and Orchard sections while keeping v4 valid.',
      sources: [{ label: 'ZIP 252', href: 'https://zips.z.cash/zip-0252' }, { label: 'ZIP 225', href: 'https://zips.z.cash/zip-0225' }],
      links: [{ label: 'Inspect v5 transaction components', href: '/tools/decode', note: 'Current decoder; v4 transactions also remained valid at NU5 activation.' }],
    },
    {
      id: 'transaction-identifiers', title: 'Stable transaction identifiers',
      description: 'Made v5 transaction IDs independent of proofs and signatures while committing to authorization data separately in block headers.',
      sources: [{ label: 'ZIP 252', href: 'https://zips.z.cash/zip-0252' }, { label: 'ZIP 244', href: 'https://zips.z.cash/zip-0244' }],
      links: [],
    },
    {
      id: 'v5-relay', title: 'Witnessed transaction relay',
      description: 'Updated peer transaction relay to identify v5 transactions by both their transaction ID and authorization commitment.',
      sources: [{ label: 'ZIP 252', href: 'https://zips.z.cash/zip-0252' }, { label: 'ZIP 239', href: 'https://zips.z.cash/zip-0239' }],
      links: [],
    },
    {
      id: 'canonical-jubjub', title: 'Canonical Sapling point encodings',
      description: 'Required canonical Jubjub point encodings so implementations agree on Sapling transaction data.',
      sources: [{ label: 'ZIP 252', href: 'https://zips.z.cash/zip-0252' }, { label: 'ZIP 216', href: 'https://zips.z.cash/zip-0216' }],
      links: [],
    },
    {
      id: 'unified-wallet-formats', title: 'Unified addresses and viewing keys', value: 'Associated wallet standard',
      description: 'Defined wallet encodings that bundle multiple address receivers or full viewing keys; this associated standard is not a consensus activation requirement.',
      sources: [{ label: 'ZIP 252', href: 'https://zips.z.cash/zip-0252' }, { label: 'ZIP 316', href: 'https://zips.z.cash/zip-0316' }],
      links: [],
    },
  ],
};
