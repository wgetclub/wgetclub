import { useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import { Hero } from './components/Hero';
import { ManageName } from './components/ManageName';
import { MyNames } from './components/MyNames';
import { E2EAutoConnect } from './E2EAutoConnect';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * Three screens and no deep links worth preserving — react-router would be a
 * dependency for a switch statement.
 */
type Route = { view: 'landing' } | { view: 'mine' } | { view: 'manage'; name: string };

export function App(): JSX.Element {
  const [route, setRoute] = useState<Route>({ view: 'landing' });
  const { isConnected } = useAccount();

  return (
    <div className="app">
      <E2EAutoConnect />
      <header className="nav">
        <button type="button" className="nav__brand" onClick={() => setRoute({ view: 'landing' })}>
          wget<span className="accent">.club</span>
        </button>
        <nav className="nav__links">
          <button
            type="button"
            className={route.view === 'landing' ? 'nav__link nav__link--on' : 'nav__link'}
            onClick={() => setRoute({ view: 'landing' })}
          >
            search
          </button>
          {isConnected ? (
            <button
              type="button"
              className={route.view === 'landing' ? 'nav__link' : 'nav__link nav__link--on'}
              onClick={() => setRoute({ view: 'mine' })}
            >
              my names
            </button>
          ) : null}
        </nav>
        {/*
          chainStatus="none": no network selector. The build talks to ONE chain
          (src/chain.ts) and the resolver is deployed with ONE CONTRACT_ADDRESS —
          offering a choice the backend does not have would be the UI lying. When the
          wallet is on another network, RainbowKit swaps the button for "Wrong network"
          on its own, because the chain list has a single item.
        */}
        <ConnectButton showBalance={false} chainStatus="none" accountStatus="address" />
      </header>

      {/*
        One boundary per screen, not a single one around everything. If "my names"
        breaks, the user still has the nav to get back to search — instead of a whole
        app replaced by an error message. The outer boundary in main.tsx is the net
        below, for whatever escapes here (e.g. a throw in the nav itself).
      */}
      <main className="main">
        {route.view === 'landing' ? (
          <ErrorBoundary section="search">
            <Hero />
          </ErrorBoundary>
        ) : null}
        {route.view === 'mine' ? (
          <ErrorBoundary section="my names">
            <MyNames onManage={(name) => setRoute({ view: 'manage', name })} />
          </ErrorBoundary>
        ) : null}
        {route.view === 'manage' ? (
          <ErrorBoundary section="manage" key={route.name}>
            <ManageName name={route.name} onBack={() => setRoute({ view: 'mine' })} />
          </ErrorBoundary>
        ) : null}
      </main>

      <footer className="foot">
        <span>names are NFTs on Base. permanent ownership.</span>
        <a className="link" href="/legal/">
          legal
        </a>
        <a className="link" href="/abuse">
          report abuse
        </a>
        <a
          className="link"
          href="https://github.com/wgetclub/wgetclub"
          target="_blank"
          rel="noreferrer noopener"
        >
          source
        </a>
      </footer>
    </div>
  );
}
