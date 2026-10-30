// ---------------------------------------------------------------------------
// Daily quests and the check-in (migration 0020).
//
// Two things live on this screen, and they are deliberately together because they set the same
// thing: the pace of a member's day. The catalogue says which actions count and what finishing
// them pays; the dials say when "today" ends and how much a check-in pays.
//
// None of these values is an XP grant by itself. A quest pays only when the server records the
// qualifying action (a gift posted in the ledger, a message stored in a room), and a check-in pays
// only through POST /api/quests/checkin. That is why this page can be generous with numbers and
// still never be a way to mint experience from a phone.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Select } from '../components/ui/Select';
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
import { ApiError, api } from '../lib/api';
import { formatNumber } from '../lib/format';
import type { AdminQuest, AdminQuestsResult, QuestInput, QuestMetric, QuestSettings } from '../types';

const METRICS: Array<{ value: QuestMetric; label: string; hint: string }> = [
  { value: 'GIFT_SENT', label: 'Gifts sent', hint: 'Each gift counts once, whatever its price.' },
  { value: 'DIAMONDS_SPENT', label: 'Diamonds spent', hint: 'Diamonds paid across all gifts today.' },
  { value: 'CHAT_MESSAGE', label: 'Chat messages', hint: 'Each message stored in a room chat counts once.' },
];

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;
const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/;

function metricLabel(metric: QuestMetric): string {
  return METRICS.find((entry) => entry.value === metric)?.label ?? metric;
}

export default function QuestsPage() {
  const toast = useToast();
  const { can } = useAuth();
  const canManage = can('config:manage');

  const [data, setData] = useState<AdminQuestsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [editing, setEditing] = useState<AdminQuest | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AdminQuest | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.adminQuests());
    } catch (err) {
      setData(null);
      setError(err instanceof ApiError ? err.message : 'Failed to load the daily quests.');
    } finally {
      setLoading(false);
    }
  }, [reloadKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = () => setReloadKey((key) => key + 1);

  const sorted = useMemo(
    () => [...(data?.quests ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key)),
    [data],
  );

  if (loading && data === null) {
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
          <h1 className="text-xl font-bold text-ink">Daily quests</h1>
          <p className="mt-0.5 max-w-2xl text-sm text-muted">
            Small tasks that reset every day, plus a check-in that pays more the longer a member keeps
            coming back. Experience is still awarded by the server when the action happens — nothing
            here can be claimed from a phone.
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

      {data !== null && (
        <>
          <SettingsCard
            settings={data.settings}
            today={data.today}
            canManage={canManage}
            onSaved={(settings) => {
              setData((current) => (current === null ? current : { ...current, settings }));
              toast.success('Check-in settings saved.');
              refresh();
            }}
          />

          <Card
            title={`Quests (${sorted.length})`}
            subtitle="A quest only counts what the server already recorded today; retiring one keeps the progress and XP it already paid."
            actions={
              canManage && (
                <Button
                  variant="primary"
                  size="sm"
                  icon={<IconPlus className="h-4 w-4" />}
                  onClick={() => setEditing('new')}
                >
                  New quest
                </Button>
              )
            }
          >
            {sorted.length === 0 ? (
              <EmptyState
                title="No quests today"
                message="With no rows, the Quests card on a phone has nothing to show. Add one to give members a reason to open the app."
                icon={<IconSpark className="h-6 w-6" />}
              />
            ) : (
              <ul className="divide-y divide-edge/50">
                {sorted.map((quest) => (
                  <QuestRow
                    key={quest.key}
                    quest={quest}
                    canManage={canManage}
                    onEdit={() => setEditing(quest)}
                    onDelete={() => setDeleting(quest)}
                  />
                ))}
              </ul>
            )}
            {!canManage && (
              <p className="mt-3 text-[11px] text-faint">
                Your role can read the catalogue but not change it; the server refuses these writes too.
              </p>
            )}
          </Card>
        </>
      )}

      {editing !== null && data !== null && (
        <QuestFormModal
          quest={editing === 'new' ? null : editing}
          quests={data.quests}
          onClose={() => setEditing(null)}
          onSaved={(quest, isNew) => {
            setEditing(null);
            toast.success(isNew ? `Quest "${quest.title}" added.` : `Quest "${quest.title}" saved.`);
            refresh();
          }}
        />
      )}

      {deleting !== null && (
        <DeleteQuestModal
          quest={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(key) => {
            setDeleting(null);
            toast.success(`Quest ${key} removed.`);
            refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The dials
// ---------------------------------------------------------------------------

function SettingsCard({
  settings,
  today,
  canManage,
  onSaved,
}: {
  settings: QuestSettings;
  today: string;
  canManage: boolean;
  onSaved: (settings: QuestSettings) => void;
}) {
  const [form, setForm] = useState({
    resetTimezone: settings.resetTimezone,
    checkinBaseXp: String(settings.checkinBaseXp),
    checkinStreakStepXp: String(settings.checkinStreakStepXp),
    checkinMaxStreakDays: String(settings.checkinMaxStreakDays),
  });
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    setForm({
      resetTimezone: settings.resetTimezone,
      checkinBaseXp: String(settings.checkinBaseXp),
      checkinStreakStepXp: String(settings.checkinStreakStepXp),
      checkinMaxStreakDays: String(settings.checkinMaxStreakDays),
    });
  }, [settings]);

  const errors = useMemo(() => {
    const next: Partial<Record<keyof typeof form, string>> = {};
    if (!TIMEZONE_PATTERN.test(form.resetTimezone.trim())) {
      next.resetTimezone = 'An IANA name like UTC, Asia/Kolkata or Europe/Berlin.';
    }
    const base = Number.parseInt(form.checkinBaseXp.trim(), 10);
    if (!Number.isInteger(base) || base < 0 || base > 10_000) next.checkinBaseXp = '0 to 10,000.';
    const step = Number.parseInt(form.checkinStreakStepXp.trim(), 10);
    if (!Number.isInteger(step) || step < 0 || step > 10_000) next.checkinStreakStepXp = '0 to 10,000.';
    const max = Number.parseInt(form.checkinMaxStreakDays.trim(), 10);
    if (!Number.isInteger(max) || max < 1 || max > 365) next.checkinMaxStreakDays = '1 to 365 days.';
    return next;
  }, [form]);
  const hasErrors = Object.keys(errors).length > 0;

  const dirty =
    form.resetTimezone.trim() !== settings.resetTimezone ||
    Number.parseInt(form.checkinBaseXp, 10) !== settings.checkinBaseXp ||
    Number.parseInt(form.checkinStreakStepXp, 10) !== settings.checkinStreakStepXp ||
    Number.parseInt(form.checkinMaxStreakDays, 10) !== settings.checkinMaxStreakDays;

  const base = Number.parseInt(form.checkinBaseXp, 10);
  const step = Number.parseInt(form.checkinStreakStepXp, 10);
  const max = Number.parseInt(form.checkinMaxStreakDays, 10);
  const topReward = Number.isFinite(base) && Number.isFinite(step) && Number.isFinite(max)
    ? base + (Math.min(Math.max(1, max), 365) - 1) * step
    : null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (hasErrors || submitting || !dirty) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await api.updateQuestSettings({
        resetTimezone: form.resetTimezone.trim(),
        checkinBaseXp: Number.parseInt(form.checkinBaseXp, 10),
        checkinStreakStepXp: Number.parseInt(form.checkinStreakStepXp, 10),
        checkinMaxStreakDays: Number.parseInt(form.checkinMaxStreakDays, 10),
      });
      onSaved(result.settings);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Saving the settings failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card
      title="Check-in and the day boundary"
      subtitle={`The current local date in ${settings.resetTimezone} is ${today}. Quests and check-ins roll over at midnight in this zone.`}
    >
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            label="Reset timezone"
            value={form.resetTimezone}
            onChange={(event) => setForm((current) => ({ ...current, resetTimezone: event.target.value }))}
            error={errors.resetTimezone}
            disabled={!canManage}
            maxLength={64}
            hint="IANA name; the server checks that PostgreSQL knows it."
          />
          <Input
            label="Day 1 reward (XP)"
            inputMode="numeric"
            value={form.checkinBaseXp}
            onChange={(event) => setForm((current) => ({ ...current, checkinBaseXp: event.target.value }))}
            error={errors.checkinBaseXp}
            disabled={!canManage}
          />
          <Input
            label="Extra per day (XP)"
            inputMode="numeric"
            value={form.checkinStreakStepXp}
            onChange={(event) => setForm((current) => ({ ...current, checkinStreakStepXp: event.target.value }))}
            error={errors.checkinStreakStepXp}
            disabled={!canManage}
            hint="Added for each consecutive day."
          />
          <Input
            label="Streak cap (days)"
            inputMode="numeric"
            value={form.checkinMaxStreakDays}
            onChange={(event) => setForm((current) => ({ ...current, checkinMaxStreakDays: event.target.value }))}
            error={errors.checkinMaxStreakDays}
            disabled={!canManage}
            hint="The day the reward stops growing."
          />
        </div>

        <p className="text-[11px] text-faint">
          {topReward === null
            ? 'Fill the reward fields to preview the streak.'
            : `A member who keeps the streak pays ${formatNumber(base)} XP on day 1, and ${formatNumber(topReward)} XP from day ${Math.max(1, max)} onward. Missing a day starts again at day 1.`}
        </p>

        {serverError !== null && (
          <div className="flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
            <IconAlert className="h-4 w-4 shrink-0" />
            {serverError}
          </div>
        )}

        {canManage && (
          <div className="flex items-center justify-end gap-2">
            <Button type="submit" variant="primary" size="sm" loading={submitting} disabled={hasErrors || !dirty}>
              Save settings
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

function QuestRow({
  quest,
  canManage,
  onEdit,
  onDelete,
}: {
  quest: AdminQuest;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="grid h-9 w-12 shrink-0 place-items-center rounded-lg border border-edge/60 bg-elevated text-[11px] font-semibold text-muted">
        {formatNumber(quest.xpReward)} XP
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-ink" title={quest.title}>
            {quest.title}
          </p>
          {!quest.isActive && <Badge tone="slate">retired</Badge>}
          <code className="shrink-0 rounded bg-elevated px-1.5 py-0.5 text-[10px] text-faint">{quest.key}</code>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-faint">
          {metricLabel(quest.metric)} · target {formatNumber(quest.target)} ·{' '}
          {quest.completedToday === 0
            ? 'nobody has finished it today'
            : `${formatNumber(quest.completedToday)} member(s) finished it today`}
          {quest.description.length > 0 ? ` · ${quest.description}` : ''}
        </p>
      </div>
      {canManage && (
        <div className="flex shrink-0 items-center gap-1">
          <IconButton label={`Edit quest ${quest.key}`} onClick={onEdit}>
            <IconEdit className="h-4 w-4" />
          </IconButton>
          <IconButton label={`Delete quest ${quest.key}`} tone="danger" onClick={onDelete}>
            <IconTrash className="h-4 w-4" />
          </IconButton>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

interface QuestForm {
  key: string;
  title: string;
  description: string;
  metric: QuestMetric;
  target: string;
  xpReward: string;
  sortOrder: string;
  isActive: boolean;
}

function validateQuest(form: QuestForm, isNew: boolean, quests: AdminQuest[]): Partial<Record<keyof QuestForm, string>> {
  const errors: Partial<Record<keyof QuestForm, string>> = {};
  const key = form.key.trim();
  if (isNew) {
    if (!KEY_PATTERN.test(key)) errors.key = 'Lowercase letters, digits and dashes, e.g. gift-1.';
    else if (quests.some((quest) => quest.key === key)) errors.key = `Quest ${key} already exists.`;
  }
  const title = form.title.trim();
  if (title.length === 0) errors.title = 'A title is required.';
  else if (title.length > 80) errors.title = 'Limited to 80 characters.';
  if (form.description.trim().length > 300) errors.description = 'Limited to 300 characters.';
  const target = Number.parseInt(form.target.trim(), 10);
  if (!Number.isInteger(target) || target < 1 || target > 1_000_000) errors.target = 'A whole number from 1 to 1,000,000.';
  const reward = Number.parseInt(form.xpReward.trim(), 10);
  if (!Number.isInteger(reward) || reward < 1 || reward > 100_000) errors.xpReward = 'A whole number from 1 to 100,000.';
  const order = Number.parseInt(form.sortOrder.trim(), 10);
  if (!Number.isInteger(order) || order < -1000 || order > 1000) errors.sortOrder = 'Between -1,000 and 1,000.';
  return errors;
}

function QuestFormModal({
  quest,
  quests,
  onClose,
  onSaved,
}: {
  quest: AdminQuest | null;
  quests: AdminQuest[];
  onClose: () => void;
  onSaved: (quest: AdminQuest, isNew: boolean) => void;
}) {
  const isNew = quest === null;
  const [form, setForm] = useState<QuestForm>(() =>
    quest === null
      ? { key: '', title: '', description: '', metric: 'GIFT_SENT', target: '1', xpReward: '10', sortOrder: '0', isActive: true }
      : {
          key: quest.key,
          title: quest.title,
          description: quest.description,
          metric: quest.metric,
          target: String(quest.target),
          xpReward: String(quest.xpReward),
          sortOrder: String(quest.sortOrder),
          isActive: quest.isActive,
        },
  );
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const errors = validateQuest(form, isNew, quests);
  const hasErrors = Object.keys(errors).length > 0;
  const setField = <K extends keyof QuestForm>(key: K, value: QuestForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (hasErrors || submitting) return;
    setSubmitting(true);
    setServerError(null);
    const input: QuestInput = {
      title: form.title.trim(),
      description: form.description.trim(),
      metric: form.metric,
      target: Number.parseInt(form.target.trim(), 10),
      xpReward: Number.parseInt(form.xpReward.trim(), 10),
      sortOrder: Number.parseInt(form.sortOrder.trim(), 10),
      isActive: form.isActive,
    };
    if (isNew) input.key = form.key.trim();
    try {
      const result = isNew ? await api.createQuest(input) : await api.updateQuest(quest.key, input);
      onSaved(result.quest, isNew);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Saving the quest failed.');
      setSubmitting(false);
    }
  };

  const metricHint = METRICS.find((entry) => entry.value === form.metric)?.hint;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={isNew ? 'Add a daily quest' : `Edit ${quest.key}`}
      subtitle={
        isNew
          ? 'The key is permanent and is how progress rows are stored; the title is what members read.'
          : 'Changing the metric or target affects today only where progress has not already passed it. Paid XP is never clawed back.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="quest-form" loading={submitting} disabled={hasErrors}>
            {isNew ? 'Add quest' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id="quest-form" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Key"
            value={form.key}
            onChange={(event) => setField('key', event.target.value)}
            error={errors.key}
            disabled={!isNew}
            placeholder="gift-1"
            maxLength={40}
            hint={isNew ? 'Lowercase, digits and dashes. Cannot be changed later.' : 'Immutable: progress rows point at it.'}
          />
          <Input
            label="Title"
            value={form.title}
            onChange={(event) => setField('title', event.target.value)}
            error={errors.title}
            placeholder="Send a Gift"
            maxLength={80}
          />
        </div>

        <Input
          label="Description"
          value={form.description}
          onChange={(event) => setField('description', event.target.value)}
          error={errors.description}
          placeholder="Send any gift to a host in a live room."
          maxLength={300}
          hint="One line under the title on the phone. Optional."
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            label="What counts"
            value={form.metric}
            onChange={(event) => setField('metric', event.target.value as QuestMetric)}
          >
            {METRICS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </Select>
          <Input
            label="Target"
            inputMode="numeric"
            value={form.target}
            onChange={(event) => setField('target', event.target.value)}
            error={errors.target}
            hint="How much of the metric completes the quest."
          />
        </div>

        {metricHint !== undefined && <p className="-mt-1 text-[11px] text-faint">{metricHint}</p>}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Reward (XP)"
            inputMode="numeric"
            value={form.xpReward}
            onChange={(event) => setField('xpReward', event.target.value)}
            error={errors.xpReward}
            hint="Paid once, when the target is reached."
          />
          <Input
            label="Sort order"
            inputMode="numeric"
            value={form.sortOrder}
            onChange={(event) => setField('sortOrder', event.target.value)}
            error={errors.sortOrder}
            hint="Lower numbers appear first on the phone."
          />
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-edge/60 bg-elevated/40 p-3">
          <p className="text-[11px] leading-relaxed text-faint">
            {form.metric === 'CHAT_MESSAGE'
              ? 'Counted after the message is stored, so a failed chat line does not advance the quest.'
              : form.metric === 'GIFT_SENT'
                ? 'Counted inside the gift transaction: a gift that rolls back advances nothing.'
                : 'Counted from the diamonds the ledger actually moved, not from the gift list price a phone showed.'}
          </p>
          <label className="flex shrink-0 items-center gap-2 text-xs text-muted">
            <Switch checked={form.isActive} onChange={(next) => setField('isActive', next)} label="Active" />
            {form.isActive ? 'Active' : 'Retired'}
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

function DeleteQuestModal({
  quest,
  onClose,
  onDeleted,
}: {
  quest: AdminQuest;
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
      await api.deleteQuest(quest.key);
      onDeleted(quest.key);
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
      title={`Delete quest ${quest.key}?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirm()} loading={submitting}>
            Delete quest
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted">
        <p>
          <span className="font-semibold text-ink">{quest.title}</span> —{' '}
          {quest.completedToday === 0
            ? 'nobody has finished it today'
            : `${formatNumber(quest.completedToday)} member(s) finished it today`}
          . Deleting removes the row from every member's list immediately.
        </p>
        <p className="text-xs text-faint">
          The server refuses to delete a quest once any progress row exists, because some of those
          rows paid XP and the history is the record of it. Retire it instead: it disappears from the
          phone and keeps what it already paid.
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
