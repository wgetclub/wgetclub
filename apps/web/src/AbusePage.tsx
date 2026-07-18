import { useCallback, useState } from 'react';
import { normalizeName, validateName } from '@wgetclub/shared';
import { reportAbuse } from './lib/api';

/**
 * Abuse report page — /abuse.
 *
 * It exists because the product linked to it before it existed: preview.ts puts
 * `<a href="/abuse">report abuse</a>` on every page, and the 451 body tells the
 * blocked user to appeal here. Both pointed at a 404.
 *
 * Its own build entry (abuse.html), not an SPA route. With the resolver's [assets]
 * binding, `/abuse` is only served if it matches a file in dist — otherwise it falls
 * through to the Worker, which would treat "abuse" as a name and return 404. A
 * `not_found_handling: single-page-application` would fix that and break the product:
 * `/myscript` would start returning HTML instead of the script.
 *
 * Deliberately wallet-free: reporting malware should not require connecting a wallet,
 * and whoever is appealing a block may no longer have access to the account.
 */

type State =
  | { step: 'form' }
  | { step: 'sending' }
  | { step: 'sent'; id: string }
  | { step: 'error'; message: string };

export function AbusePage(): JSX.Element {
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [contact, setContact] = useState('');
  const [state, setState] = useState<State>({ step: 'form' });

  const normalized = normalizeName(name);
  const validity = normalized.length > 0 ? validateName(normalized) : null;
  const nameError = validity && !validity.ok ? validity.reason : null;
  const canSend = normalized.length > 0 && !nameError && reason.trim().length > 0;

  const submit = useCallback(async () => {
    if (!canSend) return;
    setState({ step: 'sending' });
    try {
      const { id } = await reportAbuse({ name: normalized, reason: reason.trim(), contact: contact.trim() });
      setState({ step: 'sent', id });
    } catch (err) {
      setState({ step: 'error', message: err instanceof Error ? err.message : 'failed' });
    }
  }, [canSend, normalized, reason, contact]);

  if (state.step === 'sent') {
    return (
      <main className="main">
        <section className="panel">
          <h1 className="panel__title">report received</h1>
          <p className="msg">
            Ticket <code>{state.id}</code> — keep this number.
          </p>
          <p className="muted small">
            A human will read it. If the content violates the terms, the name stops being served
            by wget.club (HTTP 451). <strong>The NFT still belongs to its owner</strong> — we
            cannot, and do not want to be able to, take anyone's name away. What we can stop is
            serving the bytes.
          </p>
          <p className="muted small">
            If the content is hosted on other IPFS gateways, it stays accessible there.
            wget.club does not control IPFS.
          </p>
          <a className="link" href="/">
            back
          </a>
        </section>
      </main>
    );
  }

  return (
    <main className="main">
      <section className="panel">
        <h1 className="panel__title">report abuse</h1>
        <p className="muted small">
          Use this to report a name that serves malware, phishing, illegal content, or that
          infringes copyright. Also use it to <strong>appeal</strong> a block you think is
          unfair.
        </p>

        <label className="field">
          <span className="field__label">name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="setup_myapp.sh"
            aria-label="Reported name"
            data-testid="abuse-name"
          />
          {nameError ? <span className="msg msg--err small">{nameError}</span> : null}
        </label>

        <label className="field">
          <span className="field__label">what is wrong</span>
          <textarea
            className="input"
            rows={6}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Describe the problem. If possible, include the CID you saw (the X-Wgetclub-CID header of the response) — the owner can swap the content later."
            aria-label="Problem description"
            data-testid="abuse-reason"
          />
        </label>

        <label className="field">
          <span className="field__label">contact (optional)</span>
          <input
            className="input"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            placeholder="email, if you want a reply"
            aria-label="Contact"
            data-testid="abuse-contact"
          />
        </label>

        {state.step === 'error' ? <p className="msg msg--err">{state.message}</p> : null}

        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void submit()}
          disabled={!canSend || state.step === 'sending'}
          data-testid="abuse-submit"
        >
          {state.step === 'sending' ? 'sending…' : 'send report'}
        </button>

        <p className="muted small" style={{ marginTop: '1.5rem' }}>
          <strong>What wget.club can do:</strong> stop serving a name's bytes.
          <br />
          <strong>What it cannot do:</strong> delete the NFT, take the name from its owner, or
          remove the file from IPFS. See{' '}
          <a className="link" href="https://github.com/wgetclub/wgetclub/blob/main/docs/SECURITY.md">
            docs/SECURITY.md
          </a>
          .
        </p>
      </section>
    </main>
  );
}
