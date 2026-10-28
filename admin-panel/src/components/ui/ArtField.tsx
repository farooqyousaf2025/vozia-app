// ---------------------------------------------------------------------------
// One art URL field plus the upload that fills it in. Used by every page where
// an operator points a row at a file: gifts, themes, effects, badges.
// ---------------------------------------------------------------------------
import { Input } from './Input';
import { UploadField } from './UploadField';
import { useAuth } from '../../context/AuthContext';
import { MEDIA_KIND_META } from '../../lib/media';
import type { MediaKind } from '../../types';

interface ArtFieldProps {
  kind: MediaKind;
  label: string;
  value: string;
  error?: string | null;
  hint?: string;
  placeholder?: string;
  onChange: (url: string) => void;
  onError: (message: string) => void;
}

export function ArtField({ kind, label, value, error = null, hint, placeholder, onChange, onError }: ArtFieldProps) {
  const { can } = useAuth();
  return (
    <div className="flex items-start gap-2">
      <Input
        className="flex-1"
        label={label}
        value={value}
        error={error}
        hint={hint ?? MEDIA_KIND_META[kind].hint}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {/* `Input` spends the first 22px of its block on the label, so this raises the button onto the input's own line. */}
      {can('media:manage') && (
        <div className="shrink-0 pt-[22px]">
          <UploadField kind={kind} size="md" onUploaded={(asset) => onChange(asset.url)} onError={onError} />
        </div>
      )}
    </div>
  );
}
