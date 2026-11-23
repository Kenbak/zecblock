// "About" copy rendered at the bottom of pages with their own functionality
// (mainnet only). Each entry restates what its page shows, from the page's own
// metadata, header and methodology text, plus the search question people ask
// about it. Check the page before changing a claim; keep Zcash Names out.

import type { HomeAbout } from './home-about';

export const PAGE_ABOUT: Record<string, HomeAbout> = {
  '/mempool': {
    heading: 'About the Zcash mempool',
    intro: ['The mempool is the staging area of the Zcash network: every transaction broadcast by a wallet waits here until a miner includes it in a block. Confirmation time varies with block spacing, fees, and network demand. ZecBlock streams mempool entries and removals live over WebSocket from its own Zakura full node.'],
    more: [['Each pending transaction is classified as transparent, shielded, or mixed based on its components. For shielded entries, only the structure is visible — amounts, senders, and receivers stay encrypted, in the mempool and forever after.']],
    items: [{
      question: 'How long does a Zcash transaction take to confirm?',
      answer: ['Since the NU7 upgrade on November 6, 2026, Zcash targets one block every 25 seconds. A transaction leaves the mempool once a block includes it, and its page keeps the same URL. Measured block times are on ', { href: '/network/block-speed', text: 'Block speed' }, '.'],
    }],
  },
  '/blocks': {
    heading: 'About Zcash blocks',
    intro: ['Zcash block timing follows the active network upgrade. Each block bundles transparent and shielded transactions, a coinbase reward for the miner, and a commitment to the current state of the shielded pools. ZecBlock indexes every block from a Zcash full node, so heights, hashes, sizes, and intervals on this page reflect the canonical chain in real time.'],
    more: [['The interval column tracks the spacing between consecutive blocks — useful for spotting hashrate swings or unusually slow blocks. Click any height or hash to inspect the full block: its transactions, miner, difficulty, and shielded activity.']],
    items: [{
      question: 'How often is a Zcash block mined?',
      answer: ['Zcash targets one block every 25 seconds since NU7, and every 75 seconds before it. Actual intervals vary from block to block; see ', { href: '/network/block-speed', text: 'Block speed' }, ' for measured times.'],
    }],
  },
  '/txs': {
    heading: 'About Zcash transactions',
    intro: ['Zcash supports two kinds of value transfer: transparent transactions, which work like Bitcoin and expose addresses and amounts on-chain, and shielded transactions, which use zero-knowledge proofs (Sapling, Orchard, and Ironwood) to keep sender, receiver, and amount private. Many transactions mix both — shielding funds into a private pool or deshielding them back out.'],
    more: [['This page lists every transaction as it is mined, with type badges for transparent, Sapling, Orchard, Ironwood, and coinbase activity, plus flow indicators for shielding and deshielding movements. Filter by type, pool, flow direction, or minimum amount to analyze specific transaction patterns. The ', { href: '/txs?type=shielded', text: 'shielded view' }, ' lists shielded transactions only.']],
    items: [],
  },
  '/rich-list': {
    heading: 'About the Zcash rich list',
    intro: ['The rich list ranks Zcash transparent addresses by balance, labels known exchanges and mining pools, and shows how much of the transparent supply the top 10 and top 100 addresses hold.'],
    items: [{
      question: 'Why are shielded balances missing?',
      answer: ['Shielded addresses don’t reveal their balances, so no explorer can rank them. The list covers transparent ZEC only; ', { href: '/pools', text: 'Shielded pools' }, ' shows how much ZEC is held shielded in total.'],
    }],
  },
  '/privacy-risks': {
    heading: 'About Zcash privacy risks',
    intro: ['Shielded transfers hide the sender, receiver and amount, but ZEC enters and leaves the shielded pools in public. This page looks for amount and timing patterns at those boundaries, candidate transaction links and withdrawal batches, and shows the evidence for each.'],
    items: [{
      question: 'Can Zcash transactions be traced?',
      answer: ['Inside the shielded pools, no explorer can follow payments. At the pool boundaries, similar amounts and timing can suggest that a deposit and a withdrawal are linked. These are leads, not proof of a transfer or common ownership. To blend in, ', { href: '/tools/blend-check', text: 'check your amount' }, ' before shielding.'],
    }],
  },
  '/privacy/wallets': {
    heading: 'About Zcash wallet signals',
    intro: ['Wallets leave patterns in the transactions they build, such as the fee they pay. This page groups observed shielded transactions by those patterns and the wallet implementations they match. A match describes transaction behavior, not an identified user, and patterns can overlap.'],
    items: [],
  },
  '/tools/blend-check': {
    heading: 'Why the amount you shield matters',
    intro: ['When you shield ZEC, the amount you move into the shielded pool is visible on chain. An unusual amount such as 7.31924 ZEC can be matched later when the same amount is deshielded. Blend Check compares your amount with observed public shielding and deshielding flows, so you can pick one many others use.'],
    items: [{
      question: 'How do I shield ZEC privately?',
      answer: ['Use common, round amounts such as 1, 5 or 10 ZEC, split large or odd amounts into several transactions, and shield leftovers at a different time. Amount frequency is a heuristic, not a privacy guarantee.'],
    }],
  },
  '/network/upgrades': {
    heading: 'About Zcash network upgrades',
    intro: ['Zcash changes its consensus rules through network upgrades, each activating at a set block height. This page covers every upgrade from Overwinter to NU7 and links to trackers for their effects: block speed, the NSM reserve and fees, shielded pools, transactions and funding.'],
    items: [],
  },
  '/crosschain': {
    heading: 'About ZEC cross-chain swaps',
    intro: ['Native ZEC can be swapped to and from other chains through NEAR Intents, Maya and THORChain. This page tracks those swaps for each venue, with charts, transaction records and the historical coverage of each source.'],
    items: [],
  },
  '/turnstile': {
    heading: 'About the Turnstile Tracker',
    intro: ['ZEC that leaves a shielded pool lands on a transparent address. The Turnstile Tracker follows it and shows whether it stays there, is reshielded, moves to an exchange or bridge, or transfers elsewhere. The data updates every 5 minutes.'],
    items: [],
  },
  '/privacy': {
    heading: 'About Zcash privacy',
    intro: ['Zcash is private when people use shielded transactions, which encrypt the sender, receiver, amount and memo. Transparent transactions are public, like Bitcoin. The Privacy Score measures how much of the network’s activity and supply is shielded; it doesn’t rate the privacy of a single transaction.'],
    items: [],
  },
  '/pools': {
    heading: 'About Zcash shielded pools',
    intro: ['A shielded pool holds ZEC whose owners, balances and transfers are encrypted. Zcash has four: Sprout, Sapling, Orchard and Ironwood, each a newer generation of the protocol. Pool totals and the ZEC moving in and out are public; individual shielded balances are not.'],
    items: [],
  },
};
