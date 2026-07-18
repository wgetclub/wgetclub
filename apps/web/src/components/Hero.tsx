import { NameSearch } from './NameSearch';

export function Hero(): JSX.Element {
  return (
    <section className="hero">
      <h1 className="hero__title">
        your name. your file. <span className="accent">one command.</span>
      </h1>
      <p className="hero__sub">
        buy a name as an NFT on Base, point it at a file on IPFS, and it becomes a download URL
        that works in any terminal.
      </p>

      <div className="term" role="img" aria-label="Example: curl -sSL https://wget.club/setup_myapp.sh | bash">
        <div className="term__bar">
          <span className="term__dot" />
          <span className="term__dot" />
          <span className="term__dot" />
        </div>
        <pre className="term__body" data-testid="hero-command">
          <span className="term__prompt">$</span> curl -sSL https://wget.club/setup_myapp.sh | bash
          {'\n'}
          <span className="term__out">▸ installing myapp…</span>
          {'\n'}
          <span className="term__out term__out--ok">✓ done</span>
        </pre>
      </div>

      <NameSearch />

      <ul className="hero__facts">
        <li>
          <strong>permanent ownership</strong> — no renewal, no expiry
        </li>
        <li>
          <strong>ERC-721 on Base</strong> — transferable and resellable
        </li>
        <li>
          <strong>freezable</strong> — prove the script does not change
        </li>
      </ul>
    </section>
  );
}
