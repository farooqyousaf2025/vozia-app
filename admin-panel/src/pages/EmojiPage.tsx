// ---------------------------------------------------------------------------
// Chat emoji: the codes a member can type or tap in a room, and the art each one
// draws. These are `emoji_characters` rows (migration 0016), so adding a code or
// repointing one at new art ships to phones without an app update.
//
// The screen exists to make one rule visible while editing: a chat message stores
// the *token* `[key]`, never the URL. So the key is immutable, a delete cannot
// break history, and the only thing an operator can change underneath an old
// message is which picture its code draws.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArtField } from '../components/ui/ArtField';
import { Button, IconButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Spinner } from '../components/ui/Spinner';
import {
  IconAlert,
  IconEdit,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSmile,
  IconTrash,
} from '../components/ui/Icons';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../context/AuthContext';
import { ApiError, api, assetUrl } from '../lib/api';
import type { AdminEmoji, EmojiInput } from '../types';

// Mirrors `KEY_PATTERN` in emoji.service.ts and the 32-character ceiling inside the
// published `codePattern`. A key longer than this is stored-never-matchable: the client
// scans messages with that pattern, so it would draw plain text forever.
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;
const URL_PATTERN = /^(\/|https:\/\/)/;

export default function EmojiPage() {
  const toast = useToast();
  const { can } = useAuth();
  const canManage = can('config:manage');

  const [emoji, setEmoji] = useState<AdminEmoji[]>([]);
  const [publishedCount, setPublishedCount] = useState<number | null>(null);
  const [codePattern, setCodePattern] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState('');

  const [editing, setEditing] = useState<AdminEmoji | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AdminEmoji | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The public catalogue too, because the admin rows are only worth editing if they are
      // what phones actually receive. `codePattern` is the expression the client matches with.
      const [admin, published] = await Promise.all([api.emojiCatalogue(), api.publicEmoji()]);
      setEmoji(admin.emojis);
      setPublishedCount(published.emojis.length);
      setCodePattern(published.codePattern);
    } catch (err) {
      setEmoji([]);
      setPublishedCount(null);
      setError(err instanceof ApiError ? err.message : 'Failed to load the chat emoji catalogue.');
    } finally {
      setLoading(false);
    }
  }, [reloadKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = () => setReloadKey((key) => key + 1);

  const sorted = useMemo(
    () => [...emoji].sort((a, b) => a.sortOrder - b.sortOrder || (a.key < b.key ? -1 : 1)),
    [emoji],
  );
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return sorted;
    return sorted.filter(
      (each) =>
        each.key.includes(needle) || each.label.toLowerCase().includes(needle) || each.code.includes(needle),
    );
  }, [sorted, filter]);

  if (loading && emoji.length === 0 && publishedCount === null) {
    return (
      <div className="grid h-64 place-items-center text-violet-300">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Chat emoji</h1>
          <p className="mt-0.5 max-w-2xl text-sm text-muted">
            The codes a member types in a room, and the picture each one draws. A message keeps the
            code, not the file, so you can add a code, give it new art, or remove it without touching
            anything anyone already sent.
          </p>
        </div>
        <Button icon={<IconRefresh className="h-4 w-4" />} onClick={refresh}>
          Refresh
        </Button>
      </div>

      {error !== null && (
        <div className="panel flex items-center gap-3 border-rose-500/40 p-4 text-sm text-rose-200">
          <IconAlert className="h-5 w-5 shrink-0" />
          <span className="flex-1">{error}</span>
          <Button size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}

      <Card
        title={`Emoji picker (${sorted.length})`}
        subtitle="In picker order — this is the grid a phone paints above the chat box."
        actions={
          canManage && (
            <Button variant="primary" size="sm" icon={<IconPlus className="h-4 w-4" />} onClick={() => setEditing('new')}>
              New emoji
            </Button>
          )
        }
      >
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <p className="text-[11px] text-faint">
            {publishedCount === null ? (
              'The public catalogue could not be read, so the published count is unknown.'
            ) : (
              <>
                <span className="font-medium text-muted">{publishedCount}</span> code
                {publishedCount === 1 ? '' : 's'} published on <code className="text-muted">GET /api/emoji</code>
                {codePattern !== null && (
                  <>
                    {' · clients match '}
                    <code className="break-all text-muted">{codePattern}</code>
                  </>
                )}
              </>
            )}
          </p>
          {/* Published view: a saved row a phone does not list means the catalogue read is stale,
              or the panel is talking to another environment. */}
          <Input
            className="w-full sm:w-64"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            leadingIcon={<IconSearch className="h-4 w-4" />}
            placeholder="Search code or name"
            aria-label="Search chat emoji"
          />
        </div>

        {sorted.length === 0 ? (
          <EmptyState
            title="No chat emoji"
            message="With no rows, the picker is empty and members type plain text. Add a code and upload its art to bring it back."
            icon={<IconSmile className="h-6 w-6" />}
          />
        ) : shown.length === 0 ? (
          <EmptyState
            title="Nothing matches that search"
            message={`No code or label contains “${filter.trim()}”.`}
            icon={<IconSearch className="h-6 w-6" />}
          />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {shown.map((each) => (
              <EmojiTile
                key={each.key}
                emoji={each}
                canManage={canManage}
                onEdit={() => setEditing(each)}
                onDelete={() => setDeleting(each)}
              />
            ))}
          </div>
        )}
        {!canManage && (
          <p className="mt-3 text-[11px] text-faint">
            Your role can see the catalogue but not change it; the server refuses these writes too.
          </p>
        )}
      </Card>

      {editing !== null && (
        <EmojiFormModal
          emoji={editing === 'new' ? null : editing}
          existingKeys={emoji.map((each) => each.key)}
          onClose={() => setEditing(null)}
          onSaved={(saved, isNew) => {
            setEditing(null);
            toast.success(isNew ? `Emoji “${saved.code}” is live.` : `Emoji “${saved.code}” saved.`);
            refresh();
          }}
        />
      )}

      {deleting !== null && (
        <DeleteEmojiModal
          emoji={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(code) => {
            setDeleting(null);
            toast.success(`Emoji ${code} deleted — older messages now show the text.`);
            refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One tile, and the art behind it. A code whose file does not load is a defect an
// operator should see here rather than discover in a room, so a broken image leaves
// the frame visibly empty instead of being replaced by a placeholder glyph.
// ---------------------------------------------------------------------------
function EmojiArt({ url, size = 56 }: { url: string; size?: number }) {
  const resolved = assetUrl(url);
  return (
    <span
      className="grid shrink-0 place-items-center overflow-hidden rounded-xl border border-edge/60 bg-elevated"
      style={{ width: size, height: size }}
    >
      {resolved !== undefined ? (
        <img
          src={resolved}
          alt=""
          loading="lazy"
          className="h-full w-full object-contain"
          onError={(event) => {
            event.currentTarget.style.visibility = 'hidden';
          }}
        />
      ) : (
        <span className="text-[10px] text-faint">no art</span>
      )}
    </span>
  );
}

function EmojiTile({
  emoji,
  canManage,
  onEdit,
  onDelete,
}: {
  emoji: AdminEmoji;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-edge/60 bg-elevated/40 p-3">
      <div className="flex items-center gap-2.5">
        <EmojiArt url={emoji.url} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[11px] text-ink" title={emoji.code}>
            {emoji.code}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted" title={emoji.label}>
            {emoji.label}
          </p>
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-edge/50 pt-2">
        <p className="text-[11px] text-faint">#{emoji.sortOrder}</p>
        {canManage && (
          <div className="flex items-center gap-1">
            <IconButton label={`Edit ${emoji.code}`} onClick={onEdit}>
              <IconEdit className="h-4 w-4" />
            </IconButton>
            <IconButton label={`Delete ${emoji.code}`} tone="danger" onClick={onDelete}>
              <IconTrash className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit.
// ---------------------------------------------------------------------------
interface EmojiFormModalProps {
  emoji: AdminEmoji | null;
  existingKeys: string[];
  onClose: () => void;
  onSaved: (emoji: AdminEmoji, isNew: boolean) => void;
}

interface EmojiForm {
  key: string;
  label: string;
  url: string;
  sortOrder: string;
}

function validateEmoji(form: EmojiForm, isNew: boolean, existingKeys: string[]): Partial<Record<keyof EmojiForm, string>> {
  const errors: Partial<Record<keyof EmojiForm, string>> = {};
  const key = form.key.trim();
  if (!KEY_PATTERN.test(key)) {
    errors.key = 'Lower-case letters, digits and inner dashes, 2–32 characters, starting with a letter or digit.';
  } else if (isNew && existingKeys.includes(key)) {
    errors.key = `A chat emoji already uses the code [${key}].`;
  }
  const label = form.label.trim();
  if (label.length === 0) errors.label = 'Label is required.';
  else if (label.length > 60) errors.label = 'Label is limited to 60 characters.';
  const url = form.url.trim();
  if (url.length === 0) errors.url = 'An image URL is required.';
  else if (!URL_PATTERN.test(url)) errors.url = 'Start the path with / or use https://.';
  if (!/^\d+$/.test(form.sortOrder.trim())) errors.sortOrder = 'Must be a whole number, 0 or more.';
  return errors;
}

function EmojiFormModal({ emoji, existingKeys, onClose, onSaved }: EmojiFormModalProps) {
  const isNew = emoji === null;
  const [form, setForm] = useState<EmojiForm>(() =>
    emoji === null
      ? { key: '', label: '', url: '', sortOrder: '0' }
      : { key: emoji.key, label: emoji.label, url: emoji.url, sortOrder: String(emoji.sortOrder) },
  );
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const errors = validateEmoji(form, isNew, existingKeys);
  const hasErrors = Object.keys(errors).length > 0;
  const setField = <K extends keyof EmojiForm>(key: K, value: EmojiForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (hasErrors || submitting) return;
    setSubmitting(true);
    setServerError(null);
    const input: EmojiInput = {
      label: form.label.trim(),
      url: form.url.trim(),
      sortOrder: Number.parseInt(form.sortOrder.trim(), 10),
    };
    if (isNew) input.key = form.key.trim();
    try {
      const result = isNew ? await api.createEmoji(input) : await api.updateEmoji(form.key.trim(), input);
      onSaved(result.emoji, isNew);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Saving the chat emoji failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={isNew ? 'Add chat emoji' : `Edit “${emoji.code}”`}
      subtitle={
        isNew
          ? 'The key becomes the code everyone types — [key] is what a sent message stores, so choose it once and for good.'
          : 'The key stays; messages already carrying it keep drawing this art.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="emoji-form" loading={submitting} disabled={hasErrors}>
            {isNew ? 'Add emoji' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id="emoji-form" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Key"
            value={form.key}
            onChange={(event) => setField('key', event.target.value)}
            error={errors.key}
            placeholder="wave"
            disabled={!isNew}
            hint={
              isNew
                ? 'Members type [wave]; longer than 32 characters and no client can match it.'
                : 'Immutable — sent messages are spelled after this value.'
            }
            maxLength={32}
          />
          <Input
            label="Label"
            value={form.label}
            onChange={(event) => setField('label', event.target.value)}
            error={errors.label}
            placeholder="Waving hand"
            maxLength={60}
            hint="Shown under the tile in the picker."
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ArtField
            kind="EMOJI"
            label="Image URL"
            value={form.url}
            error={errors.url}
            placeholder="/uploads/<uuid>.png or https://cdn…"
            onChange={(url) => setField('url', url)}
            onError={setServerError}
          />
          <Input
            label="Picker position"
            inputMode="numeric"
            value={form.sortOrder}
            onChange={(event) => setField('sortOrder', event.target.value)}
            error={errors.sortOrder}
            hint="Lowest first; ties fall back to alphabetical key."
          />
        </div>

        <div className="flex items-center gap-3 rounded-xl border border-edge/60 bg-elevated/40 p-3">
          <EmojiArt url={form.url.trim()} size={72} />
          <p className="text-[11px] leading-relaxed text-faint">
            {`[${form.key.trim() || 'key'}]`} as a phone will render it. The file is loaded from this
            exact URL, so art that does not resolve here draws nothing in someone's message either.
          </p>
        </div>

        {serverError !== null && (
          <div className="flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
            <IconAlert className="h-4 w-4 shrink-0" />
            {serverError}
          </div>
        )}
      </form>
    </Modal>
  );
}

function DeleteEmojiModal({
  emoji,
  onClose,
  onDeleted,
}: {
  emoji: AdminEmoji;
  onClose: () => void;
  onDeleted: (code: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const confirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      await api.deleteEmoji(emoji.key);
      onDeleted(emoji.code);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Delete failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`Delete “${emoji.code}”?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirm()} loading={submitting}>
            Delete emoji
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted">
        <p>
          The code leaves the picker, so nobody can send it again.{' '}
          <span className="font-semibold text-ink">
            Messages that already contain {emoji.code} are not rewritten
          </span>{' '}
          — they keep their text and render it literally, because a chat row stores the code rather
          than this file.
        </p>
        <p className="text-xs text-faint">
          The uploaded image stays in the media library and is deleted there. Reusing this key later
          would make those old messages draw the new art.
        </p>
        {serverError !== null && (
          <div className="flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
            <IconAlert className="h-4 w-4 shrink-0" />
            {serverError}
          </div>
        )}
      </div>
    </Modal>
  );
}
