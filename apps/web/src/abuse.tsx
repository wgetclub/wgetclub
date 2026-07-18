import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AbusePage } from './AbusePage';
import { ErrorBoundary } from './ErrorBoundary';
import './styles.css';

/**
 * Entry point for /abuse. No WagmiProvider, no RainbowKit, no react-query.
 *
 * On purpose: reporting malware cannot depend on connecting a wallet, and whoever is
 * appealing a block may not even have access to the account anymore. It also keeps
 * this page's bundle minimal — it has to load fast and work even when the rest of
 * the app is broken.
 */
const container = document.getElementById('root');
if (!container) throw new Error('#root does not exist — was abuse.html changed?');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary section="report">
      <AbusePage />
    </ErrorBoundary>
  </StrictMode>,
);
