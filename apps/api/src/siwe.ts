/**
 * Sign-In With Ethereum (EIP-4361) + a minimal HMAC session token.
 *
 * Why auth at all: upload pins bytes on our Pinata bill. Without an identity to
 * attach a rate limit to, we are free pinning-as-a-service for spam (SPEC §5.1).
 *
 * Why a hand-rolled JWT: the payload is {sub, iat, exp} and the verification is
 * one HMAC compare. A JWT library would bring alg negotiation — including the
 * `alg: none` and RS256/HS256 confusion classes of bug — to solve a problem we
 * do not have. WebCrypto is in the runtime already; the whole thing is ~40 lines.
 */

import { verifyMessage } from 'viem';
import { CHAIN_IDS } from '@wgetclub/shared';
import type { Env } from './index';

export const SESSION_COOKIE = 'wgc_session';
const SESSION_TTL_SECONDS = 15 * 60;
const NONCE_TTL_SECONDS = 10 * 60;

/** EIP-4361 requires >= 8 alphanumerics; the address is the identity, this is only anti-replay. */
const NONCE_BYTES = 16;

export interface Session {
  address: string;
  exp: number;
}

// ---------------------------------------------------------------------------
// Nonce
// ---------------------------------------------------------------------------

/**
 * One KV write per nonce, which is a real cost against the 1k writes/day cap
 * (docs/FREE_TIER.md §1). It is accepted because a nonce is only minted when a
 * human clicks "connect" — a few dozen a day — and because the alternative
 * (a stateless HMAC nonce) cannot be burned after use, leaving a 10-minute replay
 * window on a captured signature. If /api/nonce ever becomes a write-quota
 * problem, it is being scraped, and the fix is a rate limit in front of it, not
 * a weaker nonce.
 */
export async function issueNonce(env: Env): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const nonce = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.NAMES.put(`nonce:${nonce}`, '1', { expirationTtl: NONCE_TTL_SECONDS });
  return nonce;
}

/** Single-use: a nonce that verifies is immediately burned, so a captured signature cannot be replayed. */
async function consumeNonce(env: Env, nonce: string): Promise<boolean> {
  if (!/^[0-9a-f]{8,64}$/.test(nonce)) return false;
  const hit = await env.NAMES.get(`nonce:${nonce}`);
  if (!hit) return false;
  await env.NAMES.delete(`nonce:${nonce}`);
  return true;
}

// ---------------------------------------------------------------------------
// SIWE message
// ---------------------------------------------------------------------------

export interface SiweFields {
  domain: string;
  address: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Parses the strict subset of EIP-4361 our frontend emits. Deliberately not a
 * general parser: every field we do not understand is a field an attacker could
 * use to make the message the user *saw* differ from the message we *checked*.
 */
export function parseSiweMessage(message: string): SiweFields | null {
  const lines = message.split('\n');
  if (lines.length < 6) return null;

  const header = lines[0] ?? '';
  const suffix = ' wants you to sign in with your Ethereum account:';
  if (!header.endsWith(suffix)) return null;
  const domain = header.slice(0, -suffix.length);
  if (domain.length === 0) return null;

  const address = (lines[1] ?? '').trim();
  if (!ADDRESS_RE.test(address)) return null;

  const field = (label: string): string | undefined => {
    const prefix = `${label}: `;
    const line = lines.find((l) => l.startsWith(prefix));
    return line?.slice(prefix.length).trim();
  };

  const uri = field('URI');
  const version = field('Version');
  const chainIdRaw = field('Chain ID');
  const nonce = field('Nonce');
  const issuedAt = field('Issued At');
  const expirationTime = field('Expiration Time');

  if (!uri || !version || !chainIdRaw || !nonce || !issuedAt) return null;

  const chainId = Number(chainIdRaw);
  if (!Number.isInteger(chainId)) return null;

  return {
    domain,
    address,
    uri,
    version,
    chainId,
    nonce,
    issuedAt,
    ...(expirationTime === undefined ? {} : { expirationTime }),
  };
}

export type SiweResult = { ok: true; address: string } | { ok: false; reason: string };

/**
 * Verify a SIWE signature and burn its nonce.
 *
 * `expectedDomain` comes from the request URL, never from the message: a message
 * claiming `domain: evil.com` must not authenticate against us, and a signature
 * harvested by evil.com for its own domain must not authenticate here either.
 * This binding is the entire point of the domain field.
 */
export async function verifySiwe(
  env: Env,
  message: string,
  signature: string,
  expectedDomain: string,
): Promise<SiweResult> {
  const fields = parseSiweMessage(message);
  if (!fields) return { ok: false, reason: 'malformed SIWE message' };

  if (fields.domain !== expectedDomain) return { ok: false, reason: 'wrong domain' };
  if (fields.version !== '1') return { ok: false, reason: 'unsupported SIWE version' };

  /**
   * Anvil is accepted only outside production. The chain id in a SIWE message is
   * a claim by the signer, not something we verify against a node — so allowing
   * 31337 in production would let anyone sign for a chain we do not serve and
   * still get a session. Gating it on ENVIRONMENT keeps the E2E stack working
   * without widening the real thing.
   */
  const validChains: readonly number[] =
    env.ENVIRONMENT === 'production'
      ? [CHAIN_IDS.BASE_MAINNET, CHAIN_IDS.BASE_SEPOLIA]
      : [CHAIN_IDS.BASE_MAINNET, CHAIN_IDS.BASE_SEPOLIA, CHAIN_IDS.ANVIL];
  if (!validChains.includes(fields.chainId)) return { ok: false, reason: 'wrong chain' };

  const now = Date.now();
  const issuedAt = Date.parse(fields.issuedAt);
  if (Number.isNaN(issuedAt)) return { ok: false, reason: 'invalid Issued At' };
  // Allow a minute of clock skew forward; anything older than the nonce TTL is
  // moot anyway, since the nonce would already be gone.
  if (issuedAt > now + 60_000) return { ok: false, reason: 'Issued At is in the future' };
  if (now - issuedAt > NONCE_TTL_SECONDS * 1000) return { ok: false, reason: 'message expired' };

  if (fields.expirationTime) {
    const exp = Date.parse(fields.expirationTime);
    if (Number.isNaN(exp)) return { ok: false, reason: 'invalid Expiration Time' };
    if (now >= exp) return { ok: false, reason: 'message expired' };
  }

  if (!/^0x[0-9a-fA-F]+$/.test(signature)) return { ok: false, reason: 'malformed signature' };

  let valid = false;
  try {
    valid = await verifyMessage({
      address: fields.address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  // EOA-only: viem's offline verifyMessage cannot check an ERC-1271 contract
  // signature (Safe, smart accounts) — that needs an eth_call against the wallet.
  // Acceptable for M1; TODO revisit when a Safe owner complains they cannot upload.
  if (!valid) return { ok: false, reason: 'invalid signature' };

  // Nonce last: only burn it once the signature itself checks out, so a bad
  // signature cannot be used to invalidate a nonce someone else is signing.
  if (!(await consumeNonce(env, fields.nonce))) {
    return { ok: false, reason: 'invalid or already used nonce' };
  }

  return { ok: true, address: fields.address.toLowerCase() };
}

// ---------------------------------------------------------------------------
// Session token (HS256 JWT)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(input: string): Uint8Array | null {
  try {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function issueSession(env: Env, address: string): Promise<{ token: string; exp: number }> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const header = b64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(
    encoder.encode(JSON.stringify({ sub: address, iat: Math.floor(Date.now() / 1000), exp })),
  );
  const body = `${header}.${payload}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.SESSION_SECRET), encoder.encode(body));
  return { token: `${body}.${b64url(new Uint8Array(sig))}`, exp };
}

/** Returns null for anything not currently valid: bad shape, bad HMAC, expired. */
export async function verifySession(env: Env, token: string): Promise<Session | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];

  const sigBytes = b64urlDecode(sig);
  if (!sigBytes) return null;

  // crypto.subtle.verify is constant-time, which is why the comparison happens
  // here and not on the base64 strings.
  const ok = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(env.SESSION_SECRET),
    sigBytes,
    encoder.encode(`${header}.${payload}`),
  );
  if (!ok) return null;

  const payloadBytes = b64urlDecode(payload);
  if (!payloadBytes) return null;

  let claims: { sub?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(new TextDecoder().decode(payloadBytes)) as { sub?: unknown; exp?: unknown };
  } catch {
    return null;
  }

  if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
  if (!ADDRESS_RE.test(claims.sub)) return null;
  if (Math.floor(Date.now() / 1000) >= claims.exp) return null;

  return { address: claims.sub.toLowerCase(), exp: claims.exp };
}

export function sessionCookie(token: string, maxAge: number): string {
  // HttpOnly: the token is never readable from JS, so an XSS in the dashboard
  // cannot exfiltrate a session. SameSite=Strict: no cross-site request can
  // spend someone's upload quota (there is no cross-site flow that needs it).
  return [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/api',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

/** The one gate for authenticated routes: cookie → verified address, or null. */
export async function authenticate(request: Request, env: Env): Promise<Session | null> {
  const token = readSessionCookie(request);
  if (!token) return null;
  return verifySession(env, token);
}

export function isAdmin(env: Env, address: string): boolean {
  return env.ADMIN_ADDRESSES.split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0)
    .includes(address.toLowerCase());
}
