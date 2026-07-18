import type { Env } from './index';

/**
 * Byte cache, keyed by CID. Two backends, picked by which binding exists.
 *
 * R2 is better when available: 10GB of storage and zero egress. But **R2 requires a
 * card on file**, even on the free tier, and that is not an account detail — it is a
 * barrier that stops the project from running at all. A system that only works with
 * a card on file has one more prerequisite than anyone documented.
 *
 * So: R2 if the binding exists, KV otherwise. The resolver's cascade does not
 * change; only where the bytes come from at the second level does.
 *
 * KV serves well here, and not by accident — it is read-optimized and replicated to
 * the PoP, which is exactly this data's profile (written once per CID, read a lot).
 * What disqualified it before was the 25MB-per-value limit against uploads of up to
 * 25MB. With the 1MB per-file ceiling, that leaves 25x of headroom.
 *
 * Why not D1: D1's primary is regional. The resolver is the hot path and the target
 * is p95 < 100ms (CLAUDE.md, alma #2) — a round trip to another region per byte
 * served fights that directly. KV is on the PoP.
 *
 * Budget (docs/FREE_TIER.md): free KV gives 1GB and 1000 WRITES/day. At 1MB per
 * file, 1GB is ~1000 distinct CIDs. The writes are the tight limit and they are
 * shared with the indexer — see shouldCache().
 */

/**
 * Ceiling for what goes into KV.
 *
 * 1MB is the product decision (a file should never exceed it) and MAX_UPLOAD_BYTES
 * already enforces it at upload. This number exists as a second line: a CID may have
 * been pinned elsewhere, or come from an upload that predates the limit. A 20MB blob
 * takes nothing down — it simply is not cached, and the gateway serves it. Failing
 * here would trade "slow" for "broken".
 */
const MAX_KV_BLOB_BYTES = 1024 * 1024;

/** Its own prefix: the namespace is shared with the records (n:, h:, o:). */
const KEY = (cid: string): string => `b:${cid}`;

export type BlobSource = 'r2' | 'kv';

export interface CachedBlob {
  body: ReadableStream;
  source: BlobSource;
}

export function backend(env: Env): BlobSource {
  return env.BLOBS ? 'r2' : 'kv';
}

export async function getBlob(env: Env, cid: string): Promise<CachedBlob | null> {
  if (env.BLOBS) {
    const obj = await env.BLOBS.get(`blob/${cid}`);
    return obj?.body ? { body: obj.body, source: 'r2' } : null;
  }

  const stream = await env.NAMES.get(KEY(cid), 'stream');
  return stream ? { body: stream, source: 'kv' } : null;
}

/**
 * Decide whether this CID is worth spending a write on.
 *
 * Only a name's CURRENT CID is cached. A historical `/:name@cid` always goes
 * straight to the gateway.
 *
 * The reason is budget, and the hole was real: `/:name@cid` accepts any CID the name
 * ever had. Without this rule, someone walks every historical CID of every name and
 * each one becomes a write — KV's 1000/day is gone, and with it the indexer's
 * cursor, which shares the quota. A read endpoint taking the indexer down is the
 * kind of coupling that only shows up in production.
 *
 * A pinned version is an audit case, not a traffic case. Paying 1-3s there is the
 * right trade.
 */
export function shouldCache(cid: string, currentCid: string, contentLength: number | null): boolean {
  if (cid !== currentCid) return false;
  if (contentLength !== null && contentLength > MAX_KV_BLOB_BYTES) return false;
  return true;
}

/**
 * Write the bytes. Called from inside a waitUntil — never on the user's path.
 *
 * Takes an ArrayBuffer, not a stream: KV needs the whole value to write, and R2
 * needs a length for a stream put. Since the ceiling is 1MB, buffering here is safe
 * — nowhere near the isolate's 128MB. This is the only buffering in the entire
 * resolver, and it exists because the 1MB limit makes it cheap.
 */
export async function putBlob(env: Env, cid: string, bytes: ArrayBuffer, contentType: string): Promise<void> {
  if (bytes.byteLength > MAX_KV_BLOB_BYTES) return;

  if (env.BLOBS) {
    await env.BLOBS.put(`blob/${cid}`, bytes, { httpMetadata: { contentType } });
    return;
  }

  /**
   * No TTL. The CID is the hash of the content: the key never goes stale, only
   * unused. A TTL would let the blob expire and be rewritten — spending again the
   * very write that is the scarce resource.
   *
   * The real limit is 1GB of storage. When it fills, KV rejects the write, the
   * waitUntil swallows it, and the gateway keeps serving: it degrades, it does not
   * break. Filling 1GB at 1MB per file takes ~1000 distinct CIDs — by then the
   * project has better problems.
   */
  await env.NAMES.put(KEY(cid), bytes);
}
