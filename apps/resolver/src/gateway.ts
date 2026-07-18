import { isValidCid } from '@wgetclub/shared';

/**
 * Fetch a CID from IPFS, with fallback across gateways.
 *
 * This exists for two reasons, and the second one only surfaced when someone tried
 * to actually deploy:
 *
 * 1. The previous default was `cloudflare-ipfs.com`, which Cloudflare DISCONTINUED.
 *    It does not answer — not even an error, the DNS is dead. It was in all four
 *    wrangler.toml files. Every cache miss in production would have returned 502.
 *
 * 2. Without R2, the gateway is the ONLY origin for the bytes. Depending on a single
 *    one means a third party's bad day is the whole product's bad day. With R2 the
 *    gateway is the third level of a cascade; without it, it is the floor.
 *
 * Measured on 2026-07-17 against a real CID on the public network:
 *   w3s.link              0.20s
 *   ipfs.io               0.34s
 *   dweb.link             0.42s
 *   4everland.io          0.57s
 *   gateway.pinata.cloud  10.9s   <- which is why it is not in the default
 *   cloudflare-ipfs.com   dead
 */

/** Order matters: the first to answer wins. Measured, not chosen by taste. */
export const DEFAULT_GATEWAYS = ['https://w3s.link/ipfs', 'https://ipfs.io/ipfs', 'https://dweb.link/ipfs'];

/**
 * Per-gateway timeout. Deliberately short: what is waiting on it is a `curl | bash`.
 * Better to spend 4s trying three gateways than 30s hanging on the first.
 */
const PER_GATEWAY_TIMEOUT_MS = 4_000;

export function parseGateways(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_GATEWAYS;
  const list = raw
    .split(',')
    .map((g) => g.trim().replace(/\/$/, ''))
    .filter((g) => g.length > 0);
  return list.length > 0 ? list : DEFAULT_GATEWAYS;
}

export interface FetchResult {
  response: Response;
  gateway: string;
}

/**
 * Try each gateway until one answers 200 with a body.
 *
 * SECURITY: `cid` is interpolated into a URL. It comes from a mapping a stranger
 * controls, so it is validated here, again, even if the caller already validated it.
 * See docs/SECURITY.md — the contract's validation is coarse (charset and length),
 * and this is what separates a CID from a `../../admin`.
 */
export async function fetchFromIpfs(cid: string, gateways: string[]): Promise<FetchResult | null> {
  if (!isValidCid(cid)) return null;

  for (const gw of gateways) {
    try {
      const res = await fetch(`${gw}/${cid}`, {
        headers: { accept: '*/*' },
        // Cloudflare's own cache in front of the gateway. It is what makes the
        // absence of R2 hurt less: the second request for the same CID, in the same
        // region, never reaches the gateway at all.
        cf: { cacheTtl: 3600, cacheEverything: true },
        signal: AbortSignal.timeout(PER_GATEWAY_TIMEOUT_MS),
      });
      if (res.ok && res.body) return { response: res, gateway: gw };
    } catch {
      // Timeout or network failure: try the next one. A gateway being down must not
      // take the product down — which is exactly why there is more than one.
    }
  }
  return null;
}
