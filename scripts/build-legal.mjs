/**
 * Renders docs/legal/*.md into one static page served at /legal/.
 *
 *   node scripts/build-legal.mjs
 *
 * WHY a build step and not a React route:
 *   - The markdown in docs/legal/ is the single source of truth. A lawyer edits
 *     the .md; this regenerates the page. The HTML is never hand-written, so the
 *     served text can never drift from the reviewed text.
 *   - Legal text needs no wallet, no JS, and must render even if the app bundle is
 *     broken — the same reason /abuse is its own minimal entry (apps/web/abuse.tsx).
 *
 * Output goes to apps/web/public/legal/index.html. Vite copies public/ verbatim
 * into dist/, and the resolver's [assets] binding serves dist/legal/index.html at
 * /legal/ BEFORE the Worker runs — so it never touches name resolution. `legal` is
 * a reserved name (packages/shared/src/name.ts), so nothing can buy the name this
 * page shadows.
 *
 * The output is deterministic (no timestamps): rebuilding without editing a .md
 * produces byte-identical HTML, so a --verify build is reproducible.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'docs', 'legal');
const OUT_DIR = join(ROOT, 'apps', 'web', 'public', 'legal');

/**
 * Order and titles are declared here, not derived from the directory, so the page's
 * structure is reviewed in code — a new .md does not silently appear (or fail to
 * appear) on the public legal page. The slug becomes the anchor id other pages link
 * to (e.g. the buy flow links to #terms-of-use), so it must stay stable.
 */
const DOCS = [
  { file: 'terms-of-use.md', title: 'Terms of Use', slug: 'terms-of-use' },
  { file: 'acceptable-use-policy.md', title: 'Acceptable Use Policy', slug: 'acceptable-use-policy' },
  { file: 'abuse-policy.md', title: 'Abuse & Copyright Policy', slug: 'abuse-policy' },
  { file: 'privacy-policy.md', title: 'Privacy Policy', slug: 'privacy-policy' },
  { file: 'cookie-policy.md', title: 'Cookie Policy', slug: 'cookie-policy' },
  { file: 'security-policy.md', title: 'Security Policy', slug: 'security-policy' },
  { file: 'governance.md', title: 'Governance', slug: 'governance' },
  { file: 'transparency-report.md', title: 'Transparency Report', slug: 'transparency-report' },
];

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Inline: escape first, then apply `code` and [text](url). Because escaping runs
 * first, code and link *content* is already safe; the only thing we add back is our
 * own tags. Links are restricted to http(s) so a malformed source cannot inject a
 * javascript: url.
 */
function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) =>
    /^https?:\/\//.test(url) ? `<a href="${url}" rel="noreferrer noopener">${label}</a>` : label,
  );
  return out;
}

/**
 * Minimal Markdown → HTML for the constructs these docs actually use: ATX headings,
 * `-` bullet lists, paragraphs, inline code and links. Not a general converter — it
 * covers what docs/legal uses and nothing more, on purpose (less to go wrong on a
 * page that must be trustworthy). The leading H1 is dropped: the section title comes
 * from DOCS above so it stays consistent with the table of contents.
 */
function mdToHtml(md, headingBase) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let inList = false;
  let para = [];
  let seenTitle = false;

  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);

    if (line.trim() === '') {
      flushPara();
      closeList();
      continue;
    }
    if (heading) {
      flushPara();
      closeList();
      // Drop the first H1 (the document title); render the rest, demoted so the
      // page has one H1 and sections nest under it.
      if (heading[1].length === 1 && !seenTitle) {
        seenTitle = true;
        continue;
      }
      const level = Math.min(6, headingBase + heading[1].length - 1);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (bullet) {
      flushPara();
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  closeList();
  return html.join('\n');
}

const sections = DOCS.map(({ file, title, slug }) => {
  let md;
  try {
    md = readFileSync(join(SRC, file), 'utf8');
  } catch {
    throw new Error(`docs/legal/${file} is missing — it is listed in scripts/build-legal.mjs`);
  }
  return { title, slug, body: mdToHtml(md, 3) };
});

const toc = sections.map((s) => `<li><a href="#${s.slug}">${escapeHtml(s.title)}</a></li>`).join('\n');

const body = sections
  .map(
    (s) =>
      `<section id="${s.slug}" class="doc">\n<h2>${escapeHtml(s.title)}</h2>\n${s.body}\n</section>`,
  )
  .join('\n');

/**
 * Self-contained: all CSS inline, no external requests. The colours mirror the
 * app's dark theme (apps/web/src/styles.css) so /legal does not look like a
 * different site. Kept intentionally plain — it is a document, not a landing page.
 */
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>legal — wget.club</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #0b0d10; color: #cdd6e0;
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 3rem 1.25rem 6rem; }
  a { color: #4ea1ff; }
  header a { color: #5f6b7a; text-decoration: none; font-family: monospace; }
  header .accent { color: #3ddc84; }
  h1 { color: #e8eef5; font-size: 1.9rem; margin: 1.5rem 0 0.5rem; }
  h2 { color: #e8eef5; font-size: 1.3rem; margin: 3rem 0 0.75rem; padding-top: 1rem; border-top: 1px solid #1c2430; }
  h3 { color: #aeb9c7; font-size: 1.05rem; margin: 1.75rem 0 0.5rem; }
  code { background: #151b23; color: #9ecbff; padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.9em; }
  ul { padding-left: 1.25rem; }
  li { margin: 0.25rem 0; }
  .note {
    background: #0f1620; border: 1px solid #1c2430; border-left: 3px solid #3ddc84;
    border-radius: 4px; padding: 1rem 1.25rem; margin: 1.5rem 0; color: #aeb9c7; font-size: 0.95rem;
  }
  .toc { background: #0f1620; border: 1px solid #1c2430; border-radius: 4px; padding: 1rem 1.5rem; }
  .toc ul { list-style: none; padding: 0; margin: 0.5rem 0 0; columns: 2; }
  .toc a { text-decoration: none; }
  .muted { color: #5f6b7a; font-size: 0.9rem; }
  footer { margin-top: 4rem; padding-top: 1.5rem; border-top: 1px solid #1c2430; }
</style>
</head>
<body>
<div class="wrap">
  <header><a href="/">wget<span class="accent">.club</span></a></header>
  <h1>Legal</h1>
  <div class="note">
    These documents govern the <strong>wget.club protocol</strong> and this hosted
    interface to it. The registry is an autonomous ERC-721 contract on Base; names,
    ownership and IPFS content exist independently of this website, and can be resolved
    by any other client. This site is one such interface, and can decline to serve
    specific content (HTTP 451) without affecting the on-chain name.
  </div>
  <nav class="toc" aria-label="Contents">
    <strong class="muted">Contents</strong>
    <ul>
${toc}
    </ul>
  </nav>
${body}
  <footer class="muted">
    Source of these documents: <code>docs/legal/</code> in the project repository.
    Questions or reports: <a href="/abuse">/abuse</a>.
  </footer>
</div>
</body>
</html>
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'index.html'), page);
console.log(`legal page written: apps/web/public/legal/index.html (${sections.length} documents)`);
