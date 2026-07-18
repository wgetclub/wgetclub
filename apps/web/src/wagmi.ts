import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { createConfig, http } from 'wagmi';
import { mock } from 'wagmi/connectors';
import { CHAIN } from './chain';

/**
 * E2E mode, off unless VITE_E2E=1 is set at build/dev time. Vite statically
 * replaces import.meta.env at build, so in a production bundle this is `false`
 * and the whole mock branch is dead-code eliminated — the mock connector cannot
 * ship to users by accident.
 */
export const IS_E2E = import.meta.env.VITE_E2E === '1';

/** anvil's account #0 — a publicly known dev key, funded and worthless. */
const ANVIL_ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;

/**
 * Two configs, one app — and, in both, exactly ONE chain (see ./chain.ts).
 *
 * Production: RainbowKit's default (injected + WalletConnect + Coinbase). With a
 * single chain in the list, RainbowKit stops rendering a network switcher and
 * shows "Wrong network" when the wallet is elsewhere — which is the behaviour we
 * want, and it comes for free.
 *
 * E2E: wagmi's `mock` connector against a local anvil. Why not drive a real
 * MetaMask — the extension renders in a browser context Playwright cannot capture
 * in the page video, and its popup flow shifts between releases, so the suite
 * would break on MetaMask's schedule instead of on our bugs.
 *
 * What stays real under the mock: the transaction is signed, broadcast, and mined
 * on a real chain against the real contract, and a revert fails the test. The only
 * thing faked is the human click that approves it.
 */
export const config = IS_E2E
  ? createConfig({
      chains: [CHAIN],
      connectors: [
        mock({
          accounts: [ANVIL_ACCOUNT_0],
          features: { defaultConnected: true },
        }),
      ],
      transports: {
        [CHAIN.id]: http(CHAIN.rpcUrls.default.http[0]),
      },
      ssr: false,
    })
  : getDefaultConfig({
      appName: 'wget.club',
      // WalletConnect refuses to init without a project id. Injected/Coinbase wallets
      // still work with the placeholder, so dev is not blocked on provisioning one.
      projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? 'WGETCLUB_DEV_PLACEHOLDER',
      chains: [CHAIN],
      ssr: false,
    });

declare module 'wagmi' {
  interface Register {
    config: typeof config;
  }
}
