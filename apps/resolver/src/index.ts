/**
 * wget.club resolver — the hot path.
 *
 * GET /:name  →  the bytes of whatever IPFS CID that name's NFT points at.
 *
 * This worker IS the product. Every request here is someone's `wget` or
 * `curl | bash` waiting on us. Read apps/resolver/README.md and CLAUDE.md
 * ("Regras de ouro do resolver" — the resolver's golden rules) before touching
 * it. In short:
 *   - stream, never buffer
 *   - Cache API → KV → chain;  Cache API → R2 → IPFS
 *   - never send HTML or Content-Disposition to a terminal client
 */

import { validateName, normalizeName, isValidCid, isScriptLike, type NameRecord } from '@wgetclub/shared';
import { resolveOnChain } from './chain';
import { isTerminalClient } from './ua';
import { renderPreview } from './preview';
import { getBlob, putBlob, shouldCache } from './blobs';
import { fetchFromIpfs, parseGateways } from './gateway';

export interface Env {
  NAMES: KVNamespace;
  /**
   * OPTIONAL. R2 requires a card on file even on the free tier, which is a real
   * barrier — not an account detail. Without the binding, bytes are cached in KV
   * (see blobs.ts). The product works either way; R2 just has more headroom.
   */
  BLOBS?: R2Bucket;
  BASE_RPC_URL: string;
  CONTRACT_ADDRESS: string;
  /**
   * Comma-separated list, tried in order. Empty = DEFAULT_GATEWAYS.
   * This used to be a single gateway, and the default (`cloudflare-ipfs.com`) was
   * DEAD — Cloudflare discontinued it. See gateway.ts.
   */
  IPFS_GATEWAYS?: string;
}

/**
 * Routes the Worker answers itself, instead of treating them as a name.
 *
 * `''` (the root) is deliberately NOT here: the frontend is served by the [assets]
 * binding before the Worker runs at all (wrangler.toml). While `''` was in this
 * list, `GET /` fell through to systemRoute()'s default and answered
 * `redirect('https://wget.club/')` — a redirect to itself, i.e. an infinite loop
 * on the product's front door.
 *
 * These three stay as a fallback: if dist ships no robots.txt or favicon, the
 * assets don't match and the Worker answers. If it does, the assets win and this
 * code never runs.
 */
const SYSTEM_ROUTES = new Set(['_health', 'favicon.ico', 'robots.txt', 'sitemap.xml']);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text('method not allowed\n', 405);
    }

    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname.slice(1));

    if (SYSTEM_ROUTES.has(path)) return systemRoute(path);

    // `/:name@<cid>` pins a specific version. The trust primitive for `curl | bash`:
    // audit a CID once, then pin to it forever, immune to the owner repointing the name.
    const [rawName, pinnedCid] = splitPin(path);

    // `/:name.json` exposes metadata without fetching the blob.
    const wantsJson = rawName.endsWith('.json') && !pinnedCid;
    const name = normalizeName(wantsJson ? rawName.slice(0, -5) : rawName);

    const validity = validateName(name);
    if (!validity.ok) return text(`wget.club: invalid name — ${validity.reason}\n`, 400);

    const blocked = await env.NAMES.get(`blocked:${name}`);
    if (blocked) {
      return text(
        `wget.club: "${name}" was blocked for violating the terms of use.\n` +
          `The NFT still belongs to its owner, but we no longer serve this content.\n` +
          `Appeal: https://wget.club/abuse\n`,
        451,
      );
    }

    const record = await lookup(name, env, ctx);
    if (!record || !record.cid) {
      return text(
        `wget.club: "${name}" is not registered.\n` +
          `Available at https://wget.club/?q=${encodeURIComponent(name)}\n`,
        404,
      );
    }

    if (wantsJson) return json(record);

    let cid = record.cid;
    if (pinnedCid) {
      // Only serve a pinned CID if this name actually pointed at it at some point.
      // Otherwise we'd be an open IPFS proxy — free bandwidth for anyone's content,
      // served from our domain, under someone else's trusted name.
      const ok = pinnedCid === record.cid || (await wasEverBound(name, pinnedCid, env));
      if (!ok) {
        return text(`wget.club: CID ${pinnedCid} was never bound to "${name}".\n`, 409);
      }
      cid = pinnedCid;
    }

    if (!isValidCid(cid)) {
      // Contract-level validation is coarse (charset + length only). This is the
      // real gate before the CID reaches a gateway URL. See docs/SECURITY.md (SSRF).
      return text(`wget.club: malformed CID for "${name}".\n`, 502);
    }

    const terminal = isTerminalClient(request.headers.get('user-agent'));
    const forceRaw = url.searchParams.has('raw');
    const forcePreview = url.searchParams.has('preview');

    if ((!terminal && !forceRaw) || forcePreview) {
      return renderPreview(name, record, cid, env);
    }

    return serveBlob(name, record, cid, pinnedCid !== null, env, ctx);
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Name → record
// ---------------------------------------------------------------------------

/** Cache API → KV → chain. Never skip a level; each is ~10x cheaper than the next. */
async function lookup(name: string, env: Env, ctx: ExecutionContext): Promise<NameRecord | null> {
  const cached = await env.NAMES.get<NameRecord>(`n:${name}`, 'json');
  if (cached) return cached;

  // KV miss. Either a brand-new registration the indexer hasn't seen, or a cold name.
  // Read the chain directly so the user's first `curl` right after buying still works —
  // waiting on the 1-minute cron here would make the product feel broken.
  const onChain = await resolveOnChain(name, env);
  if (!onChain) return null;

  ctx.waitUntil(
    env.NAMES.put(`n:${name}`, JSON.stringify(onChain), {
      // Frozen records can never change, so cache them for a day. Unfrozen ones
      // get 60s so a setCid propagates fast even if /api/refresh wasn't called.
      expirationTtl: onChain.frozen ? 86400 : 60,
    }),
  );

  return onChain;
}

async function wasEverBound(name: string, cid: string, env: Env): Promise<boolean> {
  const history = await env.NAMES.get<string[]>(`h:${name}`, 'json');
  return history?.includes(cid) ?? false;
}

// ---------------------------------------------------------------------------
// CID → bytes
// ---------------------------------------------------------------------------

// NOTE: no Range support. `wget -c` (resume) will silently restart from zero.
// Passing the client's Range through to R2/IPFS is a real want for the 25MB cases —
// tracked as an M4 item, not free: the Cache API entry and the R2 read would both
// need to key on the range, and a partial response must never be cached as whole.
async function serveBlob(
  name: string,
  record: NameRecord,
  cid: string,
  isPinned: boolean,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const immutable = record.frozen || isPinned;
  const cache = caches.default;

  // Key the cache on the CID, not the name — two names pointing at the same CID
  // share one cache entry, and a setCid invalidates by construction.
  const cacheKey = new Request(`https://wget.club/__blob/${cid}`, { method: 'GET' });

  const hit = await cache.match(cacheKey);
  if (hit) {
    return decorate(hit, name, record, cid, immutable, 'cache');
  }

  const cached = await getBlob(env, cid);
  if (cached) {
    const res = new Response(cached.body, {
      headers: { 'content-type': record.ct || 'application/octet-stream' },
    });
    const out = decorate(res, name, record, cid, immutable, cached.source);
    ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  }

  // Cold. Pull from IPFS and stream to the client while tee-ing a copy to the
  // cache — the user does not wait on our write finishing.
  const fetched = await fetchFromIpfs(cid, parseGateways(env.IPFS_GATEWAYS));

  if (!fetched) {
    return text(
      `wget.club: could not fetch the content of "${name}" from IPFS (CID ${cid}).\n` +
        `No gateway responded. Try again in a moment.\n`,
      502,
    );
  }

  const upstream = fetched.response;
  const [toClient, toCache] = upstream.body!.tee();

  const res = new Response(toClient, {
    headers: { 'content-type': record.ct || upstream.headers.get('content-type') || 'application/octet-stream' },
  });
  const out = decorate(res, name, record, cid, immutable, 'ipfs');

  const len = upstream.headers.get('content-length');
  const cacheable = shouldCache(cid, record.cid, len ? Number(len) : null);

  ctx.waitUntil(
    (async () => {
      await cache.put(cacheKey, out.clone());
      if (!cacheable) {
        // Pinned version (/:name@cid) or too large: don't spend a write. The
        // Cache API above already covers a repeat hit on the same PoP. See blobs.ts.
        toCache.cancel().catch(() => {});
        return;
      }
      const bytes = await new Response(toCache).arrayBuffer();
      await putBlob(env, cid, bytes, record.ct || 'application/octet-stream');
    })().catch(() => {
      // A cache failure NEVER fails the user's download. The next request retries.
    }),
  );

  return out;
}

// ---------------------------------------------------------------------------
// Headers — this is where `curl | bash` lives or dies
// ---------------------------------------------------------------------------

function decorate(
  res: Response,
  name: string,
  record: NameRecord,
  cid: string,
  immutable: boolean,
  source: 'cache' | 'r2' | 'kv' | 'ipfs',
): Response {
  const h = new Headers(res.headers);
  const ct = record.ct || 'application/octet-stream';

  if (isScriptLike(ct)) {
    /**
     * THE product-critical branch: a script served to a terminal arrives as plain
     * text with NO Content-Disposition.
     *
     * Be precise about why, because the obvious reason is wrong and was written
     * here before: Content-Disposition does NOT break `curl … | bash`. Measured —
     * curl only honours the header under `-O -J`, wget only under
     * `--content-disposition`; piping to stdout ignores it in both. Do not
     * "verify" that claim, find it false, and conclude the rule is cargo cult.
     *
     * The real reasons the header must not be here:
     *   - `curl -OJ URL` and `wget --content-disposition URL` would save the file
     *     under the attachment filename instead of showing it — a script the user
     *     asked to read becomes a silent download.
     *   - A browser hitting ?raw=1 downloads instead of displaying, so nobody can
     *     eyeball a script before piping it into their shell. That is the one
     *     habit we most want to keep cheap (docs/SECURITY.md).
     *   - SPEC §4.2 pins the contract. Clients may start honouring the header at
     *     any time; correctness should not depend on them continuing not to.
     *
     * e2e/tests/resolver.spec.ts asserts the header is absent AND that the pipe
     * actually executes.
     */
    h.set('content-type', ct.startsWith('text/') ? ct : 'text/plain; charset=utf-8');
    h.delete('content-disposition');
  } else {
    // Binary: attachment is what makes `wget` save it under the right filename
    // instead of a bare CID.
    h.set('content-type', ct);
    h.set('content-disposition', `attachment; filename="${sanitizeFilename(name)}"`);
  }

  h.set(
    'cache-control',
    immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=60, stale-while-revalidate=300',
  );

  // Auditability: the user can independently verify these bytes against IPFS.
  h.set('x-wgetclub-cid', cid);
  h.set('x-wgetclub-owner', record.owner);
  h.set('x-wgetclub-frozen', String(record.frozen));
  h.set('x-wgetclub-source', source);
  h.set('access-control-expose-headers', 'x-wgetclub-cid, x-wgetclub-owner, x-wgetclub-frozen');
  h.set('x-content-type-options', 'nosniff');

  return new Response(res.body, { status: res.status, headers: h });
}

/** Names are already [a-z0-9._-], but never trust a stored value in a header. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9._-]/g, '');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitPin(path: string): [name: string, cid: string | null] {
  const at = path.lastIndexOf('@');
  if (at <= 0) return [path, null];
  return [path.slice(0, at), path.slice(at + 1)];
}

function systemRoute(path: string): Response {
  switch (path) {
    case '_health':
      return text('ok\n');
    case 'robots.txt':
      // Names resolve to arbitrary user content — keep it out of search indexes.
      return text('User-agent: *\nDisallow: /\nAllow: /$\n');
    case 'favicon.ico':
      return new Response(null, { status: 204 });
    case 'sitemap.xml':
      // No sitemap: names point at user content we don't want indexed (same reason
      // as robots.txt above).
      return text('', 404);
    default:
      // Unreachable: SYSTEM_ROUTES and this switch list the same routes. It exists so
      // that adding one there without handling it here fails loudly, instead of
      // falling into invented behaviour. This default used to be a redirect to our
      // own root — and since `''` was in SYSTEM_ROUTES, `GET /` looped forever.
      return text(`wget.club: system route "${path}" has no handler\n`, 500);
  }
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' },
  });
}
