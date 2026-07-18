import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';

import { AdminPage } from './AdminPage';
import { E2EAutoConnect } from './E2EAutoConnect';
import { ErrorBoundary } from './ErrorBoundary';
import { config } from './wagmi';
import './styles.css';

/**
 * Entry point for /admin. Unlike /abuse, this one needs the wallet stack: an admin
 * proves who they are with the same SIWE signature the upload flow uses, so it needs
 * WagmiProvider + RainbowKit. It stays a separate entry (not part of the main SPA)
 * for the [assets] routing reason the other pages document.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const container = document.getElementById('root');
if (!container) throw new Error('#root does not exist — was admin.html changed?');

createRoot(container).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: '#3ddc84',
            accentColorForeground: '#0b0d0e',
            borderRadius: 'small',
            fontStack: 'system',
          })}
        >
          <E2EAutoConnect />
          <ErrorBoundary section="admin">
            <AdminPage />
          </ErrorBoundary>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
