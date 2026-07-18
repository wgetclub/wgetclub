/**
 * The indexer — `scheduled` handler, 1 minute cron (SPEC §6).
 *
 * It is a BACKSTOP, not the critical path: POST /api/refresh/:name updates KV the
 * moment a tx confirms, and the resolver falls back to the chain on a KV miss.
 * If this stops for a day the system is still correct, just slower on first hit.
 * That framing is what licenses everything below to fail soft.
 */

import { decodeEventLog, encodeEventTopics } from 'viem';
import { isValidCid, type NameRecord } from '@wgetclub/shared';
import { REGISTRY_ABI, ZERO_ADDRESS, blockTimestamp, latestBlock, nameOfToken, rpc } from './chain';
import type { Env } from './index';

/**
 * Blocks per tick. eth_getLogs is capped by every provider (Alchemy: 10 blocks
 * for an unbounded query, ~2k with an address filter) and a wide range on a cold
 * cursor would be rejected outright, wedging the indexer forever at the same
 * block. Anything left over is picked up next tick — at 2s/block on Base, 2000
 * blocks is ~66 minutes of chain per minute of wall clock, so a backlog always
 * drains.
 */
const MAX_BLOCK_RANGE = 2000n;

/**
 * Base reorgs are shallow but not impossible. Staying a few blocks back means we
 * do not index a log that later un-happens; the cost is a few seconds of extra
 * latency on a path that is already a 1-minute backstop.
 */
const CONFIRMATIONS = 3n;

/**
 * Last cursor this isolate persisted. Survives between ticks on a warm isolate
 * and is the reason we can skip the KV write on an empty tick — see below.
 */
let cursorInIsolate: bigint | null = null;

interface RpcLog {
  address?: string;
  topics?: string[];
  data?: string;
  blockNumber?: string;
  logIndex?: string;
}

/**
 * Per-tick memoisation of the two chain reads this pass repeats.
 *
 * Both are keyed by something that cannot change while the tick runs: a block's
 * timestamp is fixed once mined, and nameOf(tokenId) is write-once in the registry
 * (set in register(), never reassigned — contracts/src/WgetClubRegistry.sol). So
 * caching for the duration of one tick is sound, and caching *only* for that
 * duration keeps a long-lived isolate from pinning names it will never see again.
 *
 * It matters most for Transfer: every one of them needs a tokenId → name lookup,
 * and a marketplace sweep of ten names from one seller lands ten Transfers in one
 * batch. Without this that is ten eth_calls where the block already told us the
 * answer once.
 */
interface TickCache {
  timestamps: Map<string, number>;
  names: Map<string, string | null>;
}

export async function runIndexer(env: Env): Promise<void> {
  const head = await latestBlock(env);
  if (head === null) return; // RPC down. Next tick retries; nothing written, nothing lost.

  const safeHead = head > CONFIRMATIONS ? head - CONFIRMATIONS : 0n;
  const cursor = await readCursor(env);
  const from = cursor + 1n;
  if (from > safeHead) return;

  const to = from + MAX_BLOCK_RANGE - 1n > safeHead ? safeHead : from + MAX_BLOCK_RANGE - 1n;

  const logs = await getLogs(env, from, to);
  if (logs === null) return; // Bad RPC response — do not advance past blocks we never read.

  if (logs.length === 0) {
    // ══ THE most expensive line in this repo, and it is the one NOT here. ══
    // KV free tier = 1000 writes/day. This cron fires 1440x/day. A cursor write
    // on every tick is 1440 writes/day = 144% of the entire daily quota, burned
    // on ticks where nothing happened — before a single sale is indexed.
    // So: no logs, no write. The isolate keeps the cursor in memory and the next
    // tick picks up from there; if the isolate dies, we resume from the last
    // persisted cursor and re-scan some blocks. That re-scan is free and harmless
    // because applyLog is idempotent (it writes the same record for the same log).
    // Trading a little redundant work for 100% of the write quota is the whole
    // deal. See docs/FREE_TIER.md §4.2 and docs/SPEC.md §7. Do not "fix" this.
    cursorInIsolate = to;
    return;
  }

  /**
   * Order is correctness, not tidiness. These events overwrite each other's fields:
   * a Transfer sets `n:<name>.owner` while a CidUpdated in the same batch rewrites
   * the record around the owner it read. Applied out of order, the older log wins
   * and KV keeps a value the chain already retired — a name that shows the previous
   * owner, or the previous CID, until something else happens to that name.
   *
   * (blockNumber, logIndex) is the chain's own total order. eth_getLogs is specified
   * to return it and every provider does, but this pass is the only thing standing
   * between a provider's ordering bug and a wrong owner in the dashboard, and a sort
   * of an already-sorted array costs nothing.
   */
  const ordered = [...logs].sort((a, b) => {
    const block = order(a.blockNumber) - order(b.blockNumber);
    return block !== 0 ? block : order(a.logIndex) - order(b.logIndex);
  });

  const cache: TickCache = { timestamps: new Map(), names: new Map() };
  for (const log of ordered) {
    try {
      await applyLog(env, log, cache);
    } catch {
      // One malformed log must not stall the cursor forever. The record it would
      // have written is recoverable: the resolver reads the chain on a KV miss,
      // and /api/refresh rebuilds it on demand.
    }
  }

  await writeCursor(env, to);
}

/**
 * Hex quantity → sortable number. A missing or malformed field sorts first rather
 * than throwing: a log we cannot place is still a log we want to apply, and
 * applyLog re-validates everything it reads anyway.
 */
function order(hex: string | undefined): number {
  if (!hex) return 0;
  const n = Number(hex);
  return Number.isFinite(n) ? n : 0;
}

async function readCursor(env: Env): Promise<bigint> {
  if (cursorInIsolate !== null) return cursorInIsolate;

  const stored = await env.NAMES.get('sync:cursor');
  if (stored) {
    try {
      cursorInIsolate = BigInt(stored);
      return cursorInIsolate;
    } catch {
      // Fall through to START_BLOCK rather than trusting a corrupt cursor.
    }
  }

  // Cold start: the registry's deploy block. Scanning Base from 0 would be
  // millions of empty blocks at MAX_BLOCK_RANGE per minute — days of catch-up.
  let start = 0n;
  try {
    start = BigInt(env.START_BLOCK);
  } catch {
    start = 0n;
  }
  cursorInIsolate = start > 0n ? start - 1n : 0n;
  return cursorInIsolate;
}

async function writeCursor(env: Env, block: bigint): Promise<void> {
  cursorInIsolate = block;
  await env.NAMES.put('sync:cursor', block.toString());
}

async function getLogs(env: Env, from: bigint, to: bigint): Promise<RpcLog[] | null> {
  const topics = [
    [
      encodeEventTopics({ abi: REGISTRY_ABI, eventName: 'NameRegistered' })[0],
      encodeEventTopics({ abi: REGISTRY_ABI, eventName: 'CidUpdated' })[0],
      encodeEventTopics({ abi: REGISTRY_ABI, eventName: 'RecordFrozen' })[0],
      // A secondary sale (OpenSea, Blur) emits NOTHING from the registry — the
      // marketplace just calls transferFrom, and the only trace is the ERC-721
      // Transfer. Without this topic the buyer's `o:<address>` never learns it owns
      // the name and the dashboard denies the purchase (SPEC §6, ROADMAP G2).
      encodeEventTopics({ abi: REGISTRY_ABI, eventName: 'Transfer' })[0],
    ],
  ];

  const result = await rpc(env, 'eth_getLogs', [
    {
      address: env.CONTRACT_ADDRESS,
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${to.toString(16)}`,
      topics,
    },
  ]);

  if (!Array.isArray(result)) return null;
  return result as RpcLog[];
}

async function tsFor(env: Env, log: RpcLog, cache: TickCache): Promise<number> {
  const bn = log.blockNumber;
  if (!bn) return Math.floor(Date.now() / 1000);
  const cached = cache.timestamps.get(bn);
  if (cached !== undefined) return cached;

  // Several logs usually share a block; cache so a busy block is one RPC call.
  const ts = await blockTimestamp(env, BigInt(bn));
  const value = ts ?? Math.floor(Date.now() / 1000);
  cache.timestamps.set(bn, value);
  return value;
}

async function applyLog(env: Env, log: RpcLog, cache: TickCache): Promise<void> {
  if (!log.topics || !log.data) return;

  // The RPC filtered by address already, but a provider is just a server that
  // said so. The address is what makes these logs authoritative — check it.
  if ((log.address ?? '').toLowerCase() !== env.CONTRACT_ADDRESS.toLowerCase()) return;

  const decoded = decodeEventLog({
    abi: REGISTRY_ABI,
    data: log.data as `0x${string}`,
    topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
  });

  const at = await tsFor(env, log, cache);

  switch (decoded.eventName) {
    case 'NameRegistered': {
      const { tokenId, name, owner, cid } = decoded.args;
      // register() emits NameRegistered *and* CidUpdated in the same tx, and the
      // CidUpdated carries the contentType this one lacks. Both are in this batch
      // and CidUpdated is second, so it fills in `ct` a moment later. Write the
      // owner and name now so nothing depends on that ordering holding.
      await putRecord(env, name, {
        cid,
        ct: '',
        owner: owner.toLowerCase(),
        frozen: false,
        updatedAt: at,
        tokenId: `0x${tokenId.toString(16)}`,
      });
      await appendHistory(env, name, cid);
      await indexOwner(env, owner.toLowerCase(), name);
      return;
    }

    case 'CidUpdated': {
      const { tokenId, cid, contentType } = decoded.args;
      const name = await nameForToken(env, tokenId, cache);
      if (!name) return;

      const prev = await env.NAMES.get<NameRecord>(`n:${name}`, 'json');
      await putRecord(env, name, {
        cid,
        ct: contentType,
        owner: prev?.owner ?? '',
        frozen: prev?.frozen ?? false,
        updatedAt: at,
        tokenId: `0x${tokenId.toString(16)}`,
      });
      await appendHistory(env, name, cid);
      return;
    }

    case 'RecordFrozen': {
      const { tokenId } = decoded.args;
      const name = await nameForToken(env, tokenId, cache);
      if (!name) return;

      const prev = await env.NAMES.get<NameRecord>(`n:${name}`, 'json');
      if (!prev) return; // Nothing to freeze locally; a chain read will fill it in.
      if (prev.frozen) return; // Idempotent: a re-scan must not burn a write.
      await putRecord(env, name, { ...prev, frozen: true });
      return;
    }

    /**
     * The secondary-sale case, and the reason G2 existed. A marketplace fill calls
     * transferFrom and nothing else: no NameRegistered, no CidUpdated, no hint from
     * the registry that a name changed hands. This branch is the ONLY thing that
     * ever tells `o:<buyer>` the name is theirs — the registry is not
     * ERC721Enumerable, so the index cannot be rebuilt from the chain on demand
     * (SPEC §6).
     *
     * WRITE BUDGET: 3 KV writes worst case (`n:`, `o:<from>`, `o:<to>`) against
     * 1000/day (docs/FREE_TIER.md). Every write below is guarded by a read that
     * proves something actually changed, so the steady state — re-scanning blocks
     * after an isolate restart — costs 0 writes and only reads, which have 100x the
     * quota. This is the same bargain as the cursor in runIndexer().
     */
    case 'Transfer': {
      const { from, to, id } = decoded.args;
      const fromAddr = from.toLowerCase();
      const toAddr = to.toLowerCase();

      /**
       * Mints. register() emits NameRegistered *and* Transfer(0x0 → owner) in one
       * tx, so both are in this batch and NameRegistered has already written `n:`,
       * `h:` and `o:<owner>` a few logs ago. Handling this one too would re-write
       * the same record and re-scan the same owner list for nothing: up to 2 extra
       * writes on every single registration, out of 1000/day.
       *
       * NameRegistered is also strictly the better source — it carries the name and
       * the cid, which Transfer does not, so this branch would have to spend an
       * eth_call to learn less.
       */
      if (fromAddr === ZERO_ADDRESS) return;

      /**
       * Burns. Unreachable today: WgetClubRegistry never calls solmate's _burn and
       * exposes no function that reaches it — a name is the user's permanent asset
       * and not even the contract owner can take it back (CLAUDE.md, alma #3;
       * contracts/src/WgetClubRegistry.sol). Guarded anyway because the cost of
       * being wrong is asymmetric: without this line a burn would index the zero
       * address as an owner and leave `n:<name>.owner` pointing at 0x0, which the
       * resolver would then serve as a real owner. If a burn path is ever added,
       * this needs a real branch (drop `n:`/`h:`, not just skip).
       */
      if (toAddr === ZERO_ADDRESS) return;

      const name = await nameForToken(env, id, cache);
      if (!name) return;

      const prev = await env.NAMES.get<NameRecord>(`n:${name}`, 'json');
      if (prev && prev.owner !== toAddr) {
        // Only `owner` moves. A transfer does not touch the record's cid, ct or
        // frozen flag, and `updatedAt` tracks the CID's age (SPEC §7) — bumping it
        // here would tell the dashboard the file changed when it did not.
        await putRecord(env, name, { ...prev, owner: toAddr });
      }
      /**
       * No `n:` record and we do not invent one: this event knows the owner but not
       * the cid or contentType, and a record with an empty cid is worse than no
       * record — the resolver would take the KV hit as truth and serve a 404 for a
       * name that resolves fine on-chain. Missing records self-heal through the
       * resolver's chain fallback and /api/refresh (SPEC §6). The `o:` index below
       * still gets fixed, so nothing is lost by waiting.
       */

      await unindexOwner(env, fromAddr, name);
      await indexOwner(env, toAddr, name);
      return;
    }
  }
}

/** Only the tokenId is on these logs, so the name comes from nameOf() — see TickCache. */
async function nameForToken(env: Env, tokenId: bigint, cache: TickCache): Promise<string | null> {
  const key = tokenId.toString(16);
  const cached = cache.names.get(key);
  if (cached !== undefined) return cached;

  const name = await nameOfToken(tokenId, env);
  cache.names.set(key, name);
  return name;
}

async function putRecord(env: Env, name: string, record: NameRecord): Promise<void> {
  await env.NAMES.put(`n:${name}`, JSON.stringify(record));
}

/**
 * `h:<name>` backs `/:name@<cid>` in the resolver — the pinned-version check that
 * lets someone audit a script once and keep running exactly those bytes (SPEC §4.4).
 * A CID missing from here is a `curl | bash` that stops working, so this list only
 * ever grows.
 */
async function appendHistory(env: Env, name: string, cid: string): Promise<void> {
  if (!isValidCid(cid)) return; // Never let a malformed CID into the pin allowlist.

  const history = (await env.NAMES.get<string[]>(`h:${name}`, 'json')) ?? [];
  if (history.includes(cid)) return; // Re-scan of an already-indexed log: skip the write.
  history.push(cid);
  await env.NAMES.put(`h:${name}`, JSON.stringify(history));
}

/**
 * `o:<address>` → names, for GET /api/names/:address. Not in SPEC §7's table:
 * the registry is not ERC721Enumerable, so there is no way to list an address's
 * names from the chain alone, and SPEC §5 says that route is served "via indexer".
 * Costs one extra write per registration (~30/day at the base scenario).
 *
 * Kept in sync across secondary sales by the Transfer branch above (ROADMAP G2).
 * The read path still re-checks ownerOf() on-chain before returning a name: this
 * index is a candidate set that can lag by up to a cron tick, and the chain is the
 * answer. The re-check is what makes a stale entry harmless; Transfer is what stops
 * a *missing* entry, which no re-check can repair.
 *
 * The read-before-write is the write budget: a re-scanned log finds the name
 * already listed and returns without touching KV.
 */
export async function indexOwner(env: Env, owner: string, name: string): Promise<void> {
  const owned = (await env.NAMES.get<string[]>(`o:${owner}`, 'json')) ?? [];
  if (owned.includes(name)) return;
  owned.push(name);
  await env.NAMES.put(`o:${owner}`, JSON.stringify(owned));
}

/**
 * The inverse: drop a name from a seller's `o:<address>` after it transfers away.
 *
 * Returns without writing unless the name was really there — and it usually is not.
 * The seller may have bought on a marketplace and never been indexed, the list may
 * already be correct from an earlier pass, or this may be a re-scan of a Transfer
 * we handled before the isolate died. Each of those is a KV write saved out of
 * 1000/day (docs/FREE_TIER.md), and a blind put would spend one on every one of
 * them for a value identical to what is already stored — the free tier charges for
 * the write, not for the change (§1.1).
 *
 * An emptied list is stored as `[]` rather than deleted: a delete is its own 1000/day
 * quota, and `[]` reads back exactly like a missing key everywhere it is consumed.
 */
export async function unindexOwner(env: Env, owner: string, name: string): Promise<void> {
  const owned = await env.NAMES.get<string[]>(`o:${owner}`, 'json');
  if (!owned) return;

  const next = owned.filter((n) => n !== name);
  if (next.length === owned.length) return;
  await env.NAMES.put(`o:${owner}`, JSON.stringify(next));
}
