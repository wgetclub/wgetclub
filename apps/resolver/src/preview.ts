/**
 * Browser preview page.
 *
 * SECURITY: everything on this page derives from user-controlled data (the name,
 * the CID, the content-type, and the file body itself). wget.club is the origin
 * that holds the SIWE session cookie — an XSS here is a full account takeover.
 *
 * Two hard rules, both enforced below:
 *   1. Every interpolated value goes through esc(). No exceptions, no template
 *      convenience. Not even the CID — it comes from a mapping a stranger controls.
 *   2. File content is NEVER rendered as HTML. It goes inside a <pre> as escaped
 *      text, and only for script-like types under a size cap. `script-src 'none'`
 *      is the backstop for when rule 1 gets broken by accident — the page ships no
 *      JS of its own, so nothing is given up by forbidding all of it.
 */

import { isScriptLike, truncateCid, type NameRecord } from '@wgetclub/shared';
import { fetchFromIpfs, parseGateways } from './gateway';
import type { Env } from './index';

/** Preview at most this much of the file — a 25MB script would blow the CPU budget. */
const PREVIEW_BYTE_LIMIT = 64 * 1024;

export async function renderPreview(
  name: string,
  record: NameRecord,
  cid: string,
  env: Env,
): Promise<Response> {
  const scripty = isScriptLike(record.ct);

  let body: string | null = null;
  let truncated = false;

  if (scripty) {
    const snippet = await fetchSnippet(cid, env);
    if (snippet) {
      body = snippet.text;
      truncated = snippet.truncated;
    }
  }

  const cmd = scripty
    ? `curl -sSL https://wget.club/${name} | bash`
    : `wget https://wget.club/${name}`;

  const html = page({ name, record, cid, cmd, body, truncated, scripty });

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': record.frozen ? 'public, max-age=3600' : 'public, max-age=60',
      /**
       * `script-src 'none'` — no JS runs on this page at all.
       *
       * This file used to CLAIM the CSP was a backstop against an escaping bug
       * while actually serving `script-src 'unsafe-inline'`, which is no backstop
       * at all: a comment asserting a defence that the header did not implement.
       * The copy button was the only script, and it is not worth an XSS-shaped
       * hole on the origin that holds the SIWE session cookie — it now uses a
       * plain <input readonly> the user can select, no JS.
       *
       * `style-src 'unsafe-inline'` stays: a <style> block cannot execute, and the
       * alternative (hashing the stylesheet on every edit) buys nothing here.
       */
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

async function fetchSnippet(cid: string, env: Env): Promise<{ text: string; truncated: boolean } | null> {
  try {
    // Same gateway fallback as the hot path (gateway.ts). The preview does not ask
    // for a Range: gateways disagree on supporting it, and a whole 200 truncated
    // here is more predictable than a 206 half of them ignore — the cut happens
    // below, and the 1MB per-file ceiling makes the waste irrelevant.
    const fetched = await fetchFromIpfs(cid, parseGateways(env.IPFS_GATEWAYS));
    if (!fetched) return null;

    const buf = await fetched.response.arrayBuffer();
    const truncated = buf.byteLength > PREVIEW_BYTE_LIMIT;
    const slice = truncated ? buf.slice(0, PREVIEW_BYTE_LIMIT) : buf;
    return { text: new TextDecoder().decode(slice), truncated };
  } catch {
    return null; // A missing preview is cosmetic. It never fails the page.
  }
}

/** The only thing standing between a name owner and an XSS on our session origin. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface PageProps {
  name: string;
  record: NameRecord;
  cid: string;
  cmd: string;
  body: string | null;
  truncated: boolean;
  scripty: boolean;
}

function page({ name, record, cid, cmd, body, truncated, scripty }: PageProps): string {
  const frozenBadge = record.frozen
    ? `<span class="badge frozen" title="The owner froze this record. The CID can never change again.">🔒 frozen</span>`
    : `<span class="badge mutable" title="The owner can repoint the CID at any time.">⚠ mutable</span>`;

  const pinCmd = `curl -sSL https://wget.club/${name}@${cid} | bash`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(name)} — wget.club</title>
<style>
  :root { --bg:#0b0d0e; --fg:#e6e6e6; --dim:#8b949e; --accent:#3ddc84; --warn:#f0a020; --line:#21262d; }
  * { box-sizing:border-box; }
  body { margin:0; padding:2rem 1rem; background:var(--bg); color:var(--fg);
         font:14px/1.6 ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace; }
  main { max-width:820px; margin:0 auto; }
  h1 { font-size:1.6rem; margin:0 0 .25rem; color:var(--accent); word-break:break-all; }
  .meta { color:var(--dim); font-size:.8rem; margin-bottom:1.5rem; }
  .meta a { color:var(--dim); }
  .badge { display:inline-block; padding:.1rem .5rem; border-radius:3px; font-size:.75rem; margin-left:.5rem; }
  .frozen { background:#0d3320; color:var(--accent); border:1px solid #1a5c3a; }
  .mutable { background:#3a2a0a; color:var(--warn); border:1px solid #6b4a12; }
  /* An <input readonly>, not a div+JS button: click selects, ctrl+C copies, and the
     page needs no script — which is what lets the CSP be script-src 'none'. */
  .cmd { display:block; width:100%; background:#010409; border:1px solid var(--line);
         border-radius:6px; padding:.9rem 1rem; margin:.5rem 0 1rem; color:var(--fg);
         font:inherit; font-size:.85rem; }
  .cmd:focus { outline:1px solid var(--accent); }
  h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.08em; color:var(--dim);
       margin:1.5rem 0 .25rem; font-weight:600; }
  pre.src { background:#010409; border:1px solid var(--line); border-radius:6px; padding:1rem;
            overflow-x:auto; max-height:60vh; overflow-y:auto; font-size:.8rem; margin:.5rem 0; }
  .note { color:var(--dim); font-size:.75rem; }
  .warn { color:var(--warn); font-size:.78rem; border-left:2px solid var(--warn);
          padding:.5rem .75rem; background:#1a1409; margin:1rem 0; }
  footer { margin-top:2.5rem; padding-top:1rem; border-top:1px solid var(--line);
           color:var(--dim); font-size:.75rem; }
  footer a { color:var(--accent); }
</style>
</head>
<body>
<main>
  <h1>${esc(name)}${frozenBadge}</h1>
  <div class="meta">
    owner <code>${esc(record.owner)}</code> ·
    cid <code title="${esc(cid)}">${esc(truncateCid(cid))}</code> ·
    <a href="/${esc(name)}.json">json</a>
  </div>

  <h2>download</h2>
  <input class="cmd" readonly value="${esc(cmd)}" aria-label="download command" />

  ${
    record.frozen
      ? ''
      : `<div class="warn">
    This record is <strong>not frozen</strong>: the owner can swap the content at any time,
    including after you audit it. To lock onto the exact version you are looking at, use the
    pinned-CID command below.
  </div>
  <h2>pin this version</h2>
  <input class="cmd" readonly value="${esc(pinCmd)}" aria-label="pinned-CID command" />`
  }

  ${
    body !== null
      ? `<h2>content${truncated ? ' (first 64KB)' : ''}</h2>
         <pre class="src">${esc(body)}</pre>
         <p class="note">Read it before you run it. We do not audit, moderate or endorse user
         content — wget.club only resolves the name to the CID its owner pointed at.</p>`
      : scripty
        ? `<p class="note">Could not load the preview from IPFS right now.</p>`
        : `<p class="note">Binary content (<code>${esc(record.ct)}</code>) — no preview.</p>`
  }

  <footer>
    <a href="/">wget.club</a> · names on Base · content on IPFS ·
    <a href="/abuse">report abuse</a>
  </footer>
</main>
</body>
</html>`;
}
