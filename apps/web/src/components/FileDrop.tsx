import { useCallback, useRef, useState } from 'react';
import { MAX_UPLOAD_BYTES } from '@wgetclub/shared';

/**
 * Imported, NOT redeclared. There used to be a `25 * 1024 * 1024` here and another
 * one in the api; the api's became 1MB and this one lagged behind, leaving the
 * frontend accepting files the server rejects with a 413. See the comment in
 * @wgetclub/shared.
 */
const MAX_BYTES = MAX_UPLOAD_BYTES;

interface Props {
  onFile: (file: File) => void;
  disabled?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileDrop({ onFile, disabled = false }: Props): JSX.Element {
  const [over, setOver] = useState(false);
  const [tooBig, setTooBig] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      if (file.size > MAX_BYTES) {
        setTooBig(`${file.name} is ${formatSize(file.size)} — the limit is ${formatSize(MAX_BYTES)}`);
        return;
      }
      setTooBig(null);
      onFile(file);
    },
    [onFile],
  );

  return (
    <div>
      <div
        className={`drop${over ? ' drop--over' : ''}${disabled ? ' drop--disabled' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled) accept(e.dataTransfer.files[0]);
        }}
        onClick={() => !disabled && inputRef.current?.click()}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) inputRef.current?.click();
        }}
      >
        <input
          ref={inputRef}
          type="file"
          hidden
          data-testid="file-input"
          disabled={disabled}
          onChange={(e) => {
            accept(e.target.files?.[0]);
            // Reset so picking the same file twice still fires onChange.
            e.target.value = '';
          }}
        />
        <p className="drop__main">drag a file here</p>
        <p className="drop__sub">or click to choose · max {formatSize(MAX_BYTES)}</p>
      </div>
      {tooBig ? <p className="msg msg--err">{tooBig}</p> : null}
    </div>
  );
}
