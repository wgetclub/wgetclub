import { useCallback, useRef } from 'react';
import { useAccount, useChainId, useSignMessage } from 'wagmi';
import { buildSiweMessage, fetchNonce, postSession } from './lib/siwe';

/**
 * Lazily establishes the SIWE session that /api/upload requires.
 *
 * Lazy on purpose: the signature prompt only appears when the user is about to
 * upload, not when they connect. Someone who lands on the page to check whether a
 * name is free should never be asked to sign anything — availability is a plain
 * eth_call and needs no identity.
 *
 * The session is a 15-minute HttpOnly cookie the server sets (apps/api/src/siwe.ts),
 * so there is nothing to store here. `inFlight` only coalesces concurrent callers
 * so a double-click cannot open two wallet prompts.
 */
export function useSession(): { ensureSession: () => Promise<void> } {
  const { address } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();
  const inFlight = useRef<Promise<void> | null>(null);

  const ensureSession = useCallback(async (): Promise<void> => {
    if (!address) throw new Error('connect your wallet first');
    if (inFlight.current) return inFlight.current;

    const run = (async () => {
      const nonce = await fetchNonce();
      const message = buildSiweMessage({
        domain: window.location.host,
        address,
        uri: window.location.origin,
        chainId,
        nonce,
        issuedAt: new Date().toISOString(),
      });
      const signature = await signMessageAsync({ message });
      await postSession(message, signature);
    })();

    inFlight.current = run;
    try {
      await run;
    } finally {
      inFlight.current = null;
    }
  }, [address, chainId, signMessageAsync]);

  return { ensureSession };
}
