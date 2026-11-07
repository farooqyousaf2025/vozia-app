// ---------------------------------------------------------------------------
// Promotional banners: the art an operator puts on four fixed surfaces — the
// splash a member sees on cold start, the strip on home, the gift panel and the
// game desk. These are `banners` rows (migration 0028).
//
// Two things this screen exists to make obvious, because both are invisible in
// the table itself:
//
//   1. Whether a saved row is actually on the wall. The page reads the public
//      catalogue phones read, so "published" is proven, not inferred from the
//      switch — and a row that is switched on yet absent is named as the reason
//      (its window, or a ROOM target whose room has closed).
//   2. What a banner achieved. `impressions` and `taps` are the only answer to
//      "did that campaign work", and a DELETE takes them with it, so retiring
//      with the switch is always the first option in the delete dialog.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArtField } from '../components/ui/ArtField';
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
import { Badge } from '../components/ui/Badge';
import {
  IconAlert,
  IconEdit,
  IconImage,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
} from '../components/ui/Icons';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../context/AuthContext';
import { ApiError, api, assetUrl } from '../lib/api';
import type {
  AdminRoom,
  Banner,
  BannerCtaType,
  BannerFormat,
  BannerInput,
  BannerPlacement,
  PublishedBanner,
} from '../types';

// Mirrors BANNER_PLACEMENTS / BANNER_FORMATS / BANNER_CTA_TYPES / BANNER_INTERNAL_TARGETS and the
// CHECK constraints in migration 0028. These are enum columns, not rows, so the server cannot hand
// them over — but a mismatch here is caught by the server's own 400, never stored.
const PLACEMENTS: readonly BannerPlacement[] = ['SPLASH', 'HOME', 'GIFT', 'GAME'];
const FORMATS: readonly BannerFormat[] = ['PNG', 'GIF', 'WEBP', 'JPEG', 'LOTTIE', 'SVGA', 'MP4'];
const CTA_TYPES: readonly BannerCtaType[] = ['NONE', 'INTERNAL', 'ROOM', 'URL'];
const INTERNAL_TARGETS = ['HOME', 'STORE', 'WALLET', 'PROFILE'] as const;

const PLACEMENT_LABEL: Record<BannerPlacement, string> = {
  SPLASH: 'Splash',
  HOME: 'Home',
  GIFT: 'Gift panel',
  GAME: 'Game desk',
};

/** Mirrors `KEY_PATTERN` in banner.service.ts: 2-39 characters, lower-case, no spaces. */
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;
const URL_PATTERN = /^(\/|https:\/\/)/;
const HTTPS_PATTERN = /^https:\/\/\S+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ceiling `MAX_BANNERS_PER_PLACEMENT` puts on one surface. A fifteenth row is stored and never served. */
const PER_PLACEMENT_CAP = 10;

export default function BannersPage() {
  const toast = useToast();
  const { can } = useAuth();
  const canManage = can('config:manage');

  const [banners, setBanners] = useState<Banner[]>([]);
  const [published, setPublished] = useState<PublishedBanner[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState('');
  const [placement, setPlacement] = useState<string>('ALL');
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const [editing, setEditing] = useState<Banner | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Banner | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The public list is read for the same reason the emoji page reads it: a row the operator
      // switched on is not the same fact as a row a phone is handed.
      const [admin, live] = await Promise.all([api.banners(), api.publicBanners()]);
      setBanners(admin.banners);
      setPublished(live.banners);
    } catch (err) {
      setBanners([]);
      setPublished(null);
      setError(err instanceof ApiError ? err.message : 'Failed to load the banner schedule.');
    } finally {
      setLoading(false);
    }
  }, [reloadKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = () => setReloadKey((key) => key + 1);

  const liveIds = useMemo(() => new Set((published ?? []).map((each) => each.id)), [published]);

  const counts = useMemo(() => {
    const byPlacement = new Map<BannerPlacement, number>();
    for (const each of banners) {
      byPlacement.set(each.placement, (byPlacement.get(each.placement) ?? 0) + 1);
    }
    return byPlacement;
  }, [banners]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return banners
      .filter((each) => placement === 'ALL' || each.placement === placement)
      .filter(
        (each) =>
          needle.length === 0 ||
          each.key.includes(needle) ||
          each.title.toLowerCase().includes(needle) ||
          (each.subtitle ?? '').toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          a.placement.localeCompare(b.placement) ||
          a.sortOrder - b.sortOrder ||
          a.createdAt.localeCompare(b.createdAt),
      );
  }, [banners, placement, filter]);

  const onTheWall = published === null ? 0 : published.length;

  const toggleLive = async (banner: Banner) => {
    if (togglingId !== null) return;
    setTogglingId(banner.id);
    try {
      const result = await api.updateBanner(banner.id, { isActive: !banner.isActive });
      setBanners((current) => current.map((each) => (each.id === banner.id ? result.banner : each)));
      toast.success(
        result.banner.isActive
          ? `“${result.banner.title}” switched on.`
          : `“${result.banner.title}” retired — its counts stay here.`,
      );
      void api.publicBanners().then((live) => setPublished(live.banners)).catch(() => setPublished(null));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not change that banner.');
    } finally {
      setTogglingId(null);
    }
  };

  if (loading && banners.length === 0) {
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
          <h1 className="text-xl font-bold text-ink">Promotional banners</h1>
          <p className="mt-0.5 max-w-2xl text-sm text-muted">
            Splash, home, gift panel and game desk. Every banner is art plus one tap target, and a
            phone asks for all four surfaces in one call, so a change here shows up without an app
            update.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button icon={<IconRefresh className="h-4 w-4" />} onClick={refresh}>
            Refresh
          </Button>
          {canManage && (
            <Button
              variant="primary"
              icon={<IconPlus className="h-4 w-4" />}
              onClick={() => setEditing('new')}
            >
              New banner
            </Button>
          )}
        </div>
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
        title={`Schedule (${banners.length})`}
        subtitle={
          published === null
            ? 'The public list could not be read, so nothing here can be confirmed as served.'
            : `${onTheWall} banner${onTheWall === 1 ? '' : 's'} served right now on GET /api/banners — that is what phones receive.`
        }
      >
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <Tabs
            active={placement}
            onChange={setPlacement}
            items={[
              { id: 'ALL', label: 'All surfaces', count: banners.length },
              ...PLACEMENTS.map((each) => ({
                id: each,
                label: PLACEMENT_LABEL[each],
                count: counts.get(each) ?? 0,
                alert: (counts.get(each) ?? 0) > PER_PLACEMENT_CAP,
              })),
            ]}
          />
          <Input
            className="w-full sm:w-64"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            leadingIcon={<IconSearch className="h-4 w-4" />}
            placeholder="Search key or title"
            aria-label="Search banners"
          />
        </div>

        {banners.length === 0 ? (
          <EmptyState
            title="No banners yet"
            message="With no rows, every surface shows only its own content. Add a campaign and upload its art to put something on the wall."
            icon={<IconImage className="h-6 w-6" />}
          />
        ) : shown.length === 0 ? (
          <EmptyState
            title="Nothing matches"
            message={`No banner on ${placement === 'ALL' ? 'any surface' : PLACEMENT_LABEL[placement as BannerPlacement]} contains “${filter.trim()}”.`}
            icon={<IconSearch className="h-6 w-6" />}
          />
        ) : (
          <ul className="space-y-2">
            {shown.map((banner) => (
              <BannerRow
                key={banner.id}
                banner={banner}
                canManage={canManage}
                published={liveIds.has(banner.id)}
                catalogueRead={published !== null}
                toggling={togglingId === banner.id}
                onToggle={() => void toggleLive(banner)}
                onEdit={() => setEditing(banner)}
                onDelete={() => setDeleting(banner)}
              />
            ))}
          </ul>
        )}

        {placement !== 'ALL' && (counts.get(placement as BannerPlacement) ?? 0) > PER_PLACEMENT_CAP && (
          <p className="mt-3 flex items-center gap-2 text-[11px] text-amber-300">
            <IconAlert className="h-4 w-4 shrink-0" />
            {`${PLACEMENT_LABEL[placement as BannerPlacement]} holds ${counts.get(placement as BannerPlacement)} rows; a phone is served the first ${PER_PLACEMENT_CAP} in position order, and the rest are stored but never drawn.`}
          </p>
        )}
        {!canManage && (
          <p className="mt-3 text-[11px] text-faint">
            Your role can read the schedule but not change it; the server refuses these writes too.
          </p>
        )}
      </Card>

      {editing !== null && (
        <BannerFormModal
          banner={editing === 'new' ? null : editing}
          existingKeys={banners.map((each) => each.key)}
          onClose={() => setEditing(null)}
          onSaved={(saved, isNew) => {
            setEditing(null);
            toast.success(isNew ? `Banner “${saved.title}” added.` : `Banner “${saved.title}” saved.`);
            refresh();
          }}
        />
      )}

      {deleting !== null && (
        <DeleteBannerModal
          banner={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(title) => {
            setDeleting(null);
            toast.success(`Banner “${title}” deleted, counts and all.`);
            refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One row. `published` comes from the phone-facing list, so a row that is switched on
// and inside its window but still absent has exactly one remaining reason — its ROOM
// target closed — and the row says so rather than claiming it is live.
// ---------------------------------------------------------------------------
function statusOf(banner: Banner, published: boolean, catalogueRead: boolean) {
  const now = Date.now();
  if (!banner.isActive) return { tone: 'slate' as const, label: 'Switched off' };
  if (banner.startsAt !== null && new Date(banner.startsAt).getTime() > now) {
    return { tone: 'amber' as const, label: `Starts ${shortStamp(banner.startsAt)}` };
  }
  if (banner.endsAt !== null && new Date(banner.endsAt).getTime() <= now) {
    return { tone: 'slate' as const, label: `Ended ${shortStamp(banner.endsAt)}` };
  }
  if (catalogueRead && !published) return { tone: 'red' as const, label: 'Room has closed' };
  return { tone: 'green' as const, label: 'On the wall' };
}

function BannerRow({
  banner,
  canManage,
  published,
  catalogueRead,
  toggling,
  onToggle,
  onEdit,
  onDelete,
}: {
  banner: Banner;
  canManage: boolean;
  published: boolean;
  catalogueRead: boolean;
  toggling: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const status = statusOf(banner, published, catalogueRead);
  const rate = banner.impressions > 0 ? `${((banner.taps / banner.impressions) * 100).toFixed(1)}%` : '—';
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border border-edge/60 bg-elevated/40 p-3">
      <BannerArt url={banner.url} format={banner.format} width={112} height={44} />
      <div className="min-w-[10rem] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-ink" title={banner.title}>
            {banner.title}
          </p>
          <Badge tone="violet">{PLACEMENT_LABEL[banner.placement]}</Badge>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted" title={banner.subtitle ?? ''}>
          {banner.subtitle ?? <span className="text-faint">no subtitle</span>}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-faint">
          <span className="font-mono">{banner.key}</span>
          <span>{banner.format}</span>
          <span>{banner.durationMs === 0 ? 'own length' : `${banner.durationMs} ms`}</span>
          <span title={ctaHint(banner)}>{ctaLabel(banner)}</span>
          <span>#{banner.sortOrder}</span>
        </p>
      </div>
      <div className="w-28 shrink-0 text-right">
        <p className="text-sm font-semibold text-ink">{banner.impressions}</p>
        <p className="text-[10px] uppercase tracking-wide text-faint">impressions</p>
        <p className="mt-0.5 text-xs text-muted">
          {banner.taps} tap{banner.taps === 1 ? '' : 's'} · {rate}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canManage && (
          <Switch
            checked={banner.isActive}
            onChange={onToggle}
            disabled={toggling}
            label={banner.isActive ? `Retire ${banner.key}` : `Publish ${banner.key}`}
          />
        )}
        {toggling && <Spinner className="h-4 w-4 text-violet-300" />}
        {canManage && (
          <div className="flex items-center gap-1">
            <IconButton label={`Edit ${banner.key}`} onClick={onEdit}>
              <IconEdit className="h-4 w-4" />
            </IconButton>
            <IconButton label={`Delete ${banner.key}`} tone="danger" onClick={onDelete}>
              <IconTrash className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      </div>
    </li>
  );
}

function shortStamp(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

function ctaLabel(banner: Banner): string {
  switch (banner.ctaType) {
    case 'NONE':
      return 'no tap action';
    case 'INTERNAL':
      return `→ ${banner.ctaValue ?? '?'}`;
    case 'URL':
      try {
        return `→ ${new URL(banner.ctaValue ?? '').host}`;
      } catch {
        return '→ link';
      }
    case 'ROOM':
      return '→ a live room';
  }
}

function ctaHint(banner: Banner): string {
  if (banner.ctaType === 'ROOM') return `Room id ${banner.ctaValue}`;
  return banner.ctaValue ?? '';
}

// ---------------------------------------------------------------------------
// Art preview. Four of these are things a browser can draw; SVGA is not one of
// them, and saying so here stops an operator reading a blank box as a broken
// upload. A file whose bytes disagree with the chosen format shows the same
// broken frame the member's phone would.
// ---------------------------------------------------------------------------
function BannerArt({
  url,
  format,
  width,
  height,
}: {
  url: string;
  format: BannerFormat;
  width: number;
  height: number;
}) {
  const resolved = assetUrl(url);
  const box = { width, height } as const;
  const shell =
    'shrink-0 overflow-hidden rounded-lg border border-edge/60 bg-surface grid place-items-center';

  if (resolved === undefined) {
    return (
      <span className={shell} style={box}>
        <span className="text-[10px] text-faint">no art</span>
      </span>
    );
  }
  if (format === 'LOTTIE') {
    return <LottiePreview src={url} size={Math.min(width, height)} fallback="bad lottie" className={shell} />;
  }
  if (format === 'MP4') {
    return (
      <video
        src={resolved}
        width={width}
        height={height}
        muted
        loop
        autoPlay
        playsInline
        className={`${shell} object-cover`}
      />
    );
  }
  if (format === 'SVGA') {
    return (
      <span className={`${shell} px-1 text-center`} style={box} title={resolved}>
        <span className="text-[9px] leading-tight text-faint">SVGA: app only</span>
      </span>
    );
  }
  return (
    <img
      src={resolved}
      alt=""
      loading="lazy"
      className={`${shell} object-contain`}
      style={box}
      onError={(event) => {
        event.currentTarget.style.visibility = 'hidden';
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Create / edit.
// ---------------------------------------------------------------------------
interface BannerForm {
  key: string;
  placement: BannerPlacement;
  title: string;
  subtitle: string;
  url: string;
  format: BannerFormat;
  durationMs: string;
  ctaType: BannerCtaType;
  ctaValue: string;
  startsAt: string;
  endsAt: string;
  sortOrder: string;
  isActive: boolean;
}

function emptyForm(): BannerForm {
  return {
    key: '',
    placement: 'HOME',
    title: '',
    subtitle: '',
    url: '',
    format: 'PNG',
    durationMs: '0',
    ctaType: 'NONE',
    ctaValue: '',
    startsAt: '',
    endsAt: '',
    sortOrder: '0',
    isActive: true,
  };
}

function formFrom(banner: Banner): BannerForm {
  return {
    key: banner.key,
    placement: banner.placement,
    title: banner.title,
    subtitle: banner.subtitle ?? '',
    url: banner.url,
    format: banner.format,
    durationMs: String(banner.durationMs),
    ctaType: banner.ctaType,
    ctaValue: banner.ctaValue ?? '',
    startsAt: toLocalInput(banner.startsAt),
    endsAt: toLocalInput(banner.endsAt),
    sortOrder: String(banner.sortOrder),
    isActive: banner.isActive,
  };
}

/** `datetime-local` wants local wall-clock text; the API wants an ISO instant. */
function toLocalInput(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

type BannerField = keyof BannerForm;

function validateBanner(form: BannerForm, isNew: boolean, existingKeys: string[]): Partial<Record<BannerField, string>> {
  const errors: Partial<Record<BannerField, string>> = {};
  const key = form.key.trim();
  if (!KEY_PATTERN.test(key)) {
    errors.key = 'Lower-case letters, digits and inner dashes, 2-39 characters.';
  } else if (isNew && existingKeys.includes(key)) {
    errors.key = `A banner already uses the key ${key}.`;
  }
  const title = form.title.trim();
  if (title.length === 0) errors.title = 'Title is required.';
  else if (title.length > 60) errors.title = 'Title is limited to 60 characters.';
  if (form.subtitle.trim().length > 120) errors.subtitle = 'Subtitle is limited to 120 characters.';
  const url = form.url.trim();
  if (url.length === 0) errors.url = 'An art URL is required.';
  else if (!URL_PATTERN.test(url)) errors.url = 'Start the path with / or use https://.';

  const duration = Number(form.durationMs.trim());
  if (!Number.isInteger(duration) || duration < 0 || duration > 30_000) {
    errors.durationMs = 'Whole milliseconds between 0 and 30000.';
  } else if (duration > 0 && duration < 250) {
    errors.durationMs = 'Either 0 (the surface decides) or at least 250.';
  }

  const order = Number(form.sortOrder.trim());
  if (!Number.isInteger(order) || order < -9999 || order > 9999) errors.sortOrder = 'A whole number from -9999 to 9999.';

  if (form.ctaType !== 'NONE') {
    const value = form.ctaValue.trim();
    if (value.length === 0) {
      errors.ctaValue = form.ctaType === 'ROOM' ? 'Pick the room this opens.' : 'This tap target needs a value.';
    } else if (form.ctaType === 'URL' && !HTTPS_PATTERN.test(value)) {
      errors.ctaValue = 'A full https:// link, no spaces.';
    } else if (form.ctaType === 'ROOM' && !UUID_PATTERN.test(value)) {
      errors.ctaValue = 'That is not a room id.';
    }
  }

  const startsAt = fromLocalInput(form.startsAt);
  const endsAt = fromLocalInput(form.endsAt);
  if (form.startsAt.trim().length > 0 && startsAt === null) errors.startsAt = 'Not a date.';
  if (form.endsAt.trim().length > 0 && endsAt === null) errors.endsAt = 'Not a date.';
  if (startsAt !== null && endsAt !== null && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    errors.endsAt = 'The end must come after the start.';
  }
  return errors;
}

interface BannerFormModalProps {
  banner: Banner | null;
  existingKeys: string[];
  onClose: () => void;
  onSaved: (banner: Banner, isNew: boolean) => void;
}

function BannerFormModal({ banner, existingKeys, onClose, onSaved }: BannerFormModalProps) {
  const isNew = banner === null;
  const [form, setForm] = useState<BannerForm>(() => (isNew ? emptyForm() : formFrom(banner)));
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<AdminRoom[] | null>(null);

  const errors = validateBanner(form, isNew, existingKeys);
  const hasErrors = Object.keys(errors).length > 0;
  const setField = <K extends BannerField>(key: K, value: BannerForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  // The room picker is only fetched when a campaign actually wants one — most never will, and
  // `listRooms` is not a cheap call to make on every open of this dialog.
  useEffect(() => {
    if (form.ctaType !== 'ROOM' || rooms !== null) return;
    let cancelled = false;
    api
      .listRooms({ status: 'ACTIVE' })
      .then((result) => {
        if (!cancelled) setRooms(result.rooms);
      })
      .catch((err) => {
        if (!cancelled) {
          setRooms([]);
          setServerError(err instanceof ApiError ? err.message : 'Could not load live rooms.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [form.ctaType, rooms]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (hasErrors || submitting) return;
    setSubmitting(true);
    setServerError(null);
    const input: BannerInput = {
      placement: form.placement,
      title: form.title.trim(),
      subtitle: form.subtitle.trim().length > 0 ? form.subtitle.trim() : null,
      url: form.url.trim(),
      format: form.format,
      durationMs: Number(form.durationMs.trim()),
      ctaType: form.ctaType,
      ctaValue: form.ctaType === 'NONE' ? null : form.ctaValue.trim(),
      startsAt: fromLocalInput(form.startsAt),
      endsAt: fromLocalInput(form.endsAt),
      sortOrder: Number(form.sortOrder.trim()),
      isActive: form.isActive,
    };
    if (isNew) input.key = form.key.trim();
    try {
      const result = isNew
        ? await api.createBanner(input)
        : await api.updateBanner(banner.id, input);
      onSaved(result.banner, isNew);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Saving the banner failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={isNew ? 'Add banner' : `Edit “${banner.title}”`}
      subtitle={
        isNew
          ? 'The key is how the audit line and any deep link name this campaign, so it cannot be renamed later.'
          : 'The key stays. Everything else — art, surface, window, tap target — is editable.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="banner-form" loading={submitting} disabled={hasErrors}>
            {isNew ? 'Add banner' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id="banner-form" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Key"
            value={form.key}
            onChange={(event) => setField('key', event.target.value)}
            error={errors.key}
            placeholder="winter-event"
            disabled={!isNew}
            hint={isNew ? 'Lower-case, 2-39 characters. Immutable once created.' : 'Immutable — the audit history is spelled after it.'}
            maxLength={39}
          />
          <Select
            label="Surface"
            value={form.placement}
            onChange={(event) => setField('placement', event.target.value as BannerPlacement)}
          >
            {PLACEMENTS.map((each) => (
              <option key={each} value={each}>
                {PLACEMENT_LABEL[each]}
              </option>
            ))}
          </Select>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Title"
            value={form.title}
            onChange={(event) => setField('title', event.target.value)}
            error={errors.title}
            placeholder="Winter event"
            maxLength={60}
            hint="A phone may draw this as a caption; it is never required to."
          />
          <Input
            label="Subtitle"
            value={form.subtitle}
            onChange={(event) => setField('subtitle', event.target.value)}
            error={errors.subtitle}
            placeholder="Double coins all weekend"
            maxLength={120}
          />
        </div>

        <ArtField
          kind="BANNER"
          label="Art URL"
          value={form.url}
          error={errors.url}
          placeholder="/uploads/<uuid>.png or https://cdn…"
          onChange={(url) => setField('url', url)}
          onError={setServerError}
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            label="Format"
            value={form.format}
            onChange={(event) => setField('format', event.target.value as BannerFormat)}
          >
            {FORMATS.map((each) => (
              <option key={each} value={each}>
                {each}
              </option>
            ))}
          </Select>
          <Input
            label="Held for (ms)"
            inputMode="numeric"
            value={form.durationMs}
            onChange={(event) => setField('durationMs', event.target.value)}
            error={errors.durationMs}
            hint="0 lets the surface decide; a moving banner otherwise stops at 30000."
          />
        </div>

        {/* The format is a promise about the bytes, and only the app can keep it: a GIF is drawn as a
            still by a phone that cannot decode animation, and an SVGA has no browser renderer at all. */}
        <div className="flex items-center gap-3 rounded-xl border border-edge/60 bg-elevated/40 p-3">
          <BannerArt url={form.url.trim()} format={form.format} width={168} height={64} />
          <p className="text-[11px] leading-relaxed text-faint">
            {`This is what the ${PLACEMENT_LABEL[form.placement].toLowerCase()} will draw. `}
            {form.format === 'SVGA'
              ? 'An SVGA cannot be previewed in a browser — it plays only in the app, so check the file there.'
              : form.format === 'MP4'
                ? 'A video plays muted and loops in the console; on a phone it plays once per hold.'
                : form.format === 'LOTTIE'
                  ? 'A Lottie scene loops here; on a phone it runs for the hold time above.'
                  : 'A static image never animates, on either surface.'}
          </p>
        </div>

        <div className="rounded-xl border border-edge/60 bg-elevated/20 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Tap target</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select
              label="On tap"
              value={form.ctaType}
              onChange={(event) => {
                const next = event.target.value as BannerCtaType;
                setForm((current) => ({
                  ...current,
                  ctaType: next,
                  // A target typed for one verb means nothing to another, so changing the verb clears
                  // it — the operator picks deliberately instead of saving a room id into a link box.
                  ctaValue:
                    next === current.ctaType ? current.ctaValue : next === 'INTERNAL' ? 'HOME' : '',
                }));
              }}
            >
              {CTA_TYPES.map((each) => (
                <option key={each} value={each}>
                  {each === 'NONE'
                    ? 'Nothing'
                    : each === 'INTERNAL'
                      ? 'An app screen'
                      : each === 'ROOM'
                        ? 'A live room'
                        : 'An external link'}
                </option>
              ))}
            </Select>

            {form.ctaType === 'INTERNAL' && (
              <Select
                label="Screen"
                value={INTERNAL_TARGETS.includes(form.ctaValue as (typeof INTERNAL_TARGETS)[number]) ? form.ctaValue : 'HOME'}
                onChange={(event) => setField('ctaValue', event.target.value)}
              >
                {INTERNAL_TARGETS.map((each) => (
                  <option key={each} value={each}>
                    {each}
                  </option>
                ))}
              </Select>
            )}

            {form.ctaType === 'ROOM' && (
              <Select
                label="Room"
                value={form.ctaValue}
                error={errors.ctaValue}
                onChange={(event) => setField('ctaValue', event.target.value)}
              >
                <option value="">
                  {rooms === null ? 'Loading live rooms…' : rooms.length === 0 ? 'No live rooms' : 'Choose a room'}
                </option>
                {(rooms ?? []).map((room) => (
                  <option key={room.id} value={room.id}>
                    {`#${room.roomNumber} · ${room.title} · ${room.host.username}`}
                  </option>
                ))}
                {form.ctaValue.length > 0 && !(rooms ?? []).some((room) => room.id === form.ctaValue) && (
                  <option value={form.ctaValue}>{`${form.ctaValue.slice(0, 8)}… (not live)`}</option>
                )}
              </Select>
            )}

            {form.ctaType === 'URL' && (
              <Input
                label="Link"
                value={form.ctaValue}
                error={errors.ctaValue}
                onChange={(event) => setField('ctaValue', event.target.value)}
                placeholder="https://…"
                maxLength={300}
                hint="Opened outside the app, so https only."
              />
            )}

            {form.ctaType === 'NONE' && (
              <p className="self-end pb-2 text-[11px] text-faint">
                A banner nobody can tap is fine for a splash. Anything the member could act on should
                point somewhere.
              </p>
            )}
          </div>
          {form.ctaType === 'ROOM' && (
            <p className="mt-2 text-[11px] text-faint">
              When that room closes, the banner stops being served everywhere — it does not turn into a
              broken tap.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input
            label="Starts (local)"
            type="datetime-local"
            value={form.startsAt}
            error={errors.startsAt}
            onChange={(event) => setField('startsAt', event.target.value)}
          />
          <Input
            label="Ends (local)"
            type="datetime-local"
            value={form.endsAt}
            error={errors.endsAt}
            onChange={(event) => setField('endsAt', event.target.value)}
          />
          <Input
            label="Position"
            inputMode="numeric"
            value={form.sortOrder}
            error={errors.sortOrder}
            onChange={(event) => setField('sortOrder', event.target.value)}
            hint="Lowest first within the surface."
          />
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-edge/60 bg-elevated/40 p-3">
          <div>
            <p className="text-sm font-medium text-ink">Switched on</p>
            <p className="text-[11px] text-faint">
              Off keeps this row, its window and its counts, and hides it from every phone.
            </p>
          </div>
          <Switch checked={form.isActive} onChange={(next) => setField('isActive', next)} label="Switched on" />
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

function DeleteBannerModal({
  banner,
  onClose,
  onDeleted,
}: {
  banner: Banner;
  onClose: () => void;
  onDeleted: (title: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const confirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      await api.deleteBanner(banner.id);
      onDeleted(banner.title);
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
      title={`Delete “${banner.title}”?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirm()} loading={submitting}>
            Delete banner
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted">
        <p>
          {`${banner.impressions} impression${banner.impressions === 1 ? '' : 's'} and ${banner.taps} tap${banner.taps === 1 ? '' : 's'} were counted on this row. `}
          <span className="font-semibold text-ink">A delete takes those numbers with it</span> — there is
          no other record of what the campaign did.
        </p>
        <p className="text-xs text-faint">
          Switching it off instead keeps the row, the window and the counts, and hides it from every
          phone the same way. Use the key only for a duplicate or art that has to come down.
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
