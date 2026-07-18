/**
 * Name validation. This MUST stay in lockstep with WgetClubRegistry._validate().
 * The contract is the source of truth; this copy exists so the UI can reject bad
 * names without a round-trip, and so the resolver can 400 without touching KV.
 *
 * contracts/test/NameParity.t.sol fuzzes the Solidity side against the vectors in
 * ./name.vectors.ts — if you change a rule here, change it there, or CI fails.
 */

export const MIN_LENGTH = 2;
export const MAX_LENGTH = 64;

/**
 * Reserved at mint time. MUST match WgetClubRegistry._reserveDefaults() exactly —
 * the contract is the source of truth and this copy only exists so the UI can grey
 * out the Buy button without an eth_call.
 *
 * The contract can only ever REMOVE from this list (unreserve, no reserve), so a
 * name missing here at deploy time is buyable forever. `abuse` was missing while
 * every preview page linked to /abuse — see the contract's comment.
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  // system routes / web conventions
  'api', 'admin', 'www', 'app', 'assets', 'static', 'cdn', 'ipfs', 'ipns',
  'health', 'status', '_health', 'favicon.ico', 'robots.txt', 'sitemap.xml',
  '.well-known', 'index.html', 'wget', 'club',
  // institutional pages the product links to, or will link to
  'abuse', 'terms', 'tos', 'privacy', 'legal', 'dmca', 'security',
  'docs', 'blog', 'support', 'help', 'about', 'contact', 'pricing',
  // app routes
  'dashboard', 'login', 'account', 'settings',
]);

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

const isAlnum = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');

const isSeparator = (c: string): boolean => c === '-' || c === '.' || c === '_';

/**
 * Lowercase + trim. We normalize rather than reject on case because users type
 * "MeuScript" naturally — but the canonical name is always lowercase, so that
 * `Setup.sh` and `setup.sh` can never be two different owners' NFTs.
 */
export function normalizeName(input: string): string {
  return input.trim().toLowerCase();
}

export function validateName(name: string): ValidationResult {
  if (name.length < MIN_LENGTH) {
    return { ok: false, reason: `name too short (minimum ${MIN_LENGTH} characters)` };
  }
  if (name.length > MAX_LENGTH) {
    return { ok: false, reason: `name too long (maximum ${MAX_LENGTH} characters)` };
  }

  for (let i = 0; i < name.length; i++) {
    const c = name[i]!;
    if (!isAlnum(c) && !isSeparator(c)) {
      // Explicitly name the char: "invalid" alone sends users hunting.
      return { ok: false, reason: `invalid character "${c}" — use only a-z, 0-9, hyphen, dot and underscore` };
    }
  }

  const first = name[0]!;
  const last = name[name.length - 1]!;
  if (!isAlnum(first)) {
    return { ok: false, reason: 'name must start with a letter or a number' };
  }
  if (!isAlnum(last)) {
    return { ok: false, reason: 'name must end with a letter or a number' };
  }

  for (let i = 1; i < name.length; i++) {
    if (isSeparator(name[i]!) && isSeparator(name[i - 1]!)) {
      return { ok: false, reason: 'cannot have two separators in a row' };
    }
  }

  if (RESERVED_NAMES.has(name)) {
    return { ok: false, reason: 'name reserved by the system' };
  }

  return { ok: true };
}

/** Prices in wei, by name length. Mirrors the contract's default price table. */
export const PRICE_TABLE_WEI: ReadonlyArray<readonly [maxLength: number, wei: bigint]> = [
  [2, 50_000_000_000_000_000n],  // 0.05  ETH
  [3, 20_000_000_000_000_000n],  // 0.02  ETH
  [4, 5_000_000_000_000_000n],   // 0.005 ETH
  [9, 1_000_000_000_000_000n],   // 0.001 ETH
  [MAX_LENGTH, 500_000_000_000_000n], // 0.0005 ETH
];

export const UPDATE_FEE_WEI = 100_000_000_000_000n; // 0.0001 ETH

/**
 * Client-side price estimate. The contract's priceOf() is authoritative — the owner
 * can retune the table on-chain, so never submit a tx with this value; read priceOf().
 */
export function priceForLength(length: number): bigint {
  for (const [maxLength, wei] of PRICE_TABLE_WEI) {
    if (length <= maxLength) return wei;
  }
  return PRICE_TABLE_WEI[PRICE_TABLE_WEI.length - 1]![1];
}

export function formatEth(wei: bigint): string {
  const s = (Number(wei) / 1e18).toFixed(6);
  return s.replace(/\.?0+$/, '');
}
