import { keccak256, stringToHex, type Address } from 'viem';
import { CHAIN_IDS } from '@wgetclub/shared';

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/**
 * TODO(M1): fill in after `forge script contracts/script/Deploy.s.sol` — the
 * registry is not deployed yet (CLAUDE.md, "Estado atual"). The same placeholder
 * lives in apps/resolver/wrangler.toml and apps/api/wrangler.toml; all three must
 * be updated together at deploy.
 *
 * Until then `isRegistryDeployed()` is false and the UI says so instead of
 * eth_call-ing the zero address and rendering "name available" for everything.
 */
export const REGISTRY_ADDRESSES: Readonly<Record<number, Address>> = {
  [CHAIN_IDS.BASE_MAINNET]: '0xbD74AEb4B8Cb4211B4701e4614Dcf56eD7d7a999',
  [CHAIN_IDS.BASE_SEPOLIA]: ZERO_ADDRESS,
  // Anvil. Only reachable when VITE_E2E=1 puts the foundry chain in the wagmi
  // config (see wagmi.ts), so a production build can never route here.
  [CHAIN_IDS.ANVIL]: (import.meta.env.VITE_REGISTRY_ADDRESS as Address | undefined) ?? ZERO_ADDRESS,
};

export function registryAddressFor(chainId: number): Address {
  return REGISTRY_ADDRESSES[chainId] ?? ZERO_ADDRESS;
}

export function isRegistryDeployed(address: Address): boolean {
  return address !== ZERO_ADDRESS;
}

/**
 * Mirrors WgetClubRegistry.tokenIdOf(). Deterministic, so the dashboard can address
 * a token without an indexer round-trip. `stringToHex` gives the UTF-8 bytes, which
 * is exactly what `keccak256(bytes(name))` hashes on-chain.
 */
export function tokenIdOf(name: string): bigint {
  return BigInt(keccak256(stringToHex(name)));
}

/**
 * The ABI lives in @wgetclub/shared, not here — CLAUDE.md puts it there so the
 * resolver, the api worker and this app all decode the same contract.
 *
 * It was briefly duplicated in this file. Two hand-written ABIs for one contract
 * diverge silently: add an argument on-chain, update one copy, and the other keeps
 * encoding calldata that reverts with no type error to warn you. Re-exported rather
 * than re-declared so the existing `import { REGISTRY_ABI } from '../contract'`
 * call sites keep working.
 */
export { REGISTRY_ABI } from '@wgetclub/shared';
