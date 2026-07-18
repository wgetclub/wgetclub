/**
 * Tells you which deploy step you are on, by looking at the REAL state.
 *
 *   node scripts/doctor.mjs                    # checks against Base Sepolia
 *   node scripts/doctor.mjs --network mainnet  # against Base mainnet
 *   node scripts/doctor.mjs --rpc <url>        # explicit RPC
 *
 * This exists because a checklist you cannot verify is a checklist you lie to
 * yourself with. Every item here is a question answered by a real call — to disk,
 * to the RPC, to wrangler — not by a checkbox someone remembered to tick.
 *
 * Exits 0 when everything checkable from here is ready; != 0 otherwise, so it can
 * be used in an `until` loop or in CI.
 *
 * It is honest about what it CANNOT see: Worker and GitHub secrets are unreadable
 * by design, and an explicit "don't know" is worth more than an optimistic green.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const NETWORKS = {
  sepolia: { chainId: 84532, name: 'Base Sepolia', defaultRpc: 'https://sepolia.base.org' },
  mainnet: { chainId: 8453, name: 'Base mainnet', defaultRpc: 'https://mainnet.base.org' },
};

const argNet = argValue('--network') ?? 'sepolia';
const NET = NETWORKS[argNet];
if (!NET) fail(`unknown network: ${argNet} (use sepolia or mainnet)`);
const RPC = argValue('--rpc') ?? NET.defaultRpc;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------

const results = [];
let step = 0;

/** status: 'ok' | 'todo' | 'unknown' */
function check(status, title, detail) {
  results.push({ status, title, detail });
  const icon = status === 'ok' ? '✅' : status === 'todo' ? '❌' : '⚠️ ';
  console.log(`${icon} ${title}`);
  if (detail && status !== 'ok') console.log(`      ${detail.split('\n').join('\n      ')}`);
}

function section(title) {
  step++;
  console.log(`\n─── ${step}. ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT, ...opts });
}

function has(cmd) {
  try {
    sh('sh', ['-c', `command -v ${cmd}`]);
    return true;
  } catch {
    return false;
  }
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

const ZERO = '0x0000000000000000000000000000000000000000';

/** Reads CONTRACT_ADDRESS from a wrangler.toml, from the production [vars] block. */
function addressFromToml(path) {
  const src = readFileSync(join(ROOT, path), 'utf8');
  // First occurrence only: the second one is [env.staging.vars].
  const m = /^CONTRACT_ADDRESS\s*=\s*"(0x[0-9a-fA-F]{40})"/m.exec(src);
  return m?.[1] ?? null;
}

function addressFromWeb(chainId) {
  const src = readFileSync(join(ROOT, 'apps/web/src/contract.ts'), 'utf8');
  const key = chainId === 8453 ? 'BASE_MAINNET' : 'BASE_SEPOLIA';
  const m = new RegExp(`CHAIN_IDS\\.${key}\\]:\\s*'?(0x[0-9a-fA-F]{40})'?`).exec(src);
  if (m) return m[1];
  // Still the symbolic placeholder.
  return new RegExp(`CHAIN_IDS\\.${key}\\]:\\s*ZERO_ADDRESS`).test(src) ? ZERO : null;
}

/** Where the R2 binding lives, if anyone turns it on. */
const TOMLS_R2 = ['apps/resolver/wrangler.toml', 'apps/api/wrangler.toml'];

function kvIds() {
  const out = {};
  for (const f of ['apps/resolver/wrangler.toml', 'apps/api/wrangler.toml']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    const m = /^id\s*=\s*"([^"]+)"/m.exec(src);
    out[f] = m?.[1] ?? null;
  }
  return out;
}

// ---------------------------------------------------------------------------

console.log(`wget.club — where you are\n`);
console.log(`network:  ${NET.name} (chainId ${NET.chainId})`);
console.log(`rpc:      ${RPC}`);

// --- 1 ---------------------------------------------------------------------
section('Tools');

for (const [cmd, hint] of [
  ['node', 'Node 22+'],
  ['pnpm', 'npm i -g pnpm'],
  ['forge', 'https://book.getfoundry.sh/getting-started/installation'],
  ['cast', 'ships with Foundry'],
]) {
  check(has(cmd) ? 'ok' : 'todo', cmd, `install: ${hint}`);
}

check(
  existsSync(join(ROOT, 'node_modules')) ? 'ok' : 'todo',
  'dependencies installed',
  'run: pnpm install',
);

const libOk = existsSync(join(ROOT, 'contracts/lib/forge-std')) && existsSync(join(ROOT, 'contracts/lib/solmate'));
/**
 * The hint depends on where this file is running, and both cases are real. In the
 * internal repo, forge-std and solmate are git submodules. In the published package
 * they are not — a zip cannot carry a gitlink — and setup-deps.sh installs them, at
 * the same revs. Handing out the wrong command makes someone run a no-op and
 * conclude the project is broken.
 */
const hasSubmodules = existsSync(join(ROOT, '.gitmodules'));
check(
  libOk ? 'ok' : 'todo',
  'Solidity libs (forge-std, solmate)',
  hasSubmodules
    ? 'run: git submodule update --init --recursive'
    : 'run: ./scripts/setup-deps.sh',
);

// --- 2 ---------------------------------------------------------------------
section('Contract');

let chainAddr = null;
try {
  const net = await rpc('eth_chainId', []);
  const got = Number(BigInt(net));
  check(
    got === NET.chainId ? 'ok' : 'todo',
    `RPC responds and is ${NET.name}`,
    `the RPC answered chainId ${got}, expected ${NET.chainId} — does --rpc point at the right network?`,
  );
} catch (err) {
  check('todo', 'RPC responds', `${RPC} did not respond: ${err.message}`);
}

const addrs = {
  'apps/resolver/wrangler.toml': addressFromToml('apps/resolver/wrangler.toml'),
  'apps/api/wrangler.toml': addressFromToml('apps/api/wrangler.toml'),
  'apps/web/src/contract.ts': addressFromWeb(NET.chainId),
};
const unique = [...new Set(Object.values(addrs))];
const allSet = unique.length === 1 && unique[0] && unique[0] !== ZERO;

if (unique.length > 1) {
  check(
    'todo',
    'CONTRACT_ADDRESS matches in all 3 places',
    `they diverge — nothing resolves until they are identical:\n` +
      Object.entries(addrs).map(([f, a]) => `${a ?? '(not found)'}  ${f}`).join('\n'),
  );
} else if (!allSet) {
  check(
    'todo',
    'CONTRACT_ADDRESS filled in',
    'still 0x0 in all 3 places. Deploy the contract (RUNBOOK step 2) and paste the address into:\n' +
      Object.keys(addrs).join('\n'),
  );
} else {
  chainAddr = unique[0];
  check('ok', `CONTRACT_ADDRESS matches in all 3 places (${chainAddr})`);
}

if (chainAddr) {
  try {
    const code = await rpc('eth_getCode', [chainAddr, 'latest']);
    check(
      code && code !== '0x' ? 'ok' : 'todo',
      'a contract exists at that address',
      `eth_getCode at ${chainAddr} came back empty — is the address right? is it the right network?`,
    );

    if (code && code !== '0x') {
      // available("abuse") — selector + string ABI-encoded.
      // See contracts/src/WgetClubRegistry.sol _reserveDefaults(): if `abuse` is
      // buyable, the abuse-report channel is for sale and there is NO way to fix it
      // afterwards (unreserve() exists, reserve() does not).
      const out = sh('cast', ['call', chainAddr, 'available(string)(bool)', '--rpc-url', RPC, '--', 'abuse']).trim();
      check(
        out === 'false' ? 'ok' : 'todo',
        '`abuse` is reserved in the deployed contract',
        'available("abuse") = true. This contract was deployed BEFORE the reserved-list fix.\n' +
          'Anyone can buy the abuse-report channel, and that is IRREVERSIBLE.\n' +
          'Do not use this contract: redeploy from the current code.',
      );
    }
  } catch (err) {
    check('unknown', 'contract on chain', `could not check: ${err.message}`);
  }
}

/**
 * START_BLOCK. Silent and fatal: at 0, the indexer scans the chain from genesis
 * — 44M empty blocks on Base — and the cursor resets to zero on every cold cron
 * isolate, so it never catches up to the contract. Nothing errors; the indexer just
 * never indexes, and the dashboard lies forever after a resale.
 */
const startBlock = (() => {
  const src = readFileSync(join(ROOT, 'apps/api/wrangler.toml'), 'utf8');
  const m = /^START_BLOCK\s*=\s*"?(\d+)"?/m.exec(src);
  return m ? Number(m[1]) : null;
})();

if (startBlock === null) {
  check('todo', 'START_BLOCK', 'could not find START_BLOCK in apps/api/wrangler.toml');
} else if (startBlock === 0) {
  check(
    'todo',
    'START_BLOCK',
    'it is 0 — the indexer would scan the chain from block 0 and NEVER reach the contract.\n' +
      'Use the deploy block: `forge script` prints it, and it is also findable by binary\n' +
      'search on `cast code <addr> --block N`.',
  );
} else if (chainAddr) {
  // A START_BLOCK after the deploy skips the events in between: names already sold
  // stay invisible to the indexer, forever.
  try {
    const codeAtStart = await rpc('eth_getCode', [chainAddr, `0x${startBlock.toString(16)}`]);
    check(
      codeAtStart && codeAtStart !== '0x' ? 'ok' : 'todo',
      `START_BLOCK (${startBlock})`,
      `the contract did not exist yet at block ${startBlock} — that is good (the indexer\n` +
        'starts before the deploy and misses nothing). If it is MUCH earlier, it just takes\n' +
        'longer to catch up. If it is AFTER the deploy, it loses the events in between.',
    );
  } catch {
    check('unknown', `START_BLOCK (${startBlock})`, 'could not verify against the chain');
  }
} else {
  check('ok', `START_BLOCK (${startBlock})`);
}

// --- 3 ---------------------------------------------------------------------
section('Cloudflare');

const ids = kvIds();
const kvSet = Object.values(ids).every((v) => v && !v.startsWith('TODO'));
const kvSame = new Set(Object.values(ids)).size === 1;

if (!kvSet) {
  check('todo', 'KV namespace created', 'run: node scripts/bootstrap-cloudflare.mjs');
} else if (!kvSame) {
  check(
    'todo',
    'resolver and api use the SAME KV namespace',
    `they use different ids:\n${Object.entries(ids).map(([f, v]) => `${v}  ${f}`).join('\n')}\n` +
      'The api writes n:<name>, the resolver reads it. Separate namespaces = the resolver\n' +
      'serving a CID the api already replaced, with no error at all, indefinitely.',
  );
} else {
  check('ok', `KV namespace (${Object.values(ids)[0]})`);
}

/**
 * `wrangler whoami` exits 0 EVEN WHEN NOT AUTHENTICATED — it prints "You are not
 * authenticated" and returns success. Checking the exit code here would produce a
 * permanent ✅, which is the worst possible defect in a script whose entire job is
 * telling the truth about the state. So we read the output.
 */
let loggedIn = false;
try {
  const who = sh('npx', ['wrangler', 'whoami'], { stdio: ['ignore', 'pipe', 'pipe'] });
  loggedIn = !/not authenticated/i.test(who);
  check(
    loggedIn ? 'ok' : 'todo',
    'wrangler authenticated',
    'run: npx wrangler login',
  );
} catch {
  check('todo', 'wrangler authenticated', 'run: npx wrangler login');
}

/**
 * R2 is OPTIONAL and ships turned off (it demands a card even on the free tier).
 * Checking the bucket only makes sense if someone uncommented the binding — otherwise
 * this becomes a permanent ❌ nagging about something the project chose not to use,
 * and a doctor that complains about what is correct teaches you to ignore the doctor.
 */
const r2Enabled = TOMLS_R2.some((f) =>
  /^\[\[r2_buckets\]\]/m.test(readFileSync(join(ROOT, f), 'utf8')),
);

if (!r2Enabled) {
  check('ok', 'R2 disabled — the bytes go to KV (no-card mode)');
} else if (loggedIn) {
  try {
    const buckets = sh('npx', ['wrangler', 'r2', 'bucket', 'list']);
    check(
      buckets.includes('wgetclub-blobs') ? 'ok' : 'todo',
      'R2 bucket wgetclub-blobs',
      'run: node scripts/bootstrap-cloudflare.mjs',
    );
  } catch {
    check(
      'todo',
      'R2 bucket',
      'the [[r2_buckets]] binding is active but the buckets could not be listed.\n' +
        'Is R2 enabled in the dashboard? It demands a card even on the free tier.\n' +
        'If you do not want R2, comment the block out in both wrangler.toml — KV takes over.',
    );
  }
}

if (loggedIn) {

  for (const [worker, needed] of [
    ['wgetclub-resolver', ['BASE_RPC_URL']],
    ['wgetclub-api', ['BASE_RPC_URL', 'PINATA_JWT', 'SESSION_SECRET', 'ADMIN_ADDRESSES']],
  ]) {
    try {
      const out = sh('npx', ['wrangler', 'secret', 'list', '--name', worker]);
      const missing = needed.filter((s) => !out.includes(s));
      check(
        missing.length === 0 ? 'ok' : 'todo',
        `${worker} secrets`,
        `missing: ${missing.join(', ')}\n` +
          missing.map((s) => `npx wrangler secret put ${s} --name ${worker}`).join('\n'),
      );
    } catch {
      // Worker does not exist yet: normal before the first deploy.
      check('todo', `${worker} secrets`, `worker not deployed yet, or no permission to list`);
    }
  }
}

// --- 4 ---------------------------------------------------------------------
section('What this script CANNOT see');

console.log(`   No tool reads these from out here — check them yourself:

   • GitHub secrets (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)
     Settings -> Secrets and variables -> Actions

   • The value of the Worker secrets. wrangler says they EXIST, never what is in them.
     A BASE_RPC_URL with a typo passes as "ok" here and fails in production.

   • wget.club pointed at Cloudflare (the routes use zone_name).

   • Terms of Use and a DMCA contact. They do not exist, and they are not code.

   • Who reads the report queue at abuse/<date>/*.json in R2.
     With nobody on duty, the abuse channel is decorative.`);

// ---------------------------------------------------------------------------

const todo = results.filter((r) => r.status === 'todo');
const unknown = results.filter((r) => r.status === 'unknown');

console.log(`\n${'═'.repeat(64)}`);
if (todo.length === 0) {
  console.log(`\nEverything checkable from here is ready.`);
  if (unknown.length > 0) console.log(`(${unknown.length} item(s) not checkable — see above)`);
  console.log(`\nNext: git push. CI deploys. Then:`);
  console.log(`  curl https://wget.club/_health`);
  process.exit(0);
}

console.log(`\n${todo.length} item(s) pending. The next one is:\n`);
console.log(`  → ${todo[0].title}`);
if (todo[0].detail) console.log(`\n${todo[0].detail.split('\n').map((l) => `    ${l}`).join('\n')}`);
console.log(`\nFull step by step: docs/RUNBOOK.md`);
process.exit(1);
