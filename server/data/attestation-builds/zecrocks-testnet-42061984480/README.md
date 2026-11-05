# zecrocks-testnet — independently reproduced baseline

Source: `https://github.com/zecrocks/zeronym-shim-deploy` at `656c99fcfb4168e6f1685e8239c918bcc20c07b2`.
Endpoint: `tee.testnet.unsafe.zec.rocks`.

[Reproduction run](https://github.com/Kenbak/zecblock/actions/runs/42061984480)
completed successfully on 2026-11-05. The pinned Caution CLI rebuilt the enclave
from an archive of the exact source commit and verified PCR0/1/2 and TLS binding.
The CipherScan observer then independently challenged the live endpoint at
`2026-11-05T16:33:08.851Z` and passed evidence, TLS and reproduced measurements.
The source archive digest was independently regenerated from the public Git
commit locally and matched the CI record.

This deployment (tag `deploy-a67b428a-656c99f`, 2026-10-08) packages ShieldedLabs
`zero@5d14c1d` (gRPC-Web support). Its pinned `PROVENANCE` still states that the
shim is forward-only with diversion disabled.

- `candidate.json`: measurements, source/CLI pins, artifact digests and live check.
- `built-manifest.json`: actual rebuilt enclave provenance, matched to pinned inputs.
- `input-manifest.json`: unsigned build inputs, not trust by themselves.
- `trusted_hashes.json`: fresh Caution verification state with TLS binding.
- `verify.log`: source-backed verification output; initial PCR output is unverified
  until the final verification succeeds.

Generated `Containerfile.eif` SHA-256: `0d56f8315a7b4c78684d8d2c677690ced9712e6d4bdd6b4ea83a7d7b1b96fa30`.
The recipe remains in the run artifact; its framework source is pinned in the
preserved manifest. This JSON/log evidence survives the 30-day artifact expiry.

This records source/build reproduction, not a source-code security audit,
a guarantee about every wallet session, or uptime. The GitHub runner and pinned
verification toolchain remain part of the observer's trust assumptions.
