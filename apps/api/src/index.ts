/**
 * wget.club API worker.
 *
 * Everything the resolver refuses to do: upload + pin, SIWE auth, cache refresh,
 * abuse handling, and the indexer cron (SPEC §5, §6).
 *
 * The resolver's rules do not all apply here — this is not the hot path and a
 * user is watching a spinner, not a `curl`. One rule does carry over unchanged:
 * every KV write must justify itself against the 1000/day cap. That cap is shared
 * with the resolver and it is the tightest limit in the system (docs/FREE_TIER.md).
 */

import {
  normalizeName,
  validateName,
  isValidCid,
  truncateCid,
  type AdminBlocksResponse,
  type AdminReport,
  type AdminReportsResponse,
  type AvailabilityResponse,
  type BlockedName,
  type BlockRecord,
  type NameRecord,
  type NamesResponse,
  type OwnedName,
  type UploadResponse,
} from '@wgetclub/shared';
import { isAvailable, nameOfToken, ownerOfToken, priceOf, resolveOnChain, tokenIdOf } from './chain';
import { indexOwner, runIndexer } from './indexer';
import { MAX_UPLOAD_BYTES, detectContentType, pinToIpfs, sniffHead } from './pin';
import { checkUploadAllowed, recordUpload } from './ratelimit';
import { authenticate, isAdmin, issueNonce, issueSession, sessionCookie, verifySiwe } from './siwe';

export interface Env {
  NAMES: KVNamespace;
  /** OPTIONAL — R2 requires a card. Without it, the abuse queue goes to KV (see handleAbuse). */
  BLOBS?: R2Bucket;

  // vars
  CONTRACT_ADDRESS: string;
  START_BLOCK: string;
  /** Optional. Unset = real Pinata. Set by e2e/ to target the local stub. See pin.ts. */
  PINATA_ENDPOINT?: string;
  /** Optional. Unset = 10. Only e2e/ raises it — see ratelimit.ts. */
  UPLOADS_PER_HOUR?: string;
  ENVIRONMENT: string;

  // secrets — see wrangler.toml
  BASE_RPC_URL: string;
  PINATA_JWT: string;
  SESSION_SECRET: string;
  ADMIN_ADDRESSES: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get('origin');
    const allowed = allowedOrigin(env, origin);

    if (request.method === 'OPTIONS') return preflight(allowed);

    // A disallowed Origin is refused before routing. CORS response headers only
    // stop a browser from *reading* a reply — they do not stop the request from
    // being made, so a state-changing route must reject the origin itself.
    if (origin !== null && allowed === null) {
      return withCors(json({ error: 'origin not allowed' }, 403), null);
    }

    let res: Response;
    try {
      res = await route(request, env, ctx);
    } catch {
      // Nothing internal crosses this boundary: no message, no stack. Whatever
      // failed, the client's next move is identical.
      res = json({ error: 'internal error' }, 500);
    }
    return withCors(res, allowed);
  },

  /** The indexer. See indexer.ts — in particular, why an empty tick writes nothing. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runIndexer(env));
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'GET' && path === '/api/nonce') return handleNonce(env);
  if (method === 'POST' && path === '/api/session') return handleSession(request, env, url);
  if (method === 'POST' && path === '/api/upload') return handleUpload(request, env);
  if (method === 'GET' && path === '/api/availability') return handleAvailability(env, url, ctx);
  if (method === 'POST' && path === '/api/abuse') return handleAbuse(request, env);
  if (method === 'POST' && path === '/api/admin/block') return handleAdminBlock(request, env);
  if (method === 'POST' && path === '/api/admin/unblock') return handleAdminUnblock(request, env);
  if (method === 'GET' && path === '/api/admin/reports') return handleAdminReports(request, env);
  if (method === 'GET' && path === '/api/admin/blocks') return handleAdminBlocks(request, env);

  const refresh = match(path, '/api/refresh/');
  if (refresh !== null) {
    if (method !== 'POST') return json({ error: 'method not allowed' }, 405);
    return handleRefresh(refresh, env);
  }

  const names = match(path, '/api/names/');
  if (names !== null) {
    if (method !== 'GET') return json({ error: 'method not allowed' }, 405);
    return handleNames(names, env);
  }

  const nft = match(path, '/api/nft/');
  if (nft !== null) {
    if (method !== 'GET') return json({ error: 'method not allowed' }, 405);
    return handleNft(nft, env);
  }

  return json({ error: 'route not found' }, 404);
}

/** Returns the decoded trailing segment for `prefix`, or null if `path` is not under it. */
function match(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (rest.length === 0 || rest.includes('/')) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function handleNonce(env: Env): Promise<Response> {
  const nonce = await issueNonce(env);
  return json({ nonce }, 200, { 'cache-control': 'no-store' });
}

interface SessionBody {
  message?: unknown;
  signature?: unknown;
}

async function handleSession(request: Request, env: Env, url: URL): Promise<Response> {
  const body = await readJson<SessionBody>(request);
  if (!body || typeof body.message !== 'string' || typeof body.signature !== 'string') {
    return json({ error: 'send {message, signature}' }, 400);
  }

  // The domain to check against is ours, taken from the request — never from the
  // message. See verifySiwe().
  const result = await verifySiwe(env, body.message, body.signature, url.host);
  if (!result.ok) return json({ error: result.reason }, 401);

  const { token, exp } = await issueSession(env, result.address);
  // 15 minutes (SPEC §5.1): long enough for upload → register, short enough that a
  // leaked cookie is worth little. Re-signing is one click.
  return json({ address: result.address, exp }, 200, {
    'set-cookie': sessionCookie(token, exp - Math.floor(Date.now() / 1000)),
    'cache-control': 'no-store',
  });
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const session = await authenticate(request, env);
  if (!session) return json({ error: 'not authenticated' }, 401);

  // Size check BEFORE the body is touched. request.formData() buffers the whole
  // upload into the isolate's 128MB; letting an unbounded body get that far means
  // the limit is enforced by an OOM. Content-Length is client-supplied and could
  // lie low, so the parsed file's real size is re-checked below — this header
  // check exists to reject the honest 2GB upload for free.
  const declaredLength = Number(request.headers.get('content-length') ?? '');
  if (!Number.isFinite(declaredLength) || declaredLength <= 0) {
    return json({ error: 'Content-Length required' }, 411);
  }
  if (declaredLength > MAX_UPLOAD_BYTES) {
    return json({ error: `file larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit` }, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'send multipart/form-data with a "file" field' }, 400);
  }

  /**
   * @cloudflare/workers-types declares FormData.get() as `string | null`, but the
   * runtime does hand back a File for a file part — the types are narrower than
   * reality, so `instanceof File` won't even compile here.
   *
   * Duck-typing the two members we actually use is safer than casting: a cast
   * would also "succeed" on a plain string field and blow up at runtime on
   * file.size, which is exactly the malformed-upload case we need to 400 on.
   */
  function asUploadedFile(entry: unknown): File | null {
    if (entry === null || typeof entry !== 'object') return null;
    const f = entry as Partial<File>;
    if (typeof f.size !== 'number' || typeof f.arrayBuffer !== 'function') return null;
    return entry as File;
  }

  const file = asUploadedFile(form.get('file'));
  if (file === null) {
    return json({ error: '"file" field missing or not a file' }, 400);
  }
  if (file.size === 0) return json({ error: 'empty file' }, 400);
  if (file.size > MAX_UPLOAD_BYTES) {
    return json({ error: `file larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit` }, 413);
  }

  const verdict = await checkUploadAllowed(env, session.address, file.size);
  if (!verdict.allowed) {
    return json({ error: verdict.reason ?? 'limit reached' }, 429, {
      ...(verdict.retryAfterSeconds ? { 'retry-after': String(verdict.retryAfterSeconds) } : {}),
    });
  }

  const contentType = detectContentType(file.name, await sniffHead(file), file.type);

  const outcome = await pinToIpfs(env, file, file.name, contentType);
  if (!outcome.ok) return json({ error: outcome.reason }, 502);

  // Charge only what actually got pinned.
  await recordUpload(env, session.address, outcome.pin.size);

  const response: UploadResponse = {
    cid: outcome.pin.cid,
    contentType,
    size: outcome.pin.size,
  };
  return json(response, 200, { 'cache-control': 'no-store' });
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/**
 * Pull a name from the chain into KV right now, so the dashboard shows the new
 * CID the instant a tx confirms instead of waiting up to a minute for the cron
 * (SPEC §6).
 *
 * Public and unauthenticated — it only copies public chain state — which makes it
 * the one route where a stranger can trigger a KV write. Hence the compare below:
 * a refresh that would write the same bytes writes nothing. Without it, a loop on
 * this endpoint drains the 1000 writes/day the whole product shares and takes the
 * indexer down with it.
 */
async function handleRefresh(rawName: string, env: Env): Promise<Response> {
  const name = normalizeName(rawName);
  const validity = validateName(name);
  if (!validity.ok) return json({ error: validity.reason }, 400);

  const record = await resolveOnChain(name, env);
  if (!record) return json({ error: 'name not registered' }, 404);

  const current = await env.NAMES.get<NameRecord>(`n:${name}`, 'json');
  const changed =
    !current ||
    current.cid !== record.cid ||
    current.ct !== record.ct ||
    current.owner !== record.owner ||
    current.frozen !== record.frozen;

  if (changed) {
    await env.NAMES.put(`n:${name}`, JSON.stringify(record));

    if (isValidCid(record.cid)) {
      const history = (await env.NAMES.get<string[]>(`h:${name}`, 'json')) ?? [];
      if (!history.includes(record.cid)) {
        history.push(record.cid);
        await env.NAMES.put(`h:${name}`, JSON.stringify(history));
      }
    }
  }

  /**
   * Index the owner — OUTSIDE the `changed` guard, deliberately.
   *
   * Without this, the frontend's post-purchase /api/refresh made the name resolve
   * instantly but left "my names" empty until the cron caught up: up to a minute
   * of the buyer's own dashboard denying they own the thing they just paid for.
   * "my names" is the next click after buying, so that window is exactly when
   * it is wrong.
   *
   * It must not be gated on `changed`: a name already cached in `n:` but missing
   * from `o:` (indexer gap, or a refresh that arrived after the record settled)
   * would then never get indexed at all. indexOwner() reads first and returns
   * without writing when the name is already there, so the write budget only pays
   * for real additions — the cost of running it every time is one KV read, and
   * reads are 100x cheaper than writes (docs/FREE_TIER.md).
   */
  await indexOwner(env, record.owner, name);

  return json({ name, record, updated: changed }, 200, { 'cache-control': 'no-store' });
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * Cached in the Cache API rather than KV: it is free, uncounted, and a
 * search-as-you-type box would otherwise put a KV read behind every keystroke
 * (docs/FREE_TIER.md §4.1). 15s is short enough that a name bought in another tab
 * stops looking free almost immediately — and register() reverts on a stale hit
 * anyway, so the chain, not this cache, is what protects the buyer.
 */
async function handleAvailability(env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const raw = url.searchParams.get('name');
  if (raw === null) return json({ error: '"name" parameter required' }, 400);

  const name = normalizeName(raw);
  const validity = validateName(name);
  if (!validity.ok) {
    const body: AvailabilityResponse = { name, available: false, reason: validity.reason };
    return json(body, 200, { 'cache-control': 'public, max-age=60' });
  }

  const cacheKey = new Request(`https://api.wget.club/__availability/${encodeURIComponent(name)}`, {
    method: 'GET',
  });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const available = await isAvailable(name, env);
  if (available === null) return json({ error: 'could not read the chain right now' }, 502);

  let body: AvailabilityResponse;
  if (available) {
    const price = await priceOf(name, env);
    // priceOf() reverting means the contract would never mint this name, whatever
    // available() said. Report it as unavailable rather than quote a price we invented.
    body =
      price === null
        ? { name, available: false, reason: 'name unavailable' }
        : { name, available: true, priceWei: price.toString() };
  } else {
    const record = await resolveOnChain(name, env);
    body = { name, available: false, ...(record ? { record } : {}) };
  }

  const res = json(body, 200, { 'cache-control': 'public, max-age=15' });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// ---------------------------------------------------------------------------
// Names by owner
// ---------------------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The registry is not ERC721Enumerable, so this reads the indexer's `o:<address>`
 * list (see indexer.ts), which tracks registrations *and* ERC-721 Transfers — a
 * name sold on OpenSea lands in the buyer's list on the next cron tick.
 *
 * Every entry is still re-checked against ownerOf() before it is returned. The
 * indexer is a backstop that can lag by a tick (SPEC §6), so the index is a
 * candidate set and the chain is the truth: this is what keeps the seller's list
 * honest in the seconds between the sale and the tick that indexes it.
 */
async function handleNames(address: string, env: Env): Promise<Response> {
  if (!ADDRESS_RE.test(address)) return json({ error: 'invalid address' }, 400);
  const owner = address.toLowerCase();

  const candidates = (await env.NAMES.get<string[]>(`o:${owner}`, 'json')) ?? [];

  const names: OwnedName[] = [];
  for (const name of candidates) {
    // The `o:` index can lag a sale by up to one cron tick, so ownership is
    // re-checked on-chain here. The index is a hint; the chain is the answer.
    const onChainOwner = await ownerOfToken(tokenIdOf(name), env);
    if (onChainOwner !== owner) continue;

    const record = await env.NAMES.get<NameRecord>(`n:${name}`, 'json');
    // A name in `o:` with no `n:` record is a half-indexed write. Skipping it is
    // better than shipping a null the client has to defend against.
    if (!record) continue;

    names.push({ ...record, name });
  }

  // FLAT — {...record, name} — not {name, record}. The type is NamesResponse in
  // @wgetclub/shared and both sides import it; see the comment there for why this
  // shape is pinned rather than left to each side's taste.
  const body: NamesResponse = { address: owner, names };
  return json(body, 200, { 'cache-control': 'private, max-age=15' });
}

// ---------------------------------------------------------------------------
// NFT metadata
// ---------------------------------------------------------------------------

/**
 * ERC-721 metadata. The contract's tokenURI() points marketplaces here
 * (WgetClubRegistry.tokenURI), so this response is what OpenSea renders — and it
 * is fetched by third parties we do not control, which is why it is cached hard
 * and touches KV not at all.
 */
async function handleNft(rawTokenId: string, env: Env): Promise<Response> {
  let tokenId: bigint;
  try {
    tokenId = BigInt(rawTokenId);
  } catch {
    return json({ error: 'invalid tokenId' }, 400);
  }
  if (tokenId < 0n || tokenId > (1n << 256n) - 1n) return json({ error: 'invalid tokenId' }, 400);

  const name = await nameOfToken(tokenId, env);
  if (!name) return json({ error: 'token does not exist' }, 404);

  const record = await resolveOnChain(name, env);
  if (!record) return json({ error: 'token does not exist' }, 404);

  const metadata = {
    name: `wget.club/${name}`,
    description:
      `"${name}" on wget.club — a name that resolves to a file on IPFS.\n\n` +
      `    curl -sSL https://wget.club/${name}\n\n` +
      (record.frozen
        ? 'This record is FROZEN: the CID can never change again.'
        : 'The owner can repoint this name at another CID at any time.'),
    external_url: `https://wget.club/${name}`,
    image: cardSvg(name, record),
    attributes: [
      { trait_type: 'Length', value: name.length },
      { trait_type: 'CID', value: record.cid },
      { trait_type: 'Content-Type', value: record.ct },
      { trait_type: 'Frozen', value: record.frozen ? 'yes' : 'no' },
      { display_type: 'date', trait_type: 'Updated at', value: record.updatedAt },
    ],
  };

  // A frozen record can never change, so its card never changes either
  // (docs/FREE_TIER.md §4.3). Unfrozen ones get 5 minutes: marketplaces refetch
  // lazily regardless, and this is not a route where staleness costs anything.
  return json(metadata, 200, {
    'cache-control': record.frozen
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=300, stale-while-revalidate=3600',
  });
}

/**
 * Inline SVG data URI, not a hosted image: a rendered PNG would need an origin to
 * serve it from, and every marketplace impression would be a Worker request out of
 * the 100k/day budget (docs/FREE_TIER.md §4.5). This costs zero requests forever.
 */
function cardSvg(name: string, record: NameRecord): string {
  const label = escapeXml(name.length > 28 ? `${name.slice(0, 27)}…` : name);
  const cid = escapeXml(truncateCid(record.cid));
  const badge = record.frozen ? '❄ frozen' : '';

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">` +
    `<rect width="600" height="600" fill="#0b0d10"/>` +
    `<text x="48" y="120" font-family="monospace" font-size="24" fill="#5f6b7a">$ curl -sSL</text>` +
    `<text x="48" y="300" font-family="monospace" font-size="40" fill="#e8eef5">wget.club/${label}</text>` +
    `<text x="48" y="360" font-family="monospace" font-size="20" fill="#5f6b7a">${cid}</text>` +
    `<text x="48" y="540" font-family="monospace" font-size="20" fill="#4ea1ff">${badge}</text>` +
    `</svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** The name grammar excludes these, but the CID comes from a third party. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Abuse
// ---------------------------------------------------------------------------

interface AbuseBody {
  name?: unknown;
  reason?: unknown;
  contact?: unknown;
}

/**
 * Reports land in R2, not KV. This route is public and unauthenticated by design
 * — someone reporting a malicious `curl | bash` should not have to connect a
 * wallet first — which means the writes are attacker-controlled. R2 gives 1M
 * Class A ops/month; KV gives 1000 writes/day, shared with the indexer. Putting
 * this on KV would mean a stranger can stop the product from indexing sales.
 */
async function handleAbuse(request: Request, env: Env): Promise<Response> {
  const body = await readJson<AbuseBody>(request);
  if (!body || typeof body.name !== 'string' || typeof body.reason !== 'string') {
    return json({ error: 'send {name, reason}' }, 400);
  }

  const name = normalizeName(body.name);
  const validity = validateName(name);
  if (!validity.ok) return json({ error: validity.reason }, 400);

  const reason = body.reason.slice(0, 2000);
  const contact = typeof body.contact === 'string' ? body.contact.slice(0, 200) : '';
  if (reason.trim().length === 0) return json({ error: 'describe the problem' }, 400);

  const id = crypto.randomUUID();
  const day = new Date().toISOString().slice(0, 10);
  const report = JSON.stringify({
    name,
    reason,
    contact,
    at: Math.floor(Date.now() / 1000),
    // Triage only — this is a queue a human reads, not a log we mine.
    country: request.headers.get('cf-ipcountry') ?? '',
  });

  if (env.BLOBS) {
    await env.BLOBS.put(`abuse/${day}/${id}.json`, report, {
      httpMetadata: { contentType: 'application/json' },
    });
  } else {
    /**
     * Without R2 (which requires a card), the queue falls back to KV.
     *
     * THIS CARRIES A REAL RISK, and it is why the previous version used R2: this
     * route is PUBLIC and unauthenticated — deliberately, because demanding a
     * wallet to report malware would turn away exactly the people who need to
     * report. But free KV gives 1000 writes/day, shared with the indexer. A flood
     * here does not just fill the queue with junk: it stops the indexer, and then
     * the whole dashboard freezes.
     *
     * The 90-day TTL bounds the accumulation, not the flood. The real defence is a
     * Cloudflare Rate Limiting rule on /api/abuse — the free tier includes one, it
     * runs at the edge and costs no writes at all. It is a step in the RUNBOOK, and
     * G14 in docs/ROADMAP.md for as long as it stays manual.
     */
    await env.NAMES.put(`abuse:${day}:${id}`, report, {
      expirationTtl: 90 * 24 * 60 * 60,
    });
  }

  return json({ ok: true, id }, 202, { 'cache-control': 'no-store' });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

interface BlockBody {
  name?: unknown;
  reason?: unknown;
}

/**
 * Gate for every /api/admin/* route. Returns the admin's address on success, or the
 * Response to send on failure.
 *
 * The 404 (not 403) for a non-admin is deliberate and shared across all admin
 * routes: an authenticated non-admin learns nothing about whether the route even
 * exists. Enumerating admin endpoints should look identical to hitting a typo.
 */
async function requireAdmin(
  request: Request,
  env: Env,
): Promise<{ ok: true; address: string } | { ok: false; res: Response }> {
  const session = await authenticate(request, env);
  if (!session) return { ok: false, res: json({ error: 'not authenticated' }, 401) };
  if (!isAdmin(env, session.address)) return { ok: false, res: json({ error: 'route not found' }, 404) };
  return { ok: true, address: session.address };
}

/**
 * Stop serving a name's bytes. Deliberately the *only* takedown power that exists:
 * it writes `blocked:<name>` to KV and touches nothing on-chain. The NFT stays the
 * owner's, transferable and resellable — we cannot burn it, retake it, or repoint
 * it, and the contract has no function that would let us (CLAUDE.md, alma #3).
 * We are a host declining to host; the asset is not ours to take.
 */
async function handleAdminBlock(request: Request, env: Env): Promise<Response> {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.res;

  const body = await readJson<BlockBody>(request);
  if (!body || typeof body.name !== 'string' || typeof body.reason !== 'string') {
    return json({ error: 'send {name, reason}' }, 400);
  }

  const name = normalizeName(body.name);
  const validity = validateName(name);
  if (!validity.ok) return json({ error: validity.reason }, 400);
  if (body.reason.trim().length === 0) return json({ error: 'reason required' }, 400);

  const record: BlockRecord = { reason: body.reason.slice(0, 500), at: Math.floor(Date.now() / 1000) };
  await env.NAMES.put(`blocked:${name}`, JSON.stringify(record));

  return json({ ok: true, name, blocked: record }, 200, { 'cache-control': 'no-store' });
}

/**
 * Undo a block. Mistakes happen and a takedown must be reversible from the same
 * console, not by hand-editing KV. Deleting the key is enough: the resolver reads
 * `blocked:<name>` on every request, so the name resolves again on the next one
 * (subject to KV's ~60s global propagation, same as the block taking effect).
 */
async function handleAdminUnblock(request: Request, env: Env): Promise<Response> {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.res;

  const body = await readJson<BlockBody>(request);
  if (!body || typeof body.name !== 'string') return json({ error: 'send {name}' }, 400);

  const name = normalizeName(body.name);
  const validity = validateName(name);
  if (!validity.ok) return json({ error: validity.reason }, 400);

  await env.NAMES.delete(`blocked:${name}`);
  return json({ ok: true, name }, 200, { 'cache-control': 'no-store' });
}

/**
 * Cap on how many queue entries and block records a single admin read pulls back.
 * The queue is read by a human triaging, not paginated UI — 200 most-recent is
 * plenty, and it bounds the per-request KV/R2 gets (one per entry) so opening the
 * console can never accidentally spend a large slice of the daily budget.
 */
const ADMIN_READ_CAP = 200;

/** The abuse queue, newest first. Reads R2 when present, else the KV fallback. */
async function handleAdminReports(request: Request, env: Env): Promise<Response> {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.res;

  const { reports, truncated } = env.BLOBS
    ? await readAbuseFromR2(env.BLOBS, ADMIN_READ_CAP)
    : await readAbuseFromKv(env, ADMIN_READ_CAP);

  const body: AdminReportsResponse = { reports, truncated };
  return json(body, 200, { 'cache-control': 'no-store' });
}

/** Parse a stored report body into an AdminReport, or null if it is not one. */
function parseReport(raw: string, id: string): AdminReport | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  const r = obj as Record<string, unknown>;
  if (typeof r.name !== 'string' || typeof r.reason !== 'string') return null;
  return {
    id,
    name: r.name,
    reason: r.reason,
    contact: typeof r.contact === 'string' ? r.contact : '',
    at: typeof r.at === 'number' ? r.at : 0,
    country: typeof r.country === 'string' ? r.country : '',
  };
}

/**
 * KV keys are `abuse:<day>:<uuid>`, R2 keys `abuse/<day>/<uuid>.json`. Both list
 * ascending by key, so the tail is the newest by day. We page the whole prefix to
 * find the tail (listing is cheap — it is the per-entry get that costs), then read
 * only the last `cap` and sort by timestamp.
 */
async function readAbuseFromKv(env: Env, cap: number): Promise<{ reports: AdminReport[]; truncated: boolean }> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.NAMES.list({ prefix: 'abuse:', cursor, limit: 1000 });
    for (const k of page.keys) keys.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const truncated = keys.length > cap;
  const recent = keys.slice(-cap);
  const reports: AdminReport[] = [];
  for (const key of recent) {
    const raw = await env.NAMES.get(key);
    if (!raw) continue;
    const parsed = parseReport(raw, key.slice(key.indexOf(':', 'abuse:'.length) + 1));
    if (parsed) reports.push(parsed);
  }
  reports.sort((a, b) => b.at - a.at);
  return { reports, truncated };
}

async function readAbuseFromR2(bucket: R2Bucket, cap: number): Promise<{ reports: AdminReport[]; truncated: boolean }> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix: 'abuse/', cursor, limit: 1000 });
    for (const o of page.objects) keys.push(o.key);
    if (!page.truncated) break;
    cursor = page.cursor;
  }

  const truncated = keys.length > cap;
  const recent = keys.slice(-cap);
  const reports: AdminReport[] = [];
  for (const key of recent) {
    const obj = await bucket.get(key);
    if (!obj) continue;
    // `abuse/<day>/<uuid>.json` → `<uuid>`.
    const base = key.slice(key.lastIndexOf('/') + 1);
    const id = base.endsWith('.json') ? base.slice(0, -5) : base;
    const parsed = parseReport(await obj.text(), id);
    if (parsed) reports.push(parsed);
  }
  reports.sort((a, b) => b.at - a.at);
  return { reports, truncated };
}

/** Currently-blocked names, newest first. */
async function handleAdminBlocks(request: Request, env: Env): Promise<Response> {
  const gate = await requireAdmin(request, env);
  if (!gate.ok) return gate.res;

  const blocked: BlockedName[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.NAMES.list({ prefix: 'blocked:', cursor, limit: 1000 });
    for (const k of page.keys) {
      const raw = await env.NAMES.get(k.name);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw) as Partial<BlockRecord>;
        blocked.push({
          name: k.name.slice('blocked:'.length),
          reason: typeof rec.reason === 'string' ? rec.reason : '',
          at: typeof rec.at === 'number' ? rec.at : 0,
        });
      } catch {
        // A malformed block record should not hide the rest of the list.
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  blocked.sort((a, b) => b.at - a.at);
  const body: AdminBlocksResponse = { blocked };
  return json(body, 200, { 'cache-control': 'no-store' });
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const PRODUCTION_ORIGIN = 'https://wget.club';
const LOCALHOST_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/**
 * Exactly one origin in production. Not a suffix match: `https://wget.club.evil.com`
 * ends with our domain and a careless check would hand it a session-authenticated
 * upload endpoint. Localhost is allowed off production only, so a compromised dev
 * machine's page cannot talk to the real API.
 */
function allowedOrigin(env: Env, origin: string | null): string | null {
  if (origin === null) return null;
  if (origin === PRODUCTION_ORIGIN) return origin;
  if (env.ENVIRONMENT !== 'production' && LOCALHOST_RE.test(origin)) return origin;
  return null;
}

function preflight(allowed: string | null): Response {
  if (allowed === null) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': allowed,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-credentials': 'true',
      'access-control-max-age': '86400',
      vary: 'origin',
    },
  });
}

function withCors(res: Response, allowed: string | null): Response {
  const headers = new Headers(res.headers);
  if (allowed !== null) {
    headers.set('access-control-allow-origin', allowed);
    headers.set('access-control-allow-credentials', 'true');
  }
  // Always vary: a cached response must not be reused across origins.
  headers.append('vary', 'origin');
  return new Response(res.body, { status: res.status, headers });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJson<T>(request: Request): Promise<T | null> {
  const ct = request.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return null;
  // Bodies on these routes are a few hundred bytes of JSON; anything bigger is
  // not a mistake we need to accommodate.
  const length = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(length) && length > 64 * 1024) return null;
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
