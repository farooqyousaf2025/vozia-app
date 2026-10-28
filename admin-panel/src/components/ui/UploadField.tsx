import { useRef, useState, type ChangeEvent } from 'react';
import { Button } from './Button';
import { IconUpload } from './Icons';
import { ApiError, api } from '../../lib/api';
import { MEDIA_KIND_META, readFileAsBase64 } from '../../lib/media';
import { formatBytes } from '../../lib/format';
import type { MediaAsset, MediaKind } from '../../types';

interface UploadFieldProps {
  kind: MediaKind;
  label?: string;
  size?: 'sm' | 'md';
  /** The bytes are stored; the caller decides what to do with the URL. */
  onUploaded: (asset: MediaAsset, duplicate: boolean) => void;
  /** Server and client refusals both land here, in operator-readable sentences. */
  onError: (message: string) => void;
}

/**
 * Picks a file, reads it as base64 and posts it to the media store.
 *
 * The file name is only a label — the server names the stored file after a UUID and works out
 * the real type from the magic bytes, so renaming a script to `.png` gets refused rather than
 * served. The input is cleared after every attempt so picking the same file twice still fires
 * a change event.
 */
export function UploadField({ kind, label = 'Upload', size = 'sm', onUploaded, onError }: UploadFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const meta = MEDIA_KIND_META[kind];

  const handle = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size === 0) {
      onError(`${file.name} is empty.`);
      return;
    }
    if (file.size > meta.maxBytes) {
      onError(`${file.name} is ${formatBytes(file.size)} — ${meta.label} takes at most ${formatBytes(meta.maxBytes)}.`);
      return;
    }
    setBusy(true);
    try {
      const base64 = await readFileAsBase64(file);
      const result = await api.uploadAsset(kind, file.name, base64);
      onUploaded(result.asset, result.duplicate);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : `Uploading ${file.name} failed.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={meta.accept}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void handle(event)}
      />
      <Button
        size={size}
        icon={<IconUpload className="h-4 w-4" />}
        loading={busy}
        onClick={() => inputRef.current?.click()}
        title={meta.hint}
      >
        {label}
      </Button>
    </>
  );
}
