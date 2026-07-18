import { useEffect } from 'react';
import { useAccount, useConnect } from 'wagmi';
import { IS_E2E } from './wagmi';

/**
 * Auto-connects the mock wallet in E2E runs. Renders nothing.
 *
 * Why this exists: RainbowKit's modal only lists wallets from its own catalogue,
 * so wagmi's `mock` connector never appears in it — clicking "Connect Wallet" in a
 * test opens a modal with no options. Rather than script a real MetaMask (whose
 * popup Playwright cannot record and whose flow changes between releases), the
 * E2E build connects the mock connector directly and leaves every other screen
 * exactly as production renders it.
 *
 * Safety: `IS_E2E` is `import.meta.env.VITE_E2E === '1'`, which Vite statically
 * replaces at build. In a production build this is `if (false)` and the whole
 * component — plus the mock connector it reaches — is dropped by the minifier.
 */
export function E2EAutoConnect(): null {
  const { connect, connectors } = useConnect();
  const { isConnected } = useAccount();

  useEffect(() => {
    if (!IS_E2E || isConnected) return;
    const mock = connectors[0];
    if (mock) connect({ connector: mock });
  }, [connect, connectors, isConnected]);

  return null;
}
