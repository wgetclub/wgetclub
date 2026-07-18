import { useEffect, useMemo, useState } from 'react';
import { useChainId, useReadContract } from 'wagmi';
import { formatEth, normalizeName, truncateCid, validateName } from '@wgetclub/shared';
import { REGISTRY_ABI, isRegistryDeployed, registryAddressFor } from '../contract';
import { RESOLVER_ORIGIN, downloadCommand } from '../lib/api';
import { BuyFlow } from './BuyFlow';
import { CopyCommand } from './CopyCommand';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function NameSearch(): JSX.Element {
  const [raw, setRaw] = useState('');
  const [buying, setBuying] = useState(false);
  const chainId = useChainId();
  const registry = registryAddressFor(chainId);
  const deployed = isRegistryDeployed(registry);

  // Normalizing on every keystroke means the user sees the canonical name — the one
  // the NFT will actually carry — rather than discovering the rewrite after paying.
  const name = normalizeName(raw);
  const debouncedName = useDebounced(name, 300);
  const validation = useMemo(() => (debouncedName ? validateName(debouncedName) : null), [debouncedName]);
  const valid = validation?.ok === true;
  const settled = debouncedName === name;

  const canQuery = valid && deployed;

  const {
    data: available,
    isLoading: loadingAvailable,
    error: availableError,
  } = useReadContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'available',
    args: [debouncedName],
    query: { enabled: canQuery },
  });

  const { data: price, error: priceError } = useReadContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'priceOf',
    args: [debouncedName],
    query: { enabled: canQuery && available === true },
  });

  const { data: record } = useReadContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'resolve',
    args: [debouncedName],
    query: { enabled: canQuery && available === false },
  });

  useEffect(() => {
    setBuying(false);
  }, [debouncedName]);

  if (buying && valid && price !== undefined) {
    return <BuyFlow name={debouncedName} price={price} onCancel={() => setBuying(false)} />;
  }

  return (
    <div className="search">
      <div className="search__box">
        <span className="search__prefix" aria-hidden="true">
          {RESOLVER_ORIGIN.replace(/^https?:\/\//, '')}/
        </span>
        <input
          className="search__input"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="setup_myapp.sh"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Search for a name"
        />
      </div>

      {raw && name !== raw.trim() ? (
        <p className="muted small">
          normalized to <code>{name}</code> — names are always lowercase
        </p>
      ) : null}

      <div className="search__result" data-testid="search-result">
        {renderResult()}
      </div>
    </div>
  );

  function renderResult(): JSX.Element | null {
    if (!debouncedName) return null;

    if (validation && !validation.ok) {
      return <p className="msg msg--err">{validation.reason}</p>;
    }

    if (!deployed) {
      return (
        <p className="msg msg--warn">
          the registry is not deployed yet (M1) — search stays offline until the contract exists.
        </p>
      );
    }

    if (!settled || loadingAvailable || available === undefined) {
      if (availableError) {
        return <p className="msg msg--err">could not query the chain: {availableError.message}</p>;
      }
      return <p className="msg">querying the chain…</p>;
    }

    if (availableError) {
      return <p className="msg msg--err">could not query the chain: {availableError.message}</p>;
    }

    if (available) {
      if (priceError) {
        // priceOf() reverts for reserved names, which available() already filtered —
        // so anything here is an RPC problem, not a rule the user broke.
        return <p className="msg msg--err">could not read the price: {priceError.message}</p>;
      }
      return (
        <div className="result result--free">
          <div>
            <p className="result__head">
              <span className="ok-dot" aria-hidden="true" />
              <code className="accent">{debouncedName}</code> is available
            </p>
            <p className="muted small">{price !== undefined ? `${formatEth(price)} ETH` : 'reading price…'}</p>
          </div>
          <button
            type="button"
            className="btn btn--primary"
            disabled={price === undefined}
            onClick={() => setBuying(true)}
          >
            buy
          </button>
        </div>
      );
    }

    if (!record) {
      return (
        <div className="result result--taken">
          <p className="result__head">
            <code>{debouncedName}</code> is taken
          </p>
          <p className="msg">loading the record…</p>
        </div>
      );
    }

    const [cid, contentType, owner] = record;
    return (
      <div className="result result--taken">
        <p className="result__head">
          <code>{debouncedName}</code> is taken
        </p>
        <dl className="kv">
          <dt>owner</dt>
          <dd>
            <a
              href={`https://basescan.org/address/${owner}`}
              target="_blank"
              rel="noreferrer noopener"
              className="link"
            >
              {owner}
            </a>
          </dd>
          <dt>cid</dt>
          <dd>
            <a
              href={`https://ipfs.io/ipfs/${cid}`}
              target="_blank"
              rel="noreferrer noopener"
              className="link"
            >
              {truncateCid(cid)}
            </a>
          </dd>
        </dl>
        <CopyCommand command={downloadCommand(debouncedName, contentType)} />
      </div>
    );
  }
}
