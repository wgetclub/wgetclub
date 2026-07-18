/**
 * Terminal vs browser detection.
 *
 * Getting this wrong is a P0: an HTML page piped into `bash` is at best a syntax
 * error and at worst arbitrary execution of whatever the page happens to contain.
 *
 * The rule is deliberately biased: anything that isn't obviously a browser is
 * treated as a terminal. Serving raw bytes to a browser is a mild UX miss (they
 * get a download instead of a preview). Serving HTML to a pipe is a broken product.
 * When in doubt, raw wins.
 */

const TERMINAL_AGENTS = [
  'curl', 'wget', 'httpie', 'python-requests', 'python-urllib', 'go-http-client',
  'node-fetch', 'undici', 'axios', 'libfetch', 'aria2', 'powershell', 'fetch',
  'lwp::simple', 'apache-httpclient', 'okhttp', 'ruby', 'php', 'busybox',
];

/** Browsers all send a "Mozilla/5.0 (...)" prefix. Nothing scripted does, in practice. */
const BROWSER_MARKER = 'mozilla/';

export function isTerminalClient(userAgent: string | null): boolean {
  // No UA at all: almost always a script, and a raw response is the safe default.
  if (!userAgent) return true;

  const ua = userAgent.toLowerCase();

  // Explicit terminal agents win even if something odd also claims Mozilla —
  // a few curl wrappers spoof a browser UA to get past CDNs.
  if (TERMINAL_AGENTS.some((agent) => ua.includes(agent))) return true;

  return !ua.includes(BROWSER_MARKER);
}
