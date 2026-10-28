// ---------------------------------------------------------------------------
// Virtual Store Manager: gift grid, full create/edit modal with live
// validation, delete confirmation and inline active toggle.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, type BadgeTone } from '../components/ui/Badge';
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
import { useToast } from '../components/ui/Toast';
import {
  IconAlert,
  IconCoin,
  IconDiamond,
  IconEdit,
  IconGift,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '../components/ui/Icons';
import { ApiError, api, assetUrl } from '../lib/api';
import { formatCompact } from '../lib/format';
import type { Gift, GiftInput } from '../types';

const GIFT_CATEGORIES = ['ROSE', 'SPECIAL', 'LUXURY', 'EVENT'] as const;

const GIFT_EFFECT_KINDS = ['TICKER', 'FULLSCREEN'] as const;

const CATEGORY_TONES: Record<string, BadgeTone> = {
  ROSE: 'pink',
  SPECIAL: 'violet',
  LUXURY: 'amber',
  EVENT: 'fuchsia',
};

export default function GiftsPage() {
  const toast = useToast();
  const [gifts, setGifts] = useState<Gift[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Gift | 'new' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Gift | null>(null);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listGifts();
      setGifts(result.gifts);
    } catch (err) {
      setGifts([]);
      setError(err instanceof ApiError ? err.message : 'Failed to load the gift catalogue.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replaceGift = (gift: Gift) => {
    setGifts((current) =>
      current === null ? [gift] : current.map((g) => (g.id === gift.id ? gift : g)),
    );
  };

  const toggleActive = async (gift: Gift) => {
    if (togglingIds.has(gift.id)) return;
    setTogglingIds((ids) => new Set(ids).add(gift.id));
    try {
      const result = await api.updateGift(gift.id, { isActive: !gift.isActive });
      replaceGift(result.gift);
      toast.success(`${gift.name} ${result.gift.isActive ? 'enabled' : 'disabled'}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Toggle failed.');
    } finally {
      setTogglingIds((ids) => {
        const next = new Set(ids);
        next.delete(gift.id);
        return next;
      });
    }
  };

  const sorted = [...(gifts ?? [])].sort(
    (a, b) => a.sortOrder - b.sortOrder || (a.name < b.name ? -1 : 1),
  );

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Virtual Store</h1>
          <p className="mt-0.5 text-sm text-muted">
            The gift catalogue users spend diamonds on; hosts earn the R-coin value.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button icon={<IconRefresh className="h-4 w-4" />} onClick={() => void load()}>
            Refresh
          </Button>
          <Button variant="primary" icon={<IconPlus className="h-4 w-4" />} onClick={() => setEditing('new')}>
            New gift
          </Button>
        </div>
      </div>

      {loading && gifts === null ? (
        <div className="grid h-64 place-items-center text-violet-300">
          <Spinner className="h-8 w-8" />
        </div>
      ) : error !== null ? (
        <div className="panel flex items-center gap-3 border-rose-500/40 p-4 text-sm text-rose-200">
          <IconAlert className="h-5 w-5 shrink-0" />
          <span className="flex-1">{error}</span>
          <Button size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : sorted.length === 0 ? (
        <Card bodyClassName="p-0">
          <EmptyState
            title="No gifts yet"
            message="Create the first gift so rooms have something to celebrate with."
            icon={<IconGift className="h-6 w-6" />}
            action={
              <Button variant="primary" icon={<IconPlus className="h-4 w-4" />} onClick={() => setEditing('new')}>
                New gift
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {sorted.map((gift) => (
            <Card key={gift.id} className={`transition hover:border-violet-500/40 ${gift.isActive ? '' : 'opacity-60'}`}>
              <div className="flex items-start gap-3">
                <GiftIconPreview url={gift.iconUrl} name={gift.name} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-ink">{gift.name}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge tone={CATEGORY_TONES[gift.category] ?? 'slate'}>{gift.category}</Badge>
                    <Badge tone={gift.effectKind === 'FULLSCREEN' ? 'fuchsia' : 'slate'}>
                      {gift.effectKind === 'FULLSCREEN' ? 'full-screen' : 'ticker'}
                    </Badge>
                    {gift.minVipLevel > 0 && <Badge tone="sky">VIP {gift.minVipLevel}+</Badge>}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Switch
                    checked={gift.isActive}
                    onChange={() => void toggleActive(gift)}
                    disabled={togglingIds.has(gift.id)}
                    label={gift.isActive ? `Disable ${gift.name}` : `Enable ${gift.name}`}
                  />
                  {togglingIds.has(gift.id) && <Spinner className="h-3.5 w-3.5 text-violet-300" />}
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div className="flex items-center gap-1.5 rounded-lg bg-elevated/50 px-2.5 py-1.5">
                  <IconDiamond className="h-4 w-4 text-violet-300" />
                  <span className="font-bold tabular-nums text-ink">{formatCompact(gift.diamondPrice)}</span>
                  <span className="text-[11px] text-faint">cost</span>
                </div>
                <div className="flex items-center gap-1.5 rounded-lg bg-elevated/50 px-2.5 py-1.5">
                  <IconCoin className="h-4 w-4 text-fuchsia-300" />
                  <span className="font-bold tabular-nums text-ink">{formatCompact(gift.rCoinValue)}</span>
                  <span className="text-[11px] text-faint">payout</span>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between border-t border-edge/50 pt-2.5">
                <p className="text-[11px] text-faint">
                  order {gift.sortOrder} ·{' '}
                  {gift.animationUrl ? 'has animation' : 'static icon'}
                </p>
                <div className="flex items-center gap-1">
                  <IconButton label={`Edit ${gift.name}`} onClick={() => setEditing(gift)}>
                    <IconEdit className="h-4 w-4" />
                  </IconButton>
                  <IconButton label={`Delete ${gift.name}`} tone="danger" onClick={() => setDeleteTarget(gift)}>
                    <IconTrash className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing !== null && (
        <GiftFormModal
          gift={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(gift, isNew) => {
            if (isNew) {
              setGifts((current) => [...(current ?? []), gift]);
            } else {
              replaceGift(gift);
            }
            setEditing(null);
            toast.success(isNew ? `Gift “${gift.name}” created.` : `Gift “${gift.name}” saved.`);
          }}
        />
      )}

      {deleteTarget !== null && (
        <DeleteGiftModal
          gift={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setGifts((current) => (current ?? []).filter((g) => g.id !== deleteTarget.id));
            setDeleteTarget(null);
            toast.success(`Gift “${deleteTarget.name}” deleted.`);
          }}
        />
      )}
    </div>
  );
}

function GiftIconPreview({ url, name }: { url: string | null; name: string }) {
  const resolved = assetUrl(url);
  return (
    <span className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-xl border border-edge/60 bg-elevated">
      {resolved ? (
        <img
          src={resolved}
          alt={name}
          loading="lazy"
          className="h-full w-full object-contain"
          onError={(event) => {
            const target = event.currentTarget;
            target.style.visibility = 'hidden';
          }}
        />
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Create / edit form modal with live validation on every field.
// ---------------------------------------------------------------------------
interface GiftFormModalProps {
  gift: Gift | null; // null => create
  onClose: () => void;
  onSaved: (gift: Gift, isNew: boolean) => void;
}

interface FormState {
  name: string;
  iconUrl: string;
  animationUrl: string;
  soundUrl: string;
  diamondPrice: string;
  rCoinValue: string;
  category: string;
  effectKind: string;
  minVipLevel: string;
  sortOrder: string;
  isActive: boolean;
}

function emptyForm(): FormState {
  return {
    name: '',
    iconUrl: '',
    animationUrl: '',
    soundUrl: '',
    diamondPrice: '',
    rCoinValue: '',
    category: 'SPECIAL',
    effectKind: 'TICKER',
    minVipLevel: '0',
    sortOrder: '0',
    isActive: true,
  };
}

function giftToForm(gift: Gift): FormState {
  return {
    name: gift.name,
    iconUrl: gift.iconUrl,
    animationUrl: gift.animationUrl ?? '',
    soundUrl: gift.soundUrl ?? '',
    diamondPrice: String(gift.diamondPrice),
    rCoinValue: String(gift.rCoinValue),
    category: gift.category,
    effectKind: gift.effectKind === 'FULLSCREEN' ? 'FULLSCREEN' : 'TICKER',
    minVipLevel: String(gift.minVipLevel),
    sortOrder: String(gift.sortOrder),
    isActive: gift.isActive,
  };
}

function parseNonNegativeInt(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validate(form: FormState): Partial<Record<keyof FormState, string>> {
  const errors: Partial<Record<keyof FormState, string>> = {};
  const name = form.name.trim();
  if (name.length === 0) errors.name = 'Name is required.';
  else if (name.length > 40) errors.name = 'Name is limited to 40 characters.';
  if (form.iconUrl.trim().length === 0) errors.iconUrl = 'Icon URL is required.';
  const price = parseNonNegativeInt(form.diamondPrice);
  if (price === null) errors.diamondPrice = 'Must be a whole number.';
  else if (price <= 0) errors.diamondPrice = 'Diamond price must be greater than 0.';
  if (parseNonNegativeInt(form.rCoinValue) === null) errors.rCoinValue = 'Must be 0 or a positive whole number.';
  if (parseNonNegativeInt(form.minVipLevel) === null) errors.minVipLevel = 'Must be 0 or a positive whole number.';
  if (!/^-?\d+$/.test(form.sortOrder.trim())) errors.sortOrder = 'Must be a whole number.';
  return errors;
}

function GiftFormModal({ gift, onClose, onSaved }: GiftFormModalProps) {
  const isNew = gift === null;
  const [form, setForm] = useState<FormState>(() => (gift === null ? emptyForm() : giftToForm(gift)));
  const [touched, setTouched] = useState<Set<keyof FormState>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const errors = validate(form);
  const hasErrors = Object.keys(errors).length > 0;

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setTouched((current) => new Set(current).add(key));
  };

  const errorFor = (key: keyof FormState): string | null =>
    touched.has(key) ? errors[key] ?? null : null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (hasErrors || submitting) return;
    setSubmitting(true);
    setServerError(null);

    const input: GiftInput = {
      name: form.name.trim(),
      iconUrl: form.iconUrl.trim(),
      animationUrl: form.animationUrl.trim() === '' ? null : form.animationUrl.trim(),
      soundUrl: form.soundUrl.trim() === '' ? null : form.soundUrl.trim(),
      diamondPrice: parseNonNegativeInt(form.diamondPrice) as number,
      rCoinValue: parseNonNegativeInt(form.rCoinValue) as number,
      category: form.category,
      effectKind: form.effectKind,
      minVipLevel: parseNonNegativeInt(form.minVipLevel) as number,
      sortOrder: Number.parseInt(form.sortOrder.trim(), 10),
      isActive: form.isActive,
    };

    try {
      const result = isNew ? await api.createGift(input) : await api.updateGift(gift.id, input);
      onSaved(result.gift, isNew);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Saving the gift failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={isNew ? 'Create gift' : `Edit “${gift.name}”`}
      subtitle={
        isNew
          ? 'New gifts go live for everyone as soon as they are saved and active.'
          : 'Partial updates are sent via PUT; unchanged fields are simply re-sent.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="gift-form" loading={submitting} disabled={hasErrors}>
            {isNew ? 'Create gift' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id="gift-form" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Name"
            value={form.name}
            onChange={(e) => setField('name', e.target.value)}
            error={errorFor('name')}
            placeholder="Golden Rose"
            maxLength={40}
          />
          <Select label="Category" value={form.category} onChange={(e) => setField('category', e.target.value)}>
            {GIFT_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </Select>
        </div>

        <ArtField
          kind="GIFT_ICON"
          label="Icon URL"
          value={form.iconUrl}
          error={errorFor('iconUrl')}
          placeholder="/gifts/rose.png or https://cdn…"
          onChange={(url) => setField('iconUrl', url)}
          onError={setServerError}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ArtField
            kind="GIFT_ANIMATION"
            label="Animation URL (optional)"
            value={form.animationUrl}
            placeholder="/gifts/rose.json (Lottie)"
            hint="Full-screen overlay clients play; leave empty for a particle burst."
            onChange={(url) => setField('animationUrl', url)}
            onError={setServerError}
          />
          <ArtField
            kind="GIFT_SOUND"
            label="Sound URL (optional)"
            value={form.soundUrl}
            placeholder="/gifts/rose.mp3"
            onChange={(url) => setField('soundUrl', url)}
            onError={setServerError}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            label="Effect"
            value={form.effectKind}
            onChange={(e) => setField('effectKind', e.target.value)}
          >
            {GIFT_EFFECT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind === 'TICKER' ? 'Ticker — scrolls in the side column' : 'Full screen — takes over the room'}
              </option>
            ))}
          </Select>
          <p className="self-end pb-2 text-[11px] leading-relaxed text-faint">
            How loud this gift plays for everyone in the room. Only the expensive scenes
            should take the screen over; anything else — including a gift whose tier an
            older row never set — reads as a ticker.
          </p>
        </div>

        <div className="flex items-center gap-3 rounded-xl border border-edge/60 bg-elevated/40 p-3">
          <GiftIconPreview url={form.iconUrl} name={form.name || 'gift preview'} />
          <LottiePreview
            src={form.animationUrl}
            size={88}
            className="shrink-0 rounded-xl border border-edge/60 bg-elevated"
            fallback="no animation"
          />
          <p className="text-[11px] leading-relaxed text-faint">
            Icon on the left, Lottie overlay on the right. The animation plays full-screen for
            everyone in the room; with none set the client falls back to a particle burst.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Input
            label="Diamond price"
            inputMode="numeric"
            value={form.diamondPrice}
            onChange={(e) => setField('diamondPrice', e.target.value)}
            error={errorFor('diamondPrice')}
            placeholder="20"
          />
          <Input
            label="R-coin value"
            inputMode="numeric"
            value={form.rCoinValue}
            onChange={(e) => setField('rCoinValue', e.target.value)}
            error={errorFor('rCoinValue')}
            placeholder="18"
          />
          <Input
            label="Min VIP level"
            inputMode="numeric"
            value={form.minVipLevel}
            onChange={(e) => setField('minVipLevel', e.target.value)}
            error={errorFor('minVipLevel')}
          />
          <Input
            label="Sort order"
            inputMode="numeric"
            value={form.sortOrder}
            onChange={(e) => setField('sortOrder', e.target.value)}
            error={errorFor('sortOrder')}
          />
        </div>

        <label className="flex items-center gap-3 rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2.5">
          <Switch checked={form.isActive} onChange={(next) => setField('isActive', next)} label="Active" />
          <span className="text-sm">
            <span className="font-medium text-ink">Active</span>{' '}
            <span className="text-xs text-faint">— inactive gifts stay hidden in clients’ stores.</span>
          </span>
        </label>

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

// ---------------------------------------------------------------------------
// Delete confirmation.
// ---------------------------------------------------------------------------
interface DeleteGiftModalProps {
  gift: Gift;
  onClose: () => void;
  onDeleted: () => void;
}

function DeleteGiftModal({ gift, onClose, onDeleted }: DeleteGiftModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const confirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      await api.deleteGift(gift.id);
      onDeleted();
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
      title={`Delete “${gift.name}”?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirm()} loading={submitting}>
            Delete gift
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted">
        <p>
          This removes <span className="font-semibold text-ink">{gift.name}</span> (
          {formatCompact(gift.diamondPrice)} diamonds) from the store. Past gift transactions keep their
          history; the catalogue row itself is gone.
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
