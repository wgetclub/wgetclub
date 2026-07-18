# wget.club

**Buy a name. Point it at a file. Download it from any terminal.**

```bash
wget wget.club/myscript
curl -sSL https://wget.club/setup_myapp.sh | bash
```

Every name is an **ERC-721 NFT on Base**. The NFT holds an **IPFS CID**.
A **Cloudflare Worker** resolves the name and serves the bytes from the edge.

You buy the name with MetaMask, drag in a file, and the system pins it to IPFS
and writes the CID into your NFT. The name is yours — permanently, transferable, resellable.

---

## How it works

```
  you                      wget.club                         decentralized
  ───                      ─────────                         ─────────────

  drag a file      ──────► API Worker ──► pin to IPFS ──────────► CID
                                                                   │
  MetaMask (Base)  ──────► register(name, cid) ──────────► NFT ────┘
                                                            │
  wget wget.club/x ──────► Resolver Worker ──► KV ──────────┘
                                │
                                └──► R2 (cache) ──► IPFS gateway ──► bytes
```

The contract is the source of truth. KV and R2 are cache. If Cloudflare disappears,
your file is still on IPFS and your name is still in your wallet.

## Layout

| Directory | What it is |
|---|---|
| `contracts/` | Foundry. `WgetClubRegistry.sol` — ERC-721, source of truth. |
| `apps/resolver/` | Cloudflare Worker. Resolves `/:name` → bytes. The hot path. |
| `apps/api/` | Cloudflare Worker. Upload/pin, SIWE, cache refresh, indexer (cron). |
| `apps/web/` | Vite + React + wagmi. Landing, search, purchase, dashboard. |
| `packages/shared/` | Name validation, CID, types, ABI. Shared. |

## Running locally

Prerequisites: Node 22+, pnpm 9+, [Foundry](https://book.getfoundry.sh/getting-started/installation).

```bash
pnpm install

# Solidity dependencies (forge-std, solmate) at pinned revisions.
./scripts/setup-deps.sh

cd contracts && forge build
```

To bring up the Workers and the frontend you need a Cloudflare account and a Base
RPC. Copy `.env.example` to `apps/resolver/.dev.vars` and `apps/api/.dev.vars`,
fill them in, then:

```bash
pnpm dev
```

## Deploy

See **[docs/RUNBOOK.md](docs/RUNBOOK.md)** — step by step, with "how you know it
worked" at every stage. Order matters, and CI refuses to deploy if you skip a step.

```bash
node scripts/doctor.mjs   # tells you which step you're on, by looking at real state
```

The short version: the contract goes first (Base Sepolia), then **four pastes** — the
address into three files, and `START_BLOCK` (the deploy block) into
`apps/api/wrangler.toml`. `START_BLOCK` is the one people miss, and it fails in
silence: left at `0`, the indexer scans the chain from block 0 and never reaches your
contract. Then `scripts/bootstrap-cloudflare.mjs` creates the KV, the secrets go in
via `wrangler secret put`, and a push to `main` deploys via GitHub Actions.

The resolver serves the frontend **and** the names, through an `[assets]` binding —
there is no Pages project. The RUNBOOK explains why.

## Status

**Pre-launch. Nothing is deployed on a public network** — `CONTRACT_ADDRESS` is
`0x0` in every config.

The contract, the resolver, the api and the frontend are all really implemented and
work end to end locally. What's still missing before a serious launch is listed at
the end of [docs/RUNBOOK.md](docs/RUNBOOK.md) — in particular: there are no Terms of
Use and no DMCA contact, and nobody is on call for the abuse queue. Read
[docs/SECURITY.md](docs/SECURITY.md) to understand why that isn't a detail in a
service that serves `curl | bash`.

## Warning

wget.club resolves names to user content. **We do not audit, moderate, or endorse**
what name owners point at. Running
`curl -sSL wget.club/anything | bash` executes a stranger's code on your
machine — the same risk as any piped installer.

Prefer **frozen** names (`🔒`), which prove the CID can no longer change, and pin the
version (`wget.club/name@bafy...`) when you automate. Read
[docs/SECURITY.md](docs/SECURITY.md) before trusting any name — including
your own.

## License

MIT. See [LICENSE](LICENSE).
