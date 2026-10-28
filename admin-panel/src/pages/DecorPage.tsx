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
import { IconAlert, IconEdit, IconPlus, IconRefresh, IconSpark, IconTrash, IconUsers } from '../components/ui/Icons';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../context/AuthContext';
import { ApiError, api, assetUrl } from '../lib/api';
import { formatDiamonds } from '../lib/format';
import type {
  AdminRoomTheme,
  DecorCatalogue,
  EffectInput,
  FrameHolder,
  FrameInput,
  ProfileFrame,
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
  const [editingFrame, setEditingFrame] = useState<ProfileFrame | 'new' | null>(null);
  const [deletingFrame, setDeletingFrame] = useState<ProfileFrame | null>(null);
  const [holdersFrame, setHoldersFrame] = useState<ProfileFrame | null>(null);
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
  const frames = [...(catalogue?.frames ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || (a.key < b.key ? -1 : 1));
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
                      <PriceBadge forSale={theme.forSale} priceDiamonds={theme.priceDiamonds} periodDays={theme.periodDays} />
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
        title="Avatar frames"
        subtitle="The rings a member buys and wears over their avatar (migration 0019). The art is a transparent PNG and the accent is the fallback colour a slow CDN can draw. Retiring a key stops the shop selling it; every receipt already paid for keeps its row and is still visible to its owner."
        actions={
          canManage && (
            <Button variant="primary" size="sm" icon={<IconPlus className="h-4 w-4" />} onClick={() => setEditingFrame('new')}>
              New frame
            </Button>
          )
        }
      >
        {frames.length === 0 ? (
          <EmptyState
            title="No frames"
            message="The shop has no rings to sell. Add one and GET /api/store offers it on the next read."
            icon={<IconSpark className="h-6 w-6" />}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {frames.map((frame) => (
              <Card key={frame.key} bodyClassName="flex flex-col gap-3 p-3.5">
                <div className="flex items-start gap-3">
                  <FrameArt frame={frame} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-ink" title={frame.name}>
                      {frame.name}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-faint">{frame.key}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <PriceBadge forSale={frame.forSale} priceDiamonds={frame.priceDiamonds} periodDays={frame.periodDays} />
                      <span className="inline-flex items-center gap-1 text-[11px] text-muted">
                        <span
                          className="h-3 w-3 rounded-full border border-white/20"
                          style={{ backgroundColor: frame.accent }}
                          aria-hidden="true"
                        />
                        {frame.accent}
                      </span>
                    </div>
                  </div>
                </div>

                <p
                  className="truncate rounded-lg bg-elevated/60 px-2 py-1.5 font-mono text-[11px] text-muted"
                  title={frame.art}
                >
                  {frame.art}
                </p>

                <div className="mt-auto flex items-center justify-between border-t border-edge/50 pt-2.5">
                  <p className="text-[11px] text-faint">
                    {frame.holders} holder{frame.holders === 1 ? '' : 's'} · order {frame.sortOrder}
                  </p>
                  <div className="flex items-center gap-1">
                    <IconButton label={`Who holds ${frame.name}`} onClick={() => setHoldersFrame(frame)}>
                      <IconUsers className="h-4 w-4" />
                    </IconButton>
                    {canManage && (
                      <>
                        <IconButton label={`Edit ${frame.name}`} onClick={() => setEditingFrame(frame)}>
                          <IconEdit className="h-4 w-4" />
                        </IconButton>
                        <IconButton label={`Retire ${frame.name}`} tone="danger" onClick={() => setDeletingFrame(frame)}>
                          <IconTrash className="h-4 w-4" />
                        </IconButton>
                      </>
                    )}
                  </div>
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
                      <PriceBadge forSale={effect.forSale} priceDiamonds={effect.priceDiamonds} periodDays={effect.periodDays} />
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

      {editingFrame !== null && (
        <FrameFormModal
          frame={editingFrame === 'new' ? null : editingFrame}
          existingKeys={frames.map((each) => each.key)}
          onClose={() => setEditingFrame(null)}
          onSaved={(frame, isNew) => {
            setEditingFrame(null);
            toast.success(isNew ? `Frame “${frame.name}” is on sale.` : `Frame “${frame.name}” saved.`);
            refresh();
          }}
        />
      )}

      {deletingFrame !== null && (
        <DeleteFrameModal
          frame={deletingFrame}
          onClose={() => setDeletingFrame(null)}
          onDeleted={(key, holders) => {
            setDeletingFrame(null);
            toast.success(
              holders > 0
                ? `Frame “${key}” retired; ${holders} member${holders === 1 ? '' : 's'} keep their receipt.`
                : `Frame “${key}” retired.`,
            );
            refresh();
          }}
        />
      )}

      {holdersFrame !== null && <FrameHoldersModal frame={holdersFrame} onClose={() => setHoldersFrame(null)} />}
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
// A frame as the shop draws it: the PNG over a transparent middle, then the accent
// colour a client falls back to when the art cannot load. `PriceBadge` is the same
// rule the CHECK in 0019 enforces, read back rather than re-invented.
// ---------------------------------------------------------------------------
function FrameArt({ frame }: { frame: ProfileFrame }) {
  const resolved = assetUrl(frame.art);
  return (
    <span className="relative grid h-[72px] w-[72px] shrink-0 place-items-center rounded-full border border-edge/60 bg-elevated">
      {resolved !== undefined && (
        <img
          src={resolved}
          alt=""
          loading="lazy"
          className="h-16 w-16 object-contain"
          onError={(event) => {
            event.currentTarget.style.visibility = 'hidden';
          }}
        />
      )}
    </span>
  );
}

function PriceBadge({ forSale, priceDiamonds, periodDays }: { forSale: boolean; priceDiamonds: number; periodDays: number | null }) {
  if (!forSale) return <Badge tone="slate">free</Badge>;
  return (
    <Badge tone="amber">
      {formatDiamonds(priceDiamonds)} · {periodDays === null ? 'forever' : `${periodDays}d`}
    </Badge>
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
  forSale: boolean;
  priceDiamonds: string;
  periodDays: string;
}

/**
 * The three pricing rules `0019_cosmetic_store.sql` enforces with CHECK constraints, phrased for an
 * operator. The server refuses the same rows; this only says so before the round trip.
 */
function validatePricing(forSale: boolean, priceRaw: string, daysRaw: string): { price?: string; days?: string } {
  const errors: { price?: string; days?: string } = {};
  const price = priceRaw.trim();
  if (!/^\d+$/.test(price)) {
    errors.price = 'Whole number of diamonds.';
  } else if (forSale && Number.parseInt(price, 10) <= 0) {
    errors.price = 'An item on sale needs a price above zero.';
  } else if (!forSale && Number.parseInt(price, 10) !== 0) {
    errors.price = 'Take it off sale instead of pricing a free item.';
  }
  const days = daysRaw.trim();
  if (days !== '') {
    if (!/^\d+$/.test(days)) {
      errors.days = 'Whole days, or leave empty for permanent.';
    } else if (Number.parseInt(days, 10) < 1 || Number.parseInt(days, 10) > 3650) {
      errors.days = 'Between 1 and 3650 days.';
    }
  }
  return errors;
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
  const pricing = validatePricing(form.forSale, form.priceDiamonds, form.periodDays);
  if (pricing.price !== undefined) errors.priceDiamonds = pricing.price;
  if (pricing.days !== undefined) errors.periodDays = pricing.days;
  return errors;
}

function ThemeFormModal({ theme, existingSlugs, onClose, onSaved }: ThemeFormModalProps) {
  const isNew = theme === null;
  const [form, setForm] = useState<ThemeForm>(() =>
    theme === null
      ? { slug: '', name: '', accent: '#3ddc97', wallpaperUrl: '', isDefault: false, sortOrder: '0', forSale: false, priceDiamonds: '0', periodDays: '' }
      : {
          slug: theme.slug,
          name: theme.name,
          accent: theme.accent,
          wallpaperUrl: theme.wallpaper,
          isDefault: theme.isDefault,
          sortOrder: String(theme.sortOrder),
          forSale: theme.forSale,
          priceDiamonds: String(theme.priceDiamonds),
          periodDays: theme.periodDays === null ? '' : String(theme.periodDays),
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
      forSale: form.forSale,
      priceDiamonds: Number.parseInt(form.priceDiamonds.trim() || '0', 10),
      periodDays: form.periodDays.trim() === '' ? null : Number.parseInt(form.periodDays.trim(), 10),
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

        {/* The shop half of the row. A free theme is worn by anybody; a paid one has to be bought
            by the host first (`assertMayWearTheme`), and the price is read from the database at
            purchase time, never from a client. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-3 rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2.5 sm:col-span-2">
            <Switch
              checked={form.forSale}
              onChange={(next) => {
                setField('forSale', next);
                // The row's CHECK pairs "not for sale" with price 0, and the price box is
                // disabled in that state — so the switch must clear it or the form is stuck.
                if (!next) setField('priceDiamonds', '0');
              }}
              label="Sell this theme"
            />
            <span className="text-xs">
              <span className="font-medium text-ink">For sale</span>{' '}
              <span className="text-faint">— a host must own it before a room wears it. Off keeps it free for everyone.</span>
            </span>
          </label>
          <Input
            label="Price (diamonds)"
            inputMode="numeric"
            value={form.priceDiamonds}
            onChange={(event) => setField('priceDiamonds', event.target.value)}
            error={errors.priceDiamonds}
            disabled={!form.forSale}
            hint="What a purchase debits, read server-side at the moment of buying."
          />
          <Input
            label="Rent for (days)"
            inputMode="numeric"
            value={form.periodDays}
            onChange={(event) => setField('periodDays', event.target.value)}
            error={errors.periodDays}
            hint="Empty sells it once and forever."
          />
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
              priceDiamonds: 0,
              forSale: form.forSale,
              periodDays: null,
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
  forSale: boolean;
  priceDiamonds: string;
  periodDays: string;
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
  if (form.kind === 'AMBIENT' && form.forSale) {
    errors.forSale = 'An ambient loop belongs to a room category — only entry flourishes can be sold.';
  }
  const pricing = validatePricing(form.kind === 'WELCOME' && form.forSale, form.priceDiamonds, form.periodDays);
  if (pricing.price !== undefined) errors.priceDiamonds = pricing.price;
  if (pricing.days !== undefined) errors.periodDays = pricing.days;
  return errors;
}

function EffectFormModal({ effect, existingKeys, defaultKind, onClose, onSaved }: EffectFormModalProps) {
  const isNew = effect === null;
  const [form, setForm] = useState<EffectForm>(() =>
    effect === null
      ? { key: '', kind: defaultKind, name: '', url: '', sortOrder: '0', forSale: false, priceDiamonds: '0', periodDays: '' }
      : {
          key: effect.key,
          kind: effect.kind,
          name: effect.name,
          url: effect.url,
          sortOrder: String(effect.sortOrder),
          forSale: effect.forSale,
          priceDiamonds: String(effect.priceDiamonds),
          periodDays: effect.periodDays === null ? '' : String(effect.periodDays),
        },
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
    // An ambient loop plays behind every room in its category, so it has no buyer and no price.
    // Sending zero here instead of the form's values keeps a kind change from carrying a price over.
    if (form.kind === 'WELCOME') {
      input.forSale = form.forSale;
      input.priceDiamonds = form.forSale ? Number.parseInt(form.priceDiamonds.trim() || '0', 10) : 0;
      input.periodDays = form.periodDays.trim() === '' ? null : Number.parseInt(form.periodDays.trim(), 10);
    } else {
      input.forSale = false;
      input.priceDiamonds = 0;
      input.periodDays = null;
    }
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
            onChange={(event) => {
              const kind = event.target.value as VisualEffectKind;
              setField('kind', kind);
              // Switching away from WELCOME disables both boxes; clear them in the same breath.
              if (kind !== 'WELCOME') {
                setField('forSale', false);
                setField('priceDiamonds', '0');
              }
            }}
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

        {/* Only a WELCOME row can be sold: an ambient loop is chosen by room category, so there
            is no member who could own it. The server refuses a sale on AMBIENT for the same reason. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-3 rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2.5 sm:col-span-2">
            <Switch
              checked={form.kind === 'WELCOME' && form.forSale}
              onChange={(next) => {
                setField('forSale', next);
                // An ambient loop is never sold, and the disabled price box cannot be cleared.
                if (!next) setField('priceDiamonds', '0');
              }}
              disabled={form.kind !== 'WELCOME'}
              label="Sell this entry flourish"
            />
            <span className="text-xs">
              <span className="font-medium text-ink">For sale</span>{' '}
              <span className="text-faint">
                {form.kind === 'WELCOME'
                  ? '— a member buys it from the store and wears it on their account.'
                  : '— an ambient loop is chosen per room category and cannot be owned.'}
              </span>
            </span>
          </label>
          <Input
            label="Price (diamonds)"
            inputMode="numeric"
            value={form.priceDiamonds}
            onChange={(event) => setField('priceDiamonds', event.target.value)}
            error={errors.priceDiamonds ?? errors.forSale}
            disabled={form.kind !== 'WELCOME' || !form.forSale}
            hint="Read from the row at purchase time."
          />
          <Input
            label="Rent for (days)"
            inputMode="numeric"
            value={form.periodDays}
            onChange={(event) => setField('periodDays', event.target.value)}
            error={errors.periodDays}
            disabled={form.kind !== 'WELCOME'}
            hint="Empty sells it once and forever."
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

// ---------------------------------------------------------------------------
// Frame create / edit.
//
// The key is the identity a receipt stores, so it is immutable after creation. The shop reads
// `for_sale` and `price_diamonds` inside the purchase transaction, which is what lets an operator
// re-price a ring between two taps without a client ever naming the price.
// ---------------------------------------------------------------------------
interface FrameFormModalProps {
  frame: ProfileFrame | null;
  existingKeys: string[];
  onClose: () => void;
  onSaved: (frame: ProfileFrame, isNew: boolean) => void;
}

interface FrameForm {
  key: string;
  name: string;
  artUrl: string;
  accent: string;
  sortOrder: string;
  forSale: boolean;
  priceDiamonds: string;
  periodDays: string;
}

function validateFrame(form: FrameForm, isNew: boolean, existingKeys: string[]): Partial<Record<keyof FrameForm, string>> {
  const errors: Partial<Record<keyof FrameForm, string>> = {};
  if (!SLUG_PATTERN.test(form.key.trim())) {
    errors.key = 'Lower-case letters, digits and single dashes, 2–39 characters, starting with a letter or digit.';
  } else if (isNew && existingKeys.includes(form.key.trim())) {
    errors.key = 'A frame with that key already exists.';
  }
  const name = form.name.trim();
  if (name.length === 0) errors.name = 'Name is required.';
  else if (name.length > 60) errors.name = 'Name is limited to 60 characters.';
  if (!ACCENT_PATTERN.test(form.accent.trim())) errors.accent = 'Use six hex digits, like #c98a6b.';
  const art = form.artUrl.trim();
  if (art.length === 0) errors.artUrl = 'A frame image is required.';
  else if (!URL_PATTERN.test(art)) errors.artUrl = 'Start the path with / or use https://.';
  if (!/^-?\d+$/.test(form.sortOrder.trim())) errors.sortOrder = 'Must be a whole number.';
  const pricing = validatePricing(form.forSale, form.priceDiamonds, form.periodDays);
  if (pricing.price !== undefined) errors.priceDiamonds = pricing.price;
  if (pricing.days !== undefined) errors.periodDays = pricing.days;
  return errors;
}

function FrameFormModal({ frame, existingKeys, onClose, onSaved }: FrameFormModalProps) {
  const isNew = frame === null;
  const [form, setForm] = useState<FrameForm>(() =>
    frame === null
      ? { key: '', name: '', artUrl: '', accent: '#c98a6b', sortOrder: '0', forSale: true, priceDiamonds: '300', periodDays: '30' }
      : {
          key: frame.key,
          name: frame.name,
          artUrl: frame.art,
          accent: frame.accent,
          sortOrder: String(frame.sortOrder),
          forSale: frame.forSale,
          priceDiamonds: String(frame.priceDiamonds),
          periodDays: frame.periodDays === null ? '' : String(frame.periodDays),
        },
  );
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const errors = validateFrame(form, isNew, existingKeys);
  const hasErrors = Object.keys(errors).length > 0;
  const setField = <K extends keyof FrameForm>(key: K, value: FrameForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (hasErrors || submitting) return;
    setSubmitting(true);
    setServerError(null);
    const input: FrameInput = {
      name: form.name.trim(),
      artUrl: form.artUrl.trim(),
      accent: form.accent.trim(),
      sortOrder: Number.parseInt(form.sortOrder.trim(), 10),
      forSale: form.forSale,
      priceDiamonds: Number.parseInt(form.priceDiamonds.trim() || '0', 10),
      periodDays: form.periodDays.trim() === '' ? null : Number.parseInt(form.periodDays.trim(), 10),
    };
    if (isNew) input.key = form.key.trim();
    try {
      const result = isNew ? await api.createFrame(input) : await api.updateFrame(form.key, input);
      onSaved(result.frame, isNew);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Saving the frame failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={isNew ? 'Create frame' : `Edit “${frame.name}”`}
      subtitle={
        isNew
          ? 'The key is what a receipt stores, so it cannot change later — add a new frame instead.'
          : 'The key stays; members already wearing it keep it.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="frame-form" loading={submitting} disabled={hasErrors}>
            {isNew ? 'Create frame' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id="frame-form" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Key"
            value={form.key}
            onChange={(event) => setField('key', event.target.value)}
            error={errors.key}
            placeholder="ring-bronze"
            disabled={!isNew}
            hint={isNew ? 'Used on receipts and in the store API.' : 'Immutable — members wear this value.'}
            maxLength={39}
          />
          <Input
            label="Display name"
            value={form.name}
            onChange={(event) => setField('name', event.target.value)}
            error={errors.name}
            placeholder="Bronze Ring"
            maxLength={60}
          />
        </div>

        <ArtField
          kind="BADGE"
          label="Frame art"
          value={form.artUrl}
          error={errors.artUrl}
          placeholder="/frames/trace/frame-1.png or https://cdn…"
          hint="A transparent PNG the client draws over the avatar, not around a square."
          onChange={(url) => setField('artUrl', url)}
          onError={setServerError}
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Accent colour"
            value={form.accent}
            onChange={(event) => setField('accent', event.target.value)}
            error={errors.accent}
            hint="Fallback ring colour when the art cannot load."
          />
          <div className="flex items-end gap-2">
            <input
              type="color"
              value={ACCENT_PATTERN.test(form.accent.trim()) ? form.accent.trim() : '#c98a6b'}
              onChange={(event) => setField('accent', event.target.value)}
              aria-label="Pick an accent colour"
              className="h-9 w-16 cursor-pointer rounded-lg border border-edge bg-elevated p-1"
            />
            <span className="grid h-9 flex-1 place-items-center rounded-lg border border-edge/60 bg-elevated/60 text-[11px] text-faint">
              picker
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Sort order"
            inputMode="numeric"
            value={form.sortOrder}
            onChange={(event) => setField('sortOrder', event.target.value)}
            error={errors.sortOrder}
            hint="Frames are published in this order."
          />
          <div className="flex items-end">
            <label className="flex w-full items-center gap-3 rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2.5">
              <Switch
                checked={form.forSale}
                onChange={(next) => {
                  setField('forSale', next);
                  // "Not for sale" requires price 0 in the row's CHECK, and the price box
                  // is disabled then — the switch has to clear it or the form is stuck.
                  if (!next) setField('priceDiamonds', '0');
                }}
                label="Sell this frame"
              />
              <span className="text-xs">
                <span className="font-medium text-ink">For sale</span>{' '}
                <span className="text-faint">— off keeps it a grant-only frame.</span>
              </span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Price (diamonds)"
            inputMode="numeric"
            value={form.priceDiamonds}
            onChange={(event) => setField('priceDiamonds', event.target.value)}
            error={errors.priceDiamonds}
            disabled={!form.forSale}
            hint="Read from the row at purchase time."
          />
          <Input
            label="Rent for (days)"
            inputMode="numeric"
            value={form.periodDays}
            onChange={(event) => setField('periodDays', event.target.value)}
            error={errors.periodDays}
            hint="Empty sells it once and forever."
          />
        </div>

        <div className="flex items-center gap-3 rounded-xl border border-edge/60 bg-elevated/40 p-3">
          <FrameArt
            frame={{
              key: form.key,
              name: form.name,
              art: form.artUrl.trim(),
              accent: ACCENT_PATTERN.test(form.accent.trim()) ? form.accent.trim() : '#c98a6b',
              sortOrder: 0,
              priceDiamonds: 0,
              forSale: form.forSale,
              periodDays: null,
              holders: 0,
            }}
          />
          <p className="text-[11px] leading-relaxed text-faint">
            The art as the seat grid draws it. A ring with a transparent middle sits over the avatar;
            a picture with a background would hide it.
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

function DeleteFrameModal({
  frame,
  onClose,
  onDeleted,
}: {
  frame: ProfileFrame;
  onClose: () => void;
  onDeleted: (key: string, holders: number) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const confirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await api.deleteFrame(frame.key);
      onDeleted(result.key, result.membersStillHolding);
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
      title={`Retire “${frame.name}”?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirm()} loading={submitting}>
            Retire frame
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted">
        <p>
          The shop stops selling the ring and every device stops drawing it.{' '}
          {frame.holders === 0 ? (
            'Nobody holds this key, so no member loses anything.'
          ) : (
            <span>
              <span className="font-semibold text-ink">
                {frame.holders} member{frame.holders === 1 ? '' : 's'}
              </span>{' '}
              keep their receipt — the proof they paid — and their ring simply stops showing until
              the key is added back.
            </span>
          )}
        </p>
        <p className="text-xs text-faint">
          The image file stays in the media library. Deleting ownership rows is not offered: a
          receipt is history, not a setting.
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

function FrameHoldersModal({ frame, onClose }: { frame: ProfileFrame; onClose: () => void }) {
  const [holders, setHolders] = useState<FrameHolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .frameHolders(frame.key)
      .then((result) => {
        if (!cancelled) setHolders(result.holders);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load the holders.');
      });
    return () => {
      cancelled = true;
    };
  }, [frame.key]);

  return (
    <Modal open onClose={onClose} size="md" title={`Who holds “${frame.name}”`} footer={<Button onClick={onClose}>Close</Button>}>
      {error !== null ? (
        <div className="flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
          <IconAlert className="h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : holders === null ? (
        <div className="grid h-32 place-items-center text-violet-300">
          <Spinner className="h-6 w-6" />
        </div>
      ) : holders.length === 0 ? (
        <EmptyState
          title="Nobody holds this ring"
          message="No receipt names this key. The row is still sellable."
          icon={<IconUsers className="h-6 w-6" />}
        />
      ) : (
        <ul className="divide-y divide-edge/50">
          {holders.map((holder) => (
            <li key={holder.userId} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
              <span className="font-medium text-ink">{holder.username}</span>
              <span className="flex items-center gap-2 text-[11px] text-muted">
                <Badge tone={holder.acquiredVia === 'PURCHASE' ? 'green' : 'sky'}>
                  {holder.acquiredVia === 'PURCHASE' ? 'bought' : 'granted'}
                </Badge>
                <span className="tabular-nums">
                  {holder.expiresAt === null ? 'permanent' : `until ${holder.expiresAt.slice(0, 10)}`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
