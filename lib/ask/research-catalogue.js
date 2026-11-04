'use strict';
// Shared reviewed public schema. No raw relations, operational fields or secrets.
const researchCatalogue=Object.freeze([
 {id:'blocks',title:'Blocks',columns:'height, hash, timestamp, miner, transactions, bytes, fees',description:'Canonical blocks. Transaction counts include coinbase; miner is a payout address.'},
 {id:'transactions',title:'Transactions',columns:'txid, height, timestamp, miner, shielded, orchard, ironwood, sapling, bytes, fees',description:'Confirmed non-coinbase transactions. Component flags do not reveal private payments.'},
 {id:'flows',title:'Public pool flows',columns:'txid, height, timestamp, direction, pool, amount',description:'Public shielding/deshielding boundary observations; direction is shield or deshield. Historical completeness is unverified.'},
 {id:'daily',title:'Pool history',columns:'date, transactions, shielded_transactions, transparent_transactions, orchard, ironwood, sapling, sprout',description:'Maintained UTC daily counts and closing pool balances. Balances are stocks: never sum balances across dates.'},
 {id:'swaps',title:'Cross-chain swaps',columns:'timestamp, direction, chain, token, usd',description:'Direction is inflow or outflow (into/out of ZEC). Tracked successful external ZEC swaps, dated by provider creation time. Reported USD valuations; zero sentinels are unavailable. Not all exchange activity.'},
 {id:'addresses',title:'Transparent address summaries',columns:'address, balance, received, sent, transactions, first_seen, last_seen',description:'Maintained current transparent address summaries, not historical balances or people. Reconciliation completeness is unverified.'},
 {id:'address_activity',title:'Transparent address activity',columns:'address, txid, height, timestamp, tx_index, is_input, is_output, received, sent',description:'One address/transaction incidence, including coinbase. One transaction may affect several addresses. Canonical membership is checked; history completeness is unverified.'},
 {id:'activity_daily',title:'Daily chain activity',columns:'date, blocks, transactions, shielded_transactions, transparent_transactions, unclassified_transactions, bytes, fees, missing_fees, missing_bytes',description:'Completed UTC days, derived on the analytics server from canonical non-coinbase transactions. Use for long-range activity research. Fees are null when any fee is missing.'},
 {id:'flow_daily',title:'Daily public pool flows',columns:'date, pool, direction, records, amount, missing_amounts',description:'Direction is shield or deshield. No synthetic all-pool row; sum observed pools by date to combine them. Completed UTC day/pool/direction aggregates of recorded public boundary flows. Amount is null when any amount is missing; absent rows do not certify zero flow.'},
 {id:'labels',title:'Address labels',columns:'address, label, category',description:'Reviewed public labels for known transparent addresses (exchanges, bridges, foundations). Join on address to exclude or group known entities. An unlabelled address is not proof it is unaffiliated.'},
].map(Object.freeze));
const coreIds=Object.freeze(['blocks','transactions','flows']);
const researchIds=Object.freeze(researchCatalogue.map(d=>d.id));
const catalogueFor=extended=>researchCatalogue.filter(d=>extended||coreIds.includes(d.id));
module.exports={researchCatalogue,researchIds,coreIds,catalogueFor};
