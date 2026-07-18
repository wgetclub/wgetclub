import { isScriptLike } from '@wgetclub/shared';
import type {
  AdminBlocksResponse,
  AdminReportsResponse,
  BlockedName,
  NameRecord,
  NamesResponse,
  OwnedName,
  UploadResponse,
} from '@wgetclub/shared';

/** Empty in dev: vite proxies /api to wrangler (vite.config.ts). */
const API_BASE = import.meta.env.VITE_API_BASE ?? '';

export const RESOLVER_ORIGIN = import.meta.env.VITE_RESOLVER_ORIGIN ?? 'https://wget.club';

/**
 * Re-exported, NOT redeclared. This file used to define its own OwnedName, and it
 * disagreed with what the api actually sent — see NamesResponse in
 * @wgetclub/shared. Import the contract; never restate it.
 */
export type { OwnedName } from '@wgetclub/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The api worker answers errors as one line of plain text (CLAUDE.md: "user error →
 * plain-text response"), so we surface that line verbatim rather than assuming a
 * JSON error envelope that may not exist.
 */
async function readError(res: Response): Promise<never> {
  let detail = '';
  try {
    detail = (await res.text()).trim();
  } catch {
    // Body already consumed or connection dropped — the status still tells us something.
  }
  throw new ApiError(detail || `error ${res.status}`, res.status);
}

export async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      // The SIWE session is a cookie; without this, upload is anonymous and 401s.
      credentials: 'include',
      ...init,
    });
  } catch {
    // fetch only rejects on network failure; HTTP errors resolve and fall through below.
    throw new ApiError('could not reach the api — check your connection', 0);
  }
  if (!res.ok) await readError(res);
  return (await res.json()) as T;
}

/**
 * Pins `file` on IPFS and returns its CID. Requires a SIWE session and is rate
 * limited per address (SPEC §5.2) — a 429 here is expected, not a bug.
 *
 * The content type comes back from the worker, not from `file.type`: the browser
 * lies about shell scripts, and that string is written into the NFT permanently.
 */
export async function uploadFile(file: File, signal?: AbortSignal): Promise<UploadResponse> {
  const body = new FormData();
  body.append('file', file, file.name);
  return getJson<UploadResponse>('/api/upload', { method: 'POST', body, signal });
}

/**
 * Pushes the freshly-confirmed tx into KV now instead of waiting up to a minute for
 * the indexer cron (SPEC §6). Call it after the receipt, before showing the command.
 */
export async function refreshName(name: string): Promise<NameRecord> {
  return getJson<NameRecord>(`/api/refresh/${encodeURIComponent(name)}`, { method: 'POST' });
}

export async function getNames(address: string): Promise<OwnedName[]> {
  const body = await getJson<NamesResponse>(`/api/names/${address}`);
  return body.names;
}

/**
 * The command a name's owner hands out. This string is the product.
 *
 * Script-like content gets the pipe form; anything binary gets `wget`, which is what
 * the resolver's Content-Disposition split (SPEC §4.2) makes work in each case.
 */
export function downloadCommand(name: string, contentType: string): string {
  const url = `${RESOLVER_ORIGIN}/${name}`;
  return isScriptLike(contentType) ? `curl -sSL ${url} | bash` : `wget ${url}`;
}

export interface AbuseReport {
  name: string;
  reason: string;
  contact: string;
}

/**
 * Reports a name. Unauthenticated on purpose (see AbusePage): requiring SIWE to
 * report malware would turn away exactly the people who most need to report, and
 * whoever is appealing a block may no longer have the wallet.
 *
 * This route's rate limit lives on the worker side; there is nothing to protect here.
 */
export async function reportAbuse(report: AbuseReport): Promise<{ id: string }> {
  return getJson<{ id: string }>('/api/abuse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
  });
}

// ---------------------------------------------------------------------------
// Admin — all behind a SIWE session whose address is in ADMIN_ADDRESSES. The
// server answers 404 (not 403) to a non-admin, so the console cannot tell whether
// a wallet is unauthorized or the route is gone; it just reports "not an admin".
// ---------------------------------------------------------------------------

export async function getAdminReports(): Promise<AdminReportsResponse> {
  return getJson<AdminReportsResponse>('/api/admin/reports');
}

export async function getAdminBlocks(): Promise<BlockedName[]> {
  const body = await getJson<AdminBlocksResponse>('/api/admin/blocks');
  return body.blocked;
}

export async function blockName(name: string, reason: string): Promise<void> {
  await getJson('/api/admin/block', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, reason }),
  });
}

export async function unblockName(name: string): Promise<void> {
  await getJson('/api/admin/unblock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}
