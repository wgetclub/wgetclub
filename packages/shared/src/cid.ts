/**
 * CID validation.
 *
 * SECURITY: the resolver interpolates the CID into an IPFS gateway URL. An
 * unvalidated CID is an SSRF primitive — "../../admin" or a CID containing
 * "@evil.com" would let a name owner redirect our fetch anywhere. Every CID
 * MUST pass isValidCid() before it touches a URL. See docs/SECURITY.md.
 */

// CIDv1 base32: "b" + base32(lowercase, no padding). Typically 59 chars for sha2-256.
const CIDV1_BASE32 = /^b[a-z2-7]{20,110}$/;

// CIDv0: "Qm" + base58btc, always 46 chars.
const CIDV0_BASE58 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

export function isValidCid(cid: string): boolean {
  if (cid.length < 46 || cid.length > 111) return false;
  return CIDV1_BASE32.test(cid) || CIDV0_BASE58.test(cid);
}

export function truncateCid(cid: string, head = 8, tail = 6): string {
  if (cid.length <= head + tail + 1) return cid;
  return `${cid.slice(0, head)}…${cid.slice(-tail)}`;
}

/**
 * Content types we serve as plain text to terminal clients, so that
 * `curl -sSL wget.club/x | bash` works. Everything else gets attachment
 * semantics. See docs/SPEC.md §4.2 — this list is load-bearing for the product.
 */
const SCRIPT_TYPES = [
  'text/', 'application/x-sh', 'application/x-shellscript',
  'application/javascript', 'application/json', 'application/x-python',
];

export function isScriptLike(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return SCRIPT_TYPES.some((t) => ct.startsWith(t));
}
