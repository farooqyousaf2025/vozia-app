// ---------------------------------------------------------------------------
// Virtual Store Manager: gift grid, full create/edit modal with live
// validation, delete confirmation and inline active toggle, the category
// shelves the phone's gift panel is tabbed by, lucky gift boxes with their own
// prize odds and payout guard, and what the catalogue earned.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { ArtField } from '../components/ui/ArtField';
import { Button, IconButton } from '../components/ui/Button';
import { Card, StatCard } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { LottiePreview } from '../components/ui/LottiePreview';
import { Modal } from '../components/ui/Modal';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import {
  IconAlert,
  IconClose,
  IconCoin,
  IconDiamond,
  IconEdit,
  IconGift,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconTrendUp,
  IconUsers,
} from '../components/ui/Icons';
import { ApiError, api, assetUrl } from '../lib/api';
import { formatCompact, formatDiamonds, formatRCoin } from '../lib/format';
import {
  BPS_FULL,
  MAX_BOX_PRIZES,
  MAX_PRIZE_LABEL_CHARS,
  type BoxPrizeDraft,
  type DraftPrizeError,
  boxEconomics,
  describeBoxErrorCode,
  draftToOutcomes,
  draftsDifferFromOutcomes,
  expectedMultiplierBps,
  formatMultiplier,
  formatOdds,
  formatRatioPercent,
  outcomesToDrafts,
  outcomesToWeights,
  parseSharePercent,
  payoutRatioBps,
  prizeWeightOf,
  readPrizeRows,
  sharePercentToInput,
  totalWeight,
  validateDraftPrizes,
} from '../lib/lucky-box';
import type {
  BoxOutcomeDto,
  Gift,
  GiftAnalyticsResult,
  GiftAnalyticsRow,
  GiftCategoryRow,
  GiftInput,
} from '../types';

/** Mirrors the CHECK constraint migration 0025 put on `gift_categories.key`; the server upper-cases first. */
const CATEGORY_KEY_PATTERN = /^[A-Z0-9][A-Z0-9_]{1,23}$/;
/** The bounds `requireString`/`requireInt` enforce on a category write. */
const CATEGORY_NAME_MAX = 40;
const CATEGORY_ORDER_LIMIT = 9999;
const ANALYTICS_WINDOWS = [7, 30, 90] as const;

const GIFT_EFFECT_KINDS = ['TICKER', 'FULLSCREEN'] as const;
/**
 * Mirrors `GIFT_ANIMATION_FORMATS` on the server. The upload guard decides a file's container from
 * its bytes, so this choice has to name the same thing the animation URL points at — a `.mp4`
 * listed as LOTTIE reaches the phone as a file the Lottie player cannot open.
 */
const GIFT_ANIMATION_FORMATS = ['LOTTIE', 'SVGA', 'MP4'] as const;
const FORMAT_LABELS: Record<(typeof GIFT_ANIMATION_FORMATS)[number], string> = {
  LOTTIE: 'Lottie — .json vector scene (what the app has always played)',
  SVGA: 'SVGA — .svga sprite scene',
  MP4: 'MP4 — .mp4 video',
};
/** The ranges the server accepts; mirrored here so an out-of-range value is caught before the POST. */
const MAX_DURATION_MS = 30_000;
const MAX_DISPLAY_PRIORITY = 1_000;
const MIN_COMBO_WINDOW_MS = 1_000;
const MAX_COMBO_WINDOW_MS = 15_000;
const CATEGORY_TONES: Record<string, BadgeTone> = {
  ROSE: 'pink',
  SPECIAL: 'violet',
  LUXURY: 'amber',
  EVENT: 'fuchsia',
};

export default function GiftsPage() {
  const toast = useToast();
  const [gifts, setGifts] = useState<Gift[] | null>(null);
  const [categories, setCategories] = useState<GiftCategoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Gift | 'new' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Gift | null>(null);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  const [editingCategory, setEditingCategory] = useState<GiftCategoryRow | 'new' | null>(null);
  const [deleteCategoryTarget, setDeleteCategoryTarget] = useState<GiftCategoryRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [giftResult, categoryResult] = await Promise.all([api.listGifts(), api.giftCategories()]);
      setGifts(giftResult.gifts);
      setCategories(categoryResult.categories);
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

  /**
   * The shelf counts decide whether a delete will be refused, so a gift filed or removed underneath
   * a shelf has to re-read them rather than leave the grid showing a number the server disagrees with.
   */
  const loadCategories = useCallback(async () => {
    try {
      const result = await api.giftCategories();
      setCategories(result.categories);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to reload the gift categories.');
    }
  }, [toast]);

  const replaceGift = (gift: Gift) => {
    setGifts((current) =>
      current === null ? [gift] : current.map((g) => (g.id === gift.id ? gift : g)),
    );
  };

  const replaceCategory = (category: GiftCategoryRow) => {
    setCategories((current) => {
      const next = current.some((each) => each.key === category.key)
        ? current.map((each) => (each.key === category.key ? category : each))
        : [...current, category];
      // The server returns this order; keeping it locally means a tab move shows up without a reload.
      return next.sort((a, b) => a.sortOrder - b.sortOrder || (a.key < b.key ? -1 : 1));
    });
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

  const categoryName = useMemo(() => new Map(categories.map((c) => [c.key, c.name])), [categories]);

  // The shelves are read with the gifts, so a failed load shows its banner rather than an empty
  // shelf list that would read as "the operator has categorised nothing".
  const showCategories = error === null && !(loading && gifts === null);

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Virtual Store</h1>
          <p className="mt-0.5 text-sm text-muted">
            The gift catalogue users spend diamonds on; hosts earn the R-coin value — or, on a lucky
            box, the share of a pool the server rolls per unit sent.
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
                    <Badge tone={CATEGORY_TONES[gift.category] ?? 'slate'}>
                      {categoryName.get(gift.category) ?? gift.category}
                    </Badge>
                    <Badge tone={gift.effectKind === 'FULLSCREEN' ? 'fuchsia' : 'slate'}>
                      {gift.effectKind === 'FULLSCREEN' ? 'full-screen' : 'ticker'}
                    </Badge>
                    {gift.minVipLevel > 0 && <Badge tone="sky">VIP {gift.minVipLevel}+</Badge>}
                    {gift.animationFormat !== 'LOTTIE' && <Badge tone="amber">{gift.animationFormat}</Badge>}
                    {gift.comboEnabled && (
                      <Badge tone="slate">combo {Math.round((gift.comboWindowMs ?? 0) / 1000)}s</Badge>
                    )}
                    {gift.isLuckyBox && <Badge tone="amber">box</Badge>}
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

              {gift.isLuckyBox && (
                <BoxOddsStrip outcomes={gift.boxOutcomes ?? []} receiverShareBps={gift.receiverShareBps ?? BPS_FULL} />
              )}

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

      {showCategories && (
        <CategoriesCard
          categories={categories}
          onCreate={() => setEditingCategory('new')}
          onEdit={setEditingCategory}
          onDelete={setDeleteCategoryTarget}
        />
      )}

      <GiftAnalyticsSection categories={categories} />

      {editing !== null && (
        <GiftFormModal
          gift={editing === 'new' ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={(gift, isNew) => {
            if (isNew) {
              setGifts((current) => [...(current ?? []), gift]);
            } else {
              replaceGift(gift);
            }
            setEditing(null);
            void loadCategories();
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
            void loadCategories();
            toast.success(`Gift “${deleteTarget.name}” deleted.`);
          }}
        />
      )}

      {editingCategory !== null && (
        <CategoryFormModal
          category={editingCategory === 'new' ? null : editingCategory}
          existingKeys={categories.map((each) => each.key)}
          onClose={() => setEditingCategory(null)}
          onSaved={(category, isNew) => {
            replaceCategory(category);
            setEditingCategory(null);
            toast.success(isNew ? `Category “${category.name}” added.` : `Category “${category.name}” saved.`);
          }}
        />
      )}

      {deleteCategoryTarget !== null && (
        <DeleteCategoryModal
          category={deleteCategoryTarget}
          onClose={() => setDeleteCategoryTarget(null)}
          onDeleted={(key) => {
            setCategories((current) => current.filter((each) => each.key !== key));
            setDeleteCategoryTarget(null);
            toast.success(`Category ${key} deleted.`);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The shelves the phone's gift panel is tabbed by. Labels and order are the
// operator's, so this list is the only place the panel learns what exists —
// hardcoding a key here would hide one they just added.
// ---------------------------------------------------------------------------
function CategoriesCard({
  categories,
  onCreate,
  onEdit,
  onDelete,
}: {
  categories: GiftCategoryRow[];
  onCreate: () => void;
  onEdit: (category: GiftCategoryRow) => void;
  onDelete: (category: GiftCategoryRow) => void;
}) {
  return (
    <Card
      bodyClassName="p-0"
      title={`Categories (${categories.length})`}
      subtitle="The tabs a phone builds its gift panel from, in this order. A key is an identity — gifts are filed under it — so a rename edits the label, never the key."
      actions={
        <Button variant="primary" size="sm" icon={<IconPlus className="h-4 w-4" />} onClick={onCreate}>
          New category
        </Button>
      }
    >
      {categories.length === 0 ? (
        <EmptyState
          title="No gift categories"
          message="Until a shelf exists, no gift can be filed and no phone can list a tab. Add one to start the catalogue."
          icon={<IconGift className="h-6 w-6" />}
        />
      ) : (
        <Table>
          <THead>
            <Th width="20%">Key</Th>
            <Th width="30%">Tab label</Th>
            <Th align="right">Order</Th>
            <Th align="right">Gifts</Th>
            <Th align="right" className="pr-5">
              Actions
            </Th>
          </THead>
          <TBody>
            {categories.map((category) => (
              <Tr key={category.key}>
                <Td className="font-mono text-xs text-ink">{category.key}</Td>
                <Td className="truncate text-sm text-muted">{category.name}</Td>
                <Td align="right" className="tabular-nums">
                  {category.sortOrder}
                </Td>
                <Td align="right" className="tabular-nums">
                  {category.gifts === 0 ? (
                    <span className="text-faint">empty shelf</span>
                  ) : (
                    `${category.gifts} on the shelf`
                  )}
                </Td>
                <Td align="right" className="pr-5">
                  <div className="flex items-center justify-end gap-1">
                    <IconButton label={`Edit ${category.name}`} onClick={() => onEdit(category)}>
                      <IconEdit className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      label={`Delete ${category.name}`}
                      tone="danger"
                      onClick={() => onDelete(category)}
                    >
                      <IconTrash className="h-4 w-4" />
                    </IconButton>
                  </div>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

function GiftIconPreview({ url, name, size = 56 }: { url: string | null; name: string; size?: number }) {
  const resolved = assetUrl(url);
  return (
    <span
      className="grid shrink-0 place-items-center overflow-hidden rounded-xl border border-edge/60 bg-elevated"
      style={{ width: size, height: size }}
    >
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
// A box's odds where the catalogue is read, not edited.
//
// The prize table is the only thing that says what a gift like this pays — the price column says what
// it costs — so a card that printed the price alone would make an operator open the editor to answer
// a question they ask about every box in the list. Rows come out in the order the draw walks them,
// with the same `chanceBps` a phone publishes and the weight behind it, because the two numbers
// disagreeing is a bug an operator should be able to see from the grid.
// ---------------------------------------------------------------------------
function BoxOddsStrip({ outcomes, receiverShareBps }: { outcomes: BoxOutcomeDto[]; receiverShareBps: number }) {
  const prizes = outcomesToWeights(outcomes);
  const weight = totalWeight(prizes);
  const expected = expectedMultiplierBps(prizes);
  const payout = payoutRatioBps(expected, receiverShareBps);
  const overGuarded = payout > BPS_FULL;

  return (
    <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
      {outcomes.length === 0 ? (
        <p className="text-[11px] text-amber-200">
          A box with no prizes stored — nothing can be rolled from it. Open the editor and save a prize
          table; the server refuses an empty draw for exactly this reason.
        </p>
      ) : (
        <>
          <ul className={`space-y-1 ${outcomes.length > 5 ? 'max-h-32 overflow-y-auto pr-1' : ''}`}>
            {outcomes.map((outcome, index) => {
              const rowWeight = prizeWeightOf(outcome);
              return (
                <li key={`${outcome.label}-${index}`} className="flex items-baseline gap-1.5 text-[11px]">
                  <span className="w-12 shrink-0 font-bold tabular-nums text-ink">
                    {formatMultiplier(outcome.multiplierBps)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted" title={outcome.label}>
                    {outcome.label}
                  </span>
                  <span className="shrink-0 tabular-nums text-amber-200" title={`${outcome.chanceBps} bps of the box`}>
                    {formatOdds(rowWeight, weight)}
                    <span className="text-faint"> · {outcome.chanceBps} bps</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 border-t border-amber-500/20 pt-1.5 text-[11px] leading-relaxed text-faint">
            Rolls{' '}
            <span className="font-semibold tabular-nums text-ink">{formatMultiplier(expected)}</span> on
            average ·{' '}
            <span className={overGuarded ? 'font-semibold text-rose-300' : 'text-muted'}>
              pays {formatRatioPercent(payout)} of what it sells for
            </span>{' '}
            · the box banks {formatRatioPercent(BPS_FULL - receiverShareBps)}.
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit form modal with live validation on every field.
// ---------------------------------------------------------------------------
interface GiftFormModalProps {
  gift: Gift | null; // null => create
  /** `gift_categories` as the server has them now; the editor offers no other shelf. */
  categories: GiftCategoryRow[];
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
  animationFormat: string;
  durationMs: string;
  displayPriority: string;
  comboEnabled: boolean;
  comboWindowMs: string;
  minVipLevel: string;
  sortOrder: string;
  isActive: boolean;
  /** The lucky box switch, and the two dials a box is made of. See `LuckyBoxFields`. */
  isLuckyBox: boolean;
  /** `receiverShareBps` as a human percent — "60" is 6000, and the box keeps the other 40. */
  receiverSharePercent: string;
  prizes: BoxPrizeDraft[];
}

/**
 * The shipped ticker gifts: an overlay nobody times is a blank screen for four seconds, so a new
 * row starts with a lifetime and a quiet priority rather than the zero the server would default to.
 */
const PLAYBACK_DEFAULTS = {
  animationFormat: 'LOTTIE',
  durationMs: '2500',
  displayPriority: '10',
  comboEnabled: true,
  comboWindowMs: '5000',
} as const;

/**
 * What a box starts on. The share is 60% rather than the server's 10,000 bps default because at a
 * full share the guard only accepts a table that averages 1× or less — the shipped box pays 60%, and
 * an operator switching the box on should land on a dial the prize ladder then moves.
 */
const BOX_DEFAULTS = {
  isLuckyBox: false,
  receiverSharePercent: '60',
} as const;

/** A prize row has no server identity — the whole table is replaced on every write — so the editor names them. */
let prizeRowSeq = 0;

function newPrizeRow(): BoxPrizeDraft {
  prizeRowSeq += 1;
  // ×1 on 100 weight: a row that costs the box nothing until it is edited, and reads as one chance in
  // a hundred against a plain table so the odds column is never blank while the ladder is being built.
  return { rowId: `prize-new-${prizeRowSeq}`, label: '', multiplier: '1', weight: '100' };
}

/** A new gift opens on the first shelf the operator put in the tab strip, since that is what the phone shows first. */
function emptyForm(categories: GiftCategoryRow[]): FormState {
  return {
    name: '',
    iconUrl: '',
    animationUrl: '',
    soundUrl: '',
    diamondPrice: '',
    rCoinValue: '',
    category: categories[0]?.key ?? '',
    effectKind: 'TICKER',
    ...PLAYBACK_DEFAULTS,
    minVipLevel: '0',
    sortOrder: '0',
    isActive: true,
    ...BOX_DEFAULTS,
    prizes: [],
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
    animationFormat: gift.animationFormat ?? PLAYBACK_DEFAULTS.animationFormat,
    durationMs: String(gift.durationMs ?? PLAYBACK_DEFAULTS.durationMs),
    displayPriority: String(gift.displayPriority ?? PLAYBACK_DEFAULTS.displayPriority),
    comboEnabled: gift.comboEnabled ?? PLAYBACK_DEFAULTS.comboEnabled,
    comboWindowMs: String(gift.comboWindowMs ?? PLAYBACK_DEFAULTS.comboWindowMs),
    minVipLevel: String(gift.minVipLevel),
    sortOrder: String(gift.sortOrder),
    isActive: gift.isActive,
    isLuckyBox: gift.isLuckyBox,
    // A box's read always carries the dial; a flat gift carries neither it nor a table, and the
    // switch starting off means the box section stays closed rather than showing an invented 100%.
    receiverSharePercent: sharePercentToInput(gift.receiverShareBps ?? BPS_FULL),
    prizes: outcomesToDrafts(gift.boxOutcomes ?? []),
  };
}

function parseNonNegativeInt(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** The container an animation URL claims, lower-cased and without a query string; '' if unreadable. */
function animationFileExtension(url: string): string {
  const path = url.trim().split(/[?#]/)[0];
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot === path.length - 1) return '';
  return path.slice(dot + 1).toLowerCase();
}

function validate(form: FormState): Partial<Record<keyof FormState, string>> {
  const errors: Partial<Record<keyof FormState, string>> = {};
  const name = form.name.trim();
  if (name.length === 0) errors.name = 'Name is required.';
  else if (name.length > 40) errors.name = 'Name is limited to 40 characters.';
  if (form.iconUrl.trim().length === 0) errors.iconUrl = 'Icon URL is required.';
  // Only the empty case is caught here: a key the server does not know is its own message to tell,
  // and pre-empting it would hide which shelf the row is actually filed under.
  if (form.category.length === 0) errors.category = 'There is no shelf to file this under — add a category first.';
  const price = parseNonNegativeInt(form.diamondPrice);
  if (price === null) errors.diamondPrice = 'Must be a whole number.';
  else if (price <= 0) errors.diamondPrice = 'Diamond price must be greater than 0.';
  if (parseNonNegativeInt(form.rCoinValue) === null) errors.rCoinValue = 'Must be 0 or a positive whole number.';
  if (parseNonNegativeInt(form.minVipLevel) === null) errors.minVipLevel = 'Must be 0 or a positive whole number.';
  if (!/^-?\d+$/.test(form.sortOrder.trim())) errors.sortOrder = 'Must be a whole number.';

  const duration = parseNonNegativeInt(form.durationMs);
  if (duration === null) errors.durationMs = 'Must be 0 or a whole number of milliseconds.';
  else if (duration > MAX_DURATION_MS) errors.durationMs = `Must be ${MAX_DURATION_MS} ms or less.`;

  const priority = parseNonNegativeInt(form.displayPriority);
  if (priority === null) errors.displayPriority = 'Must be 0 or a whole number.';
  else if (priority > MAX_DISPLAY_PRIORITY) errors.displayPriority = `Must be ${MAX_DISPLAY_PRIORITY} or less.`;

  const window = parseNonNegativeInt(form.comboWindowMs);
  if (window === null) errors.comboWindowMs = 'Must be a whole number of milliseconds.';
  else if (window < MIN_COMBO_WINDOW_MS || window > MAX_COMBO_WINDOW_MS) {
    errors.comboWindowMs = `Must be between ${MIN_COMBO_WINDOW_MS} and ${MAX_COMBO_WINDOW_MS} ms.`;
  }

  // The renderer must be the one that opens the file that is actually there — the upload guard
  // chose the container from the bytes, so a mismatch here is a gift that shows nothing but a name.
  const ext = animationFileExtension(form.animationUrl);
  const expectedExtension: Record<string, string> = { LOTTIE: 'json', SVGA: 'svga', MP4: 'mp4' };
  if (ext !== '' && expectedExtension[form.animationFormat] !== undefined && ext !== expectedExtension[form.animationFormat]) {
    errors.animationFormat = `That file is a .${ext}; pick the renderer that plays it, or upload a ${expectedExtension[form.animationFormat]} file.`;
  }

  // A box's own refusals, checked the way the write checks them so the operator reads a sentence in
  // the form instead of a 400 after pressing save. What is deliberately NOT here is the payout guard:
  // an over-100% table is a warning while the ladder is half-typed, and the running line says so.
  if (form.isLuckyBox) {
    const prizeRows = validateDraftPrizes(form.prizes);
    if (form.prizes.length === 0) {
      errors.prizes = 'A lucky box needs at least one prize to roll — add a row, or turn the box off.';
    } else if (prizeRows.firstError !== null) {
      errors.prizes = prizeRows.firstError;
    }
    if (parseSharePercent(form.receiverSharePercent) === null) {
      errors.receiverSharePercent = 'The share a receiver banks, 0 to 100, to two decimals at most.';
    }
    const pool = parseNonNegativeInt(form.rCoinValue);
    if (pool !== null && pool < 1) {
      errors.rCoinValue = 'A box multiplies this gift’s R-coin value, so an R-coin value of 0 rolls nothing but zero.';
    }
  }
  return errors;
}

/**
 * A refused gift write, in a sentence.
 *
 * The box codes are phrased here because their `error.details` carry the arithmetic the form has been
 * warning about, and a code the panel does not know still shows the server's own sentence — which is
 * never "Request failed with status 400".
 */
function giftSaveFailure(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Saving the gift failed.';
  return describeBoxErrorCode(err.code, err.details) ?? err.message;
}

function GiftFormModal({ gift, categories, onClose, onSaved }: GiftFormModalProps) {
  const isNew = gift === null;
  const [form, setForm] = useState<FormState>(() => (gift === null ? emptyForm(categories) : giftToForm(gift)));
  const [touched, setTouched] = useState<Set<keyof FormState>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const errors = validate(form);
  const hasErrors = Object.keys(errors).length > 0;

  // A gift can outlive the read of the shelf list (a key deleted in another session, or a stale
  // list here). Offering its own key keeps the select from silently re-filing the row.
  const knownCategory = categories.some((each) => each.key === form.category);

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

    const outcomes = draftToOutcomes(form.prizes);
    const shareBps = parseSharePercent(form.receiverSharePercent) ?? BPS_FULL;
    // Which box keys go on the wire. Three rules, all of them the server's:
    //  - a flat gift sends neither the dial nor a table, because prizes without the switch on are
    //    refused outright (`lucky_box_outcomes_without_box`) rather than ignored;
    //  - an update sends `boxOutcomes` only when the operator actually edited the table, because the
    //    key being absent is what means "leave the draw that is stored alone";
    //  - switching the box off sends the flag and nothing else, which is how the stored table is
    //    deleted — a box that stops being one keeps nothing that rolls.
    const tableRewritten =
      form.isLuckyBox &&
      outcomes !== null &&
      (isNew || draftsDifferFromOutcomes(form.prizes, gift?.boxOutcomes ?? []));

    const input: GiftInput = {
      name: form.name.trim(),
      iconUrl: form.iconUrl.trim(),
      animationUrl: form.animationUrl.trim() === '' ? null : form.animationUrl.trim(),
      soundUrl: form.soundUrl.trim() === '' ? null : form.soundUrl.trim(),
      diamondPrice: parseNonNegativeInt(form.diamondPrice) as number,
      rCoinValue: parseNonNegativeInt(form.rCoinValue) as number,
      category: form.category,
      effectKind: form.effectKind,
      animationFormat: form.animationFormat,
      durationMs: parseNonNegativeInt(form.durationMs) as number,
      displayPriority: parseNonNegativeInt(form.displayPriority) as number,
      comboEnabled: form.comboEnabled,
      comboWindowMs: parseNonNegativeInt(form.comboWindowMs) as number,
      minVipLevel: parseNonNegativeInt(form.minVipLevel) as number,
      sortOrder: Number.parseInt(form.sortOrder.trim(), 10),
      isActive: form.isActive,
      isLuckyBox: form.isLuckyBox,
      ...(form.isLuckyBox ? { receiverShareBps: shareBps } : {}),
      ...(tableRewritten ? { boxOutcomes: outcomes } : {}),
    };

    try {
      const result = isNew ? await api.createGift(input) : await api.updateGift(gift.id, input);
      onSaved(result.gift, isNew);
    } catch (err) {
      setServerError(giftSaveFailure(err));
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
          : 'Saved with PUT, which is a partial write: a box’s prize table is only re-sent when the table itself changed, so editing a name can never overwrite a draw somebody else just saved.'
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
          <Select
            label="Category"
            value={form.category}
            onChange={(e) => setField('category', e.target.value)}
            // Nothing is selected only when there is no shelf to select, which the operator has to
            // fix below in Categories — so that one says itself rather than waiting for a touch.
            error={categories.length === 0 ? (errors.category ?? null) : errorFor('category')}
          >
            {categories.map((category) => (
              <option key={category.key} value={category.key}>
                {category.name}
              </option>
            ))}
            {!knownCategory && form.category.length > 0 && (
              <option value={form.category}>{form.category} — not on the Categories list</option>
            )}
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
            placeholder="/gifts/rose.json, jet.svga or cinematic.mp4"
            hint="Full-screen overlay clients play. Lottie JSON up to 2 MB, SVGA and MP4 up to 8 MB; the container is read from the file, not its name."
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

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            label="Renderer"
            value={form.animationFormat}
            onChange={(e) => setField('animationFormat', e.target.value)}
            error={errorFor('animationFormat')}
          >
            {GIFT_ANIMATION_FORMATS.map((format) => (
              <option key={format} value={format}>
                {FORMAT_LABELS[format]}
              </option>
            ))}
          </Select>
          <p className="self-end pb-2 text-[11px] leading-relaxed text-faint">
            Which player on the phone opens the animation file. The upload read the container from
            the bytes, so this has to name the same thing the URL points at — an MP4 sent to the
            Lottie player is a silent rectangle.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Input
            label="On screen for (ms)"
            inputMode="numeric"
            value={form.durationMs}
            onChange={(e) => setField('durationMs', e.target.value)}
            error={errorFor('durationMs')}
            hint={`How long the room hands the screen to this gift (0–${MAX_DURATION_MS}).`}
          />
          <Input
            label="Display priority"
            inputMode="numeric"
            value={form.displayPriority}
            onChange={(e) => setField('displayPriority', e.target.value)}
            error={errorFor('displayPriority')}
            hint={`When two gifts arrive at once, the higher number plays (0–${MAX_DISPLAY_PRIORITY}).`}
          />
          <Input
            label="Combo window (ms)"
            inputMode="numeric"
            value={form.comboWindowMs}
            onChange={(e) => setField('comboWindowMs', e.target.value)}
            error={errorFor('comboWindowMs')}
            hint={`Repeats inside this window share one counter (${MIN_COMBO_WINDOW_MS}–${MAX_COMBO_WINDOW_MS}).`}
          />
        </div>

        <label className="flex items-center gap-3 rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2.5">
          <Switch checked={form.comboEnabled} onChange={(next) => setField('comboEnabled', next)} label="Combo" />
          <span className="text-sm">
            <span className="font-medium text-ink">Count repeats as a combo</span>{' '}
            <span className="text-xs text-faint">
              — the server keeps the tally from the clock, so every device in the room shows the
              same number for the same sender and receiver.
            </span>
          </span>
        </label>

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

        <LuckyBoxFields
          form={form}
          wasBox={gift?.isLuckyBox ?? false}
          storedOutcomes={gift?.boxOutcomes ?? []}
          errorFor={errorFor}
          setField={setField}
        />

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
// The lucky box section of the gift form.
//
// A box is an ordinary gift except for one thing: the number the receiver banks is drawn, not
// configured. Two dials decide what that costs — the prize weights and the receiver's share of the
// rolled pool — and the platform's take is not a third dial but whatever the product of those two
// leaves over. So the form shows the product while the operator is typing it: per-row odds, the
// expected multiplier, and the average payout as a percentage of what the box sells for, with the
// same arithmetic the write refuses above 100%. A box can therefore only be saved as a machine that
// pays out less than it takes in, and the operator sees that number before the request leaves.
// ---------------------------------------------------------------------------
interface LuckyBoxFieldsProps {
  form: FormState;
  /** The row as stored, so an edit can say what switching the box off costs. */
  storedOutcomes: BoxOutcomeDto[];
  wasBox: boolean;
  errorFor: (key: keyof FormState) => string | null;
  setField: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}

function LuckyBoxFields({ form, storedOutcomes, wasBox, errorFor, setField }: LuckyBoxFieldsProps) {
  const shareBps = parseSharePercent(form.receiverSharePercent);
  const readings = readPrizeRows(form.prizes);
  const prizeErrors = validateDraftPrizes(form.prizes).rows;
  const economics = boxEconomics(form.prizes, shareBps ?? BPS_FULL);
  const payoutOverPool = economics.payoutRatioBps > BPS_FULL;
  const tableAtCap = form.prizes.length >= MAX_BOX_PRIZES;

  const setPrize = (rowId: string, patch: Partial<Omit<BoxPrizeDraft, 'rowId'>>) => {
    setField(
      'prizes',
      form.prizes.map((prize) => (prize.rowId === rowId ? { ...prize, ...patch } : prize)),
    );
  };

  return (
    <section className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
      <label className="flex items-center gap-3">
        <Switch
          checked={form.isLuckyBox}
          onChange={(next) => setField('isLuckyBox', next)}
          label="Lucky gift box"
        />
        <span className="text-sm">
          <span className="font-medium text-ink">Lucky gift box</span>{' '}
          <span className="text-xs text-faint">
            — sending one rolls a prize per unit instead of paying the R-coin value flat.
          </span>
        </span>
      </label>

      {!form.isLuckyBox && (
        <p className="text-[11px] leading-relaxed text-faint">
          Off, this gift is what the price list says: {form.rCoinValue || '0'} R-coins per unit to the
          receiver, always.{' '}
          {wasBox && storedOutcomes.length > 0 && (
            <span className="text-amber-200">
              It is a box with {storedOutcomes.length} prize
              {storedOutcomes.length === 1 ? '' : 's'} stored, and switching it off deletes that table —
              nothing keeps odds for later, so turning it back on means writing the ladder again.
            </span>
          )}
        </p>
      )}

      {form.isLuckyBox && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,12rem)_1fr]">
            <Input
              label="Receiver keeps (%)"
              inputMode="decimal"
              value={form.receiverSharePercent}
              onChange={(event) => setField('receiverSharePercent', event.target.value)}
              error={errorFor('receiverSharePercent')}
              hint={
                shareBps === null
                  ? undefined
                  : `The box banks the other ${formatRatioPercent(BPS_FULL - shareBps)}.`
              }
            />
            <p className="self-end pb-2 text-[11px] leading-relaxed text-faint">
              The platform’s take is not a dial — it is what the roll leaves over. One prize is chosen
              per unit sent, paid as a multiple of this gift’s R-coin value, and the receiver banks this
              share of it. Weights are relative: they never have to sum to anything, and the odds column
              is what the server will publish as <span className="font-mono">chanceBps</span>.
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="grid grid-cols-[minmax(0,1fr)_5rem_5rem_6.5rem_1.75rem] items-center gap-2 px-0.5 text-[10px] uppercase tracking-wide text-faint">
              <span>Prize</span>
              <span>Pays ×</span>
              <span>Weight</span>
              <span>Odds</span>
              <span />
            </div>

            {form.prizes.length === 0 ? (
              <p className="rounded-lg border border-dashed border-amber-500/30 px-3 py-2 text-[11px] text-amber-200">
                {errorFor('prizes') ?? 'No prizes yet — a box with nothing to roll is refused, not saved empty.'}
              </p>
            ) : (
              form.prizes.map((prize, index) => {
                const reading = readings[index];
                const rowErrors: DraftPrizeError = prizeErrors[index] ?? {};
                return (
                  <div key={prize.rowId} className="grid grid-cols-[minmax(0,1fr)_5rem_5rem_6.5rem_1.75rem] items-start gap-2">
                    <Input
                      value={prize.label}
                      onChange={(event) => setPrize(prize.rowId, { label: event.target.value })}
                      error={rowErrors.label ?? null}
                      placeholder="Grand jackpot"
                      maxLength={MAX_PRIZE_LABEL_CHARS}
                      aria-label={`Prize ${index + 1} name`}
                    />
                    <Input
                      inputMode="decimal"
                      value={prize.multiplier}
                      onChange={(event) => setPrize(prize.rowId, { multiplier: event.target.value })}
                      error={rowErrors.multiplier ?? null}
                      placeholder="2.5"
                      aria-label={`Prize ${index + 1} multiplier`}
                    />
                    <Input
                      inputMode="numeric"
                      value={prize.weight}
                      onChange={(event) => setPrize(prize.rowId, { weight: event.target.value })}
                      error={rowErrors.weight ?? null}
                      placeholder="100"
                      aria-label={`Prize ${index + 1} weight`}
                    />
                    <p className="pt-2 text-[11px] leading-tight tabular-nums text-muted">
                      {reading?.odds ?? '—'}
                      <span className="block text-faint">
                        {reading?.chanceBps === null || reading?.chanceBps === undefined
                          ? '— bps'
                          : `${reading.chanceBps} bps`}
                      </span>
                    </p>
                    <IconButton
                      label={`Remove prize ${index + 1}`}
                      tone="danger"
                      onClick={() =>
                        setField(
                          'prizes',
                          form.prizes.filter((each) => each.rowId !== prize.rowId),
                        )
                      }
                    >
                      <IconClose className="h-4 w-4" />
                    </IconButton>
                  </div>
                );
              })
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                size="sm"
                icon={<IconPlus className="h-4 w-4" />}
                disabled={tableAtCap}
                onClick={() => setField('prizes', [...form.prizes, newPrizeRow()])}
              >
                Add prize
              </Button>
              <span className="text-[11px] text-faint">
                {form.prizes.length} of {MAX_BOX_PRIZES} prizes
                {tableAtCap ? ' — a longer table cannot show its own odds, so the cap is the cap.' : ''}
              </span>
              {form.prizes.length > 0 && errorFor('prizes') !== null && (
                <span className="text-[11px] text-rose-400">{errorFor('prizes')}</span>
              )}
            </div>
          </div>

          <div className="space-y-1.5 rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2">
            <p className="text-[11px] leading-relaxed text-muted">
              {economics.complete ? (
                <>
                  On average this box rolls{' '}
                  <span className="font-semibold tabular-nums text-ink">
                    {formatMultiplier(economics.expectedMultiplierBps)}
                  </span>{' '}
                  of its pool, and the receiver banks{' '}
                  <span
                    className={`font-semibold tabular-nums ${payoutOverPool ? 'text-rose-300' : 'text-emerald-300'}`}
                  >
                    {formatRatioPercent(economics.payoutRatioBps)}
                  </span>{' '}
                  of what it sells for — the box keeps the{' '}
                  {formatRatioPercent(BPS_FULL - economics.payoutRatioBps)} the roll leaves over.
                </>
              ) : (
                <>
                  Finish the prize table — every row needs a name, a multiplier and a weight — and the
                  running average appears here.
                </>
              )}
            </p>
            {economics.complete && payoutOverPool && (
              <p className="flex items-start gap-2 text-[11px] leading-relaxed text-amber-200">
                <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  On average this box pays {formatRatioPercent(economics.payoutRatioBps)} of what it
                  sells for. The save will be refused at anything over 100%: lower the receiver’s share,
                  or move weight onto the smaller multipliers.
                </span>
              </p>
            )}
            <p className="text-[11px] leading-relaxed text-faint">
              Both lines are the server’s own arithmetic — the same floors, in the same order — so a box
              this one reads at 100% or less is a box the write accepts, and one it reads over is one the
              write refuses. Nothing is recomputed on the way down.
            </p>
          </div>
        </>
      )}
    </section>
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
        {gift.isLuckyBox && (
          <p className="text-xs text-amber-200">
            This is a lucky box: its {(gift.boxOutcomes ?? []).length} prize row
            {(gift.boxOutcomes ?? []).length === 1 ? '' : 's'} are deleted with it.{' '}
            {(gift.boxOutcomes ?? []).length === 0
              ? 'Nothing is stored for the draw now, so no odds are being lost.'
              : 'The ledger rows already rolled keep what they paid.'}
          </p>
        )}
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
// Category create / edit / delete. `key` is immutable for the reason every other
// identity in this console is: gifts are filed under it and the phone's tabs are
// named after it, so a rename is an edit to `name` and never to the key.
// ---------------------------------------------------------------------------
interface CategoryFormModalProps {
  category: GiftCategoryRow | null; // null => create
  existingKeys: string[];
  onClose: () => void;
  onSaved: (category: GiftCategoryRow, isNew: boolean) => void;
}

interface CategoryForm {
  key: string;
  name: string;
  sortOrder: string;
}

function validateCategory(
  form: CategoryForm,
  isNew: boolean,
  existingKeys: string[],
): Partial<Record<keyof CategoryForm, string>> {
  const errors: Partial<Record<keyof CategoryForm, string>> = {};
  const key = form.key.trim();
  if (!CATEGORY_KEY_PATTERN.test(key)) {
    errors.key = 'Two to 24 characters of upper-case letters, digits and underscores — this is what a gift row stores.';
  } else if (isNew && existingKeys.includes(key)) {
    errors.key = `A category already uses the key ${key}.`;
  }
  const name = form.name.trim();
  if (name.length === 0) errors.name = 'The tab label is required.';
  else if (name.length > CATEGORY_NAME_MAX) errors.name = `The label is limited to ${CATEGORY_NAME_MAX} characters.`;
  if (!/^-?\d+$/.test(form.sortOrder.trim())) {
    errors.sortOrder = 'Must be a whole number.';
  } else if (Math.abs(Number.parseInt(form.sortOrder.trim(), 10)) > CATEGORY_ORDER_LIMIT) {
    errors.sortOrder = `Must be between -${CATEGORY_ORDER_LIMIT} and ${CATEGORY_ORDER_LIMIT}.`;
  }
  return errors;
}

function CategoryFormModal({ category, existingKeys, onClose, onSaved }: CategoryFormModalProps) {
  const isNew = category === null;
  const [form, setForm] = useState<CategoryForm>(() =>
    category === null
      ? { key: '', name: '', sortOrder: String((existingKeys.length + 1) * 10) } // one notch past the last shelf, on the tens ladder migration 0025 seeds
      : { key: category.key, name: category.name, sortOrder: String(category.sortOrder) },
  );
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const errors = validateCategory(form, isNew, existingKeys);
  const hasErrors = Object.keys(errors).length > 0;

  const setField = <K extends keyof CategoryForm>(key: K, value: CategoryForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (hasErrors || submitting) return;
    setSubmitting(true);
    setServerError(null);
    const name = form.name.trim();
    const sortOrder = Number.parseInt(form.sortOrder.trim(), 10);
    try {
      // An update sends only the label and the order: `key` is the path segment, and putting a
      // different one in the body is what the server refuses with `category_key_immutable`.
      const result = isNew
        ? await api.createGiftCategory({ key: form.key.trim().toUpperCase(), name, sortOrder })
        : await api.updateGiftCategory(category.key, { name, sortOrder });
      onSaved(result.category, isNew);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Saving the category failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? 'Add gift category' : `Edit “${category.name}”`}
      subtitle={
        isNew
          ? 'The key files the gifts; the label is what the phone’s tab says.'
          : 'Gifts already filed here keep their shelf — renaming a category changes its label, not its key.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="category-form" loading={submitting} disabled={hasErrors}>
            {isNew ? 'Add category' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id="category-form" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Key"
            value={form.key}
            onChange={(event) => setField('key', event.target.value.toUpperCase())}
            error={isNew ? errors.key : null}
            placeholder="SEASON"
            disabled={!isNew}
            hint={
              isNew
                ? 'Upper snake, 2–24 characters. Choose once: gifts and the phone’s tabs are spelled after it.'
                : 'Immutable — gifts are filed under this key.'
            }
            maxLength={24}
          />
          <Input
            label="Tab label"
            value={form.name}
            onChange={(event) => setField('name', event.target.value)}
            error={errors.name}
            placeholder="Seasonal"
            maxLength={CATEGORY_NAME_MAX}
            hint="Shown as-is on the phone, so this is the copy users read."
          />
        </div>
        <Input
          label="Tab position"
          inputMode="numeric"
          value={form.sortOrder}
          onChange={(event) => setField('sortOrder', event.target.value)}
          error={errors.sortOrder}
          hint="Lowest first; this is the order the gift panel’s tabs appear in."
          className="sm:w-56"
        />

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

function DeleteCategoryModal({
  category,
  onClose,
  onDeleted,
}: {
  category: GiftCategoryRow;
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
      await api.deleteGiftCategory(category.key);
      onDeleted(category.key);
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
      title={`Delete “${category.name}”?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirm()} loading={submitting}>
            Delete category
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted">
        <p>
          The tab leaves the phone’s gift panel. Gifts are not re-filed behind your back, which is why
          an occupied shelf cannot be deleted at all — there is no forced delete here.
        </p>
        {category.gifts > 0 && (
          <p className="text-xs text-amber-200">
            {category.gifts} gift(s) sit on {category.key} now. Move them in the gift editor first; if
            you try anyway, the server’s refusal names them.
          </p>
        )}
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
// What the catalogue earned. The numbers come from the ledger, not from the price
// list, so the unattributed slice is printed instead of hidden: a retired gift
// stops being a row while its diamonds stay in the window's totals.
// ---------------------------------------------------------------------------
/**
 * R-coins paid against diamonds spent, as a percent. On a flat gift this is the catalogue's own
 * margin showing up in the book; on a box it is what the draw actually paid, which is the number the
 * payout guard is about — read here, rather than re-derived by hand from two columns.
 */
function payoutRate(row: GiftAnalyticsRow): string {
  if (row.diamonds <= 0) return '—';
  return formatRatioPercent(Math.floor((row.rCoins * BPS_FULL) / row.diamonds));
}

function GiftAnalyticsSection({ categories }: { categories: GiftCategoryRow[] }) {
  const [days, setDays] = useState<number>(30);
  const [result, setResult] = useState<GiftAnalyticsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await api.giftAnalytics(days));
    } catch (err) {
      setResult(null);
      setError(err instanceof ApiError ? err.message : 'Failed to load gift earnings.');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const categoryName = useMemo(() => new Map(categories.map((each) => [each.key, each.name])), [categories]);
  const totals = result?.totals ?? null;
  const rows = result?.gifts ?? [];

  return (
    <Card
      bodyClassName="p-0"
      title="Earnings by gift"
      subtitle={
        result === null
          ? `What the last ${days} days of gift sends earned, best-earning gift first.`
          : `${result.days}-day ledger: ${rows.length} gift${rows.length === 1 ? '' : 's'}${
              rows.length >= 100 ? ' — the server lists only the top 100' : ''
            }, best-earning first.`
      }
      actions={
        <>
          <Select
            aria-label="Window"
            className="w-32"
            value={String(days)}
            onChange={(event) => setDays(Number.parseInt(event.target.value, 10))}
          >
            {ANALYTICS_WINDOWS.map((each) => (
              <option key={each} value={String(each)}>
                Last {each} days
              </option>
            ))}
          </Select>
          <Button size="sm" icon={<IconRefresh className="h-4 w-4" />} onClick={() => void load()}>
            Refresh
          </Button>
        </>
      }
    >
      {error !== null ? (
        <EmptyState
          title="Could not load gift earnings"
          message={error}
          icon={<IconAlert className="h-6 w-6" />}
          action={<Button onClick={() => void load()}>Retry</Button>}
        />
      ) : loading && result === null ? (
        <div className="grid h-48 place-items-center text-violet-300">
          <Spinner className="h-8 w-8" />
        </div>
      ) : (
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard
              label="Send taps"
              value={formatCompact(totals?.sends ?? 0)}
              sub="ledger rows — a combo of ten counts once"
              icon={<IconTrendUp className="h-5 w-5" />}
              tone="violet"
            />
            <StatCard
              label="Gifts sent"
              value={formatCompact(totals?.gifts ?? 0)}
              sub="individual gifts"
              icon={<IconGift className="h-5 w-5" />}
              tone="rose"
            />
            <StatCard
              label="Diamonds spent"
              value={formatDiamonds(totals?.diamonds ?? 0)}
              sub={`${formatCompact(totals?.averageDiamondPerGift ?? 0)} per gift`}
              icon={<IconDiamond className="h-5 w-5" />}
              tone="fuchsia"
            />
            <StatCard
              label="R-coins earned"
              value={formatRCoin(totals?.rCoins ?? 0)}
              sub="paid out to receivers"
              icon={<IconCoin className="h-5 w-5" />}
              tone="emerald"
            />
            <StatCard
              label="Unattributed"
              value={formatDiamonds(totals?.unattributedDiamonds ?? 0)}
              sub="spend on gifts since retired — in these totals, on no row below"
              icon={<IconAlert className="h-5 w-5" />}
              tone={(totals?.unattributedDiamonds ?? 0) > 0 ? 'amber' : 'sky'}
            />
          </div>

          {rows.length === 0 ? (
            <EmptyState
              title="Nothing sent in this window"
              message={`No completed gift transaction in the last ${days} days, so there is nothing to rank.`}
              icon={<IconGift className="h-6 w-6" />}
            />
          ) : (
            <Table>
              <THead>
                <Th width="26%">Gift</Th>
                <Th>Category</Th>
                <Th align="right">Taps</Th>
                <Th align="right">Gifts</Th>
                <Th align="right">Diamonds</Th>
                <Th align="right">R-coins</Th>
                <Th align="right">Paid / spent</Th>
                <Th align="right">Senders</Th>
                <Th align="right" className="pr-5">
                  Avg / gift
                </Th>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <Tr key={row.giftId}>
                    <Td>
                      <div className="flex min-w-0 items-center gap-2.5">
                        <GiftIconPreview url={row.iconUrl} name={row.name} size={32} />
                        <span className="truncate text-sm text-ink">{row.name}</span>
                        {row.isLuckyBox && <Badge tone="amber">box</Badge>}
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={CATEGORY_TONES[row.category] ?? 'slate'}>
                        {categoryName.get(row.category) ?? row.category}
                      </Badge>
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {formatCompact(row.sends)}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {formatCompact(row.gifts)}
                    </Td>
                    <Td align="right" className="font-semibold tabular-nums text-ink">
                      {formatCompact(row.diamonds)}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {formatCompact(row.rCoins)}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      <span
                        className={
                          row.isLuckyBox && row.diamonds > 0 && row.rCoins > row.diamonds
                            ? 'font-semibold text-rose-300'
                            : 'text-muted'
                        }
                        title={
                          row.isLuckyBox
                            ? 'What the draw actually paid, against what senders spent'
                            : 'The catalogue margin, earned out'
                        }
                      >
                        {payoutRate(row)}
                      </span>
                    </Td>
                    <Td align="right" className="tabular-nums">
                      <span className="inline-flex items-center gap-1">
                        <IconUsers className="h-3.5 w-3.5 text-faint" />
                        {formatCompact(row.senders)}
                      </span>
                    </Td>
                    <Td align="right" className="pr-5 tabular-nums">
                      {formatCompact(row.averageDiamonds)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
          <p className="text-[11px] leading-relaxed text-faint">
            Taps are presses of the send button and gifts are the quantities inside them, so a combo of
            ten Roses is one tap of ten gifts. Diamonds are what senders spent and R-coins what
            receivers earned; the rows join the live catalogue, which is why a retired gift’s spend
            appears only in the totals above. <span className="font-semibold text-muted">Paid /
            spent</span> is the two against each other: on a flat gift that is the price list’s own
            margin, and on a box (badged) it is what the draw actually paid out — over 100% is a box
            giving away more diamonds’ worth than it sold, which is the number the create form warns
            about before a write is attempted.
          </p>
        </div>
      )}
    </Card>
  );
}
