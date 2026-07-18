import { useCallback, useEffect, useState } from 'react';

interface Props {
  command: string;
  /** Shown above the block, e.g. "your command". */
  label?: string;
}

export function CopyCommand({ command, label }: Props): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = useCallback(async () => {
    setFailed(false);
    try {
      // Absent over plain http and in browsers that gate it behind permissions.
      if (!navigator.clipboard) throw new Error('no clipboard api');
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setFailed(true);
    }
  }, [command]);

  return (
    <div className="cmd">
      {label ? <div className="cmd__label">{label}</div> : null}
      <div className="cmd__row">
        <pre className="cmd__code">
          <span className="cmd__prompt" aria-hidden="true">
            $
          </span>
          <code>{command}</code>
        </pre>
        <button
          type="button"
          className="btn btn--ghost cmd__copy"
          onClick={() => void copy()}
          aria-label="Copy command"
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      {failed ? <p className="cmd__hint">copy it manually — the browser blocked the clipboard</p> : null}
    </div>
  );
}
