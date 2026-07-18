import type { Address } from 'viem';
import { getJson } from './api';

/**
 * SIWE sign-in, client side.
 *
 * This was missing entirely: `uploadFile()` posted to /api/upload expecting a
 * session cookie that nothing ever obtained, so every upload 401'd and the buy
 * flow could not complete. Found by e2e/tests/demo.spec.ts — typecheck and unit
 * tests were both green, because neither crosses the two apps.
 *
 * The message format below must round-trip through parseSiweMessage() in
 * apps/api/src/siwe.ts. It is a hand-built EIP-4361 message rather than a `siwe`
 * dependency: the server parses exactly these fields, and pulling a library in on
 * one side of a contract that the other side hand-parses is how the two drift.
 */

interface NonceResponse {
  nonce: string;
}

interface SessionResponse {
  address: Address;
  exp: number;
}

/**
 * EIP-4361. Field order matters to the human reading it in the wallet, and the
 * `domain` line must match what the server sees as its own host — the server
 * takes the expected domain from the request, never from the message, so a
 * mismatch here is a 401, not a security hole.
 */
export function buildSiweMessage(params: {
  domain: string;
  address: Address;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
}): string {
  return [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    params.address,
    '',
    'Authorize the upload of your file to IPFS. This is not a transaction and costs no gas.',
    '',
    `URI: ${params.uri}`,
    'Version: 1',
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
  ].join('\n');
}

export async function fetchNonce(): Promise<string> {
  const { nonce } = await getJson<NonceResponse>('/api/nonce');
  return nonce;
}

export async function postSession(message: string, signature: string): Promise<SessionResponse> {
  return getJson<SessionResponse>('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });
}
