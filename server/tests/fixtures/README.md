# Public API contract fixtures

Captured 2026-09-14 from:
- https://api.mainnet.cipherscan.app/api/transactions/list?limit=5
- https://api.mainnet.cipherscan.app/api/blocks?limit=5

Preserve field types, especially BIGINT strings and zatoshi amounts. Browser tests may move the timestamp while retaining its string representation so relative-clock assertions remain deterministic.

## NU7 staging transactions

`nu7-staging-transactions.json` contains real Nu7StagingV2 pre/activation/post
coinbases (heights 4,398,755–4,398,757), plus both transactions in fee-bearing
block 4,400,478. Captured 2026-09-28 JST using an isolated validating Zakura
node at revision 738d175061e23d1ad65ec99b2d2a6b5d004bb10f.
Manifest: https://api.nu7.valargroup.dev/v1/network (dashboard https://zakura.com/nu7/).
Activation is 4,398,756 / branch 77190ad9 on this staging fork only.
Expected versions, lock/expiry heights, sizes, action counts and transparent
output zatoshis come from node RPC. This is not official testnet/mainnet activation
certification. Historical v4 fixtures remain in the original corpus.

## Official testnet NU7 accounting

`nu7-accounting.v1.json` is the public `/v1/network/accounting` envelope
captured from `https://api.testnet.zecblock.com` on 2026-10-05 JST
(2026-10-04 21:18:29 UTC), after official activation at 4,465,026.
It retains the real v1 shape: no legacy `success` property inside `data`,
and exact zatoshi amounts encoded as decimal strings. The visibility test
passes it through the shared envelope parser before rendering accounting.
