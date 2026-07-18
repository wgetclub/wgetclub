/**
 * Chain reads for the API worker.
 *
 * Same shape as apps/resolver/src/chain.ts, but this worker is not on the hot
 * path, so it can afford the wider ABI and the extra calls. The rule that carries
 * over: never retry. An RPC hiccup surfaces as a 502 immediately rather than
 * holding a request open — the frontend can retry with better context than we can.
 */

import { encodeFunctionData, decodeFunctionResult, keccak256, toBytes } from 'viem';
import { REGISTRY_ABI, type NameRecord } from '@wgetclub/shared';
import type { Env } from './index';

/**
 * Re-exported from @wgetclub/shared, where the single copy of the ABI lives
 * (CLAUDE.md). It used to be declared here; two hand-written ABIs for one
 * contract diverge silently — change an argument on-chain, update one copy, and
 * the other keeps encoding calldata that reverts with no type error to warn you.
 * indexer.ts imports it from this module, so the re-export keeps that path.
 */
export { REGISTRY_ABI };

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

interface RpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * One JSON-RPC round trip. Returns null on transport failure OR on a JSON-RPC
 * error — callers cannot do anything useful with the distinction, and the error
 * message from a public RPC is not something we want to echo to a client.
 */
export async function rpc(env: Env, method: string, params: unknown[]): Promise<unknown | null> {
  let res: Response;
  try {
    res = await fetch(env.BASE_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  const body = (await res.json()) as RpcResponse;
  if (body.error || body.result === undefined || body.result === null) return null;
  return body.result;
}

async function ethCall(env: Env, data: string): Promise<`0x${string}` | null> {
  const result = await rpc(env, 'eth_call', [{ to: env.CONTRACT_ADDRESS, data }, 'latest']);
  if (typeof result !== 'string' || result === '0x') return null;
  return result as `0x${string}`;
}

/**
 * tokenId = uint256(keccak256(bytes(name))) — computed locally, exactly as the
 * contract does it. No eth_call: the whole point of the deterministic id is that
 * clients can derive it without the chain (see contracts/src/WgetClubRegistry.sol).
 */
export function tokenIdOf(name: string): bigint {
  return BigInt(keccak256(toBytes(name)));
}

export async function resolveOnChain(name: string, env: Env): Promise<NameRecord | null> {
  const raw = await ethCall(env, encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'resolve', args: [name] }));
  if (!raw) return null;

  let decoded: readonly [string, string, `0x${string}`, boolean];
  try {
    decoded = decodeFunctionResult({ abi: REGISTRY_ABI, functionName: 'resolve', data: raw }) as readonly [
      string,
      string,
      `0x${string}`,
      boolean,
    ];
  } catch {
    return null;
  }

  const [cid, ct, owner, frozen] = decoded;
  if (owner.toLowerCase() === ZERO_ADDRESS) return null;

  return {
    cid,
    ct,
    owner: owner.toLowerCase(),
    frozen,
    updatedAt: Math.floor(Date.now() / 1000),
    tokenId: `0x${tokenIdOf(name).toString(16)}`,
  };
}

export async function isAvailable(name: string, env: Env): Promise<boolean | null> {
  const raw = await ethCall(env, encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'available', args: [name] }));
  if (!raw) return null;
  try {
    return decodeFunctionResult({ abi: REGISTRY_ABI, functionName: 'available', data: raw }) as boolean;
  } catch {
    return null;
  }
}

/**
 * priceOf() reverts for names that could never be minted (invalid or reserved),
 * which surfaces here as null — the caller reports "unavailable", not "error".
 * Callers must use this value and never packages/shared's priceForLength(): the
 * contract owner can retune the on-chain table at any time.
 */
export async function priceOf(name: string, env: Env): Promise<bigint | null> {
  const raw = await ethCall(env, encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'priceOf', args: [name] }));
  if (!raw) return null;
  try {
    return decodeFunctionResult({ abi: REGISTRY_ABI, functionName: 'priceOf', data: raw }) as bigint;
  } catch {
    return null;
  }
}

/** Reverse lookup for /api/nft/:tokenId, whose caller only has the numeric id. */
export async function nameOfToken(tokenId: bigint, env: Env): Promise<string | null> {
  const raw = await ethCall(env, encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'nameOf', args: [tokenId] }));
  if (!raw) return null;
  try {
    const name = decodeFunctionResult({ abi: REGISTRY_ABI, functionName: 'nameOf', data: raw }) as string;
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

/**
 * Used by the rate limiter to tell customers from strangers. Note this is a
 * balance, not an enumeration — the registry is not ERC721Enumerable, so listing
 * an address's names needs the KV owner index the indexer maintains.
 */
export async function balanceOf(address: string, env: Env): Promise<bigint | null> {
  const raw = await ethCall(env, encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'balanceOf', args: [address as `0x${string}`] }));
  if (!raw) return null;
  try {
    return decodeFunctionResult({ abi: REGISTRY_ABI, functionName: 'balanceOf', data: raw }) as bigint;
  } catch {
    return null;
  }
}

/**
 * Current owner of a token. The indexer does watch ERC-721 Transfer, so a KV
 * record's `owner` survives a secondary sale — but it is a 1-minute backstop, not a
 * subscription, so it can trail the chain by a tick. Anything that gates on
 * ownership must confirm here, on-chain.
 */
export async function ownerOfToken(tokenId: bigint, env: Env): Promise<string | null> {
  const raw = await ethCall(env, encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'ownerOf', args: [tokenId] }));
  if (!raw) return null;
  try {
    const owner = decodeFunctionResult({ abi: REGISTRY_ABI, functionName: 'ownerOf', data: raw }) as `0x${string}`;
    return owner.toLowerCase() === ZERO_ADDRESS ? null : owner.toLowerCase();
  } catch {
    return null;
  }
}

export async function latestBlock(env: Env): Promise<bigint | null> {
  const result = await rpc(env, 'eth_blockNumber', []);
  if (typeof result !== 'string') return null;
  try {
    return BigInt(result);
  } catch {
    return null;
  }
}

/** Block timestamp, for a record's updatedAt. Callers should cache per block. */
export async function blockTimestamp(env: Env, blockNumber: bigint): Promise<number | null> {
  const result = await rpc(env, 'eth_getBlockByNumber', [`0x${blockNumber.toString(16)}`, false]);
  if (typeof result !== 'object' || result === null) return null;
  const ts = (result as { timestamp?: unknown }).timestamp;
  if (typeof ts !== 'string') return null;
  try {
    return Number(BigInt(ts));
  } catch {
    return null;
  }
}
