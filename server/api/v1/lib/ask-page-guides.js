'use strict';
// Reviewed against the corresponding page/components, not scraped page text.
// These guides describe controls and methodology; they contain no live readings.
const chartPages = require('../../../../lib/ask/chart-pages.json');
const pageGuides = [
  ...chartPages.map(chart => ({ id: `chart_${chart.id.replace(/-/g, '_')}`, title: chart.title, url: `/charts/${chart.id}`, text: `${chart.title}: ${chart.description}\n\nUnits: ${chart.unit}. Available source window: ${chart.window}. Use the chart’s supported range and series controls to change the view; source analysis and sharing controls are on the card. This guide explains the series definition. Ask has not received the current plotted values or your selected range.`, questions: {} })),
  {
    id: 'attestations', title: 'Reading Indexer Attestations', url: '/network/attestations',
    text: 'Indexer Attestations displays observed enclave evidence, TLS certificate bindings and software release verification for experimental Zero Indexer endpoints. Inspect the endpoint status, observation age and the separate release-measurement checks.\n\nA fresh attestation, a published measurement match and a reproduced-build match are different claims. Expired or unavailable observations are not a verified current state. This page guide does not fetch or certify the endpoint’s latest security status.',
    questions: { 'Is an attestation the same as a reproduced build?': 'No. Enclave evidence and certificate binding describe an observed endpoint. A reproduced-build match is a separate check against independently reproduced software measurements. Read both the freshness and release-verification labels.' },
  },
  {
    id: 'privacy_policy', title: 'Reading the Privacy Policy', url: '/privacy-policy',
    text: 'The Privacy Policy describes information processed by the explorer, its tools and third-party services, along with retention, choices and contact details. Read the sections for the particular feature you use and check the page’s update date.\n\nBrowser-local decryption is separate from requests sent to the explorer or an AI provider. A private blockchain transaction does not make every website request unlogged. The published policy is the source for the service’s stated handling; this guide does not replace its wording.',
    questions: { 'Is browser-local decryption the same as private chat?': 'No. Memo decryption and Ask are different features. Decryption runs in the browser, while enabled AI requests send the question and supported context to a provider. Read the policy’s feature-specific descriptions and keep wallet secrets out of chat.' },
  },
  {
    id: 'terms', title: 'Reading the Terms of Service', url: '/terms',
    text: 'The Terms of Service covers the explorer, API and tools, user responsibilities, third-party swap and on-ramp services, availability and liability limits. Use the section headings and update date to locate the relevant published wording.\n\nExplorer data and modeled metrics are informational. They are not a promise of uninterrupted availability, transaction success or investment performance. This page guide helps navigate the document; the terms themselves are the authoritative service text.',
    questions: { 'Where are the availability conditions?': 'See the Availability section of the Terms of Service, alongside the Description of Service and Limitation of Liability sections. Use the published wording and update date for the applicable conditions.' },
  },
  {
    id: 'name', title: 'Reading a Zcash Name', url: '/docs#name-resolve',
    text: 'A name page displays the name-service record and its available public resolution information. Check the record and linked destination before using a resolved address; a readable name and a verified identity are different things.\n\nAsk can explain name resolution but does not automatically retrieve this page’s current record, verify its owner or initiate a payment. It never needs a private key or recovery phrase to explain the public record.',
    questions: { 'Does a readable name verify someone’s identity?': 'No. Name resolution provides a record and a destination according to the naming system. It does not by itself prove a real-world identity or that a payment destination is appropriate for your purpose.' },
  },
  {
    id: 'mempool', title: 'Reading the Mempool', url: '/mempool',
    text: 'The Mempool page shows transactions waiting in this explorer’s node before they are mined. Start with the pending count, then use the live visualization or transaction table to inspect entries. The view can be expanded to fullscreen or opened in ambient mode. Click a transaction ID for its public details.\n\nFully shielded, transparent and mixed describe transaction components. The shielded-plus-partial share includes mixed transactions and applies to the displayed sample, which may be smaller than the total pending count. Transactions can enter or leave as blocks arrive; a removal alone does not tell you whether a transaction confirmed or was dropped. This node’s mempool is an observation, not a global queue or a guaranteed confirmation schedule.',
    questions: { 'Does pending mean confirmed?': 'No. Pending means this node has observed the transaction in its mempool. Confirmation happens when it is included in a canonical block. Open its transaction page to check the current indexed status; disappearance from the mempool alone is not confirmation.' },
  },
  {
    id: 'network', title: 'Reading the Network overview', url: '/network',
    text: 'The Network page brings protocol parameters, issuance, block production and observed network activity together. Use the section navigation to move between the overview, issuance and supporting charts. Read the observation window beside hashrate, block cadence and fees before comparing them; Technical details describes this explorer’s node.\n\nHashrate is estimated from chain work over a window, not measured from every miner. Block cadence uses header timestamps rather than arrival times. Issuance and subsidy describe newly created ZEC; fees come from transactions. Node, chain and market observations can update at different times, so one current card does not make every chart current.',
    questions: { 'How should I read the hashrate estimate?': 'Hashrate estimates the work rate implied by blocks over the stated window. Compare like-for-like windows; a short-window change can reflect variation in block production. It is not a direct measurement of every mining machine, and one change does not establish its cause.' },
  },
  {
    id: 'network_upgrades', reviewed: '2026-10-23', title: 'Reading Network Upgrades', url: '/network/upgrades',
    text: 'Network Upgrades connects Zcash protocol history with the explorer’s existing trackers. Select an upgrade on the timeline to read its summary and specification; the arrow controls scroll to earlier or later milestones. Each selection lists the major protocol changes and associated wallet standards, with specifications and links to existing views of their effects. Some changes have no dedicated explorer visualization. NSM and fee accounting has a preactivation mechanism overview; observed accounting charts require verified NU7 activation. Activation status belongs to the selected network.\n\nCheck whether a status or estimate comes from the serving node, historical configuration or an announcement. An announced or estimated date does not establish activation, and a tracker link does not prove that an upgrade is active. Tracker measurements have their own sources, windows and limitations. This guide explains the hub without retrieving current activation status or tracker observations.',
    questions: { 'Does a linked tracker prove an upgrade is active?': 'No. The link connects an upgrade with related explorer data. Check the upgrade’s status, selected network and stated source. Announcements and projected dates are separate from confirmation that the serving network has reached an activation height.' },
  },
  {
    id: 'block_speed', reviewed: '2026-10-23', title: 'Reading Block Speed', url: '/network/block-speed',
    text: 'Block Speed expands the Network overview’s block-speed card into daily block intervals, confirmation-wait comparisons and a recent interval chart. Use the section links to move between the daily chart, confirmations, live detail and methodology. The Network page links to this detail page, and the page header links back to Network.\n\nMeasured intervals come from block-header timestamps rather than explorer arrival times. Consensus targets and future projections are labeled separately from observations. Confirmation waits are estimates that assume the transaction enters the next block; they are not a guarantee of inclusion or a wallet’s spending policy. Check the selected network, observation window and method before comparing mainnet and testnet, because testnet’s minimum-difficulty behavior makes its timing irregular. This guide explains the page without retrieving its current observations.',
    questions: {},
  },
  {
    id: 'nodes', title: 'Reading Network Nodes', url: '/network/nodes',
    text: 'Network Nodes explores the peers this infrastructure observes. Use the map and topology views for geographic and advertisement context, Software & Protocol for client/version distribution, and Reliability & Hosting for reachability and concentration. The node directory can be sorted to compare the observed records.\n\nActive observations combine live peer connections and recent crawler handshakes with same-session Zcash checkpoint proof, deduplicated by IP address. Graph links record fresh address advertisements; advertised-only targets are not verified active nodes or confirmed remote connections. Client names and versions are self-reported. Geographic positions are rounded and Tor nodes may have no map position. The totals count observed nodes, not all Zcash nodes or independent operators.',
    questions: { 'Is this a count of every Zcash node?': 'No. It is the active network observed by this infrastructure through peer connections and recent crawler handshakes. Unreachable, private or unobserved nodes may be absent. Deduplicating addresses does not turn the result into a count of independent operators.' },
  },
  {
    id: 'mining', title: 'Reading Mining analytics', url: '/mining',
    text: 'Mining combines hashrate, pool distribution, pool rankings, software markers, block economics and miner behavior. Use each section’s period control to compare the same window. Pool rankings and shares describe blocks attributed to pools; unattributed blocks still matter when judging concentration.\n\nPool attribution comes from coinbase evidence. Software markers are a separate, self-reported signal: a Zebra or Zakura tag does not authenticate the software, and no tag does not mean zcashd. Block rewards and transaction fees are different sources of miner revenue. Miner behavior compares spent and unspent reward outputs; a movement alone does not prove a sale.',
    questions: { 'Do software markers prove which node software miners run?': 'No. They are tags miners put in coinbase data. They can identify a reported implementation, but the explorer does not authenticate the running software. Unknown or missing tags belong in the denominator; no tag is not evidence of zcashd.' },
  },
  {
    id: 'reorgs', title: 'Reading Forks & Reorgs', url: '/reorgs',
    text: 'Forks & Reorgs records competing blocks and changes in the canonical chain observed by the monitor. Use Reorg History for detected events, Orphaned Blocks for retained losing blocks, and Monitored Nodes to compare reporting infrastructure. Open the block links to inspect the canonical and orphaned records.\n\nReorg depth counts replaced blocks; it is different from the number of orphan records or fork events. Block first-seen information describes the monitor’s observations, not a guaranteed network arrival time. The monitored-node list is not a census of Zcash nodes. A competing tip alone does not establish an attack, and an empty history does not prove complete monitoring coverage.',
    questions: { 'What is the difference between an orphan and a reorg?': 'An orphan here is a retained block that is not on the canonical chain. A reorg is a change in which chain is canonical, potentially replacing several blocks. An orphan record, a detected fork event and reorg depth therefore measure different things.' },
  },
  {
    id: 'charts', title: 'Using the Chart library', url: '/charts',
    text: 'The Chart library groups Zcash observations by topic so you can compare supply, activity, mining, valuation and cross-chain data. Open a chart to inspect its description, units, source and observation window. Its controls let you adjust supported ranges and series, and sharing/export controls preserve the chart context.\n\nBefore interpreting a move, check whether the chart measures a balance, a flow, a count or a modeled ratio. Compare equal windows and look for missing observations. Chart guides explain how to read the controls; a chart’s displayed series and URL filters are not automatically passed to Ask.',
    questions: { 'What should I check before comparing charts?': 'Check the units, observation window, source coverage and whether each series is a balance, a period flow or a count. Two curves moving together do not establish causation. Missing observations should not be interpreted as zero.' },
  },
  {
    id: 'privacy_score', title: 'Reading the Privacy Score', url: '/privacy',
    text: 'Privacy Score is the explorer’s weighted model of observed shielded participation, fully shielded activity, shielded supply and tracked reshielding. Read the component breakdown and methodology alongside the headline: the inputs use different observation windows and their coverage can differ. The activity feed updates independently from the score.\n\nThis is a network-usage indicator, not a security audit or a probability that your transaction can be linked. The current formula treats unavailable turnstile inputs as zero, so a low reshielding contribution can reflect incomplete data. Historical changes can also reflect formula changes rather than a change in cryptographic privacy.',
    questions: { 'Does the privacy score measure my transaction’s privacy?': 'No. It combines public network-level usage indicators. It does not inspect your wallet, measure your personal anonymity set or provide a probability that a specific transaction can be linked. Use the component breakdown and methodology to understand what moved.' },
  },
  {
    id: 'turnstile', title: 'Reading the Turnstile Tracker', url: '/turnstile',
    text: 'Turnstile Tracker follows observable transparent activity after ZEC leaves a shielded pool. Read the destination categories to distinguish funds still on the transparent address, reshielding, labelled exchange destinations and other transfers. Use the page’s records and source transactions to inspect a category rather than interpreting the headline alone.\n\nThis is public-boundary tracking. A labelled exchange destination is not proof of a sale, and reshielding is not evidence about subsequent private payments. Coverage and destination labels limit what can be inferred; the tracker does not reveal transfers inside a shielded pool.',
    questions: { 'Does an exchange destination mean the ZEC was sold?': 'No. It identifies an observed transfer to a labelled destination. Depositing, trading and withdrawing are different actions; a public transfer does not show whether an exchange trade actually happened.' },
  },
  {
    id: 'privacy_risks', title: 'Reading Privacy Risk Analysis', url: '/privacy-risks',
    text: 'Privacy Risk Analysis surfaces candidate relationships in public shielding and deshielding amounts and timing. Switch between round-trip candidates and repeated withdrawal patterns, then narrow the window or signal level. Open the score evidence and transaction links to inspect why a candidate was shown. Batch graphs use dashed connections for inferred links.\n\nAmount similarity, timing, rarity and competing candidates contribute to heuristic scores. A high score is not proof of identity, ownership or an exact flow of funds. Empty results mean no observations matched those filters, not that privacy is guaranteed.',
    questions: { 'Does a high score prove these transactions are linked?': 'No. It is a model score based on public amount and timing evidence. Inspect competing candidates and the individual score inputs. Even a strong candidate does not prove common ownership or trace funds through hidden shielded transfers.' },
  },
  {
    id: 'wallet_signals', title: 'Reading Wallet Signals', url: '/privacy/wallets',
    text: 'Wallet Signals compares fee patterns and observable transaction construction patterns with reviewed wallet implementation signals. Read the fee distribution, observed pattern matches and implementation descriptions together. A match describes behavior in public transaction data; it does not identify the person using a wallet.\n\nDifferent wallets can share a pattern, and a wallet’s behavior can change between versions or settings. Counts and shares apply to the observed dataset rather than all wallet users. Use the underlying transaction and implementation evidence before treating a match as attribution.',
    questions: { 'Can these signals identify someone’s wallet?': 'They can suggest compatible implementation behavior, not identify a user or prove which wallet produced a transaction. Shared fee rules and transaction construction can create overlapping matches across wallets.' },
  },
  {
    id: 'valuation', title: 'Reading Valuation & Market Context', url: '/valuation',
    text: 'Valuation separates market quotes, modeled cost basis, transparent spending behavior and search interest. Use the period controls and metric switches to compare like-for-like observations. Open Methodology & data coverage to check which values are current quotes and which are dated model snapshots.\n\nMVRV compares market capitalization with modeled realized capitalization; NUPL expresses the same inputs differently, so it is not independent confirmation. SOPR and output-age charts describe observable transparent outputs. Shielded cost basis is a model, not a view into private acquisition prices. A ratio, older output movement or search-interest spike is not a validated buy/sell signal.',
    questions: { 'Are MVRV and NUPL independent signals?': 'No. They are different expressions of the same market-cap and modeled realized-cap inputs. Read them alongside the model’s coverage and date. Agreement between the two is not a second independent confirmation of valuation.' },
  },
  {
    id: 'usage_clock', title: 'Reading the Usage Clock', url: '/usage-clock',
    text: 'Usage Clock shows when observed Zcash activity happens across the UTC day and week. Select a period, move the hour slider or play through the day, then compare Daily activity, Activity vs. baseline and the weekly heatmap. The daylight map overlays observed node geography for context.\n\nTransaction timestamps and node locations describe different populations. A timing correlation with regional daylight does not locate users or identify where transactions originated. A busier hour is an observation for the selected window, not a permanent geographic characteristic of Zcash usage.',
    questions: { 'Does daylight correlation show where users live?': 'No. Transaction timing is not user-location data, and observed node geography does not identify transaction origin. The daylight comparison is contextual correlation, not geographic attribution.' },
  },
  {
    id: 'governance', title: 'Using the Governance hub', url: '/governance',
    text: 'Governance separates active votes, upcoming schedules and past results. Open a round to inspect its proposal choices, status, published tallies and verification sources. An announced schedule is not the same as an opened voting round; results should be read with the round’s eligibility and counting rules.\n\nA coinholder vote records that process’s outcome. It does not itself prove a network upgrade is activated or that a grant has been paid. Ask’s page guide explains these distinctions; it does not receive the current round’s ballots or result rows automatically.',
    questions: { 'Does a vote result mean a network upgrade is live?': 'No. A vote outcome, implementation, release and network activation are separate stages. Inspect the round’s scope and the serving network’s activation evidence before saying an upgrade is live.' },
  },
  {
    id: 'tools', title: 'Choosing an explorer tool', url: '/tools',
    text: 'Developer Tools links to transaction decoding, signed-transaction broadcasting, memo decryption, Blend Check, unit conversion and anchor-root search. Choose the tool that matches the job: Decode inspects public structure; Broadcast submits an already signed transaction; Decrypt Memo uses a viewing key locally in your browser.\n\nAsk explains the controls and public concepts. It does not operate these tools or read their form contents. Keep viewing keys, private keys and recovery phrases out of chat.',
    questions: { 'What is the difference between decoding and broadcasting?': 'Decoding inspects the structure of raw transaction data. Broadcasting submits an already signed transaction to a node for validation and possible relay. Inspecting a transaction does not submit it.' },
  },
  {
    id: 'decode', title: 'Using Decode Transaction', url: '/tools/decode',
    text: 'Decode Transaction turns raw Zcash transaction hex into readable public fields. Use the result to inspect inputs, outputs and shielded components. Decoding does not broadcast the transaction and does not decrypt private shielded payment contents.\n\nAsk can explain the field meanings, but it does not see the hex or decoded result entered into this tool. For an indexed transaction, ask about its transaction ID. No spending key or recovery phrase is needed to understand public transaction structure.',
    questions: { 'Does decoding broadcast the transaction?': 'No. Decoding inspects transaction structure. Broadcasting is a separate action in a separate tool; a decoded transaction is not necessarily accepted or confirmed by the network.' },
  },
  {
    id: 'broadcast', title: 'Using Broadcast Transaction', url: '/tools/broadcast',
    text: 'Broadcast Transaction submits a fully signed raw transaction to the node. The transaction must already have been constructed and signed by your wallet or application. The result reports submission success or a validation error; successful submission is not confirmation in a block.\n\nAsk can explain this workflow but cannot broadcast, sign or modify a transaction. Keep raw transaction submission in the dedicated tool and check the transaction ID afterward for indexed or pending status. The form does not need your private key or recovery phrase.',
    questions: { 'Does successful broadcast mean confirmed?': 'No. It means the submission was accepted at that step. The transaction can remain pending before it is mined, and its later state must be checked by transaction ID. Ask has no broadcast or signing action.' },
  },
  {
    id: 'decrypt', title: 'Using Decrypt Memo', url: '/decrypt',
    text: 'Decrypt Memo uses a compatible viewing key to read Orchard or Ironwood memos in the browser. Enter the required transaction and key only into the dedicated decryption tool. Decryption runs locally; it is separate from Ask.\n\nThe chat does not receive the viewing-key field, decrypted memos or tool output. A viewing key can disclose payment information even though it is not a spending key, so do not paste it into Ask. The tool cannot recover a missing spending key or reveal arbitrary shielded payments without the appropriate viewing authority.',
    questions: { 'Should I give Ask my viewing key?': 'No. Use a viewing key only in the dedicated local decryption workflow. Ask does not need it and cannot decrypt memos for you. Do not paste viewing keys, private keys or recovery phrases into chat.' },
  },
  {
    id: 'blend_check', title: 'Using Blend Check', url: '/tools/blend-check',
    text: 'Blend Check compares an amount with observed public shielding and deshielding amounts. Enter the amount in the tool and inspect its matches, distribution and explanation to understand how common that public amount is in the observed window.\n\nThis is a comparison of public flow patterns. A score or common amount is not a guarantee of anonymity, and a rare match is not proof that two transfers share an owner. Ask does not see the amount you entered or automatically receive the tool’s results.',
    questions: { 'Does a common amount guarantee anonymity?': 'No. Amount frequency is one public signal. Timing, other disclosures and dataset coverage also matter. Blend Check compares observations; it cannot certify a transfer as anonymous.' },
  },
  {
    id: 'unit_converter', title: 'Using the Unit Converter', url: '/tools/unit-converter',
    text: 'Unit Converter translates between ZEC and integer zatoshis. ZEC supports eight decimal places: one ZEC is one hundred million zatoshis. Use the fields and copy controls to take the converted amount into your own application.\n\nThis is denomination conversion, not a currency-price quote or a transaction. Amounts smaller than a zatoshi cannot be represented on chain. Ask explains the units but does not automatically see the value entered into the converter.',
    questions: { 'What is a zatoshi?': 'A zatoshi is the smallest ZEC unit: one hundred million zatoshis make one ZEC. Integer zatoshis let applications represent amounts exactly without floating-point rounding.' },
  },
  {
    id: 'anchor_search', title: 'Using Anchor Root Search', url: '/tools/anchor-search',
    text: 'Anchor Root Search looks for a Sapling or Orchard commitment-tree root in canonical and retained orphaned blocks. Use it to investigate wallet synchronization or fork-related problems and inspect the returned block links.\n\nA root is a commitment-tree state, not an address or a list of private payments. A match on an orphaned branch is different from a canonical match. No result means no match was returned within the tool’s coverage; it does not by itself prove a wallet is broken. Ask does not receive the entered root or result list.',
    questions: { 'Does an anchor root reveal private payments?': 'No. It commits to a tree state. Finding the root can help establish which observed block or branch contains that state, but it does not expose the private contents of shielded payments.' },
  },
  {
    id: 'docs', title: 'Using the API documentation', url: '/docs',
    text: 'API Docs organizes the explorer’s endpoints, parameters, response formats and examples. Start with the endpoint for the data you need, then check its network, units, pagination and error contract. Use the documented examples and schema rather than guessing URL parameters.\n\nThe response separates data from metadata such as source observations and freshness. Unknown freshness is not a guarantee of current data, and integer zatoshi strings should not be confused with display ZEC values. Ask can explain the contract; it does not accept arbitrary URLs or SQL to execute.',
    questions: { 'How do I interpret unknown freshness?': 'It means the response does not establish the source observation’s age. Response generation or retrieval time only tells you when the request was served, not when indexing last caught up. Preserve unavailable values instead of treating them as fresh or zero.' },
  },
  {
    id: 'learn', title: 'Using Learn Zcash', url: '/learn',
    text: 'Learn Zcash collects links to wallets, privacy explanations, node software, development tools and protocol resources. Choose the section for your task and follow the official project documentation for setup or current compatibility.\n\nA wallet manages payments, a full node validates the chain and an indexing service makes data easier to query. These roles are different. Resource descriptions are guidance, not evidence about which software produced an individual transaction.',
    questions: { 'What is the difference between a wallet and a full node?': 'A wallet manages keys and payment workflows. A full node independently validates the blockchain and network rules. Indexing services organize data for applications. One product may combine roles, but the roles are not interchangeable.' },
  },
  {
    id: 'newsletter', title: 'Using the Newsletter archive', url: '/newsletter',
    text: 'The Newsletter archive collects dated Zcash updates and analysis. Open an issue to read its charts, commentary and linked sources. Use the issue date to separate the observations reported then from the network’s current state.\n\nAsk’s archive guide does not receive an article’s text automatically. For current supported network data, ask a specific analytics question; for an article’s claim, follow its cited source and observation date.',
    questions: { 'Are newsletter figures live network readings?': 'Treat them as observations published for that issue and its stated date or window. They are not automatically current readings. Check the linked source and its dates before comparing an issue with today’s explorer data.' },
  },
  {
    id: 'about', title: 'Reading About ZecBlock', url: '/about',
    text: 'About explains the explorer’s purpose, development history, open-source work and contribution links. Its network cards are public observations; the timeline describes product development rather than protocol activation.\n\nUse the explorer pages for current block and transaction records, the API documentation for integration details and the linked project resources for contribution information. Ask does not infer today’s product deployment state from an old timeline entry.',
    questions: { 'Where do I find integration details?': 'Open API Docs for endpoint parameters, response schemas, units and examples. The About page provides project context; it is not the API contract.' },
  },
  {
    id: 'press', title: 'Using Press & Brand', url: '/press',
    text: 'Press & Brand provides the project’s logo assets, colors, typography, description and media contact information. Use the supplied variants and formats for the background and medium you are preparing.\n\nStart with the Logo section for downloads, then check Colors and Typography when placing assets in an article or presentation. Use the published project description and media contact for attribution and enquiries.',
    questions: { 'Where can I find the logo assets?': 'Use the Logo section of the Press & Brand page. It provides the supplied variants and download formats; the Colors and Typography sections document the surrounding visual identity.' },
  },
  {
    id: 'address', title: 'Reading an Address page', url: '/rich-list',
    text: 'An address page describes the indexed public activity available for that address: balance, transaction history and related public inputs or outputs where available. Use the pagination and transaction links to inspect individual observations.\n\nAn address is not a person or necessarily a wallet. Shielded addresses do not expose private balances or a complete public payment history. Ask’s address guide does not automatically load the selected address’s balances or records; do not treat this explanation as an analysis of its owner or funds.',
    questions: { 'Is an address the same as a user?': 'No. One person or service can use many addresses, and a custodial address can represent many people. Public address activity does not by itself establish ownership or user counts.' },
  },
];
module.exports = { pageGuides: pageGuides.map(guide => ({ reviewed: '2026-10-01', ...guide })) };
