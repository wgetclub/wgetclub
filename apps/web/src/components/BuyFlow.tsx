import { useCallback, useEffect, useState } from 'react';
import { useAccount, useChainId, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { BaseError } from 'viem';
import { formatEth } from '@wgetclub/shared';
import type { UploadResponse } from '@wgetclub/shared';
import { REGISTRY_ABI, registryAddressFor } from '../contract';
import { downloadCommand, refreshName, uploadFile } from '../lib/api';
import { useSession } from '../useSession';
import { CopyCommand } from './CopyCommand';
import { FileDrop } from './FileDrop';

interface Props {
  name: string;
  /** From priceOf() — never the client-side estimate; the owner can retune on-chain. */
  price: bigint;
  onCancel: () => void;
}

type Step = 1 | 2 | 3;

function errorText(err: unknown): string {
  // viem wraps revert reasons; shortMessage is the one line worth showing.
  if (err instanceof BaseError) return err.shortMessage;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

export function BuyFlow({ name, price, onCancel }: Props): JSX.Element {
  const chainId = useChainId();
  const { isConnected } = useAccount();
  const registry = registryAddressFor(chainId);

  const [upload, setUpload] = useState<UploadResponse | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Consent is captured at the moment of purchase, not buried in a footer link:
  // registering is the point where the user takes on the Terms (a name can resolve
  // to code that executes on whoever runs it). buy() is gated on this below.
  const [agreed, setAgreed] = useState(false);

  const { writeContract, data: txHash, isPending: signing, error: writeError, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess: confirmed, error: receiptError } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const { ensureSession } = useSession();

  const step: Step = confirmed ? 3 : upload ? 2 : 1;

  const handleFile = useCallback(
    async (file: File) => {
      setUploading(true);
      setUploadError(null);
      try {
        // /api/upload is behind a SIWE session. Establish it here, right before the
        // only call that needs it — not on connect, so browsing never prompts a
        // signature. Cheap when a session already exists: the server just re-reads
        // the cookie, and the wallet prompt is the only visible cost.
        await ensureSession();
        setUpload(await uploadFile(file));
      } catch (err) {
        setUploadError(errorText(err));
      } finally {
        setUploading(false);
      }
    },
    [ensureSession],
  );

  useEffect(() => {
    if (!confirmed) return;
    let cancelled = false;
    setRefreshing(true);
    setRefreshError(null);
    refreshName(name)
      .then(() => {
        if (!cancelled) setRefreshing(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRefreshing(false);
        // Non-fatal: the indexer cron picks this up within a minute anyway (SPEC §6).
        setRefreshError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [confirmed, name]);

  const buy = useCallback(() => {
    if (!upload || !agreed) return;
    reset();
    writeContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: 'register',
      args: [name, upload.cid, upload.contentType],
      value: price,
    });
    // `agreed` MUST be in the deps: without it this callback closes over the initial
    // `false`, so after the user ticks consent the button enables (render reads the
    // live value) but the click runs the stale closure and returns early — the tx
    // never fires. e2e/tests/ui.spec.ts "compra completa" caught exactly this.
  }, [upload, agreed, name, price, registry, reset, writeContract]);

  const txError = writeError ?? receiptError;

  if (step === 3 && upload) {
    return (
      <section className="panel panel--ok">
        <h2 className="panel__title">
          <span className="ok-dot" aria-hidden="true" />
          {name} is yours
        </h2>
        {refreshing ? <p className="msg">propagating to the resolver…</p> : null}
        {refreshError ? (
          <p className="msg msg--warn">
            the name is already on the chain, but the resolver cache did not confirm ({refreshError}).
            the indexer fixes this within 1 minute.
          </p>
        ) : null}
        <CopyCommand label="your command" command={downloadCommand(name, upload.contentType)} />
        <p className="muted small">
          cid: <code>{upload.cid}</code>
        </p>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          search another name
        </button>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">
          buy <span className="accent">{name}</span>
        </h2>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
          cancel
        </button>
      </div>

      <ol className="steps">
        <li className={step === 1 ? 'steps__item steps__item--on' : 'steps__item'}>
          <span className="steps__n">1</span> file
        </li>
        <li className={step === 2 ? 'steps__item steps__item--on' : 'steps__item'}>
          <span className="steps__n">2</span> pay {formatEth(price)} ETH
        </li>
        <li className="steps__item">
          <span className="steps__n">3</span> done
        </li>
      </ol>

      {step === 1 ? (
        <>
          <FileDrop onFile={(f) => void handleFile(f)} disabled={uploading} />
          {uploading ? <p className="msg">pinning to IPFS…</p> : null}
          {uploadError ? <p className="msg msg--err">{uploadError}</p> : null}
          <p className="muted small">
            the file goes to IPFS before the purchase — the CID has to exist to go into the NFT.
          </p>
        </>
      ) : null}

      {step === 2 && upload ? (
        <>
          <dl className="kv">
            <dt>cid</dt>
            <dd>
              <code>{upload.cid}</code>
            </dd>
            <dt>type</dt>
            <dd>
              <code>{upload.contentType}</code>
            </dd>
            <dt>price</dt>
            <dd>{formatEth(price)} ETH</dd>
          </dl>

          {txError ? <p className="msg msg--err">{errorText(txError)}</p> : null}

          <label className="consent">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              disabled={signing || confirming}
              data-testid="buy-consent"
            />
            <span className="small muted">
              I agree to the{' '}
              <a className="link" href="/legal/#terms-of-use" target="_blank" rel="noreferrer noopener">
                Terms of Use
              </a>{' '}
              and the{' '}
              <a
                className="link"
                href="/legal/#acceptable-use-policy"
                target="_blank"
                rel="noreferrer noopener"
              >
                Acceptable Use Policy
              </a>
              , and understand a name can resolve to code that executes on whoever runs it.
            </span>
          </label>

          <div className="row">
            <button
              type="button"
              className="btn btn--primary"
              onClick={buy}
              disabled={!isConnected || !agreed || signing || confirming}
            >
              {signing ? 'confirm in your wallet…' : confirming ? 'mining…' : `register ${name}`}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setUpload(null);
                reset();
              }}
              disabled={signing || confirming}
            >
              replace file
            </button>
          </div>
          {!isConnected ? <p className="msg msg--warn">connect your wallet to register</p> : null}
        </>
      ) : null}
    </section>
  );
}
