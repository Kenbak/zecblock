<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/brand/zecblock-logotype.png" />
    <img src="public/brand/zecblock-logotype-light.png" alt="ZecBlock" width="280" />
  </picture>
</p>

<h1 align="center">ZecBlock</h1>

<p align="center">
  <strong>A clearer view of Zcash.</strong>
</p>

<p align="center">
  <a href="https://zecblock.com">Mainnet</a> •
  <a href="https://testnet.cipherscan.app">Testnet</a> •
  <a href="https://zecblock.com/docs">API Docs</a> •
  <a href="https://zecblock.com/learn">Learn Zcash</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-16-black?logo=next.js" alt="Next.js 16" />
  <img src="https://img.shields.io/badge/TypeScript-5-blue?logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Rust-WASM-orange?logo=rust" alt="Rust WASM" />
  <img src="https://img.shields.io/badge/License-AGPL%20v3%20+%20Commons%20Clause-blue" alt="License AGPL v3 + Commons Clause" />
</p>

---

## 📖 Table of Contents

- [About](#-about)
- [Features](#-features)
- [Explorer Links](#-explorer-links)
- [Quick Start](#-quick-start)
- [Tech Stack](#️-tech-stack)
- [Public Infrastructure](#-public-infrastructure)
- [API Documentation](#-api-documentation)
- [Configuration](#️-configuration)
- [Contributing](#-contributing)
- [Support the Project](#-support-the-project)
- [License](#-license)

---

## 🎯 About

ZecBlock, formerly **CipherScan**, is a Zcash blockchain explorer built by Atmosphere Labs. Explore public transactions, blocks, shielded pool balances, network observations and tools for understanding Zcash.

The same explorer project continues under a new name and design. The source repository is `Kenbak/zecblock`; existing API and lightwalletd hostnames are retained for compatibility. ZecBlock launched on mainnet and testnet on October 1, 2026. Previous explorer website addresses redirect to the corresponding ZecBlock site.

Shielded transfer details are not publicly visible. Aggregate pool flows and transaction patterns do not identify users or prove that coins were sold.

**Mission:** Make the Zcash blockchain accessible to everyone, not just developers.

---

## ✨ Features

### 🔍 Core Explorer
| Feature | Description |
|---------|-------------|
| **Search** | Find addresses, transactions and blocks |
| **Balances** | View public address activity and transparent balances |
| **Block Explorer** | Navigate blocks and publicly visible transaction details |
| **Mempool Viewer** | Real-time pending transactions |
| **Live Updates** | WebSocket for real-time block notifications |
| **CSV/JSON Export** | Export address, block, and transaction data from the UI |
| **Fork Watch** | Chain reorganizations and orphaned block comparison |

### 🛡️ Privacy Tools
| Feature | Description |
|---------|-------------|
| **Privacy Dashboard** | Observed shielded participation and transaction patterns |
| **Pool Analytics** | Per-pool supply, shield/deshield flows, and deltas |
| **Turnstile Tracker** | Follow observable outputs after deshielding, with coverage and attribution limits |
| **Decrypt Memos** | Client-side Orchard memo decryption (WASM) |
| **Privacy Risks** | Heuristic checks for observable transaction patterns |
| **Browser-local decryption** | Memo/inbox tools process viewing keys in the browser; blockchain requests still reach data services |

### 🔗 Cross-Chain
| Feature | Description |
|---------|-------------|
| **ZEC Flows** | Real-time cross-chain swaps via NEAR Intents |
| **Inflows/Outflows** | Explore supported cross-chain swaps involving ZEC |

### 📚 Education & UX
| Feature | Description |
|---------|-------------|
| **Learn Zcash** | Comprehensive guide to addresses, viewing keys, wallets |
| **Address Labels** | Tag addresses with custom labels (localStorage) |
| **Light/Dark Mode** | Theme toggle with system preference support |
| **Mobile Responsive** | Responsive layouts for smaller screens |

### 🔧 Developer Tools
| Feature | Description |
|---------|-------------|
| **API Documentation** | Versioned endpoint reference, parameters and examples at [`/docs`](https://zecblock.com/docs) |
| **Public Infrastructure** | lightwalletd gRPC and explorer REST endpoints |
| **Deployment Guide** | Operational docs in [`DEPLOYMENT.md`](DEPLOYMENT.md) |

---

## 🌐 Explorer Links

| Network | URL |
|---------|-----|
| **Mainnet** | [zecblock.com](https://zecblock.com) |
| **Testnet** | [testnet.zecblock.com](https://testnet.zecblock.com) |

---

## 🚀 Quick Start

### Prerequisites

- Node.js 24.22.1 or newer within Node 24 for frontend development (see `.node-version`); self-managed servers remain on patched Node 22 (see `.node-version.server`)
- npm or yarn
- PostgreSQL (optional, for full indexer)

### Installation

For local development, the loopback v1 adapter reads public mainnet data. It is not a production API service.


```bash
# Clone the repository
git clone https://github.com/Kenbak/zecblock.git
cd zecblock

# Install dependencies
npm ci

# Install the API adapter dependencies
npm ci --prefix server/api

# Terminal 1: local mainnet v1 adapter on 127.0.0.1:3002
npm run dev:v1

# Terminal 2: mainnet frontend on http://localhost:3000
NEXT_PUBLIC_NETWORK=mainnet \
NEXT_PUBLIC_API_URL=http://127.0.0.1:3002 \
CIPHERSCAN_API_URL=http://127.0.0.1:3002 \
npm run dev
```

### Production Build

```bash
# Set the intended network and verified API origins before building.
npm run build
npm start
```

Copy the relevant settings from [`.env.example`](.env.example). `NEXT_PUBLIC_*` values are embedded at build time. Do not promote a build configured with loopback URLs to production. Testnet uses separate data and API origins; the local adapter above is mainnet-only.

### Verify Before Push

```bash
# Fast lint, design-token, and TypeScript checks
make verify-fast

# The full local contract used by CI (all subprojects/toolchains)
make verify-full

# Optional responsive/light-dark browser audit
npx playwright install chromium  # once per machine
npm run visual:audit             # run while the app is serving on port 3000
```

---

## 🏗️ Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | Next.js 16, React 19, TypeScript |
| **Styling** | Tailwind CSS |
| **Database** | PostgreSQL |
| **API Server** | Express.js + WebSocket |
| **Cryptography** | Rust + WebAssembly |
| **Zcash Node** | Zakura / Zebra-compatible node integration |

---

## 🔌 Public Infrastructure

Existing service addresses are retained during the rebrand. Website redirects do not replace API or gRPC endpoints. Check service availability before integrating; this list does not certify current uptime.

### Mainnet

| Service | Endpoint |
|---------|----------|
| **Lightwalletd gRPC** | `lightwalletd.mainnet.cipherscan.app:443` |
| **REST API** | `https://api.mainnet.cipherscan.app/api/*` |

### Testnet

| Service | Endpoint |
|---------|----------|
| **Lightwalletd gRPC** | `lightwalletd.testnet.cipherscan.app:443` |
| **REST API** | `https://api.testnet.cipherscan.app/api/*` |

---

## 📖 API Documentation

The redesigned reference is at [zecblock.com/docs](https://zecblock.com/docs), with the contract in [`public/openapi-v1.json`](public/openapi-v1.json).

Public v1 access at `https://api.zecblock.com/v1` is a separate launch gate: verify authentication, CORS and WebSocket access before switching clients. Keep existing consumers on their working endpoints until then.

### Existing API examples

```javascript
// Fetch block data
const block = await fetch('https://api.mainnet.cipherscan.app/api/block/2500000');
const data = await block.json();

// Fetch privacy stats
const stats = await fetch('https://api.mainnet.cipherscan.app/api/privacy-stats');
const privacy = await stats.json();
```

```python
import requests

# Fetch mempool
response = requests.get('https://api.mainnet.cipherscan.app/api/mempool')
print(f"Pending transactions: {response.json()['count']}")
```

**Rate limits:** Deployment-specific. Successful responses expose standard
rate-limit headers; clients should honor those headers and `Retry-After` on
HTTP 429 responses.

---

## ⚙️ Configuration

The redesigned frontend consumes `/v1` endpoints. Use the local adapter above for the staged preview, or configure a verified v1 deployment. Running
against a custom node requires the Express API and indexer; configure those
services using [DEPLOYMENT.md](DEPLOYMENT.md) rather than placing node RPC
credentials in the browser-facing frontend environment.

---

## 📋 Roadmap

See [GitHub Issues](https://github.com/Kenbak/zecblock/issues) for upcoming features and improvements.

Release scope and availability are tracked in issues and release notes; this README does not promise dates for unreleased features.

---

## 🤝 Contributing

Contributions are welcome! Here's how you can help:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### Development Guidelines

- Follow the existing code style
- Write meaningful commit messages
- Add tests for new features when applicable
- Update documentation as needed

---

## ☕ Support the Project

ZecBlock is free, source-available, and community-driven. If you find it useful, consider supporting development:

### Zcash Donation Address (Shielded)

```
u1fh3kwyl9hq9q907rx9j8mdy2r7gz4xh0y4yt63dxykk2856gr0238vxsegemyfu8s5a77ycq72tcnzkxa75ykjtcn6wp2w9rtuu3ssdzpe2fyghl8wlk3vh6f67304xe4lrxtvywtudy5t434zc07u6mh27ekufx7ssr55l8875z7f4k76c3tk23s3jzf8rxdlkequlta8lwsv09gxm
```

> This is a **Unified Address**. Use a wallet that supports shielded transfers and check the selected receiver before sending.

Your support helps us:
- Keep the infrastructure running 24/7
- Add new features and improvements
- Maintain free public APIs for developers

---

## 🔐 Privacy Principles

The redesigned application limits analytics to selected public landing pages, strips query strings and fragments, and honors Do Not Track and Global Privacy Control. Individual address, transaction and block pages, Ask and sensitive tools are excluded from that analytics integration.

- Viewing-key processing in memo/inbox tools runs in the browser. Requests for blockchain data still reach the services supplying it.
- Preferences and custom address labels use browser storage. They do not automatically move between domains.
- Hosting, API and security providers process connection information and may retain operational logs. We do not promise zero logging or zero retention.
- When AI is enabled, Ask sends questions and relevant context to the configured provider. Never enter private keys, recovery phrases or viewing keys into Ask, search or support messages.

See the [privacy policy](https://zecblock.com/privacy-policy) and [terms](https://zecblock.com/terms) for details. These describe the rebrand release; deployment status must be verified separately.

---

## 📄 License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)** with the **Commons Clause** restriction — see the [LICENSE](LICENSE) file for details.

**What this means:**
- ✅ You can view, fork, and modify the code
- ✅ You must share your modifications under the same license
- ❌ You cannot sell this software or offer it as a paid service

---

## 🙏 Acknowledgments

- [Zcash Foundation](https://zfnd.org/) — Zebra node
- [Electric Coin Company](https://electriccoin.co/) — librustzcash
- [NEAR Protocol](https://near.org/) — Cross-chain intents
- [Zingo Labs](https://github.com/zingolabs) — zingolib inspiration

---

<p align="center">
  <strong>Built with ⚡ for the Zcash community</strong>
</p>

<p align="center">
  <a href="https://github.com/Kenbak/zecblock">GitHub</a> •
  <a href="https://x.com/zecblock">@zecblock on X</a> •
  <a href="https://discord.gg/zcash">Discord</a> •
  <a href="https://forum.zcashcommunity.com/">Forum</a>
</p>
