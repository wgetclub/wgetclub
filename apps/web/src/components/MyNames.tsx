import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { truncateCid } from '@wgetclub/shared';
import { downloadCommand, getNames } from '../lib/api';
import type { OwnedName } from '../lib/api';
import { CopyCommand } from './CopyCommand';

interface Props {
  onManage: (name: string) => void;
}

export function MyNames({ onManage }: Props): JSX.Element {
  const { address, isConnected } = useAccount();

  const { data, isPending, error, refetch, isRefetching } = useQuery<OwnedName[]>({
    queryKey: ['names', address],
    queryFn: () => getNames(address ?? ''),
    enabled: isConnected && address !== undefined,
  });

  if (!isConnected) {
    return (
      <section className="panel">
        <p className="msg">connect your wallet to see your names.</p>
      </section>
    );
  }

  if (isPending) {
    return (
      <section className="panel">
        <p className="msg">reading your names…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="panel">
        <p className="msg msg--err">could not load your names: {error.message}</p>
        <button type="button" className="btn btn--ghost" onClick={() => void refetch()}>
          try again
        </button>
      </section>
    );
  }

  if (data.length === 0) {
    return (
      <section className="panel">
        <p className="msg">you do not have any names yet.</p>
        <p className="muted small">search for one on the home page and register it — it takes one tx.</p>
      </section>
    );
  }

  return (
    <section>
      <div className="panel__head">
        <h2 className="panel__title">
          my names <span className="muted">({data.length})</span>
        </h2>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void refetch()}
          disabled={isRefetching}
        >
          {isRefetching ? 'refreshing…' : 'refresh'}
        </button>
      </div>

      <div className="grid">
        {data.map((n) => (
          <article className="card" key={n.tokenId} data-testid="name-card">
            <header className="card__head">
              <h3 className="card__name">{n.name}</h3>
              {n.frozen ? (
                <span className="badge badge--frozen" title="Record immutable forever">
                  frozen
                </span>
              ) : null}
            </header>

            <a
              className="link small card__cid"
              href={`https://ipfs.io/ipfs/${n.cid}`}
              target="_blank"
              rel="noreferrer noopener"
              title={n.cid}
            >
              {truncateCid(n.cid)}
            </a>

            <CopyCommand command={downloadCommand(n.name, n.ct)} />

            <footer className="card__foot">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => onManage(n.name)}
                disabled={n.frozen}
                title={n.frozen ? 'record frozen — the CID cannot change' : undefined}
              >
                replace file
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => onManage(n.name)}
                disabled={n.frozen}
              >
                freeze
              </button>
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}
