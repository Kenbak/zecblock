# Independent attestation build evidence

These records preserve successful source-backed Caution rebuilds and subsequent
independent CipherScan nonce/TLS/PCR checks. Active baselines are selected explicitly
in `../attestation-endpoints.json`, with links pinned to the evidence commit.

| Endpoint | Successful build run |
| --- | --- |
| Shielded Labs hub | [34325307813](https://github.com/Kenbak/cipherscan/actions/runs/34325307813) |
| Shielded Labs shim | [34327233925](https://github.com/Kenbak/cipherscan/actions/runs/34327233925) |
| Zec.rocks mainnet | [34327234175](https://github.com/Kenbak/cipherscan/actions/runs/34327234175) |
| Zec.rocks testnet | [34327233990](https://github.com/Kenbak/cipherscan/actions/runs/34327233990) |
| Zec.rocks mainnet (2026-10-08 release) | [42061912754](https://github.com/Kenbak/zecblock/actions/runs/42061912754) |
| Zec.rocks testnet (2026-10-08 release) | [42061984480](https://github.com/Kenbak/zecblock/actions/runs/42061984480) |

Caution's hub remains unconfirmed because its published manifest lacks an app
source mapping. Zec.rocks testnet's older checked-in `.caution/trusted_hashes.json`
records different PCR0/1 values from the current rebuilt deployment; it was not
adopted as a current baseline. Testnet's pinned `PROVENANCE` states that its shim
is forward-only with diversion disabled. A reproduced build is not a guarantee
of hub routing, source-code safety or wallet privacy.
