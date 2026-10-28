// ---------------------------------------------------------------------------
// Room decoration: the themes a host can pick and the Lottie loops a room
// breathes. Since migration 0015 these are database rows, so a new skin or a
// different loop for PARTY rooms ships without a backend release. Writes need
// `config:manage`; the server refuses a delete that would strand a room, a
// category mapping, or an upload something still points at.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArtField } from '../components/ui/ArtField';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { LottiePreview } from '../components/ui/LottiePreview';
import { Modal } from '../components/ui/Modal';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import { Tabs } from '../components/ui/Tabs';
import { IconAlert, IconEdit, IconPlus, IconRefresh, IconSpark, IconTrash } from '../components/ui/Icons';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../context/AuthContext';
import { ApiError, api, assetUrl } from '../lib/api';
import type {
  AdminRoomTheme,
  DecorCatalogue,
  EffectInput,
  VisualEffectKind,
  ThemeCatalogue,
  ThemeInput,
  VisualEffect,
} from '../types';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;
const ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/;
// The same rule the `CHECK` in 0015 enforces: this string is handed to every device
// that joins a room, so a `javascript:` value must not be storable even by an operator.
const URL_PATTERN = /^(\/|https:\/\/)/;

const CATEGORY_TONE: BadgeTone = 'sky';

export default function DecorPage() {
  const toast = useToast();
  const { can } = useAuth();
  const canManage = can('config:manage');

  const [catalogue, setCatalogue] = useState<DecorCatalogue | null>(null);
  const [published, setPublished] = useState<ThemeCatalogue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [editingTheme, setEditingTheme] = useState<AdminRoomTheme | 'new' | null>(null);
  const [deletingTheme, setDeletingTheme] = useState<AdminRoomTheme | null>(null);
  const [editingEffect, setEditingEffect] = useState<VisualEffect | 'new' | null>(null);
  const [deletingEffect, setDeletingEffect] = useState<VisualEffect | null>(null);
  const [effectKind, setEffectKind] = useState<VisualEffectKind>('AMBIENT');
  const [mappingBusy, setMappingBusy] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Both endpoints, because the point of this screen is that the published catalogue is
      // these rows. `themeCatalogue()` is what a phone reads, so the badge below proves the
      // write reached clients rather than only the database.
      const [decor, publicCatalogue] = await Promise.all([api.decorCatalogue(), api.themeCatalogue()]);
      setCatalogue(decor);
      setPublished(publicCatalogue);
    } catch (err) {
      setCatalogue(null);
      setPublished(null);
      setError(err instanceof ApiError ? err.message : 'Failed to load the decoration catalogue.');
    } finally {
      setLoading(false);
    }
  }, [reloadKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = () => setReloadKey((key) => key + 1);

  const mapCategory = async (category: string, effectKey: string) => {
    if (mappingBusy.has(category)) return;
    setMappingBusy((ids) => new Set(ids).add(category));
    try {
      await api.setCategoryEffect(category, effectKey);
      toast.success(`${category} rooms now play “${effectKey}”.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not change the loop for that category.');
    } finally {
      setMappingBusy((ids) => {
        const next = new Set(ids);
        next.delete(category);
        return next;
      });
    }
  };

  if (loading && catalogue === null) {
    return (
      <div className="grid h-64 place-items-center text-violet-300">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const themes = [...(catalogue?.themes ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || (a.slug < b.slug ? -1 : 1));
  const ambient = (catalogue?.effects ?? []).filter((effect) => effect.kind === 'AMBIENT');
  const welcomes = (catalogue?.effects ?? []).filter((effect) => effect.kind === 'WELCOME');
  const mappings = [...(catalogue?.categoryEffects ?? [])].sort((a, b) => (a.category < b.category ? -1 : 1));
  const shownEffects = effectKind === 'AMBIENT' ? ambient : welcomes;

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Effects &amp; themes</h1>
          <p className="mt-0.5 max-w-2xl text-sm text-muted">
            Room skins and the ambient loops they breathe. Every value here is a row: a new theme is
            published to phones as soon as it is saved, with no app update and no backend release.
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
        title="Themes"
        subtitle="What a room looks like: a name, an accent colour and a wallpaper. A room keeps its slug even if the theme is retired, and then renders the default."
        actions={
          canManage && (
            <Button variant="primary" size="sm" icon={<IconPlus className="h-4 w-4" />} onClick={() => setEditingTheme('new')}>
              New theme
            </Button>
          )
        }
      >
        {themes.length === 0 ? (
          <EmptyState
            title="No themes"
            message="At least one theme is required — a room without a look has nothing to render."
            icon={<IconSpark className="h-6 w-6" />}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {themes.map((theme) => (
              <Card key={theme.slug} bodyClassName="flex flex-col gap-3 p-3.5">
                <div className="flex gap-3">
                  <ThemeWallpaper theme={theme} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-ink" title={theme.name}>
                      {theme.name}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-faint">{theme.slug}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {theme.isDefault && <Badge tone="green">default</Badge>}
                      <span className="inline-flex items-center gap-1 text-[11px] text-muted">
                        <span
                          className="h-3 w-3 rounded-full border border-white/20"
                          style={{ backgroundColor: theme.accent }}
                          aria-hidden="true"
                        />
                        {theme.accent}
                      </span>
                    </div>
                  </div>
                </div>

                <p
                  className="truncate rounded-lg bg-elevated/60 px-2 py-1.5 font-mono text-[11px] text-muted"
                  title={theme.wallpaper}
                >
                  {theme.wallpaper}
                </p>

                <div className="mt-auto flex items-center justify-between border-t border-edge/50 pt-2.5">
                  <p className="text-[11px] text-faint">
                    {theme.roomsUsing} room{theme.roomsUsing === 1 ? '' : 's'} · order {theme.sortOrder}
                  </p>
                  {canManage && (
                    <div className="flex items-center gap-1">
                      <IconButton label={`Edit ${theme.name}`} onClick={() => setEditingTheme(theme)}>
                        <IconEdit className="h-4 w-4" />
                      </IconButton>
                      <IconButton
                        label={`Delete ${theme.name}`}
                        tone="danger"
                        disabled={theme.isDefault || themes.length === 1}
                        onClick={() => setDeletingTheme(theme)}
                      >
                        <IconTrash className="h-4 w-4" />
                      </IconButton>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Visual effects"
        subtitle="Lottie files an operator uploaded. Ambient loops play behind a room forever; the entry flourish plays once when someone joins."
        actions={
          canManage && (
            <Button variant="primary" size="sm" icon={<IconPlus className="h-4 w-4" />} onClick={() => setEditingEffect('new')}>
              New effect
            </Button>
          )
        }
      >
        <Tabs
          items={[
            { id: 'AMBIENT', label: `Ambient loops (${ambient.length})` },
            { id: 'WELCOME', label: `Entry flourish (${welcomes.length})` },
          ]}
          active={effectKind}
          onChange={(id) => setEffectKind(id as VisualEffectKind)}
        />
        {shownEffects.length === 0 ? (
          <EmptyState
            title={effectKind === 'AMBIENT' ? 'No ambient loops' : 'No entry flourish'}
            message={
              effectKind === 'AMBIENT'
                ? 'With no loop left, rooms render their wallpaper without motion. Upload a Lottie JSON to bring one back.'
                : 'Rooms publish `welcome: null` until one exists, so phones simply play nothing on entry.'
            }
            icon={<IconSpark className="h-6 w-6" />}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {shownEffects.map((effect) => (
              <Card key={effect.key} bodyClassName="flex flex-col gap-3 p-3.5">
                <div className="flex items-start gap-3">
                  <LottiePreview
                    src={effect.url}
                    size={56}
                    className="shrink-0 rounded-xl border border-edge/60 bg-elevated"
                    fallback="no loop"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-ink" title={effect.name}>
                      {effect.name}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-faint">{effect.key}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {published !== null && published.welcome === effect.url && <Badge tone="green">published</Badge>}
                      {effect.usedByCategories.map((category) => (
                        <Badge key={category} tone={CATEGORY_TONE}>
                          {category}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>

                <p
                  className="truncate rounded-lg bg-elevated/60 px-2 py-1.5 font-mono text-[11px] text-muted"
                  title={effect.url}
                >
                  {effect.url}
                </p>

                <div className="mt-auto flex items-center justify-between border-t border-edge/50 pt-2.5">
                  <p className="text-[11px] text-faint">order {effect.sortOrder}</p>
                  {canManage && (
                    <div className="flex items-center gap-1">
                      <IconButton label={`Edit ${effect.name}`} onClick={() => setEditingEffect(effect)}>
                        <IconEdit className="h-4 w-4" />
                      </IconButton>
                      <IconButton
                        label={`Delete ${effect.name}`}
                        tone="danger"
                        disabled={effect.usedByCategories.length > 0}
                        onClick={() => setDeletingEffect(effect)}
                      >
                        <IconTrash className="h-4 w-4" />
                      </IconButton>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Which loop each room category plays"
        subtitle="One row per category, taken from the database rather than listed here, so a category added by a future migration appears on its own. The room DTO carries the result as `ambientEffect`."
      >
        {mappings.length === 0 ? (
          <p className="text-sm text-muted">
            No category is mapped yet. Rooms still play the first ambient loop, but nothing decides
            which one — add a mapping to choose per category.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {mappings.map((mapping) => (
              <div key={mapping.category} className="flex items-end gap-3 rounded-xl border border-edge/60 bg-elevated/40 p-3">
                <LottiePreview
                  src={mapping.url}
                  size={48}
                  loop
                  className="shrink-0 rounded-lg border border-edge/60 bg-surface"
                  fallback="none"
                />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Badge tone={CATEGORY_TONE}>{mapping.category}</Badge>
                  <Select
                    aria-label={`Ambient loop for ${mapping.category} rooms`}
                    value={mapping.effectKey}
                    disabled={!canManage || ambient.length === 0 || mappingBusy.has(mapping.category)}
                    onChange={(event) => void mapCategory(mapping.category, event.target.value)}
                  >
                    {ambient.map((effect) => (
                      <option key={effect.key} value={effect.key}>
                        {effect.name} — {effect.key}
                      </option>
                    ))}
                  </Select>
                </div>
                {mappingBusy.has(mapping.category) && <Spinner className="mb-2 h-4 w-4 text-violet-300" />}
              </div>
            ))}
          </div>
        )}
        {!canManage && (
          <p className="mt-3 text-[11px] text-faint">
            Your role can see the catalogue but not change it; the server refuses these writes too.
          </p>
        )}
      </Card>

      {editingTheme !== null && (
        <ThemeFormModal
          theme={editingTheme === 'new' ? null : editingTheme}
          existingSlugs={themes.map((each) => each.slug)}
          onClose={() => setEditingTheme(null)}
          onSaved={(theme, isNew) => {
            setEditingTheme(null);
            toast.success(isNew ? `Theme “${theme.name}” is live.` : `Theme “${theme.name}” saved.`);
            refresh();
          }}
        />
      )}

      {deletingTheme !== null && (
        <DeleteThemeModal
          theme={deletingTheme}
          onClose={() => setDeletingTheme(null)}
          onDeleted={(roomsLeftOnDefault) => {
            const name = deletingTheme.name;
            setDeletingTheme(null);
            toast.success(
              roomsLeftOnDefault > 0
                ? `Theme “${name}” deleted; ${roomsLeftOnDefault} room${roomsLeftOnDefault === 1 ? '' : 's'} now render the default look.`
                : `Theme “${name}” deleted.`,
            );
            refresh();
          }}
        />
      )}

      {editingEffect !== null && (
        <EffectFormModal
          effect={editingEffect === 'new' ? null : editingEffect}
          existingKeys={(catalogue?.effects ?? []).map((each) => each.key)}
          defaultKind={effectKind}
          onClose={() => setEditingEffect(null)}
          onSaved={(effect, isNew) => {
            setEditingEffect(null);
            setEffectKind(effect.kind);
            toast.success(isNew ? `Effect “${effect.name}” added.` : `Effect “${effect.name}” saved.`);
            refresh();
          }}
        />
      )}

      {deletingEffect !== null && (
        <DeleteEffectModal
          effect={deletingEffect}
          onClose={() => setDeletingEffect(null)}
          onDeleted={(key) => {
            setDeletingEffect(null);
            toast.success(`Effect “${key}” deleted.`);
            refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One theme card's wallpaper. A room's background is served from this exact URL,
// so an operator can see whether the art actually loads rather than only that a
// row was saved.
// ---------------------------------------------------------------------------
function ThemeWallpaper({ theme }: { theme: AdminRoomTheme }) {
  const resolved = assetUrl(theme.wallpaper);
  return (
    <span className="relative grid h-[72px] w-14 shrink-0 place-items-center overflow-hidden rounded-xl border border-edge/60 bg-elevated">
      {resolved !== undefined && (
        <img
          src={resolved}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={(event) => {
            event.currentTarget.style.visibility = 'hidden';
          }}
        />
      )}
      <span
        className="absolute inset-x-0 bottom-0 h-1"
        style={{ backgroundColor: theme.accent }}
        aria-hidden="true"
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Theme create / edit.
// ---------------------------------------------------------------------------
interface ThemeFormModalProps {
  theme: AdminRoomTheme | null;
  existingSlugs: string[];
  onClose: () => void;
  onSaved: (theme: AdminRoomTheme, isNew: boolean) => void;
}

interface ThemeForm {
  slug: string;
  name: string;
  accent: string;
  wallpaperUrl: string;
  isDefault: boolean;
  sortOrder: string;
}

function validateTheme(form: ThemeForm, isNew: boolean, existingSlugs: string[]): Partial<Record<keyof ThemeForm, string>> {
  const errors: Partial<Record<keyof ThemeForm, string>> = {};
  if (!SLUG_PATTERN.test(form.slug.trim())) {
    errors.slug = 'Lower-case letters, digits and single dashes, 2–39 characters, starting with a letter or digit.';
  } else if (isNew && existingSlugs.includes(form.slug.trim())) {
    errors.slug = 'A theme with that slug already exists.';
  }
  const name = form.name.trim();
  if (name.length === 0) errors.name = 'Name is required.';
  else if (name.length > 40) errors.name = 'Name is limited to 40 characters.';
  if (!ACCENT_PATTERN.test(form.accent.trim())) errors.accent = 'Use six hex digits, like #3ddc97.';
  const wallpaper = form.wallpaperUrl.trim();
  if (wallpaper.length === 0) errors.wallpaperUrl = 'A wallpaper URL is required.';
  else if (!URL_PATTERN.test(wallpaper)) errors.wallpaperUrl = 'Start the path with / or use https://.';
  if (!/^-?\d+$/.test(form.sortOrder.trim())) errors.sortOrder = 'Must be a whole number.';
  return errors;
}

function ThemeFormModal({ theme, existingSlugs, onClose, onSaved }: ThemeFormModalProps) {
  const isNew = theme === null;
  const [form, setForm] = useState<ThemeForm>(() =>
    theme === null
      ? { slug: '', name: '', accent: '#3ddc97', wallpaperUrl: '', isDefault: false, sortOrder: '0' }
      : {
          slug: theme.slug,
          name: theme.name,
          accent: theme.accent,
          wallpaperUrl: theme.wallpaper,
          isDefault: theme.isDefault,
          sortOrder: String(theme.sortOrder),
        },
  );
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const errors = validateTheme(form, isNew, existingSlugs);
  const hasErrors = Object.keys(errors).length > 0;
  const setField = <K extends keyof ThemeForm>(key: K, value: ThemeForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (hasErrors || submitting) return;
    setSubmitting(true);
    setServerError(null);
    const input: ThemeInput = {
      name: form.name.trim(),
      accent: form.accent.trim(),
      wallpaperUrl: form.wallpaperUrl.trim(),
      isDefault: form.isDefault,
      sortOrder: Number.parseInt(form.sortOrder.trim(), 10),
    };
    if (isNew) input.slug = form.slug.trim();
    try {
      const result = isNew ? await api.createTheme(input) : await api.updateTheme(form.slug, input);
      onSaved(result.theme, isNew);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Saving the theme failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={isNew ? 'Create theme' : `Edit “${theme.name}”`}
      subtitle={
        isNew
          ? 'The slug is what a room stores, so it cannot change later — create a new theme instead.'
          : 'The slug stays; rooms already using it keep working.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="theme-form" loading={submitting} disabled={hasErrors}>
            {isNew ? 'Create theme' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id="theme-form" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Slug"
            value={form.slug}
            onChange={(event) => setField('slug', event.target.value)}
            error={errors.slug}
            placeholder="sunset-glass"
            disabled={!isNew}
            hint={isNew ? 'Used in the API; lower-case with dashes.' : 'Immutable — a room stores this value.'}
            maxLength={39}
          />
          <Input
            label="Display name"
            value={form.name}
            onChange={(event) => setField('name', event.target.value)}
            error={errors.name}
            placeholder="Sunset Glass"
            maxLength={40}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Accent colour"
            value={form.accent}
            onChange={(event) => setField('accent', event.target.value)}
            error={errors.accent}
            hint="Draws the room’s highlighted controls."
          />
          <div className="flex items-end gap-2">
            <input
              type="color"
              value={ACCENT_PATTERN.test(form.accent.trim()) ? form.accent.trim() : '#3ddc97'}
              onChange={(event) => setField('accent', event.target.value)}
              aria-label="Pick an accent colour"
              className="h-9 w-16 cursor-pointer rounded-lg border border-edge bg-elevated p-1"
            />
            <span className="grid h-9 flex-1 place-items-center rounded-lg border border-edge/60 bg-elevated/60 text-[11px] text-faint">
              picker
            </span>
          </div>
        </div>

        <ArtField
          kind="WALLPAPER"
          label="Wallpaper URL"
          value={form.wallpaperUrl}
          error={errors.wallpaperUrl}
          placeholder="/uploads/<uuid>.png or https://cdn…"
          onChange={(url) => setField('wallpaperUrl', url)}
          onError={setServerError}
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Sort order"
            inputMode="numeric"
            value={form.sortOrder}
            onChange={(event) => setField('sortOrder', event.target.value)}
            error={errors.sortOrder}
            hint="Themes are published in this order."
          />
          <label className="flex items-center gap-3 self-end rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2.5">
            <Switch
              checked={form.isDefault}
              onChange={(next) => setField('isDefault', next)}
              label="Make this the default theme"
            />
            <span className="text-xs">
              <span className="font-medium text-ink">Default theme</span>{' '}
              <span className="text-faint">— new rooms and retired slugs render this one.</span>
            </span>
          </label>
        </div>

        <div className="flex items-center gap-3 rounded-xl border border-edge/60 bg-elevated/40 p-3">
          <ThemeWallpaper
            theme={{
              slug: form.slug,
              name: form.name,
              accent: ACCENT_PATTERN.test(form.accent.trim()) ? form.accent.trim() : '#3ddc97',
              wallpaper: form.wallpaperUrl.trim(),
              isDefault: form.isDefault,
              sortOrder: 0,
              roomsUsing: 0,
            }}
          />
          <p className="text-[11px] leading-relaxed text-faint">
            Live preview of the wallpaper and accent. The phone loads this exact URL, so a path that
            does not resolve here will not resolve in a room either.
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

function DeleteThemeModal({
  theme,
  onClose,
  onDeleted,
}: {
  theme: AdminRoomTheme;
  onClose: () => void;
  onDeleted: (roomsLeftOnDefault: number) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const confirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await api.deleteTheme(theme.slug);
      onDeleted(result.roomsLeftOnDefault);
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
      title={`Delete “${theme.name}”?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirm()} loading={submitting}>
            Delete theme
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted">
        <p>
          The row goes away and phones stop offering the skin.{' '}
          {theme.roomsUsing === 0 ? (
            'No room stores this slug, so nothing changes for anyone already in a room.'
          ) : (
            <span>
              <span className="font-semibold text-ink">
                {theme.roomsUsing} room{theme.roomsUsing === 1 ? '' : 's'}
              </span>{' '}
              {theme.roomsUsing === 1 ? 'keeps' : 'keep'} the slug, so {theme.roomsUsing === 1 ? 'it' : 'they'}{' '}
              render the default theme afterwards.
            </span>
          )}
        </p>
        <p className="text-xs text-faint">
          The wallpaper file stays in the media library — delete it there once nothing points at it.
          The default theme and the last theme cannot be removed.
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

// ---------------------------------------------------------------------------
// Effect create / edit.
// ---------------------------------------------------------------------------
interface EffectFormModalProps {
  effect: VisualEffect | null;
  existingKeys: string[];
  defaultKind: VisualEffectKind;
  onClose: () => void;
  onSaved: (effect: VisualEffect, isNew: boolean) => void;
}

interface EffectForm {
  key: string;
  kind: VisualEffectKind;
  name: string;
  url: string;
  sortOrder: string;
}

function validateEffect(form: EffectForm, isNew: boolean, existingKeys: string[]): Partial<Record<keyof EffectForm, string>> {
  const errors: Partial<Record<keyof EffectForm, string>> = {};
  if (!SLUG_PATTERN.test(form.key.trim())) {
    errors.key = 'Lower-case letters, digits and single dashes, 2–39 characters, starting with a letter or digit.';
  } else if (isNew && existingKeys.includes(form.key.trim())) {
    errors.key = 'An effect with that key already exists.';
  }
  const name = form.name.trim();
  if (name.length === 0) errors.name = 'Name is required.';
  else if (name.length > 40) errors.name = 'Name is limited to 40 characters.';
  const url = form.url.trim();
  if (url.length === 0) errors.url = 'A Lottie URL is required.';
  else if (!URL_PATTERN.test(url)) errors.url = 'Start the path with / or use https://.';
  if (!/^-?\d+$/.test(form.sortOrder.trim())) errors.sortOrder = 'Must be a whole number.';
  return errors;
}

function EffectFormModal({ effect, existingKeys, defaultKind, onClose, onSaved }: EffectFormModalProps) {
  const isNew = effect === null;
  const [form, setForm] = useState<EffectForm>(() =>
    effect === null
      ? { key: '', kind: defaultKind, name: '', url: '', sortOrder: '0' }
      : { key: effect.key, kind: effect.kind, name: effect.name, url: effect.url, sortOrder: String(effect.sortOrder) },
  );
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const errors = validateEffect(form, isNew, existingKeys);
  const hasErrors = Object.keys(errors).length > 0;
  const setField = <K extends keyof EffectForm>(key: K, value: EffectForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (hasErrors || submitting) return;
    setSubmitting(true);
    setServerError(null);
    const input: EffectInput = {
      name: form.name.trim(),
      url: form.url.trim(),
      sortOrder: Number.parseInt(form.sortOrder.trim(), 10),
    };
    if (isNew) {
      input.key = form.key.trim();
      input.kind = form.kind;
    }
    try {
      const result = isNew ? await api.createEffect(input) : await api.updateEffect(form.key, input);
      onSaved(result.effect, isNew);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Saving the effect failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={isNew ? 'Add visual effect' : `Edit “${effect.name}”`}
      subtitle="Ambient loops are chosen per room category; the entry flourish plays once when someone joins. A category mapping that points at a loop keeps the loop from being deleted."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="effect-form" loading={submitting} disabled={hasErrors}>
            {isNew ? 'Add effect' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id="effect-form" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Key"
            value={form.key}
            onChange={(event) => setField('key', event.target.value)}
            error={errors.key}
            placeholder="room-bubbles"
            disabled={!isNew}
            hint={isNew ? 'Referenced by category mappings; cannot change later.' : 'Immutable.'}
            maxLength={39}
          />
          <Input
            label="Display name"
            value={form.name}
            onChange={(event) => setField('name', event.target.value)}
            error={errors.name}
            placeholder="Bubbles"
            maxLength={40}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            label="Kind"
            value={form.kind}
            disabled={!isNew}
            onChange={(event) => setField('kind', event.target.value as VisualEffectKind)}
          >
            <option value="AMBIENT">Ambient — loops behind a room</option>
            <option value="WELCOME">Welcome — plays once on entry</option>
          </Select>
          <Input
            label="Sort order"
            inputMode="numeric"
            value={form.sortOrder}
            onChange={(event) => setField('sortOrder', event.target.value)}
            error={errors.sortOrder}
            hint="The lowest-welcome loop in this order is the one phones publish as `welcome`."
          />
        </div>

        <ArtField
          kind="EFFECT"
          label="Lottie URL"
          value={form.url}
          error={errors.url}
          placeholder="/uploads/<uuid>.json or https://cdn…"
          onChange={(url) => setField('url', url)}
          onError={setServerError}
        />

        <div className="flex items-center gap-3 rounded-xl border border-edge/60 bg-elevated/40 p-3">
          <LottiePreview
            src={form.url.trim()}
            size={88}
            className="shrink-0 rounded-xl border border-edge/60 bg-elevated"
            fallback="not playable yet"
          />
          <p className="text-[11px] leading-relaxed text-faint">
            The loop as a phone will see it. A file the server refuses to play here — not valid Lottie,
            or a URL that does not resolve — would leave rooms without motion.
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

function DeleteEffectModal({
  effect,
  onClose,
  onDeleted,
}: {
  effect: VisualEffect;
  onClose: () => void;
  onDeleted: (key: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const confirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await api.deleteEffect(effect.key);
      onDeleted(result.key);
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
      title={`Delete “${effect.name}”?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirm()} loading={submitting}>
            Delete effect
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted">
        <p>
          Removes this {effect.kind === 'AMBIENT' ? 'ambient loop' : 'entry flourish'} from the
          catalogue.{' '}
          {effect.usedByCategories.length > 0 ? (
            <span className="font-semibold text-ink">
              {effect.usedByCategories.join(', ')} {effect.usedByCategories.length === 1 ? 'maps' : 'map'} to it,
              so the server will refuse until those categories point elsewhere.
            </span>
          ) : (
            'No room category maps to it, so nothing loses its motion.'
          )}
        </p>
        <p className="text-xs text-faint">
          The uploaded Lottie file itself stays in the media library and is deleted there.
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
