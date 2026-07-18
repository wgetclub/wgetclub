import { base, baseSepolia, foundry } from 'wagmi/chains';
import type { Chain } from 'viem';

/**
 * The one chain this build talks to.
 *
 * ONE, not a list. The app used to ship `chains: [base, baseSepolia]`, which made
 * RainbowKit render a network switcher — and a network switcher on this product is
 * a trap, not a feature: a name is an NFT on a specific chain, so `myscript` on
 * mainnet and `myscript` on Sepolia are different tokens with possibly different
 * owners. A user who switches networks does not see "the same site on another
 * network"; they see a different registry, silently. The buy button would quote a
 * price for a contract that is not the one the resolver reads.
 *
 * The resolver has no switcher either: it is deployed with one CONTRACT_ADDRESS.
 * The frontend offering a choice the backend does not have is a lie in the UI.
 *
 * So: build-time, one chain, no switcher. Moving to mainnet is a var + a contract
 * deploy, not a code change.
 */

const CHAINS = {
  'base-sepolia': baseSepolia,
  base,
  /** Local anvil. Only reachable with VITE_E2E=1 — see wagmi.ts. */
  anvil: foundry,
} as const satisfies Record<string, Chain>;

export type ChainName = keyof typeof CHAINS;

function resolveChain(): Chain {
  const name = (import.meta.env.VITE_CHAIN ?? 'base-sepolia') as ChainName;
  const chain = CHAINS[name];
  if (!chain) {
    /**
     * Loud failure, at load. Silence here would be worse than the crash: a typo in
     * VITE_CHAIN would fall back to a default, and the app would talk to the wrong
     * network while looking healthy — checking availability and quoting prices
     * against a registry that is not the one the resolver reads.
     */
    throw new Error(
      `VITE_CHAIN="${name}" is not a known network. Use: ${Object.keys(CHAINS).join(', ')}`,
    );
  }
  return chain;
}

export const CHAIN: Chain = resolveChain();

/** Shown to the user when the wallet is on another network. */
export const CHAIN_LABEL: string = CHAIN.name;
