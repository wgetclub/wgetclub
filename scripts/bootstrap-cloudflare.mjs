/**
 * Creates the Cloudflare infra and writes the ids into the wrangler.toml files.
 *
 *   node scripts/bootstrap-cloudflare.mjs            # creates and edits
 *   node scripts/bootstrap-cloudflare.mjs --dry-run  # only shows what it would do
 *
 * Runs once per account. Idempotent.
 *
 * What this script does NOT do, on purpose:
 *   - does not deploy the contract (a contract is not fixed by redeploying; see RUNBOOK)
 *   - does not set secrets (a secret does not go through argv, which lands in shell history)
 *   - does not enable R2 or create the zone (only you can, in the dashboard)
 *
 * It replaced a bash version that had three real defects, all found the first time
 * someone actually ran it. See the comments on kvNamespace(), main() and createBucket().
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DRY = process.argv.includes('--dry-run');
const TOMLS = ['apps/resolver/wrangler.toml', 'apps/api/wrangler.toml'];

function say(...a) {
  console.log(...a);
}
function die(msg) {
  console.error(`\n${msg}`);
  process.exit(1);
}
function wrangler(args, opts = {}) {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

// ---------------------------------------------------------------------------

/**
 * `wrangler whoami` exits 0 EVEN WHEN NOT AUTHENTICATED — it prints "You are not
 * authenticated" and returns success. An `if !wrangler whoami` never fires. Read the
 * output, not the code.
 */
function requireAuth() {
  let out = '';
  try {
    out = wrangler(['whoami']);
  } catch (err) {
    out = (err.stdout ?? '') + (err.stderr ?? '');
  }
  if (/not authenticated/i.test(out)) die('Not authenticated. Run: npx wrangler login');
  const account = /[a-f0-9]{32}/.exec(out)?.[0];
  say(`account: ${account ?? '(id not found in the output)'}\n`);
}

/**
 * Finds or creates the KV namespace.
 *
 * Parses the JSON from `list` instead of `grep -B2 '"title": "wgetclub-NAMES"'`, which
 * is what the bash version did. That grep depended on an exact title the script does
 * not control: `wrangler kv namespace create NAMES` builds the title from the
 * directory's wrangler.toml, and this script runs from the ROOT, where there isn't
 * one. If the real title was anything else, the `list` would never match, the script
 * created a NEW namespace on every run, and the idempotency was a lie — silently.
 *
 * Now it matches on the `NAMES` suffix and, with more than one candidate, STOPS and
 * asks: picking the wrong one unattended would point the Workers at an empty KV, and
 * the symptom would be "every name 404s" with nothing in the log.
 */
function kvNamespace() {
  let list;
  try {
    list = JSON.parse(wrangler(['kv', 'namespace', 'list']));
  } catch (err) {
    die(`could not list the KV namespaces:\n${(err.stderr ?? err.message ?? '').toString().trim()}`);
  }

  const found = list.filter((ns) => /(^|[-_])NAMES$/.test(ns.title));

  if (found.length === 1) {
    say(`KV: already exists — ${found[0].id}  (title: ${found[0].title})`);
    return found[0].id;
  }
  if (found.length > 1) {
    die(
      `KV: found ${found.length} namespaces ending in NAMES:\n` +
        found.map((n) => `  ${n.id}  ${n.title}`).join('\n') +
        `\n\nI will not choose for you — pointing the Workers at the wrong KV makes\n` +
        `every name 404 with nothing in the log. Pick one, delete the others, or\n` +
        `write the id by hand into:\n` +
        TOMLS.map((t) => `  ${t}`).join('\n'),
    );
  }

  if (DRY) {
    say('KV: [dry-run] would create the NAMES namespace');
    return '0'.repeat(32);
  }

  say('KV: creating...');
  let out;
  try {
    out = wrangler(['kv', 'namespace', 'create', 'NAMES']);
  } catch (err) {
    die(`could not create the namespace:\n${(err.stderr ?? err.message ?? '').toString().trim()}`);
  }
  const id = /[a-f0-9]{32}/.exec(out)?.[0];
  if (!id) die(`could not extract the id from the output:\n${out}`);
  say(`KV: created — ${id}`);
  return id;
}

/** Writes the KV id into both tomls. Idempotent. */
function writeKvId(id) {
  for (const t of TOMLS) {
    const path = join(ROOT, t);
    const src = readFileSync(path, 'utf8');
    if (!src.includes('TODO_KV_NAMESPACE_ID')) {
      say(`  ${t}  already filled in, left alone`);
      continue;
    }
    if (DRY) {
      say(`  [dry-run] ${t}  <- ${id}`);
      continue;
    }
    writeFileSync(path, src.replace('TODO_KV_NAMESPACE_ID', id));
    say(`  ${t}  <- ${id}`);
  }
}

/**
 * R2 has to be enabled ONCE in the dashboard — it is not on by default, not even on
 * the free tier, and the API answers 10042 until it is. wrangler's raw error ("Please
 * enable R2 through the Cloudflare Dashboard") says neither where nor that it demands
 * a card, so we translate it.
 */
function createBucket(name) {
  let existing = '';
  try {
    existing = wrangler(['r2', 'bucket', 'list']);
  } catch (err) {
    const text = ((err.stdout ?? '') + (err.stderr ?? '')).toString();
    if (/10042|enable R2/i.test(text)) {
      die(
        `R2 is not enabled on this account.\n\n` +
          `  Enable it at:  https://dash.cloudflare.com/  ->  R2  ->  "Enable R2"\n\n` +
          `  It demands a card on file even for the free tier (10GB free, zero egress).\n` +
          `  Cloudflare only charges above the quota.\n\n` +
          `The KV namespace is already created and its id is already in the wrangler.toml\n` +
          `files — running this script again after enabling R2 reuses everything.`,
      );
    }
    die(`could not list the R2 buckets:\n${text.trim()}`);
  }

  if (existing.includes(name)) {
    say(`R2: ${name} already exists`);
    return;
  }
  if (DRY) {
    say(`R2: [dry-run] would create ${name}`);
    return;
  }
  try {
    wrangler(['r2', 'bucket', 'create', name]);
    say(`R2: ${name} created`);
  } catch (err) {
    die(`could not create the bucket ${name}:\n${((err.stdout ?? '') + (err.stderr ?? '')).toString().trim()}`);
  }
}

// ---------------------------------------------------------------------------

requireAuth();

const kvId = kvNamespace();

/**
 * Write the id BEFORE touching R2.
 *
 * The bash version created the namespace, tried R2, and only then wrote — with
 * `set -e`, a failure in R2 aborted and the freshly created id was lost: the namespace
 * existed on the account, the toml still said TODO, and nothing anywhere said what the
 * id was. That is exactly what happened on the first real run.
 *
 * The id is a fact the moment the namespace exists. Persisting it right then is what
 * makes resuming trivial instead of archaeology.
 */
say('\nwriting the id into the wrangler.toml files...');
writeKvId(kvId);

say('');
for (const b of ['wgetclub-blobs', 'wgetclub-blobs-preview']) createBucket(b);

say(`
done. Still missing, and no script does it for you:

  1. deploy the contract and paste the address in (see docs/RUNBOOK.md step 2)
  2. the secrets — one at a time, interactive, so they do not leak into your history:
       npx wrangler secret put BASE_RPC_URL    --name wgetclub-resolver
       npx wrangler secret put BASE_RPC_URL    --name wgetclub-api
       npx wrangler secret put PINATA_JWT      --name wgetclub-api
       npx wrangler secret put SESSION_SECRET  --name wgetclub-api   # openssl rand -hex 32
       npx wrangler secret put ADMIN_ADDRESSES --name wgetclub-api

  3. point wget.club at Cloudflare (the routes use zone_name)

Where you are:  node scripts/doctor.mjs`);
