import { useCallback, useEffect, useState } from 'react';
import {
  useAccount,
  useChainId,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { BaseError } from 'viem';
import { formatEth, truncateCid } from '@wgetclub/shared';
import type { UploadResponse } from '@wgetclub/shared';
import { REGISTRY_ABI, isRegistryDeployed, registryAddressFor, tokenIdOf } from '../contract';
import { downloadCommand, refreshName, uploadFile } from '../lib/api';
import { useSession } from '../useSession';
import { CopyCommand } from './CopyCommand';
import { FileDrop } from './FileDrop';

interface Props {
  name: string;
  onBack: () => void;
}

function errorText(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

export function ManageName({ name, onBack }: Props): JSX.Element {
  const chainId = useChainId();
  const { address } = useAccount();
  const registry = registryAddressFor(chainId);
  const deployed = isRegistryDeployed(registry);
  const tokenId = tokenIdOf(name);

  const [upload, setUpload] = useState<UploadResponse | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [confirmFreeze, setConfirmFreeze] = useState(false);

  const {
    data: record,
    error: recordError,
    isPending: loadingRecord,
    refetch: refetchRecord,
  } = useReadContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'resolve',
    args: [name],
    query: { enabled: deployed },
  });

  // updateFee is owner-tunable on-chain, so read it rather than using UPDATE_FEE_WEI.
  const { data: updateFee } = useReadContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: 'updateFee',
    query: { enabled: deployed },
  });

  const { writeContract, data: txHash, isPending: signing, error: writeError, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess: confirmed, error: receiptError } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  useEffect(() => {
    if (!confirmed) return;
    // Best-effort: the indexer cron is the backstop if this fails (SPEC §6).
    void refreshName(name).catch(() => undefined);
    void refetchRecord();
    setUpload(null);
    setConfirmFreeze(false);
  }, [confirmed, name, refetchRecord]);

  const { ensureSession } = useSession();

  const handleFile = useCallback(
    async (file: File) => {
      setUploading(true);
      setUploadError(null);
      try {
        // Same as BuyFlow: /api/upload needs a SIWE session, established lazily
        // at the one call that requires it.
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

  const submitCid = useCallback(() => {
    if (!upload || updateFee === undefined) return;
    reset();
    writeContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: 'setCid',
      args: [tokenId, upload.cid, upload.contentType],
      value: updateFee,
    });
  }, [upload, updateFee, registry, tokenId, reset, writeContract]);

  const submitFreeze = useCallback(() => {
    reset();
    writeContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: 'freeze',
      args: [tokenId],
    });
  }, [registry, tokenId, reset, writeContract]);

  if (!deployed) {
    return (
      <section className="panel">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onBack}>
          ← back
        </button>
        <p className="msg msg--warn">the registry is not deployed yet (M1).</p>
      </section>
    );
  }

  if (loadingRecord) {
    return (
      <section className="panel">
        <p className="msg">reading {name} from the chain…</p>
      </section>
    );
  }

  if (recordError || !record) {
    return (
      <section className="panel">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onBack}>
          ← back
        </button>
        <p className="msg msg--err">
          could not read {name}: {recordError ? recordError.message : 'empty record'}
        </p>
      </section>
    );
  }

  const [cid, contentType, owner, frozen] = record;
  const isOwner = address !== undefined && address.toLowerCase() === owner.toLowerCase();
  const txError = writeError ?? receiptError;
  const busy = signing || confirming;

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">
          <span className="accent">{name}</span>
          {frozen ? <span className="badge badge--frozen">frozen</span> : null}
        </h2>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onBack}>
          ← back
        </button>
      </div>

      <dl className="kv">
        <dt>cid</dt>
        <dd>
          <a
            className="link"
            href={`https://ipfs.io/ipfs/${cid}`}
            target="_blank"
            rel="noreferrer noopener"
            title={cid}
          >
            {truncateCid(cid)}
          </a>
        </dd>
        <dt>type</dt>
        <dd>
          <code>{contentType}</code>
        </dd>
        <dt>owner</dt>
        <dd>
          <code>{owner}</code>
        </dd>
      </dl>

      <CopyCommand label="command" command={downloadCommand(name, contentType)} />

      {!isOwner ? (
        <p className="msg msg--warn">
          you are not the owner of this name — connect wallet {truncateCid(owner, 6, 4)} to manage it.
        </p>
      ) : frozen ? (
        <p className="msg">
          this record is frozen. the CID does not change anymore — that is what makes{' '}
          <code>| bash</code> auditable.
        </p>
      ) : (
        <>
          <div className="section">
            <h3 className="section__title">replace file</h3>
            {upload ? (
              <>
                <dl className="kv">
                  <dt>new cid</dt>
                  <dd>
                    <code>{upload.cid}</code>
                  </dd>
                  <dt>type</dt>
                  <dd>
                    <code>{upload.contentType}</code>
                  </dd>
                  <dt>fee</dt>
                  <dd>{updateFee !== undefined ? `${formatEth(updateFee)} ETH` : 'reading…'}</dd>
                </dl>
                <div className="row">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={submitCid}
                    disabled={busy || updateFee === undefined}
                  >
                    {signing ? 'confirm in your wallet…' : confirming ? 'mining…' : 'update cid'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setUpload(null)}
                    disabled={busy}
                  >
                    discard
                  </button>
                </div>
              </>
            ) : (
              <>
                <FileDrop onFile={(f) => void handleFile(f)} disabled={uploading || busy} />
                {uploading ? <p className="msg">pinning to IPFS…</p> : null}
                {uploadError ? <p className="msg msg--err">{uploadError}</p> : null}
              </>
            )}
          </div>

          <div className="section section--danger">
            <h3 className="section__title">freeze</h3>
            <p className="muted small">
              freezing makes the record immutable <strong>forever</strong>. it is the trust signal
              for whoever runs <code>curl | bash</code>: it proves the script does not change after
              it has been audited.
            </p>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => setConfirmFreeze(true)}
              disabled={busy}
            >
              freeze {name}
            </button>
          </div>
        </>
      )}

      {txError ? <p className="msg msg--err">{errorText(txError)}</p> : null}

      {confirmFreeze ? (
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="freeze-title">
          <div className="modal__box">
            <h3 id="freeze-title" className="modal__title">
              freeze {name}?
            </h3>
            <p className="modal__body">
              this is <strong className="danger">IRREVERSIBLE</strong>. the CID of {name} can never
              be changed again — not by you, not by anyone. there is no unfreeze.
            </p>
            <p className="muted small">
              you remain the owner of the NFT and can transfer or sell it. only the content locks.
            </p>
            <div className="row">
              <button type="button" className="btn btn--danger" onClick={submitFreeze} disabled={busy}>
                {signing ? 'confirm in your wallet…' : confirming ? 'mining…' : 'yes, freeze forever'}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setConfirmFreeze(false)}
                disabled={busy}
              >
                cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
