# Runbook — from zero to `wget wget.club/yourname`

Step by step, in order. Every step has **how you know it worked** and **what breaks
if you skip it**.

At any point, to find out where you are:

```bash
node scripts/doctor.mjs
```

It looks at real state — the disk, the RPC, your Cloudflare account — and tells you
what's next. It isn't a checklist you tick; it's a question it answers.

> **This runbook targets Base Sepolia.** It's free and it's where mistakes are cheap.
> Mainnet has its own list at the end, and it isn't only technical.

---

## Before you start — what only you have

| | |
|---|---|
| Cloudflare account | the free plan is enough |
| R2 | **Optional.** Requires a card even on the free tier. Without it the bytes are cached in KV and the product works the same, with 1GB instead of 10GB (~1000 files at 1MB). If you have a card: Dashboard → R2 → Enable R2, uncomment the `[[r2_buckets]]` block in both `wrangler.toml`, and run the bootstrap again. |
| `wget.club` | **on Cloudflare** (nameservers pointed at it) — the routes use `zone_name` |
| **a DNS record on `wget.club`** | A Worker route **does not fire without a DNS record on the hostname**, even if the Worker answers everything. Without it the deploy succeeds and the site is offline. See below. |
| Wallet | with Base Sepolia faucet ETH |
| Pinata account | the free tier is enough to start |
| RPC key | Alchemy or QuickNode, Base Sepolia |

About the RPC: **don't use the public one** (`sepolia.base.org`). It's rate-limited
enough to take down the resolver's cold path — which is exactly what runs when the
cache is empty, i.e. at launch.

### The DNS record the route requires

This catches everybody once: `[[routes]] pattern = "wget.club/*"` is only evaluated if
`wget.club` **resolves**. A Worker doesn't replace DNS — it intercepts traffic that
would already reach the domain.

Since there's no origin server (the Worker answers everything), the Cloudflare pattern
is a *dummy* **proxied** record:

```
Dashboard → wget.club → DNS → Add record
  Type:    AAAA
  Name:    @          (or "wget.club")
  IPv6:    100::      (discard prefix — the traffic never gets there)
  Proxy:   Proxied    (ORANGE cloud, not grey)
```

The orange cloud is what matters: it puts Cloudflare in the path, and that's where the
Worker route runs. Grey (DNS only) sends the traffic to `100::` and it dies there.

Check before deploying:

```bash
dig +short A wget.club     # should return Cloudflare IPs (104.x / 172.x)
```

Empty = the route won't fire, and the CI smoke test will fail even with a green
deploy.

---

## 1. Tooling and dependencies

```bash
pnpm install
```

Now the Solidity libs (forge-std, solmate). **The command depends on where you are**,
and running the wrong one gives you a silent "did nothing":

```bash
# If you extracted the .zip (no .gitmodules):
./scripts/setup-deps.sh

# If you cloned the development repo (.gitmodules exists):
git submodule update --init --recursive
```

If you don't know which case you're in, don't guess — ask:

```bash
node scripts/doctor.mjs        # it detects and prints the right command
```

> Why two paths: a `.zip` can't carry a gitlink — the submodule entry (mode 160000)
> doesn't exist outside a git tree. `setup-deps.sh` installs the **same revisions**
> (`bf647bd` / `89365b8`) via `forge install --no-git`. It needs no `git init`: it
> works in any directory.

Then:

```bash
cd contracts && forge build && cd ..
```

**How you know it worked:**
```bash
node scripts/doctor.mjs        # section 1 all green
```

> `forge test` only exists in the development repo. The published package carries no
> tests, so there `forge build` is the verification — if it compiles, the libs are at
> the right revisions.

---

## 2. Contract — first, and alone

**No script does this step, and that's on purpose.** A wrong Worker is fixed with
another deploy. A wrong contract isn't: the names other people bought are stuck in it
and you can't migrate them.

### 2.1 Read the reserved list first

Open `contracts/src/WgetClubRegistry.sol` and read `_reserveDefaults()`.

**That list is your only chance.** The contract has `unreserve()` and no
`reserve()` — it only shrinks, never grows. Every name outside it is buyable by
anyone, forever.

This isn't theoretical: `abuse` was left out while every preview page rendered
`<a href="/abuse">report abuse</a>`. Anyone could have bought their own victims'
reporting channel for 0.001 ETH.

If the product ends up linking `/partners`, `/api-docs`, whatever — reserve it **now**.

### 2.2 Keep the key in a keystore, not in the command

```bash
cast wallet import deployer --interactive
# it asks for the private key and a password, and stores it encrypted in ~/.foundry/keystores/
```

**`--interactive` matters.** The alternative (`--private-key 0x...` straight into
`forge script`) puts your key in the shell history, in the `ps` of anyone on the
machine, and in any terminal log. Once it's there, it doesn't come out.

Check the address it prints — that's the account that will own the contract:

```bash
cast wallet list
```

### 2.3 Fill in the .env — copying isn't enough

```bash
cd contracts
cp ../.env.example .env
```

Now **open the `.env` and fill it in**. Copying and running off doesn't work, and each
field fails silently in a different way:

| field | if you leave it as it came |
|---|---|
| `BASE_SEPOLIA_RPC_URL` | if it still contains `YOUR_KEY`, Alchemy answers `401 Must be authenticated!` — which says not one word about the cause |
| `REGISTRY_OWNER` | empty → `forge` fails with "environment variable not found" |
| `ROYALTY_RECEIVER` | same |

`REGISTRY_OWNER` is the address `cast wallet list` showed you. **It is the only account
that will be able to withdraw the revenue, adjust the price and release reserved names,
and it cannot be changed after the deploy.** If this is going to become a business,
consider a multisig.

> Previously, `REGISTRY_OWNER=0x000...0` — the `.env.example` default — **deployed**.
> The result was a registry with no owner: `withdraw()` unreachable, all the revenue
> stuck in the contract forever. Today the contract reverts with `ZeroAddress`. The
> guard exists because this very nearly went to the chain.

Check before spending gas:

```bash
grep -E "^(REGISTRY_OWNER|ROYALTY_RECEIVER|BASE_SEPOLIA_RPC_URL)=" .env
# none may be empty, be 0x000...0, or contain YOUR_KEY
```

### 2.4 Deploy

```bash
forge script script/Deploy.s.sol \
  --rpc-url base_sepolia \
  --broadcast --verify \
  --account deployer \
  --sender <the address cast wallet list showed>
```

Without `BASESCAN_API_KEY` in the `.env`, drop the `--verify`: the deploy works, the
contract just doesn't get verified on the explorer.

`--sender` is not optional. Without it forge uses the default sender and aborts with
*"You seem to be using Foundry's default sender"* — the error the previous version of
this runbook walked you straight into, because I never said how to sign.

The script prints the contract address.

### 2.5 Paste it in FOUR places

`forge script` prints both values. That's **four** pastes, not three:

```
apps/resolver/wrangler.toml   [vars] CONTRACT_ADDRESS
apps/api/wrangler.toml        [vars] CONTRACT_ADDRESS
apps/api/wrangler.toml        [vars] START_BLOCK          <- the forgotten one
apps/web/src/contract.ts      REGISTRY_ADDRESSES[CHAIN_IDS.BASE_SEPOLIA]
```

**`START_BLOCK` is the deploy block, and leaving it at 0 is fatal in silence.** The
indexer scans the chain from it; with 0, that's 44 million empty Base blocks at 2000 per
minute — 368 hours — and the cursor resets to zero on every cold cron isolate. It
**never** catches up to the contract. Nothing errors: the indexer simply never indexes,
and the dashboard lies forever after a resale.

If you lost the deploy output, find the block by binary search:

```bash
# raise/lower N until you find the first block where the code exists
cast code <ADDRESS> --block N --rpc-url base_sepolia | head -c 4    # 0x = didn't exist yet
```

CI refuses to deploy with `START_BLOCK=0`.

**If you skip this:** nothing resolves. The resolver answers 404 for every name — in
silence, no error. The service looks empty, not broken, which is the worst way to fail.
CI refuses to deploy with `0x0` for exactly that reason.

**How you know it worked:**
```bash
node scripts/doctor.mjs
# ✅ CONTRACT_ADDRESS matches in all 3 places
# ✅ a contract exists at that address
# ✅ `abuse` is reserved in the deployed contract    <- the most important one
```

If `abuse` shows up as buyable, **stop**. The contract was built from old code.
Deploy again; there's no fixing it afterwards.

---

## 3. Cloudflare infra

```bash
npx wrangler login
node scripts/bootstrap-cloudflare.mjs --dry-run   # see what it would do
node scripts/bootstrap-cloudflare.mjs
```

R2 is optional and ships off. If you have a card and want the 10GB, enable it in the
dashboard, uncomment `[[r2_buckets]]` in both `wrangler.toml`, and run it again — the
script reuses what it already created and not a line of code changes.

It creates the KV namespace and the R2 buckets, and writes the id into both
`wrangler.toml`. Idempotent: running it again duplicates nothing.

**One KV for both Workers, never two.** The api writes `n:<name>` and the resolver
reads it. Separate namespaces would give you a resolver serving a CID the api already
replaced — with no error anywhere, just stale content, indefinitely. The doctor checks
this.

**How you know it worked:**
```bash
node scripts/doctor.mjs        # ✅ KV namespace (<id>)  ✅ R2 bucket
```

---

## 4. Worker secrets

One at a time, interactive. **They don't go in `wrangler.toml`** — that's committed —
nor in CI.

```bash
npx wrangler secret put BASE_RPC_URL    --name wgetclub-resolver
npx wrangler secret put BASE_RPC_URL    --name wgetclub-api
npx wrangler secret put PINATA_JWT      --name wgetclub-api
npx wrangler secret put SESSION_SECRET  --name wgetclub-api    # openssl rand -hex 32
npx wrangler secret put ADMIN_ADDRESSES --name wgetclub-api
```

> These commands only work **after** the Worker's first deploy — a secret needs a
> Worker to live in. If you get an error saying the worker doesn't exist, do step 5
> first and come back here.

**If you skip `SESSION_SECRET`:** SIWE login doesn't sign a session, every upload 401s,
and buying a name becomes impossible.

**How you know it worked:**
```bash
node scripts/doctor.mjs        # ✅ wgetclub-api secrets
```

⚠️ The doctor confirms the secrets **exist**, never their contents. A `BASE_RPC_URL`
with a typo passes as green here and fails in production. Nobody verifies that from
outside — only step 6 does.

---

## 5. GitHub

Under **Settings → Secrets and variables → Actions**, the **Secrets** tab, the
**"Repository secrets"** section.

⚠️ **Repository secrets, NOT Environment secrets.** They're two sections on the same
screen, and that distinction has already broken this deploy once. A GitHub Environment
scopes its secrets only to jobs that declare that exact name; the workflow declares
none, so secrets created inside an Environment simply never reach it. What you see is an
empty `CLOUDFLARE_API_TOKEN`, three minutes into the deploy, with not a word about the
cause.

| secret | where to find it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Dashboard → My Profile → API Tokens → **Create Token** → use the **"Edit Cloudflare Workers"** template |
| `CLOUDFLARE_ACCOUNT_ID` | `npx wrangler whoami` |

**Use the template, don't assemble the token by hand.** The previous version of this
runbook listed "Workers Scripts:Edit + Workers KV Storage:Edit + R2:Edit" and **was
incomplete**: `wrangler.toml` declares a zone route (`wget.club/*`), and creating a
route requires **Zone → Workers Routes → Edit**. A token assembled from that list
installs the Worker and fails on the route — the worst possible moment, because the
deploy has already touched your account.

The "Edit Cloudflare Workers" template already brings Workers Scripts, Workers KV,
Workers Routes and Account Settings:Read. When creating it, in the **Zone Resources**
field, include `wget.club`.

Then:

```bash
git push origin main
```

`.github/workflows/deploy.yml` runs typecheck, builds the contract, **refuses to
deploy** if `CONTRACT_ADDRESS` or the KV id are still placeholders, builds the
frontend, and deploys both Workers.

---

## 5.1 Turn off Cloudflare's managed robots.txt

**Do this as soon as the deploy goes through.** New zones ship with *Managed robots.txt*
on (AI Crawl Control), and it intercepts `/robots.txt` **before the Worker** — serving
`User-agent: * / Allow: /`, the **opposite** of what this project needs.

The resolver serves `Disallow: /` on purpose: **names resolve to user content that
nobody audits**. With `Allow: /`, Google indexes
`wget.club/<whatever-a-stranger-uploaded>` under your domain — and `docs/SECURITY.md`
lists domain reputation as a **high** risk. A name serving malware, indexed as your
content, is the shortest path to the whole domain going toxic.

```
Dashboard → wget.club → AI Crawl Control (or Bots) → Managed robots.txt → turn off
```

Check:

```bash
curl -s https://wget.club/robots.txt | head -3
# right: User-agent: *
#        Disallow: /
# wrong: a long text about "content signals" -> Cloudflare is still in the path
```

---

## 5.2 The network is chosen at build time

This build talks to **one** network. There is no selector: a name is an NFT on a
specific chain, so `myscript` on mainnet and `myscript` on Sepolia are different tokens,
possibly with different owners. A selector wouldn't show "the same site on another
network" — it would silently show a different registry, quoting a price against a
contract the resolver doesn't read.

The default is `base-sepolia`. To switch:

```
Settings → Secrets and variables → Actions → Variables tab → CHAIN = base
```

**Deploy the contract on the new network BEFORE changing this**, and update
`CONTRACT_ADDRESS` and `START_BLOCK`. Changing only the var leaves the UI talking to an
empty registry: nothing errors, every name shows as available, and the first purchase
reverts.

---

## 6. The real proof

CI already does a smoke test, but it only confirms the service is up. This confirms the
**product** works:

```bash
# 1. the landing responds
curl -sI https://wget.club/ | head -1              # 200, text/html

# 2. the resolver is alive
curl https://wget.club/_health                     # ok

# 3. the abuse page exists (it used to be a 404)
curl -sI https://wget.club/abuse | head -1         # 200

# 4. buy a name through the UI, and then:
curl -sSL https://wget.club/<your-name> | bash     # <- the product
curl -sI https://wget.club/<your-name> | grep -i x-wgetclub-cid
```

Step 4 is the only one that matters. The other three can pass with the product broken.

---

## If something goes wrong

| symptom | likely cause |
|---|---|
| Every name 404s | `CONTRACT_ADDRESS` is `0x0` or points at another network |
| `wget.club/` 404s, but `/_health` responds | the frontend didn't ship with it: the resolver serves the dist via `[assets]`, and CI has to build web **before** deploying the resolver |
| Deploy green, but the domain answers nothing | the proxied DNS record on `wget.club` is missing — the Worker route doesn't fire without it. An empty `dig +short A wget.club` confirms it |
| 522 right after the deploy | normal for ~1min: the route hasn't propagated and Cloudflare is trying the `100::` origin. If it persists, the token didn't have Zone → Workers Routes → Edit and the route wasn't created |
| `robots.txt` isn't yours | Cloudflare's Managed robots.txt intercepts before the Worker — see step 5.1 |
| `Could not find zone for wget.club` during deploy | the domain isn't on your Cloudflare account, or the token doesn't have the zone in Zone Resources |
| Upload 401s | `SESSION_SECRET` is missing, or the SIWE cookie isn't arriving |
| Upload 429s | rate limit (10/hour per address) |
| A name resolves stale content | resolver and api on different KV namespaces |
| Every name 502s with "no gateway responded" | the IPFS gateways in the list are down, or the CID isn't pinned. `IPFS_GATEWAYS` accepts a comma-separated list |
| Downloads get slow over time | KV filled up (1GB). Without R2, ~1000 distinct CIDs fit; after that everything comes from the gateway |
| `curl \| bash` prints HTML | `not_found_handling` drifted off `"none"` |
| "my names" empty after buying | the indexer didn't run and `/api/refresh` failed |

---

## Routing: one Worker serves everything

The resolver serves **the frontend and the names**. There is no Pages project.

That isn't what the architecture said. The intent was Pages at the root and the resolver
at `wget.club/*` — except **that doesn't work**: a Worker route takes precedence over a
Pages custom domain on the same host, so `wget.club/*` swallowed the landing and the
frontend never rendered.

With `[assets]` in `apps/resolver/wrangler.toml`, a request matching a file in `dist` is
served straight from the edge and **doesn't count as a Worker invocation** — the same
saving Pages would give (`docs/FREE_TIER.md`). Whatever doesn't match — i.e. every
name — falls through to the Worker.

That's why CI **builds the frontend before** deploying the resolver: the binding points
at `../web/dist`, and a deploy without that directory ships a Worker whose landing is a
404, with no error at all in the deploy log.

`not_found_handling` stays at `"none"` and needs to stay there.
`"single-page-application"` would return `index.html` for `/myscript`, and anyone
running `curl -sSL wget.club/myscript | bash` would get the HTML landing instead of the
script.

---

## Mainnet — what's missing, and it isn't code

Sepolia needs none of this. Mainnet needs all of it.

`docs/SECURITY.md` says the takedown path blocks the launch, and that isn't a
formality: you're about to serve strangers' `curl | bash` to strangers.

- ❌ **Terms of Use and a DMCA policy.** `/abuse` receives reports, but no document
  says what's forbidden and no formal contact is registered.
  **This is lawyer work.** AI-generated text here would be worse than not having it:
  it would look valid, and you'd act trusting it.
- ❌ **Who reads the queue?** Reports land in `abuse/<date>/<uuid>.json` in R2. No
  alerting, no SLA, nobody on call. A malware report nobody reads for a week is the
  same as having no reporting channel at all.
- ❌ **`POST /api/admin/block` has no interface.** Blocking requires `curl` with the
  admin address. This gets used under pressure, and under pressure is when you get it
  wrong.
- ⚠️ **A mainnet contract is final.** Consider an audit. The 36 tests and the fuzz
  cover what I knew to look for — not what I didn't.

---

## Reference

- `docs/SPEC.md` — the whole system
- `docs/SECURITY.md` — **read before mainnet**
- `docs/FREE_TIER.md` — the budget; the tight limit is 1000 KV writes/day
- `docs/ROADMAP.md` — the open gaps
- `e2e/README.md` — how to run the whole thing locally in one command
