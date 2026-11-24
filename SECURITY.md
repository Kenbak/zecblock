# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub:
**Security → Report a vulnerability** on
[github.com/Kenbak/zecblock](https://github.com/Kenbak/zecblock/security/advisories/new).

Do not open a public issue, pull request or forum post for a suspected
vulnerability until it has been fixed.

A useful report includes:

- the affected URL, API route or file and commit;
- the steps or request needed to reproduce it;
- what an attacker gains (data exposed, data changed, cost or availability);
- whether you believe it is being exploited.

We aim to acknowledge reports within 3 business days and to keep you updated
until the issue is resolved. We are happy to credit reporters in the advisory
unless you prefer to stay anonymous.

## Scope

- The ZecBlock web application and its public API (`zecblock.com`,
  `testnet.zecblock.com`, `crosslink.zecblock.com` and their `api.` hosts).
- The source in this repository, including deployment configuration under
  `server/deploy/`.

Out of scope: volumetric denial-of-service, findings that require a
compromised device or browser, missing best-practice headers without a
demonstrated impact, and third-party services we link to.

## Handling sensitive data

ZecBlock never needs your spending keys or seed phrase. Viewing-key tools run
in your browser. Never include private keys, recovery phrases or viewing keys
in a report. If a report needs to show one, use a throwaway testnet wallet.

## Safe harbor

We will not pursue legal action against good-faith research that respects this
policy: test only against your own data or testnet, avoid privacy violations
and service disruption, and give us reasonable time to fix an issue before
disclosing it.
