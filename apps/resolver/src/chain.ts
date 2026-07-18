/**
 * Chain reads — the COLD path only.
 *
 * This runs on a KV miss: a name registered seconds ago that the indexer cron
 * hasn't picked up, or a name so cold it aged out of KV. Never on a cache hit.
 *
 * That's why viem is acceptable here despite the bundle budget: it's tree-shaken
 * to just encode/decode, and ABI coding by hand is a correctness risk we'd be
 * paying for a saving that never shows up on the hot path.
 */

import { encodeFunctionData, decodeFunctionResult } from 'viem';
import { REGISTRY_ABI, type NameRecord } from '@wgetclub/shared';
import type { Env } from './index';


const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

interface RpcResponse {
  result?: string;
  error?: { code: number; message: string };
}

async function ethCall(data: string, env: Env): Promise<string | null> {
  const res = await fetch(env.BASE_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: env.CONTRACT_ADDRESS, data }, 'latest'],
    }),
  });

  if (!res.ok) return null;

  const body = (await res.json()) as RpcResponse;
  if (body.error || !body.result) return null;
  return body.result;
}

/**
 * Read a name straight from the registry.
 * Returns null for unregistered names (owner == 0) and on any RPC failure —
 * the caller turns both into a 404/502. We deliberately do not retry: an RPC
 * hiccup should surface fast, not hold a `curl | bash` hostage.
 */
export async function resolveOnChain(name: string, env: Env): Promise<NameRecord | null> {
  const data = encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'resolve', args: [name] });

  const raw = await ethCall(data, env);
  if (!raw || raw === '0x') return null;

  let decoded: readonly [string, string, `0x${string}`, boolean];
  try {
    decoded = decodeFunctionResult({
      abi: REGISTRY_ABI,
      functionName: 'resolve',
      data: raw as `0x${string}`,
    }) as readonly [string, string, `0x${string}`, boolean];
  } catch {
    return null;
  }

  const [cid, contentType, owner, frozen] = decoded;

  if (owner.toLowerCase() === ZERO_ADDRESS) return null;

  const tokenIdData = encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'tokenIdOf', args: [name] });
  const tokenIdRaw = await ethCall(tokenIdData, env);

  return {
    cid,
    ct: contentType,
    owner: owner.toLowerCase(),
    frozen,
    updatedAt: Math.floor(Date.now() / 1000),
    tokenId: tokenIdRaw ?? '0x0',
  };
}
