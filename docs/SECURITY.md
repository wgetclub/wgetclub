# wget.club — Security and Abuse

> Critical document. Read all of it before touching the resolver, the contract, or the upload flow.

---

## 1. The central thesis: we are a malware distribution vector

Let's be blunt, because pretending otherwise is the one way to get this badly wrong.

**A service whose product is `curl -sSL wget.club/anything | bash` is, by construction,
a platform for executing arbitrary remote code on other people's machines.** We sell
short, pretty names, we serve bytes controlled by a stranger, and the end user pipes
those bytes straight into a shell — often with `sudo`, often without reading. This is not
a side risk. It is the literal description of the product.

That is not a reason not to build it. This risk profile is shared by essentially all of
modern development infrastructure:

| Service | The same profile |
|---|---|
| `get.docker.com` | `curl -fsSL get.docker.com \| sh`, with sudo, millions of times a day |
| `rustup.rs` | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| `sh.rustup.rs`, `deb.nodesource.com`, `install.python-poetry.org`, Homebrew | same |
| **npm / PyPI / crates.io** | run arbitrary scripts on `install`, publishing open to anyone |
| **GitHub Gists / raw.githubusercontent** | free, anonymous hosting of any script, served as plain text |
| **Pastebin** | same, and has literally been used as C2 and malware stager for 15 years |

All of them are malware vectors. All of them exist. All of them are useful. The difference
between the ones that are respected and the ones that corporate firewalls block **isn't the
risk profile — it's the investment in anti-abuse**.

**Therefore: we treat abuse as a first-class product requirement, not an afterthought.**
Concretely, that means:

- The takedown path (`blocked:<name>` → 451) ships **before** mainnet launch, not after the
  first incident. It's milestone M4 in `docs/ROADMAP.md`, and M4 is a prerequisite for M5.
- There is an abuse address and a human who reads it (`POST /api/abuse`, `SPEC.md` §5.1).
- Takedown response time is a product metric — measured, with a target.
- We **build tools for the user to defend themselves against us and against our customers**:
  `freeze()`, `/:name@cid`, `X-Wgetclub-CID`, public CID history.
- We assume we will be abused in the first month. Not "if". The question is how long we take
  to respond.

And an honest admission of scope: **we cannot make `curl | bash` safe.** It isn't safe
anywhere, and it doesn't become safe just because the domain is pretty. What we can do is
(a) not be *worse* than the state of the art, (b) give the attentive user verification tools
that most competitors don't offer (auditable CID, irreversible freeze, version pinning), and
(c) respond fast when we're abused. None of that protects someone who doesn't look.
Documenting it isn't pessimism — it's the only honest posture available.

---

## 2. Threat model

### 2.1 Who attacks

| Actor | Goal | How | Impact | Prob. |
|---|---|---|---|---|
| **Malware spammer** | infect machines | buys `install-tool.sh`, points it at a stager, promotes it on forums/SEO/Discord | RCE on victims; our domain on blocklists | **High** |
| **Typosquatting phisher** | intercept whoever gets the name wrong | buys `setup-app.sh` knowing the real one is `setup_app.sh` | RCE; erosion of trust in the namespace | **High** |
| **Free payload CDN** | host 2nd-stage malware for free | uses upload+pin as anonymous storage; `wget.club/x` is short and looks "clean" in EDR logs | burns pinning quota; domain reputation | **High** |
| **Poisoner of an audited name** | hit people who already trust it | buys/runs a legitimate name, earns adoption, **swaps the CID** after it's been audited and promoted | **the worst case.** Supply chain. Victims already have `curl \| bash` in their runbook | **Medium** |
| **Buyer of an expired/sold name** | inherit someone else's trust | buys a name on OpenSea that third-party docs/blogs already cite, then swaps the content | supply chain, without hacking anything at all | **Medium** |
| **Quota abuser** | take the service down | fires requests until the 100k/day is blown (free, trivial) | error 1027, **product offline until 00:00 UTC** | **Medium** |
| **Attacker of the domain** | steal the SIWE session, sign a tx | XSS via user content rendered on `wget.club` | compromise of user wallets | **Low/critical** |
| **Attacker of the contract** | drain revenue or steal a name | reentrancy in `withdraw`, authorization bug | financial loss; unrecoverable loss of trust | **Low/critical** |
| **Legal / DMCA requester** | content removal | formal notice | needs a process, or the registrar/CF takes down the whole domain | **Medium** |

### 2.2 What we are defending

In order of importance:

1. **The end user's machine** (whoever runs the `curl | bash`). They have the most to lose and
   the least control.
2. **The `wget.club` domain.** If it lands on an EDR/corporate firewall blocklist, the whole
   product dies. It's an asset shared by every name owner.
3. **The user's ownership** (the NFT). We can't take it, and we shouldn't be able to.
4. **The revenue and the contract key.**

### 2.3 What we explicitly do NOT defend

Honesty about limits is worth more than a pretty matrix:

- **We don't audit content.** We don't read scripts before serving them. We have no way to, and
  pretending we do would be worse than not doing it.
- **We don't protect people who run `curl | bash` without looking.** No mechanism does that.
- **We don't stop a blocked name from being fetched directly from IPFS.** The content is there.
  We stop *serving*, not *existing* (§3).
- **We don't protect against a legitimate owner acting in bad faith**, beyond the tools in §5.
- **We are not custodians.** If a user's wallet is compromised, the name goes with it.

---

## 3. Takedown: the boundary between the NFT and the service

This is the most important section in the document. **Understand the boundary before touching anything.**

### 3.1 The mechanism

```
POST /api/admin/block  { name, reason }        (admin auth)
        │
        ▼
   KV  blocked:<name> = { reason, at, ref }
        │
        ▼
   resolver, BEFORE any resolution:
        │
        ├─ blocked? ──► 451 Unavailable For Legal Reasons
        │               Content-Type: text/plain
        │               body: one line + policy URL
        │
        └─ waitUntil: Cache API purge for that name  ⚠ critical
```

**Details that are not optional:**

- The `blocked:` check comes **before** everything, including the response cache (`ARCHITECTURE.md` §3).
  A blocked name whose response is still in the Cache API would keep being served. **Purging the
  cache is part of the takedown, not cleanup afterwards.**
- `frozen: true` + `Cache-Control: immutable, max-age=1y` means that **downstream caches that
  already fetched the file will keep serving it for up to a year**, and we have no way to purge
  anyone's browser cache. This is the real cost of `immutable` (`FREE_TIER.md` §4.3) and there is
  no mitigation. The takedown stops *new* traffic, not what's already cached.
- 451 is the right code (RFC 7725), not 404. Let's not lie about the reason.
- The response is **plain text**, because the client is `curl` (`CLAUDE.md`, golden rules).
- **Every block becomes a line in the public takedown log** (§8).
- Blocking is **reversible**. Unlike the NFT, our service decision can be wrong and must be
  correctable. `blocked:` has an `unblock`.

### 3.2 The boundary, explicitly

> **The NFT belongs to the user. The resolution service is ours.**

| | Can we? | Why |
|---|---|---|
| Delete/burn the NFT | ❌ **No** | No such function exists. By design. |
| Transfer someone's name | ❌ **No** | No such function. By design. |
| Reverse a `freeze()` | ❌ **No** | Irreversible by design (`CLAUDE.md`). |
| Add a name to `reserved` after deploy | ❌ **No** | Only `unreserve` exists (§6). |
| Change the CID of someone else's name | ❌ **No** | `setCid` is `onlyTokenOwner`. |
| **Stop serving the bytes at `wget.club/<name>`** | ✅ **Yes** | It's *our* CDN, *our* domain, *our* Worker. |
| Refuse new uploads/pins from an address | ✅ **Yes** | It's our pinning service. |
| Unpin content from our Pinata | ✅ **Yes** | It's our account. (Doesn't remove it from IPFS — others can pin it.) |

**This is intentional, not a technical limitation we wish we could overcome.**

Soul #3 of the product (`CLAUDE.md`) is *"the name is the user's asset... we cannot delete or
seize a name"*. If we could burn NFTs by administrative decision, none of that would be true:
it would be a SaaS subscription with a gas fee. Permanence is the product. An "erase abusive
name" button would destroy more value than any malware.

And there's a pragmatic argument on top of the philosophical one: **this boundary is our
defensible position.** "We don't host it, we don't control it and we cannot remove the content —
but we remove our delivery service as soon as we're notified, within X hours, and here's the
log" is a clear, consistent, sustainable stance. "We can remove anything, but we choose case by
case" makes us the arbiter of every piece of content in the namespace, with all the cost and
liability that comes with it.

**A consequence we don't hide:** a blocked name is still a valid NFT, with a valid CID, pointing
at content that is still on IPFS. The owner can fetch it straight from a gateway. **We don't
"remove" anything — we stop being the path.** That is the full extent of our power, and that's
how it should be. Document this in the ToS in plain language.

### 3.3 Block criteria

Block when there is: confirmed malware/stager, phishing, credential harvesting, typosquatting
with demonstrated intent, CSAM (block **and report to the authorities** — that one isn't a
decision), a valid DMCA notice, or a court order.

**Do not block for:** content you find ugly, political opinion, competition, or "someone
complained". Every block is a precedent and goes into a public log.

**Response time target:** CSAM and active malware → **< 4h**. DMCA → per the process (§8).
Everything else → < 48h. Measure it. It's a product metric (`ROADMAP.md` M4).

---

## 4. Typosquatting

### 4.1 The problem

`SPEC.md` §2.1 already eliminates the two worst homograph classes, and those decisions are right:

- **Lowercase only.** Kills `Setup.sh` vs `setup.sh`.
- **ASCII only.** Kills `сetup.sh` (Cyrillic С U+0421) vs `setup.sh` — the classic IDN attack.

**But confusable separators are still a risk, and they're the risk that's left:**

```
setup-app.sh   vs   setup_app.sh   vs   setup.app.sh
install-cli    vs   install_cli    vs   installcli
get-docker.sh  vs   get_docker.sh
node-setup.sh  vs   nodesetup.sh
```

Our grammar allows `[-._]` as separators that are interchangeable to the eye. In a terminal,
in a monospaced font, `-` and `_` sit at opposite vertical positions and are **notoriously**
confused — especially when the command is copied from a blog, from a screenshot, from
something someone said, or typed from memory.

Worse: the vector doesn't even need a typo. The attacker writes the forum post with `_`
instead of `-`, and the reader copies and pastes. **The victim made no mistake — the attacker
supplied the command.**

This is made worse by two things that are ours: (a) the extension is part of the name
(`SPEC.md` §2.1), which multiplies the variants of a single "concept" (`setup`, `setup.sh`,
`setup-sh`), and (b) names of 10+ chars cost 0.0005 ETH — the typosquat is **cheap**.

### 4.2 What we are not going to do

- **Block separators at mint.** It would break legitimate names (`setup_myapp.sh` is
  `CLAUDE.md`'s own example) and the grammar lives in the contract — it isn't mutable.
- **Reject names at mint for being close to existing names.** On-chain Levenshtein is
  expensive, arbitrary ("close to what?"), and would turn the first registrant into a
  legitimate squatter over a whole radius of the namespace. It would also freeze names someone
  wants to buy, which is exactly what the `reserved` rule (§6) exists to prevent.
- **Manual mint curation.** Doesn't scale and makes us the arbiter of the namespace.

### 4.3 Proposal: proximity warning in the browser preview

**Where:** exclusively on the preview page (browser UA) and in `apps/web`'s dashboard/search.
**Never** on the terminal path — the resolver can't spend CPU on it and can't break the
`| bash` with any warning at all.

**What:**

```
┌────────────────────────────────────────────────────────┐
│ ⚠  WARNING                                             │
│                                                        │
│ The name  setup-app.sh  is very close to               │
│           setup_app.sh  (12.4k downloads, frozen)      │
│                                                        │
│ If you got here from a copied link or command,         │
│ confirm with the original source which one is right.   │
│                                                        │
│ This name:  0x1a2b…  ·  registered 2 days ago          │
│ Look-alike: 0x9f8e…  ·  registered 14 months ago       │
└────────────────────────────────────────────────────────┘
```

**How (cheap enough to fit the budget):**

1. Keep a list of **popular names** (top ~500 by downloads, via Analytics Engine) in a KV
   `popular:index`, refreshed 1×/day by the cron. **1 write/day** — irrelevant to the quota
   (`FREE_TIER.md` §4.2).
2. Normalization key: `norm(name)` = lowercase, strip **all** `[-._]`. `setup-app.sh` and
   `setup_app.sh` → both `setupappsh`. **A `norm` collision is the strongest signal there is**
   and it's O(1) in a set — it catches the dominant case with no Levenshtein at all.
3. Levenshtein ≤ 1 against the popular list only as a secondary net, and **only** in the
   preview (cold path, no 5ms budget). 500 comparisons of short strings is trivial off the hot
   path.
4. Reinforcing signals in the warning: age of the registration, download count, `frozen?`, and
   whether the owner is the same as the popular name's (if it is, **don't warn** — that's the
   owner defending their own variants).

**Complements:**
- In **search** (`apps/web`), when someone types a name whose `norm()` collides with a popular
  one, show the warning **before the purchase**. It reduces opportunistic squatting and is
  honest with people who meant no harm.
- **Letting the legitimate owner buy their own variants** is the most effective defense there
  is. Search should actively suggest it: *"you bought `setup_app.sh`. The variants
  `setup-app.sh` and `setup.app.sh` are free at 0.0005 ETH each."* That's good for the user
  **and** it's revenue.
- A `norm()` collision with a popular name is a strong signal for **prioritizing** an abuse
  report — not for an automatic block.

**What this warning does not do:** it protects nobody who uses `curl`. Terminal traffic never
sees a preview. The real terminal defense is the owner buying the variants, and the consumer
using `/:name@cid` (§5).

---

## 5. Content rug-pull (the worst case)

### 5.1 The attack

```
  t0   Alice registers "deploy-tool.sh", points it at a legitimate, useful script
  t1   The tool gets traction. Blog post. HN. 8k downloads/day.
  t2   Companies put `curl -sSL wget.club/deploy-tool.sh | bash` in CI and in the runbook
  t3   Someone audits the script. Approves it. Says so publicly.
  t4   Alice (or whoever bought her NFT on OpenSea) calls setCid(...)  ← 0.0001 ETH
  t5   The CI of 200 companies runs something else, on the next build, with sudo, unreviewed
```

**Cost of the attack: 0.0001 ETH and one transaction.** It requires hacking nothing. It is the
normal use of the system. **This is the structural risk of the product**, and no amount of
anti-abuse eliminates it — only the consumer can defend against it, with tools we are obliged
to provide.

Note t4: **it doesn't even have to be Alice.** The name is a resellable NFT (`SPEC.md` §3.4).
Whoever buys it on OpenSea inherits the trust the name accumulated. Resale is a feature; it is
also a market in transferable reputation, which is exactly what an attacker wants to buy.

### 5.2 Mitigations (all already decided — implement them well)

| Mitigation | How | Protects whom | Limit |
|---|---|---|---|
| **Irreversible `freeze()`** | owner calls `freeze(tokenId)`. `setCid` reverts **forever** from then on. No `unfreeze`, ever. | whoever checks `X-Wgetclub-Frozen` before trusting | voluntary. Doesn't protect against a name that never froze. |
| **`/:name@<cid>`** | serves exactly that CID, if it was ever bound to the name (history `h:<name>`). | **anyone who cares.** It's the complete defense. | requires the consumer to use it. Most won't. |
| **`X-Wgetclub-CID`** | every response exposes the CID served. | CI, auditors, whoever logs | it's observability, not prevention |
| **Public CID history** | `h:<name>` exposed on the dashboard and at `/:name.json` | whoever investigates afterwards; whoever monitors | detects, doesn't prevent |

**The recommendation that goes in all user documentation, without exception:**

```bash
# Fragile — the owner can swap the content at any moment:
curl -sSL https://wget.club/deploy-tool.sh | bash

# Correct for CI, runbooks, blog posts, anything automated:
curl -sSL https://wget.club/deploy-tool.sh@bafybeih... | bash
```

**`@cid` is cryptographically immutable.** The CID is the hash of the content. No rug-pull
against an `@cid` is possible — not by us, not by the owner, not by whoever buys the NFT. It is
the only complete defense in this document, and that's why it exists.

**Therefore we treat `@cid` as a front-line feature, not a footnote:**
- The dashboard shows the `@cid` command **next to** the short command, always. Not hidden.
- The browser preview shows both, with a line explaining the difference.
- `X-Wgetclub-Frozen: false` in the preview comes with a visible warning: *"this content can
  change. For automated use, use the command with `@cid`."*
- The "put this in your CI" documentation shows **only** the `@cid` form.

**Proposed improvement for M4:** a notification window. `setCid` on a name with > N downloads
emits `CidUpdated`, and we (a) keep the old CID in R2 and (b) expose a feed/webhook of "popular
names that changed CID in the last 24h". It doesn't prevent the attack — but it turns a silent
rug-pull into a public event, detectable within minutes, which changes the economics of the
attack. Requires no contract change.

**What we are not going to do:** a mandatory timelock on `setCid`. It penalizes legitimate use
(fixing a bug in a script should be fast) in order to delay by hours an attack that anyone
using `@cid` already avoids entirely. And we can't apply it retroactively to the contract.

---

## 6. Contract security

`WgetClubRegistry.sol` is the only part of the system that **cannot be fixed with a deploy**.
Treat every line at that level.

### 6.1 Reentrancy in `withdraw`

**The risk:** `withdraw(address to)` sends ETH. If `to` is a contract with a malicious
`receive()`, it reenters before state is updated.

**Rule: checks-effects-interactions, no exceptions.**

```solidity
// Effects before interactions. Zero the balance BEFORE the external call so a
// malicious `to` re-entering finds nothing left to withdraw.
function withdraw(address to) external onlyOwner {
    uint256 amount = address(this).balance;
    if (amount == 0) revert NothingToWithdraw();
    // no mutable balance accumulator exists; balance is read once and sent once
    (bool ok, ) = to.call{value: amount}("");
    if (!ok) revert WithdrawFailed();
}
```

If at some point the contract starts holding per-account balances (e.g. royalty splits,
credits), **migrate to pull-payment** (`ReentrancyGuard` + per-address balance + individual
withdrawal). Never push ETH in a loop.

**Also review for reentrancy:** `register()` and `setCid()` are `payable` and may refund
excess. **A refund is an external call.** Do the whole `_mint` and every write to `records`
**before** the refund, or don't refund at all (demand the exact value). The same rule applies
to ERC-721's `_safeMint`, which calls `onERC721Received` on the recipient — **that is an
external call to an arbitrary contract in the middle of `register`**. All state has to be
written before it.

### 6.2 The owner cannot steal a name

**Invariant:** there is no path by which the contract owner alters ownership or content of
someone else's name.

- `setCid` → `onlyTokenOwner`. **Not** `onlyTokenOwnerOrContractOwner`.
- `freeze` → `onlyTokenOwner`.
- No privileged `transferFrom`, no `adminBurn`, no `adminSetCid`, no pause that freezes
  transfers.
- **Watch out for the exception in `SPEC.md` §2.3:** *"updates are free for the contract owner
  (migrations)"*. That is a **fee waiver**, not authorization. Concretely:

```solidity
// The contract owner may waive the fee, never the ownership check.
function setCid(uint256 id, string calldata cid, string calldata ct) external payable {
    if (ownerOf(id) != msg.sender) revert NotTokenOwner();   // ALWAYS. No admin bypass.
    if (records[id].frozen) revert RecordFrozen();
    if (msg.sender != owner() && msg.value < updateFee) revert InsufficientFee();
    ...
}
```

  If the contract owner isn't the token's owner, `setCid` reverts — even if they pay.
  **Write a test for exactly that** and treat its failure as P0.

**Mandatory fuzz test:** for any `(attacker, tokenId)` where `ownerOf(tokenId) != attacker`, no
external function changes `records[tokenId]` or `ownerOf(tokenId)`. Include the contract owner
in the `attacker` set.

### 6.3 `reserved`: can only be removed, never added

**Invariant (`SPEC.md` §2.2):** `unreserve(string)` exists. **`reserve(string)` does not.**
The reserved list is fixed in the constructor.

**Why:** if the owner could add to `reserved`, they could watch the mempool, see someone buying
`stripe.sh`, and reserve the name in front of them (front-run) — freezing a name someone wants
to buy. That is: (a) a censorship attack, (b) MEV against your own customer, (c) destruction of
the premise that "the name is the user's asset".

```solidity
mapping(uint256 => bool) private reserved;   // set once in the constructor

// Reserved names can only be released, never added. An `addReserved` would let the
// contract owner front-run a purchase and freeze any name someone wants. Never add one.
function unreserve(string calldata name) external onlyOwner {
    reserved[uint256(keccak256(bytes(name)))] = false;
}
```

Test: there is no path, in any function, that writes `reserved[x] = true` after the
constructor. Also verify that `available()` and `priceOf()` respect `reserved` identically — a
divergence between the two becomes a surprise revert in `register`.

### 6.4 `freeze` is irreversible on purpose

There is no `unfreeze`. There is no `emergencyUnfreeze`. There is no unfreeze with a timelock,
a multisig, or governance. **`CLAUDE.md` is explicit.**

**Why:** `freeze()` is the **only** strong guarantee we offer to someone running `curl | bash`.
It's worth something because it's a property of the system, not a policy of ours. An
`unfreeze` — under any condition, however narrow — demotes it from cryptographic guarantee to
administrative promise. And a guarantee with an exception isn't a guarantee; it's a marketing
sentence that people will build CI on top of.

Accepted consequence: someone will freeze a name by mistake and be stuck with bad content
forever. **That cost is smaller than the alternative.** Mitigation: the dashboard requires
confirmation by typing the name, shows the CID, and gives an unambiguous warning about
irreversibility.

Note also: freeze does **not** prevent transferring the NFT. The name is still sellable — what's
frozen is the content, not the ownership. That's correct, and it's what makes `freeze` safe for
the buyer: buying a frozen name does not grant the power to swap the content.

### 6.5 Others

| Item | Rule |
|---|---|
| **On-chain name validation** | It's the source of truth. `packages/shared` only mirrors it. A fuzz test guarantees parity (`CLAUDE.md`). Divergence = a homograph getting through = P0. |
| **`tokenId` collision** | `keccak256(bytes(name))`. A collision is computationally infeasible. But `names[tokenId]` must be written **only once**, at mint, and `register` must revert if `_exists(tokenId)`. |
| **Price overflow** | Solidity 0.8.x checks. `setPrice` should have sanity bounds (`> 0`, ceiling) so a fat-fingered owner doesn't turn it into a 1000 ETH price. |
| **`priceOf` vs `msg.value`** | Revert if `msg.value < priceOf(name)`. Decide explicitly: refund the excess (external call — see §6.1) or demand the exact value. **Demanding the exact value is simpler and safer.** |
| **ERC-2981** | `royaltyInfo` must never revert. A marketplace that gets a revert may delist. |
| **Events** | Every state change emits. The indexer depends on it (`CLAUDE.md`). A silent `setCid` is permanently stale KV. |
| **Ownership** | `Ownable2Step`. Transferring ownership to the wrong address in a contract with no emergency admin is irreversible. |
| **`string` in `calldata`, not `memory`** | Gas, and it avoids unnecessary copies during validation. |
| **Audit** | Before M5 (mainnet). The contract has no `upgrade`. Don't go to mainnet on "we'll audit it later". |

---

## 7. Worker operational security

### 7.1 SSRF in the IPFS gateway

**The risk:** the resolver builds `https://<gateway>/ipfs/<cid>` and does a `fetch`. The CID
comes from KV, which comes from the chain, **which comes from arbitrary user input** —
`register()` accepts any string as a CID. An attacker registers a name with CID `../../admin`
or `x/../../../` or `evil.com/x#` and makes us fetch any URL at all.

**Rule: validate the CID before building any URL. The gateway is a constant.**

```ts
// The CID comes from on-chain input, i.e. fully attacker-controlled. Validate its shape
// before it touches a URL. Never interpolate user input into the gateway host.
const CID_V1 = /^ba[a-z2-7]{57,61}$/;          // CIDv1, base32, lowercase
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/; // CIDv0, base58btc

function isValidCid(cid: string): boolean {
  return CID_V1.test(cid) || CID_V0.test(cid);
}

// GATEWAY is a compile-time constant. It is NEVER derived from a record.
const url = `${GATEWAY}/ipfs/${cid}`;
```

**Non-negotiable checklist:**

- [ ] CID validated against a **strict** regex before any concatenation. `^`/`$` anchors are
      mandatory — without them, `evil.com/#bafy...` gets through.
- [ ] The regex does **not** allow `/`, `.`, `:`, `?`, `#`, `%`, `@`, `\`, or anything outside
      the alphabet.
- [ ] The gateway host is a **build constant**, never from KV, from a record, from a query param
      or from a header.
- [ ] The record's `contentType` **is also user input** — never echo it raw into the
      `Content-Type` header. Validate against an allowlist, or sanitize. A `contentType` of
      `text/html`, or one with an embedded `\r\n`, is response splitting / XSS on our own domain
      (§7.3).
- [ ] The name is validated before becoming a KV key (prevents namespace injection: a "name"
      `x` that turns into `n:x` vs `blocked:x`).
- [ ] No `redirect: "follow"` to an arbitrary host in the gateway fetch. Use
      `redirect: "manual"` or accept only same-host redirects.
- [ ] Validate the CID **on-chain in `register`/`setCid` too**? Expensive in gas, and the full
      regex is infeasible in Solidity. **Decision: CID format validation is the responsibility
      of the resolver and the `api`, not the contract.** A malformed CID on-chain is a name that
      simply doesn't resolve (404) — not a vector. **That is only true if the resolver actually
      validates. This is the single point of failure of this section.**

### 7.2 Rate limiting and quota

- Upload: 10/hour per address, 50MB/day. Address with no registered name: 3/hour (`SPEC.md` §5.2).
  **Without this we become free, anonymous IPFS pinning for spam** — and the cost is ours, in
  real money.
- SIWE is the anchor of the rate limit. A wallet is cheap to create, but not free: it takes gas
  to have a history. Using "has a registered name" as a reputation signal (`SPEC.md` §5.2) is
  clever — keep it.
- **The 1027 is a trivial, free DoS against us** (`FREE_TIER.md` §5). 100k requests/day is
  reachable by one person with a `while true; do curl ...; done`. Cache API + `immutable` help,
  but don't solve it. Mitigations: Cloudflare WAF/rate limit per IP (free, runs **before** the
  Worker, so it doesn't spend quota), and the paid plan (FREE_TIER §5.1), which trades "product
  offline" for "a few cents". **Configure the WAF before M5.**
- A rate limit consistent across PoPs requires Durable Objects (paid plan). On the free tier the
  per-isolate rate limit is approximate — **assume it leaks** and don't depend on it for
  anything critical.

### 7.3 Header security and the HTML preview

**The absolute rule: user content is NEVER rendered as HTML on the `wget.club` domain.**

**Why:** `wget.club` is where the SIWE session lives (JWT cookie, `SPEC.md` §5.1). An XSS on the
main domain allows stealing that session, calling `/api/upload` as the victim, and — worse —
manipulating what the dashboard asks the wallet to sign. **XSS here is wallet compromise.** That
makes the preview the most dangerous surface in the entire system.

And the preview is *exactly* where the temptation lives: it would be useful to render a
`README.md`, syntax-highlight a `.sh`, show an image. **No.**

**Rules:**

| Rule | Detail |
|---|---|
| Content preview = **escaped text** | Escape `<`, `>`, `&`, `"`, `'`. No exceptions, no "it's just markdown". |
| **Never** `Content-Type: text/html` for user content | Even if the record says `text/html`. Force `text/plain` in the preview. |
| If one day rendering becomes necessary | **a separate sandboxed domain** (e.g. `*.wget-content.club`), different origin, no cookies, `<iframe sandbox>`. Never on `wget.club`. This is v2 scope. |
| **`contentType` is user input** | Strict allowlist before echoing. Reject anything with `\r`, `\n`, or outside the `type/subtype; charset=...` format. |
| `X-Content-Type-Options: nosniff` | On **every** response. Without it, the browser can sniff a `text/plain` as HTML. |
| Strict CSP on the preview | See below. |
| SIWE cookie | `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api`, 15min. **`Path=/api` matters:** the preview at `/:name` shouldn't even receive the cookie. |
| Self-contained preview | No external assets (`FREE_TIER.md` §4.5) — which fits perfectly with a CSP with no external `unsafe-inline`. |

**Preview CSP (`GET /:name` with a browser UA):**

```
Content-Security-Policy:
  default-src 'none';
  style-src 'sha256-<hash-of-the-inline-style>';
  img-src 'self' data:;
  form-action 'none';
  base-uri 'none';
  frame-ancestors 'none';
  sandbox allow-popups
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

`default-src 'none'` and the **absence of `script-src`** are the point: the preview executes no
JavaScript at all. It's static HTML with a copy button (which can be done without JS, or with a
`sha256` in `script-src` if it's truly necessary). **If you had to add `unsafe-inline` to make
the preview work, you're building the wrong thing.**

**Headers on every resolver response:**

```
X-Content-Type-Options: nosniff
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

**But mind soul #1 (`CLAUDE.md`):** *"if a header breaks the `| bash`, it's a P0 bug"*.
**Browser** security headers (CSP, HSTS, `nosniff`, `X-Frame-Options`) are ignored by
`curl`/`wget` and are safe. **`Content-Disposition` and `Content-Encoding` are not** — those are
the two that break the `| bash` and they are forbidden for terminal UAs on a script
(`SPEC.md` §4.2). Don't confuse the two categories, and test with real `curl`.

**No permissive CORS on the `api`.** `Access-Control-Allow-Origin` must list the Pages origin,
not `*`. `*` + a session cookie is how you give the session away for free.

---

## 8. Legal responsibilities

I'm not a lawyer and this isn't legal advice. But the three things below are obviously
necessary and are cheap to do **before** M5. Get a real lawyer before the mainnet launch — the
cost is small next to the cost of getting it wrong.

### 8.1 Terms of Service

They need to exist, they need to be linked in the footer, and they need to say, in plain
language:

- **The boundary from §3.2**: the NFT belongs to the user and is permanent; resolution at
  `wget.club` is a service of ours, which we can suspend for abuse. Buying a name is **not**
  buying the right to have us serve it forever. This needs to be prominent **before the
  purchase**, not buried — it's the expectation most likely to be violated, and it's the kind of
  thing that turns into a dispute.
- **Forbidden content**: malware, phishing, CSAM, IP infringement, illegal content.
- **No warranty** about third-party content. We don't audit, we don't endorse.
- **`curl | bash` executes strangers' code.** Say it. Explicitly. Not in fine print — we are
  selling the convenience of doing exactly that.
- No uptime guarantee while we're on the free tier (FREE_TIER §5: the service **goes down** at
  100k req/day). Don't promise 99.9% publicly before you have the paid plan.
- Jurisdiction, entity, governing law.

### 8.2 DMCA / abuse process

| Item | Requirement |
|---|---|
| **Contact** | `abuse@wget.club` **and** a form (`POST /api/abuse`, `SPEC.md` §5.1). Published in the footer and at `/.well-known/security.txt`. |
| **DMCA agent** | Designated and registered, if the entity is US-based. |
| **SLA** | CSAM/active malware: < 4h. Valid DMCA: per the law. Everything else: < 48h. **Measure it.** |
| **Counter-notice** | The owner of a blocked name needs an appeal path. Blocking is reversible (§3.1) — and we will get some of them wrong. |
| **Owner notification** | When blocking, notify them (the on-chain event gives the address; with no email, use the dashboard). |
| **Court order** | Have a defined path. Know in advance what we can and cannot comply with (§3.2) — "we can't delete the NFT" needs to be a prepared answer, not an improvisation under pressure. |
| **CSAM** | Immediate block + report to NCMEC/local authority + unpin. **This is not a product decision.** |

### 8.3 Takedown log

**Public, append-only, published** (Lumen Database / transparency report style).

| Field | Example |
|---|---|
| date | 2026-03-14 |
| name | `f***-installer.sh` (the name may be partially redacted if the name itself is the vector) |
| reason | malware / phishing / DMCA / court order / CSAM |
| requester | public report / rights holder / authority (identity not necessarily public) |
| action | block / unblock |
| response time | 3h |

**Why this matters more than it looks:**

1. **It's the proof that the boundary in §3.2 is real.** With no log, "we only block abuse" is a
   claim we make about ourselves. With a log, it's verifiable.
2. **It protects against abusive takedown requests.** People who demand removal for bad reasons
   tend to back off when the request is going to become a line in a public log.
3. **It's the difference between "malware domain" and "serious infrastructure"** when an EDR
   vendor decides whether to put `wget.club` on a blocklist. That domain on a blocklist is an
   asset shared by **every** name owner — protecting it is our obligation to them.
4. **It disciplines us.** A block you'd be embarrassed to log is a block that shouldn't happen.

Keep an **internal** log too (not public) with complete evidence: who asked, what exactly, who
approved, the CID at the moment of the block. You will need it.

---

## 9. Pre-mainnet checklist (blocks M5)

Nothing here is optional. See `docs/ROADMAP.md` M4.

**Contract**
- [ ] External audit completed, findings resolved
- [ ] Fuzz: no non-owner (including the contract owner) changes `records`/`ownerOf`
- [ ] Fuzz: parity of name validation on-chain ↔ `packages/shared`
- [ ] Test: there is no path that writes `reserved[x] = true` post-constructor
- [ ] Test: there is no `unfreeze`, and `setCid` reverts forever after `freeze`
- [ ] Test: reentrancy in `withdraw`, `register` (via `onERC721Received`) and in the refund
- [ ] `Ownable2Step`; ownership on a multisig, not on a hot EOA

**Resolver / API**
- [ ] Strict CID validation before any gateway URL (§7.1) — **with anchors**
- [ ] Gateway host is a build constant
- [ ] `contentType` goes through an allowlist before becoming a header
- [ ] `blocked:<name>` → 451, **before** the cache, with a Cache API purge
- [ ] `nosniff` + CSP `default-src 'none'` on the preview; zero third-party JS
- [ ] Zero user HTML rendered on `wget.club`
- [ ] SIWE cookie `HttpOnly; Secure; SameSite=Strict; Path=/api`
- [ ] `api` CORS restricted to the Pages origin, never `*`
- [ ] Upload rate limits active and tested
- [ ] WAF per-IP rate limit rule (free, before the Worker)
- [ ] `curl | bash` actually tested, on real `curl` and `wget`, with and without `frozen`

**Operational**
- [ ] `abuse@wget.club` exists and someone reads it
- [ ] `/.well-known/security.txt` published
- [ ] ToS published, with the boundary from §3.2 prominent **before the purchase**
- [ ] Takedown runbook written and **rehearsed once**
- [ ] Takedown log published (empty, but existing)
- [ ] Proximity warning (§4.3) live on the preview and in search
- [ ] `@cid` documented as the recommended form for CI, throughout the docs
