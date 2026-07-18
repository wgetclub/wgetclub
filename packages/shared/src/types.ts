/** The shape stored in KV under `n:<name>`. Keys are short — KV values count against storage. */
export interface NameRecord {
  /** IPFS CID the name points at. */
  cid: string;
  /** Content-Type, e.g. "text/plain; charset=utf-8". */
  ct: string;
  /** Owner address, lowercase hex. */
  owner: string;
  /** Frozen records are immutable forever — the resolver caches them aggressively. */
  frozen: boolean;
  /** Unix seconds of the last CidUpdated. */
  updatedAt: number;
  /** uint256(keccak256(name)) as a hex string. */
  tokenId: string;
}

/** `blocked:<name>` — abuse takedown. The NFT still exists; we just stop serving bytes. */
export interface BlockRecord {
  reason: string;
  at: number;
}

/**
 * One entry in the abuse queue, as the admin console reads it back. Mirrors the
 * object handleAbuse() writes (apps/api/src/index.ts) plus the id parsed from the
 * storage key. Same shape whether the queue lives in R2 or KV.
 */
export interface AdminReport {
  id: string;
  name: string;
  reason: string;
  contact: string;
  /** Unix seconds the report was filed. */
  at: number;
  /** Best-effort country from cf-ipcountry; triage only, may be empty. */
  country: string;
}

export interface AdminReportsResponse {
  reports: AdminReport[];
  /** True when the queue held more than the read cap — older entries were not returned. */
  truncated: boolean;
}

/** A currently-blocked name, for the admin console's block list. */
export interface BlockedName {
  name: string;
  reason: string;
  at: number;
}

export interface AdminBlocksResponse {
  blocked: BlockedName[];
}

/**
 * Upload ceiling. BOTH sides import it from here — the api to reject, the frontend
 * to warn before pushing 1MB over the wire for nothing.
 *
 * It used to be duplicated: `MAX_UPLOAD_BYTES` in apps/api/src/pin.ts and
 * `MAX_BYTES` in apps/web/src/components/FileDrop.tsx, both with 25MB hand-typed.
 * When the product limit became 1MB, only the server changed: the frontend kept
 * accepting 20MB files and sending them to a 413. Same defect as NamesResponse — a
 * contract restated on both sides diverges the first day someone touches it.
 *
 * 1MB is a product decision and it pays two bills: the byte cache fits in KV
 * (25MB-per-value ceiling) without needing R2, which requires a card on file; and
 * the resolver can buffer 1MB to write to the cache, nowhere near the isolate's
 * 128MB. Raising this number means revisiting apps/resolver/src/blobs.ts.
 */
export const MAX_UPLOAD_BYTES = 1024 * 1024;

export interface UploadResponse {
  cid: string;
  contentType: string;
  size: number;
}

/**
 * A record plus the name it belongs to. `NameRecord` is keyed by name in KV, so
 * it omits it.
 */
export interface OwnedName extends NameRecord {
  name: string;
}

/**
 * GET /api/names/:address
 *
 * This type lives in shared, and BOTH sides must import it — the api to build the
 * response, the web to read it. It is here because the two drifted once: the api
 * returned `{name, record: {...}}` (nested) while the web modelled
 * `{name, cid, ...}` (flat). Every field the web touched was `undefined`,
 * `truncateCid(undefined)` threw on `.length`, and with no error boundary the
 * whole app white-screened. Neither typecheck nor any unit test could see it —
 * the contract crosses an HTTP boundary, so only E2E caught it.
 */
export interface NamesResponse {
  address: string;
  names: OwnedName[];
}

export interface AvailabilityResponse {
  name: string;
  available: boolean;
  /** Price in wei as a decimal string. Absent when unavailable or invalid. */
  priceWei?: string;
  /** Present when the name is taken. */
  record?: NameRecord;
  /** Present when the name is invalid. */
  reason?: string;
}

export const CHAIN_IDS = {
  BASE_MAINNET: 8453,
  BASE_SEPOLIA: 84532,
  /** Local anvil, E2E only. Never offered by a production build — see apps/web/src/wagmi.ts. */
  ANVIL: 31337,
} as const;
