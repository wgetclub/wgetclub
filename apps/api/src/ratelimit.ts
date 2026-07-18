/**
 * Per-address rate limits for upload (SPEC §5.2).
 *
 * What this defends: pinning is the one cost in this system that is neither free
 * nor Cloudflare's. A name costs 0.0005 ETH once and pins forever; an unlimited
 * uploader costs us storage forever for nothing. See docs/FREE_TIER.md §5.3 —
 * the paid plan does not fix this, because Pinata is not Cloudflare.
 *
 * TRADE-OFF — why KV, given 1k writes/day:
 *
 *   Each upload costs 2 KV writes (hour counter + day byte budget). At the base
 *   scenario's traffic that is noise, and the write count is *bounded by the
 *   limit itself*: an address can never cost more than 10 counter writes/hour,
 *   because after that it is refused before the counter is touched. The floor is
 *   what matters — a rate limiter whose enforcement costs more than the thing it
 *   protects is worse than none.
 *
 *   The real cost is correctness, not quota. KV is eventually consistent (~60s
 *   global), so a client racing N uploads across N PoPs can overshoot the limit
 *   before any counter converges. That is accepted: the limit is a spam ceiling,
 *   not a billing meter, and the worst case is a handful of extra pins from one
 *   authenticated address — which we can then block. The correct fix is a Durable
 *   Object (strongly consistent, single-instance counter), and DOs are a paid-plan
 *   feature (docs/FREE_TIER.md §5.2). TODO: move here at the same time we migrate.
 *
 *   Counters carry an expirationTtl, so they cost zero deletes and zero storage
 *   drift — an idle address leaves nothing behind.
 */

import { balanceOf } from './chain';
import type { Env } from './index';

/**
 * Overridable so the E2E suite is not rate-limited against itself.
 *
 * Every test in the suite uploads as the same anvil account, so a full run spends
 * several of these. The stack wipes KV on boot, which made reruns honest ACROSS
 * boots — but not within one: around the 4th run of a session the buy-flow test
 * starts failing with 429, and it reads exactly like a product bug. It is not; it
 * is the limiter working, aimed at us.
 *
 * Production leaves this unset and gets 10. A typo'd override cannot loosen the
 * real thing, because unset means the default.
 */
function uploadsPerHour(env: Env): number {
  const raw = Number(env.UPLOADS_PER_HOUR ?? '');
  return Number.isInteger(raw) && raw > 0 ? raw : 10;
}
/**
 * An address with no name has never paid us anything and may never — 3/hour is
 * enough to buy a name (upload → CID → register) but not enough to be a free
 * pinning service. (SPEC §5.2)
 */
const UPLOADS_PER_HOUR_UNREGISTERED = 3;
const BYTES_PER_DAY = 50 * 1024 * 1024;

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86400;

export interface RateVerdict {
  allowed: boolean;
  /** Present when refused: a plain sentence for the user, no internals. */
  reason?: string;
  retryAfterSeconds?: number;
}

function hourBucket(): number {
  return Math.floor(Date.now() / 1000 / HOUR_SECONDS);
}

function dayBucket(): number {
  return Math.floor(Date.now() / 1000 / DAY_SECONDS);
}

async function readCounter(env: Env, key: string): Promise<number> {
  const raw = await env.NAMES.get(key);
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Check the limits for `address` before accepting `size` bytes.
 *
 * Read-only on purpose: nothing is charged until the pin actually succeeds
 * (see `recordUpload`), so a failed pin does not eat the user's quota for an
 * hour. The gap between check and charge is the same race described above and
 * has the same answer.
 */
export async function checkUploadAllowed(env: Env, address: string, size: number): Promise<RateVerdict> {
  const hourKey = `rl:h:${address}:${hourBucket()}`;
  const dayKey = `rl:b:${address}:${dayBucket()}`;

  const [used, bytesUsed] = await Promise.all([readCounter(env, hourKey), readCounter(env, dayKey)]);

  if (bytesUsed + size > BYTES_PER_DAY) {
    return {
      allowed: false,
      reason: `daily limit of ${BYTES_PER_DAY / 1024 / 1024}MB per address reached`,
      retryAfterSeconds: DAY_SECONDS - (Math.floor(Date.now() / 1000) % DAY_SECONDS),
    };
  }

  // Only ask the chain once the cheap counter says we might allow it — a caller
  // already over the hourly ceiling should not cost us an RPC call.
  if (used >= UPLOADS_PER_HOUR_UNREGISTERED) {
    const balance = await balanceOf(address, env);
    // RPC failure → treat as unregistered. Failing closed here costs a customer a
    // retry; failing open costs us unbounded pins during an RPC outage.
    const limit = balance !== null && balance > 0n ? uploadsPerHour(env) : UPLOADS_PER_HOUR_UNREGISTERED;

    if (used >= limit) {
      return {
        allowed: false,
        reason:
          limit === UPLOADS_PER_HOUR_UNREGISTERED
            ? `limit of ${limit} uploads/hour for addresses with no registered name`
            : `limit of ${limit} uploads/hour reached`,
        retryAfterSeconds: HOUR_SECONDS - (Math.floor(Date.now() / 1000) % HOUR_SECONDS),
      };
    }
  }

  return { allowed: true };
}

/** Charge the quota. Called only after a successful pin. */
export async function recordUpload(env: Env, address: string, size: number): Promise<void> {
  const hourKey = `rl:h:${address}:${hourBucket()}`;
  const dayKey = `rl:b:${address}:${dayBucket()}`;

  const [used, bytesUsed] = await Promise.all([readCounter(env, hourKey), readCounter(env, dayKey)]);

  await Promise.all([
    env.NAMES.put(hourKey, String(used + 1), { expirationTtl: HOUR_SECONDS * 2 }),
    env.NAMES.put(dayKey, String(bytesUsed + size), { expirationTtl: DAY_SECONDS * 2 }),
  ]);
}
