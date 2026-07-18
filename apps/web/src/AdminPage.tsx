import { useCallback, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import type { AdminReport, BlockedName } from '@wgetclub/shared';
import {
  ApiError,
  blockName,
  getAdminBlocks,
  getAdminReports,
  unblockName,
} from './lib/api';
import { useSession } from './useSession';

/**
 * Admin console — /admin.
 *
 * The one place a takedown happens by clicking instead of by hand-crafting a curl
 * with a session cookie. Everything here is gated server-side: /api/admin/* requires
 * a SIWE session whose address is in ADMIN_ADDRESSES, and answers 404 to anyone else.
 * This page holds no secret and grants no power — it is a form over those endpoints,
 * so shipping it to every visitor is safe. A non-admin who opens it just sees "not
 * an admin".
 *
 * Its own build entry (admin.html), not an SPA route — same reason as /abuse: with
 * the resolver's [assets] binding, only built files are served; anything else falls
 * through and is treated as a name. `admin` is a reserved name so nothing can buy it.
 *
 * What a block does and does not do is stated on the page on purpose: an admin
 * reaching for it under pressure should be reminded, every time, that it stops
 * wget.club serving the bytes and touches nothing on-chain.
 */

function fmtDate(unixSeconds: number): string {
  if (!unixSeconds) return '—';
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 16);
}

type Data = { reports: AdminReport[]; truncated: boolean; blocked: BlockedName[] };

export function AdminPage(): JSX.Element {
  const { isConnected } = useAccount();
  const { ensureSession } = useSession();

  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'denied' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [data, setData] = useState<Data>({ reports: [], truncated: false, blocked: [] });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [reports, blocked] = await Promise.all([getAdminReports(), getAdminBlocks()]);
    setData({ reports: reports.reports, truncated: reports.truncated, blocked });
  }, []);

  const authenticateAndLoad = useCallback(async () => {
    setStatus('loading');
    setMessage('');
    try {
      await ensureSession();
      await load();
      setStatus('ready');
    } catch (err) {
      // 404 is what a non-admin gets (the server hides the route from them); 401 is
      // an expired/absent session. Everything else is a real failure.
      if (err instanceof ApiError && (err.status === 404 || err.status === 401)) {
        setStatus('denied');
      } else {
        setStatus('error');
        setMessage(err instanceof Error ? err.message : 'failed');
      }
    }
  }, [ensureSession, load]);

  const doBlock = useCallback(
    async (name: string, reason: string) => {
      const trimmed = reason.trim();
      if (!trimmed) return;
      setBusy(`block:${name}`);
      setMessage('');
      try {
        await blockName(name, trimmed);
        await load();
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'block failed');
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const doUnblock = useCallback(
    async (name: string) => {
      setBusy(`unblock:${name}`);
      setMessage('');
      try {
        await unblockName(name);
        await load();
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'unblock failed');
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  return (
    <main className="main">
      <section className="panel">
        <div className="panel__head">
          <h1 className="panel__title">admin</h1>
          <ConnectButton showBalance={false} chainStatus="none" accountStatus="address" />
        </div>

        <p className="muted small">
          A block stops wget.club serving a name's bytes (HTTP 451). It touches nothing on-chain:
          the NFT stays its owner's, and the content stays reachable on any other IPFS gateway.
        </p>

        {status === 'idle' || status === 'loading' ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void authenticateAndLoad()}
            disabled={!isConnected || status === 'loading'}
          >
            {status === 'loading' ? 'authenticating…' : 'authenticate'}
          </button>
        ) : null}
        {!isConnected && status !== 'ready' ? (
          <p className="msg msg--warn">connect an admin wallet to continue</p>
        ) : null}

        {status === 'denied' ? (
          <p className="msg msg--err">this wallet is not an admin.</p>
        ) : null}
        {status === 'error' ? <p className="msg msg--err">{message}</p> : null}
      </section>

      {status === 'ready' ? (
        <>
          {message ? (
            <section className="panel">
              <p className="msg msg--err">{message}</p>
            </section>
          ) : null}

          <BlockForm onBlock={doBlock} />

          <section className="panel">
            <h2 className="panel__title">abuse queue ({data.reports.length})</h2>
            {data.truncated ? (
              <p className="muted small">showing the {data.reports.length} most recent — older reports exist.</p>
            ) : null}
            {data.reports.length === 0 ? (
              <p className="muted small">the queue is empty.</p>
            ) : (
              <ul className="admin-list">
                {data.reports.map((r) => (
                  <li key={r.id} className="admin-item">
                    <div className="admin-item__head">
                      <code className="accent">{r.name}</code>
                      <span className="muted small">
                        {fmtDate(r.at)} {r.country ? `· ${r.country}` : ''}
                      </span>
                    </div>
                    <p className="admin-item__reason">{r.reason}</p>
                    {r.contact ? (
                      <p className="muted small">contact: {r.contact}</p>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void doBlock(r.name, `abuse report ${r.id}`)}
                      disabled={busy === `block:${r.name}`}
                    >
                      {busy === `block:${r.name}` ? 'blocking…' : `block ${r.name}`}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <h2 className="panel__title">blocked names ({data.blocked.length})</h2>
            {data.blocked.length === 0 ? (
              <p className="muted small">nothing is blocked.</p>
            ) : (
              <ul className="admin-list">
                {data.blocked.map((b) => (
                  <li key={b.name} className="admin-item">
                    <div className="admin-item__head">
                      <code className="accent">{b.name}</code>
                      <span className="muted small">{fmtDate(b.at)}</span>
                    </div>
                    <p className="admin-item__reason">{b.reason}</p>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void doUnblock(b.name)}
                      disabled={busy === `unblock:${b.name}`}
                    >
                      {busy === `unblock:${b.name}` ? 'unblocking…' : 'unblock'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}

function BlockForm({
  onBlock,
}: {
  onBlock: (name: string, reason: string) => Promise<void>;
}): JSX.Element {
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const canSubmit = name.trim().length > 0 && reason.trim().length > 0 && !submitting;

  return (
    <section className="panel">
      <h2 className="panel__title">block a name</h2>
      <label className="field">
        <span className="field__label">name</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="setup_myapp.sh"
          aria-label="Name to block"
        />
      </label>
      <label className="field">
        <span className="field__label">reason</span>
        <input
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="why (kept on record)"
          aria-label="Block reason"
        />
      </label>
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => {
          setSubmitting(true);
          void onBlock(name.trim(), reason)
            .then(() => {
              setName('');
              setReason('');
            })
            .finally(() => setSubmitting(false));
        }}
        disabled={!canSubmit}
      >
        {submitting ? 'blocking…' : 'block'}
      </button>
    </section>
  );
}
