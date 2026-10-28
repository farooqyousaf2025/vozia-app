// ---------------------------------------------------------------------------
// The level ladder: the rungs a member climbs by earning experience, and the
// badge each rung paints next to their name. These are `rank_levels` rows
// (migration 0017), so a new threshold or a new crest ships to phones without
// an app update.
//
// This is not the VIP tier. VIP is set by hand and gates which gifts an account
// may send; a rung here is earned from the coins that actually moved, and no
// client can write it. The screen exists so an operator can see both facts:
// where each rung sits, and how many accounts stand on it right now.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArtField } from '../components/ui/ArtField';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Spinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import {
  IconAlert,
  IconEdit,
  IconPlus,
  IconRefresh,
  IconSpark,
  IconTrash,
} from '../components/ui/Icons';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../context/AuthContext';
import { ApiError, api, assetUrl } from '../lib/api';
import { formatNumber } from '../lib/format';
import type { AdminRank, PublishedLadder, RankInput } from '../types';

// The same rules the migration's CHECK constraints enforce, so an impossible
// value is caught before the round-trip rather than in a database error toast.
const URL_PATTERN = /^(\/|https:\/\/)/;
const ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/;

export default function RanksPage() {
  const toast = useToast();
  const { can } = useAuth();
  const canManage = can('config:manage');

  const [ranks, setRanks] = useState<AdminRank[]>([]);
  const [published, setPublished] = useState<PublishedLadder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [editing, setEditing] = useState<AdminRank | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AdminRank | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Both reads, because a saved rung only matters once phones list it. `publicRanks()` is the
      // unauthenticated view an app fetches, so its count is the proof the write reached clients.
      const [admin, ladder] = await Promise.all([api.rankLadder(), api.publicRanks()]);
      setRanks(admin.levels);
      setPublished(ladder);
    } catch (err) {
      setRanks([]);
      setPublished(null);
      setError(err instanceof ApiError ? err.message : 'Failed to load the level ladder.');
    } finally {
      setLoading(false);
    }
  }, [reloadKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = () => setReloadKey((key) => key + 1);

  const sorted = useMemo(() => [...ranks].sort((a, b) => a.level - b.level), [ranks]);
  const publishedLevels = useMemo(
    () => new Set((published?.levels ?? []).map((rung) => rung.level)),
    [published],
  );

  // The schema caps a rung at `level <= 20`, so the ladder holds at most maxLevel+1 rungs. Rather
  // than open the form on a level the server will refuse, the button waits for a free rung —
  // which only appears after one is deleted.
  const nextFreeLevel = useMemo(() => {
    const ceiling = (published?.maxLevel ?? 20) + 1;
    const taken = new Set(ranks.map((rung) => rung.level));
    for (let level = 0; level < ceiling; level += 1) if (!taken.has(level)) return level;
    return null;
  }, [ranks, published]);

  if (loading && ranks.length === 0 && published === null) {
    return (
      <div className="grid h-64 place-items-center text-violet-300">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Level ladder</h1>
          <p className="mt-0.5 max-w-2xl text-sm text-muted">
            The ranks a member earns with experience and the badge each one shows next to their name.
            Experience is moved by the server when coins change hands — a client can never write it,
            and this is separate from the VIP tier that gates which gifts an account may send.
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

      {published !== null && (
        <Card title="How experience is earned">
          <p className="text-sm text-muted">
            A member earns{' '}
            <span className="font-semibold text-ink">{published.xpRules.perDiamondSpent.toLocaleString('en-US')}</span>{' '}
            experience for every diamond they send, and{' '}
            <span className="font-semibold text-ink">{published.xpRules.perRCoinEarned.toLocaleString('en-US')}</span>{' '}
            for every coin they receive. Those rates are fixed in the server — a rung only decides
            where its floor sits, never how fast anyone reaches it.
          </p>
          <p className="mt-2 text-[11px] text-faint">
            <span className="font-medium text-muted">{published.levels.length}</span> of{' '}
            {ranks.length} rung{ranks.length === 1 ? '' : 's'} published on{' '}
            <code className="text-muted">GET /api/ranks</code> · top rung is level {published.maxLevel} · a
            retired rung is hidden from phones and its members fall to the rung below.
          </p>
        </Card>
      )}

      <Card
        title={`Rungs (${sorted.length})`}
        subtitle="Floors must strictly rise: a rung set at another rung's experience would never be shown to anyone."
        actions={
          canManage && (
            <Button
              variant="primary"
              size="sm"
              icon={<IconPlus className="h-4 w-4" />}
              onClick={() => setEditing('new')}
              disabled={nextFreeLevel === null}
              title={
                nextFreeLevel === null
                  ? `The ladder holds rungs 0 to ${published?.maxLevel ?? 20} and every one is in use`
                  : undefined
              }
            >
              New rung
            </Button>
          )
        }
      >
        {sorted.length === 0 ? (
          <EmptyState
            title="No rungs on the ladder"
            message="With no rows, every account resolves to no rank and phones show a plain name. Add a level 0 rung to start the ladder."
            icon={<IconSpark className="h-6 w-6" />}
          />
        ) : (
          <ul className="divide-y divide-edge/50">
            {sorted.map((rung) => (
              <RankRow
                key={rung.level}
                rung={rung}
                isPublished={publishedLevels.has(rung.level)}
                isFirst={rung.level === sorted[0].level}
                canManage={canManage}
                onEdit={() => setEditing(rung)}
                onDelete={() => setDeleting(rung)}
              />
            ))}
          </ul>
        )}
        {!canManage && (
          <p className="mt-3 text-[11px] text-faint">
            Your role can read the ladder but not change it; the server refuses these writes too.
          </p>
        )}
      </Card>

      {editing !== null && (
        <RankFormModal
          rung={editing === 'new' ? null : editing}
          ranks={ranks}
          maxLevel={published?.maxLevel ?? 20}
          newLevel={nextFreeLevel ?? 0}
          onClose={() => setEditing(null)}
          onSaved={(saved, isNew) => {
            setEditing(null);
            toast.success(isNew ? `Level ${saved.level} is on the ladder.` : `Level ${saved.level} saved.`);
            refresh();
          }}
        />
      )}

      {deleting !== null && (
        <DeleteRankModal
          rung={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(level, moved) => {
            setDeleting(null);
            toast.success(`Level ${level} removed — ${moved} account(s) fell to the rung below.`);
            refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One rung. The badge is loaded from the exact URL a phone will use, so art that
// does not resolve here is visibly missing rather than papered over — an operator
// should catch that on this screen, not in a room.
// ---------------------------------------------------------------------------
function BadgeArt({ url, size = 40 }: { url: string; size?: number }) {
  const resolved = assetUrl(url);
  return (
    <span
      className="grid shrink-0 place-items-center overflow-hidden rounded-lg border border-edge/60 bg-elevated"
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

function RankRow({
  rung,
  isPublished,
  isFirst,
  canManage,
  onEdit,
  onDelete,
}: {
  rung: AdminRank;
  isPublished: boolean;
  isFirst: boolean;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span
        className="grid h-6 w-9 shrink-0 place-items-center rounded-md text-[11px] font-bold"
        style={{ backgroundColor: `${rung.accent}22`, color: rung.accent }}
      >
        {rung.level}
      </span>
      <BadgeArt url={rung.badge} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink" title={rung.name}>
          {rung.name}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-faint">
          {isFirst ? 'floor of the ladder' : `from ${formatNumber(rung.minXp)} XP`} ·{' '}
          {rung.membersOnRung === 0
            ? 'no account sits here'
            : `${formatNumber(rung.membersOnRung)} account(s) here`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!isPublished && <Badge tone="slate">retired</Badge>}
        {canManage && (
          <div className="flex items-center gap-1">
            <IconButton label={`Edit level ${rung.level}`} onClick={onEdit}>
              <IconEdit className="h-4 w-4" />
            </IconButton>
            <IconButton label={`Delete level ${rung.level}`} tone="danger" onClick={onDelete}>
              <IconTrash className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Create / edit.
// ---------------------------------------------------------------------------
interface RankFormModalProps {
  rung: AdminRank | null;
  ranks: AdminRank[];
  maxLevel: number;
  /** The lowest unused rung, offered as the default for a new row. */
  newLevel: number;
  onClose: () => void;
  onSaved: (rung: AdminRank, isNew: boolean) => void;
}

interface RankForm {
  level: string;
  name: string;
  badge: string;
  accent: string;
  minXp: string;
  isActive: boolean;
}

/**
 * A rung may not fold onto a neighbour's floor, because the server resolves a member to the
 * highest rung they reached and the lower one would become unreachable. Same rule as
 * `assertOrder()` in rank.service.ts — checked here only to explain it before the write.
 */
function orderProblem(
  level: number,
  minXp: number,
  ranks: AdminRank[],
  editingLevel: number | null,
): string | null {
  const live = ranks
    .filter((rung) => rung.isActive && rung.level !== editingLevel)
    .sort((a, b) => a.level - b.level);
  const below = [...live].reverse().find((rung) => rung.level < level);
  const above = live.find((rung) => rung.level > level);
  if (below && minXp <= below.minXp) {
    return `Level ${level} must cost more than level ${below.level} (${below.name}) at ${formatNumber(below.minXp)} XP, or nobody will ever be shown level ${below.level}.`;
  }
  if (above && minXp >= above.minXp) {
    return `Level ${level} at ${formatNumber(minXp)} XP would cover level ${above.level} (${above.name}), whose floor is ${formatNumber(above.minXp)} XP. Lower it, or move level ${above.level} first.`;
  }
  return null;
}

function validateRank(
  form: RankForm,
  isNew: boolean,
  ranks: AdminRank[],
  maxLevel: number,
): Partial<Record<keyof RankForm, string>> {
  const errors: Partial<Record<keyof RankForm, string>> = {};
  const level = Number.parseInt(form.level.trim(), 10);
  if (!Number.isInteger(level) || level < 0 || level > maxLevel) {
    errors.level = `A whole rung between 0 and ${maxLevel}.`;
  } else if (isNew && ranks.some((rung) => rung.level === level)) {
    errors.level = `Level ${level} is already on the ladder.`;
  }
  const name = form.name.trim();
  if (name.length === 0) errors.name = 'Name is required.';
  else if (name.length > 60) errors.name = 'Name is limited to 60 characters.';
  const badge = form.badge.trim();
  if (badge.length === 0) errors.badge = 'A badge URL is required.';
  else if (!URL_PATTERN.test(badge)) errors.badge = 'Start the path with / or use https://.';
  if (!ACCENT_PATTERN.test(form.accent.trim())) errors.accent = 'A hex colour like #d9a53c.';
  const minXp = Number.parseInt(form.minXp.trim(), 10);
  if (!Number.isInteger(minXp) || minXp < 0) {
    errors.minXp = 'Must be a whole number, 0 or more.';
  } else if (level === 0 && minXp !== 0) {
    errors.minXp = 'Level 0 is the floor every account stands on; it costs no experience.';
  } else if (Number.isInteger(level) && errors.level === undefined) {
    const order = orderProblem(level, minXp, ranks, isNew ? null : Number.parseInt(form.level.trim(), 10));
    if (order !== null) errors.minXp = order;
  }
  return errors;
}

function RankFormModal({ rung, ranks, maxLevel, newLevel, onClose, onSaved }: RankFormModalProps) {
  const isNew = rung === null;
  const [form, setForm] = useState<RankForm>(() =>
    rung === null
      ? { level: String(newLevel), name: '', badge: '', accent: '#d9a53c', minXp: '0', isActive: true }
      : {
          level: String(rung.level),
          name: rung.name,
          badge: rung.badge,
          accent: rung.accent,
          minXp: String(rung.minXp),
          isActive: rung.isActive,
        },
  );
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const errors = validateRank(form, isNew, ranks, maxLevel);
  const hasErrors = Object.keys(errors).length > 0;
  const setField = <K extends keyof RankForm>(key: K, value: RankForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (hasErrors || submitting) return;
    setSubmitting(true);
    setServerError(null);
    const input: RankInput = {
      name: form.name.trim(),
      badgeUrl: form.badge.trim(),
      accent: form.accent.trim(),
      minXp: Number.parseInt(form.minXp.trim(), 10),
      isActive: form.isActive,
    };
    if (isNew) input.level = Number.parseInt(form.level.trim(), 10);
    try {
      const level = Number.parseInt(form.level.trim(), 10);
      const result = isNew ? await api.createRank(input) : await api.updateRank(level, input);
      onSaved(result.rank, isNew);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Saving the rung failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={isNew ? 'Add a rung' : `Edit level ${rung.level} — ${rung.name}`}
      subtitle={
        isNew
          ? 'A rung is published to phones as soon as it is saved; experience only ever moves when coins do.'
          : 'The level number stays — it is the rung accounts sit on, not a label. To renumber, add the new level and delete this one.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="rank-form" loading={submitting} disabled={hasErrors}>
            {isNew ? 'Add rung' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id="rank-form" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Level"
            inputMode="numeric"
            value={form.level}
            onChange={(event) => setField('level', event.target.value)}
            error={errors.level}
            disabled={!isNew}
            hint={isNew ? `Rungs run 0 to ${maxLevel}; 0 is what every new account starts on.` : 'Immutable.'}
            maxLength={2}
          />
          <Input
            label="Name"
            value={form.name}
            onChange={(event) => setField('name', event.target.value)}
            error={errors.name}
            placeholder="Gold III"
            maxLength={60}
            hint="Shown beside the badge on a member's profile."
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Floor experience"
            inputMode="numeric"
            value={form.minXp}
            onChange={(event) => setField('minXp', event.target.value)}
            error={errors.minXp}
            hint="The lowest experience that still shows this rung. Must rise with the level."
          />
          <Input
            label="Accent"
            value={form.accent}
            onChange={(event) => setField('accent', event.target.value)}
            error={errors.accent}
            placeholder="#d9a53c"
            maxLength={7}
            hint="Used by clients for the ring around the badge and rank chips."
          />
        </div>

        <ArtField
          kind="BADGE"
          label="Badge URL"
          value={form.badge}
          error={errors.badge}
          placeholder="/badges/level-9.png or https://cdn…"
          onChange={(url) => setField('badge', url)}
          onError={setServerError}
        />

        <div className="flex items-center justify-between gap-3 rounded-xl border border-edge/60 bg-elevated/40 p-3">
          <div className="flex items-center gap-3">
            <BadgeArt url={form.badge.trim()} size={56} />
            <p className="text-[11px] leading-relaxed text-faint">
              Level {form.level.trim() || '—'} as a phone will render it, on{' '}
              <span
                className="inline-block h-2.5 w-2.5 rounded-full align-middle"
                style={{ backgroundColor: ACCENT_PATTERN.test(form.accent.trim()) ? form.accent.trim() : '#3a3f52' }}
              />{' '}
              {form.accent.trim() || 'no accent'}. The file is loaded from this exact URL, so art that
              does not resolve here is missing from someone's nameplate too.
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-xs text-muted">
            <Switch checked={form.isActive} onChange={(next) => setField('isActive', next)} label="Published" />
            {form.isActive ? 'Published' : 'Retired'}
          </label>
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

function DeleteRankModal({
  rung,
  onClose,
  onDeleted,
}: {
  rung: AdminRank;
  onClose: () => void;
  onDeleted: (level: number, moved: number) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const confirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await api.deleteRank(rung.level);
      onDeleted(rung.level, result.membersMoved);
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
      title={`Delete level ${rung.level} — ${rung.name}?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirm()} loading={submitting}>
            Delete rung
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted">
        <p>
          <span className="font-semibold text-ink">
            {rung.membersOnRung === 0
              ? 'No account sits here'
              : `${formatNumber(rung.membersOnRung)} account(s) sit here`}
          </span>{' '}
          — they keep their experience and re-resolve to the nearest rung below it. Nothing is
          rewritten in their history, and their total stays untouched.
        </p>
        <p className="text-xs text-faint">
          Level 0 cannot be deleted, because every account needs a floor to resolve to; retire it
          instead. If you delete a rung by mistake, re-adding the same level and floor puts the badge
          back on everyone who had it.
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
