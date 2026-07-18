/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WalletConnect Cloud project id. RainbowKit requires one for the WC connector. */
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  /** Origin of the api worker. Empty in dev — vite proxies /api (see vite.config.ts). */
  readonly VITE_API_BASE?: string;
  /** Origin the download commands are built from. */
  readonly VITE_RESOLVER_ORIGIN?: string;
  /** "1" switches wagmi to the anvil + mock-connector config. E2E only — see wagmi.ts. */
  readonly VITE_E2E?: string;
  /** Registry address on anvil. Only read when VITE_E2E=1; production addresses are hardcoded. */
  readonly VITE_REGISTRY_ADDRESS?: string;
  /**
   * The ONLY network of this build: "base-sepolia" (default), "base", or "anvil" (E2E).
   * Not a list, on purpose — see src/chain.ts. An unknown value takes the app down at
   * load, instead of falling back to a default and talking to the wrong network.
   */
  readonly VITE_CHAIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
