/**
 * IPFS pinning via Pinata.
 *
 * Content-type detection lives here rather than in the resolver because the CID's
 * content type is written into the NFT at register() time — by the time the
 * resolver sees it, it is on-chain and, if the owner froze the record, immutable
 * forever. A wrong guess here is not a rendering bug; it is a permanent one.
 */

import { isValidCid, MAX_UPLOAD_BYTES } from '@wgetclub/shared';
import type { Env } from './index';

const PINATA_ENDPOINT_DEFAULT = 'https://api.pinata.cloud/pinning/pinFileToIPFS';

/**
 * Overridable so the E2E suite can point at a local Pinata-compatible stub
 * (e2e/ipfs-stub.mjs). Hardcoding the URL made the upload path untestable without
 * a real paid JWT, real network, and real garbage pinned on every run.
 *
 * Defaults to Pinata, so production needs no var — and a typo'd override cannot
 * silently send user uploads somewhere else, because an unset var still means Pinata.
 */
function pinEndpoint(env: Env): string {
  return env.PINATA_ENDPOINT && env.PINATA_ENDPOINT.length > 0
    ? env.PINATA_ENDPOINT
    : PINATA_ENDPOINT_DEFAULT;
}

/** Re-exported from @wgetclub/shared, where the single definition lives. Do not redeclare. */
export { MAX_UPLOAD_BYTES };

const TEXT_PLAIN = 'text/plain; charset=utf-8';

/** Enough bytes to see a shebang; we never sniff deeper than the first line. */
const SNIFF_BYTES = 2;

const SCRIPT_EXTENSIONS = ['.sh', '.bash'];

/**
 * Decide the content type a name will serve.
 *
 * `text/plain; charset=utf-8` for scripts is THE product decision (SPEC §4.2,
 * CLAUDE.md alma #1). A file the user uploads to be piped into bash must never
 * come back as application/x-sh or octet-stream: the resolver keys its
 * `Content-Disposition` behaviour off this string, and an attachment header on a
 * script breaks `curl -sSL wget.club/x | bash` — which is the product.
 *
 * The shebang wins over the browser-supplied type because browsers routinely
 * report `application/x-sh` or an empty type for the exact files this product
 * exists to serve.
 */
export function detectContentType(filename: string, head: Uint8Array, declared: string | undefined): string {
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) return TEXT_PLAIN; // "#!"

  const lower = filename.toLowerCase();
  if (SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext))) return TEXT_PLAIN;

  // Browsers send text/plain for .txt/.md and the right thing for images/zips.
  // Anything unrecognised is bytes: octet-stream makes the resolver send an
  // attachment header, which is what makes `wget` save it under the real name.
  const ct = declared?.trim();
  if (!ct || ct === 'application/octet-stream') return 'application/octet-stream';
  if (ct.startsWith('text/') && !ct.includes('charset')) return `${ct}; charset=utf-8`;
  return ct;
}

export async function sniffHead(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
}

export interface PinResult {
  cid: string;
  size: number;
}

export type PinOutcome = { ok: true; pin: PinResult } | { ok: false; reason: string };

interface PinataResponse {
  IpfsHash?: unknown;
  PinSize?: unknown;
}

/**
 * Pin `file` and return its CID.
 *
 * The returned CID is validated with the same grammar the resolver enforces
 * before it ever reaches a gateway URL (packages/shared/src/cid.ts). Pinata is a
 * third party: if it returned an error string, an IPNS path, or anything with a
 * slash or an `@` in it, that value would end up in the NFT and, one register()
 * later, inside `${IPFS_GATEWAY}/${cid}` — an SSRF the name owner did not even
 * have to be malicious to cause. Validate at the boundary, once.
 */
export async function pinToIpfs(env: Env, file: Blob, filename: string, contentType: string): Promise<PinOutcome> {
  const form = new FormData();
  // The filename Pinata records is cosmetic for us — the CID is the identity —
  // but it lands in their dashboard, so keep it recognisable and harmless.
  form.append('file', file, sanitizeFilename(filename));
  form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
  form.append(
    'pinataMetadata',
    JSON.stringify({ name: sanitizeFilename(filename), keyvalues: { contentType } }),
  );

  let res: Response;
  try {
    res = await fetch(pinEndpoint(env), {
      method: 'POST',
      headers: { authorization: `Bearer ${env.PINATA_JWT}` },
      body: form,
    });
  } catch {
    return { ok: false, reason: 'pinning service unavailable' };
  }

  if (!res.ok) {
    // Never surface the upstream body: it can echo our JWT back in an auth error.
    return { ok: false, reason: `the pinning service answered ${res.status}` };
  }

  let body: PinataResponse;
  try {
    body = (await res.json()) as PinataResponse;
  } catch {
    return { ok: false, reason: 'invalid response from the pinning service' };
  }

  const cid = body.IpfsHash;
  if (typeof cid !== 'string' || !isValidCid(cid)) {
    return { ok: false, reason: 'the pinning service returned an invalid CID' };
  }

  const size = typeof body.PinSize === 'number' ? body.PinSize : file.size;
  return { ok: true, pin: { cid, size } };
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  return cleaned.length > 0 ? cleaned : 'upload';
}
