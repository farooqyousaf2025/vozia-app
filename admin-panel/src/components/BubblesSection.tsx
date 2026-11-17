import { useEffect, useState, type FormEvent } from 'react';
import { Badge } from './ui/Badge';
import { Button, IconButton } from './ui/Button';
import { Card } from './ui/Card';
import { EmptyState } from './ui/EmptyState';
import { Input } from './ui/Input';
import { IconAlert, IconEdit, IconPlus, IconSpark, IconTrash, IconUsers } from './ui/Icons';
import { Modal } from './ui/Modal';
import { Select } from './ui/Select';
import { Spinner } from './ui/Spinner';
import { Switch } from './ui/Switch';
import { useToast } from './ui/Toast';
import { useAuth } from '../context/AuthContext';
import { ApiError, api } from '../lib/api';
import { formatDiamonds } from '../lib/format';
import type { BubbleInput, ChatBubble, FrameHolder } from '../types';

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const MOTIFS: Record<ChatBubble['motif'], string> = {
  NONE: 'None',
  SPARKLE: 'Sparkle',
  HEART: 'Heart',
  CROWN: 'Crown',
};
const DEFAULT_COLORS = { background: '#211c35', accent: '#d9b777', textColor: '#f6eddb' };
const COLOR_LABELS = { background: 'Background colour', accent: 'Accent colour', textColor: 'Text colour' };
type BubbleLook = Pick<ChatBubble, 'background' | 'accent' | 'textColor' | 'motif'>;

function BubbleMotif({ motif }: { motif: ChatBubble['motif'] }) {
  if (motif === 'NONE') return null;
  if (motif === 'SPARKLE') return <IconSpark className="h-4 w-4 shrink-0" />;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0" aria-hidden="true">
      {motif === 'HEART' ? (
        <path d="M20.5 5.5a5 5 0 0 0-7 0L12 7l-1.5-1.5a5 5 0 0 0-7 7L12 21l8.5-8.5a5 5 0 0 0 0-7Z" />
      ) : (
        <><path d="m3 6 4 4 5-7 5 7 4-4-2 12H5L3 6Z" /><path d="M6 21h12M5 15h14" /></>
      )}
    </svg>
  );
}

function BubblePreview({ bubble }: { bubble: BubbleLook }) {
  const background = COLOR_PATTERN.test(bubble.background.trim()) ? bubble.background.trim() : DEFAULT_COLORS.background;
  const accent = COLOR_PATTERN.test(bubble.accent.trim()) ? bubble.accent.trim() : DEFAULT_COLORS.accent;
  const textColor = COLOR_PATTERN.test(bubble.textColor.trim()) ? bubble.textColor.trim() : DEFAULT_COLORS.textColor;
  return (
    <div className="rounded-xl border border-edge/60 bg-base p-3" aria-label="Message preview">
      <p className="mb-2 text-[11px] font-medium text-muted">Room chat · preview</p>
      <div className="rounded-2xl rounded-bl-sm border px-3 py-2.5" style={{ backgroundColor: background, borderColor: accent, color: textColor }}>
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="text-xs font-semibold">Aanya</span>
          <span style={{ color: accent }}><BubbleMotif motif={bubble.motif} /></span>
        </div>
        <p className="text-sm leading-relaxed">So glad you're here. Stay for one more song.</p>
      </div>
    </div>
  );
}

export function BubblesSection({ bubbles, onChanged }: { bubbles: ChatBubble[]; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const canManage = can('config:manage');
  const canReadHolders = can('user:read');
  const [editing, setEditing] = useState<ChatBubble | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ChatBubble | null>(null);
  const [holdersBubble, setHoldersBubble] = useState<ChatBubble | null>(null);
  const sorted = [...bubbles].sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));

  return (
    <>
      <Card
        title="Bubbles"
        subtitle="Chat colours and a small signature motif. No artwork or uploads needed."
        actions={canManage && (
          <Button variant="primary" size="sm" icon={<IconPlus className="h-4 w-4" />} onClick={() => setEditing('new')}>
            New bubble
          </Button>
        )}
      >
        {sorted.length === 0 ? (
          <EmptyState title="No chat bubbles" message="Add a bubble to style members' messages, then sell it or grant it from Users." icon={<IconSpark className="h-6 w-6" />} />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {sorted.map((bubble) => (
              <Card key={bubble.key} bodyClassName="flex h-full flex-col gap-3 p-3.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-ink" title={bubble.name}>{bubble.name}</p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-faint">{bubble.key}</p>
                </div>
                <BubblePreview bubble={bubble} />
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="slate">{MOTIFS[bubble.motif]}</Badge>
                  {bubble.recommended && <Badge tone="violet">recommended</Badge>}
                  {bubble.minVipLevel > 0 && <Badge tone="fuchsia">vip {bubble.minVipLevel}</Badge>}
                  {bubble.forSale ? (
                    <Badge tone="amber">{formatDiamonds(bubble.priceDiamonds)} · {bubble.periodDays === null ? 'forever' : `${bubble.periodDays}d`}</Badge>
                  ) : <Badge tone="slate">grant only</Badge>}
                </div>
                <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-edge/50 pt-2.5">
                  <p className="text-[11px] text-faint">{bubble.holders} holder{bubble.holders === 1 ? '' : 's'} · order {bubble.sortOrder}</p>
                  <div className="flex items-center gap-1">
                    {canReadHolders && (
                      <IconButton label={`Who holds ${bubble.name}`} onClick={() => setHoldersBubble(bubble)}><IconUsers className="h-4 w-4" /></IconButton>
                    )}
                    {canManage && (
                      <>
                        <IconButton label={`Edit ${bubble.name}`} onClick={() => setEditing(bubble)}><IconEdit className="h-4 w-4" /></IconButton>
                        <IconButton label={`Retire ${bubble.name}`} tone="danger" onClick={() => setDeleting(bubble)}><IconTrash className="h-4 w-4" /></IconButton>
                      </>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Card>
      {canManage && editing !== null && (
        <BubbleFormModal
          bubble={editing === 'new' ? null : editing}
          existingKeys={bubbles.map((bubble) => bubble.key)}
          onClose={() => setEditing(null)}
          onSaved={(bubble) => {
            setEditing(null);
            toast.success(`Bubble “${bubble.name}” saved.`);
            onChanged();
          }}
        />
      )}
      {canManage && deleting !== null && (
        <DeleteBubbleModal bubble={deleting} onClose={() => setDeleting(null)} onDeleted={(key, holders) => {
          setDeleting(null);
          toast.success(`Bubble “${key}” retired.${holders > 0 ? ` ${holders} member${holders === 1 ? '' : 's'} keep their receipt.` : ''}`);
          onChanged();
        }} />
      )}
      {canReadHolders && holdersBubble !== null && <BubbleHoldersModal bubble={holdersBubble} onClose={() => setHoldersBubble(null)} />}
    </>
  );
}

interface BubbleForm extends BubbleLook {
  key: string;
  name: string;
  sortOrder: string;
  priceDiamonds: string;
  forSale: boolean;
  periodDays: string;
  minVipLevel: string;
  recommended: boolean;
}

function validateBubble(form: BubbleForm, isNew: boolean, existingKeys: string[]) {
  const errors: Partial<Record<keyof BubbleForm, string>> = {};
  if (!KEY_PATTERN.test(form.key.trim())) errors.key = 'Use 2–39 lower-case letters, digits or dashes, starting with a letter or digit.';
  else if (isNew && existingKeys.includes(form.key.trim())) errors.key = 'A bubble with that key already exists.';
  if (!form.name.trim()) errors.name = 'Name is required.';
  else if (form.name.trim().length > 60) errors.name = 'Name is limited to 60 characters.';
  for (const field of ['background', 'accent', 'textColor'] as const) {
    if (!COLOR_PATTERN.test(form[field].trim())) errors[field] = 'Use six hex digits, like #d9b777.';
  }
  const contrast = contrastRatio(form.background, form.textColor);
  if (contrast !== null && contrast < 4.5) errors.textColor = 'Text and background need at least 4.5:1 contrast.';
  if (!Object.keys(MOTIFS).includes(form.motif)) errors.motif = 'Choose a motif from the list.';
  const order = Number(form.sortOrder);
  if (!/^-?\d+$/.test(form.sortOrder.trim()) || order < -9999 || order > 9999) errors.sortOrder = 'Whole number between -9999 and 9999.';
  const price = Number(form.priceDiamonds);
  if (!/^\d+$/.test(form.priceDiamonds.trim()) || price > 100_000_000) errors.priceDiamonds = 'Whole number between 0 and 100,000,000.';
  else if (form.forSale && price === 0) errors.priceDiamonds = 'An item on sale needs a price above zero.';
  else if (!form.forSale && price !== 0) errors.priceDiamonds = 'A grant-only item must have a zero price.';
  const days = form.periodDays.trim();
  if (days !== '' && (!/^\d+$/.test(days) || Number(days) < 1 || Number(days) > 3650)) errors.periodDays = 'Whole days between 1 and 3650, or empty for permanent.';
  if (!/^\d+$/.test(form.minVipLevel.trim()) || Number(form.minVipLevel) > 20) errors.minVipLevel = 'Whole number between 0 and 20.';
  return errors;
}

function contrastRatio(background: string, foreground: string): number | null {
  if (!COLOR_PATTERN.test(background.trim()) || !COLOR_PATTERN.test(foreground.trim())) return null;
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((offset) => {
      const value = parseInt(hex.trim().slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const a = luminance(background);
  const b = luminance(foreground);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function BubbleFormModal({ bubble, existingKeys, onClose, onSaved }: {
  bubble: ChatBubble | null;
  existingKeys: string[];
  onClose: () => void;
  onSaved: (bubble: ChatBubble) => void;
}) {
  const isNew = bubble === null;
  const [form, setForm] = useState<BubbleForm>(() => bubble === null ? {
    key: '', name: '', ...DEFAULT_COLORS, motif: 'SPARKLE', sortOrder: '0', priceDiamonds: '300',
    forSale: true, periodDays: '30', minVipLevel: '0', recommended: false,
  } : {
    key: bubble.key, name: bubble.name, background: bubble.background, accent: bubble.accent,
    textColor: bubble.textColor, motif: bubble.motif, sortOrder: String(bubble.sortOrder),
    priceDiamonds: String(bubble.priceDiamonds), forSale: bubble.forSale,
    periodDays: bubble.periodDays === null ? '' : String(bubble.periodDays),
    minVipLevel: String(bubble.minVipLevel), recommended: bubble.recommended,
  });
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const errors = validateBubble(form, isNew, existingKeys);
  const hasErrors = Object.keys(errors).length > 0;
  const contrast = contrastRatio(form.background, form.textColor);
  const setField = <K extends keyof BubbleForm>(key: K, value: BubbleForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const close = () => { if (!submitting) onClose(); };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (hasErrors || submitting) return;
    setSubmitting(true);
    setServerError(null);
    const input: BubbleInput = {
      key: form.key.trim(), name: form.name.trim(), background: form.background.trim(),
      accent: form.accent.trim(), textColor: form.textColor.trim(), motif: form.motif,
      sortOrder: Number(form.sortOrder), priceDiamonds: Number(form.priceDiamonds), forSale: form.forSale,
      periodDays: form.periodDays.trim() === '' ? null : Number(form.periodDays),
      minVipLevel: Number(form.minVipLevel), recommended: form.recommended,
    };
    try {
      const result = bubble === null ? await api.createBubble(input) : await api.updateBubble(bubble.key,
        Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== 'key' && value !== bubble[key as keyof BubbleInput])),
      );
      onSaved(result.bubble);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Saving the bubble failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal open onClose={close} size="lg" title={isNew ? 'Create bubble' : `Edit “${bubble.name}”`}
      subtitle="The key cannot change after creation. Colours and motif update the message style."
      footer={<>
        <Button onClick={close} disabled={submitting}>Cancel</Button>
        <Button variant="primary" type="submit" form="bubble-form" loading={submitting} disabled={hasErrors}>{isNew ? 'Create bubble' : 'Save changes'}</Button>
      </>}
    >
      <form id="bubble-form" onSubmit={submit}>
        <fieldset disabled={submitting} className="min-w-0 space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Key" value={form.key} onChange={(e) => setField('key', e.target.value)} error={errors.key} placeholder="midnight-gold" disabled={!isNew} maxLength={39} autoFocus={isNew} hint="Used in the store and on receipts." />
            <Input label="Display name" value={form.name} onChange={(e) => setField('name', e.target.value)} error={errors.name} placeholder="Midnight Gold" maxLength={60} autoFocus={!isNew} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {(['background', 'accent', 'textColor'] as const).map((field) => (
              <Input key={field} label={COLOR_LABELS[field]} value={form[field]} onChange={(e) => setField(field, e.target.value)} error={errors[field]} maxLength={7} spellCheck={false} />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select label="Motif" value={form.motif} error={errors.motif} onChange={(e) => setField('motif', e.target.value as ChatBubble['motif'])}>
              {(Object.keys(MOTIFS) as ChatBubble['motif'][]).map((motif) => <option key={motif} value={motif}>{MOTIFS[motif]}</option>)}
            </Select>
            <Input label="Sort order" inputMode="numeric" value={form.sortOrder} onChange={(e) => setField('sortOrder', e.target.value)} error={errors.sortOrder} />
          </div>
          <BubblePreview bubble={form} />
          {contrast !== null && contrast < 4.5 && (
            <p role="status" className="text-xs text-amber-300">Text contrast is low ({contrast.toFixed(1)}:1). Choose lighter text or a darker background for readable messages.</p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-3 rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2.5">
              <Switch checked={form.forSale} onChange={(next) => setForm((current) => ({ ...current, forSale: next, priceDiamonds: next ? current.priceDiamonds : '0' }))} label="Sell this bubble" />
              <span className="text-xs"><span className="font-medium text-ink">For sale</span><span className="text-faint"> — off makes it grant only.</span></span>
            </label>
            <label className="flex items-center gap-3 rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2.5">
              <Switch checked={form.recommended} onChange={(next) => setField('recommended', next)} label="Recommend this bubble" />
              <span className="text-xs font-medium text-ink">Recommended</span>
            </label>
            <Input label="Price (diamonds)" inputMode="numeric" value={form.priceDiamonds} onChange={(e) => setField('priceDiamonds', e.target.value)} error={errors.priceDiamonds} disabled={!form.forSale} />
            <Input label="Rent for (days)" inputMode="numeric" value={form.periodDays} onChange={(e) => setField('periodDays', e.target.value)} error={errors.periodDays} hint="Empty means permanent." />
            <Input label="VIP level required to buy" inputMode="numeric" value={form.minVipLevel} onChange={(e) => setField('minVipLevel', e.target.value)} error={errors.minVipLevel} hint="0 opens purchases to everyone." />
          </div>
          {serverError !== null && <BubbleError message={serverError} />}
        </fieldset>
      </form>
    </Modal>
  );
}

function DeleteBubbleModal({ bubble, onClose, onDeleted }: {
  bubble: ChatBubble;
  onClose: () => void;
  onDeleted: (key: string, holders: number) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { if (!submitting) onClose(); };
  const confirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { removed } = await api.deleteBubble(bubble.key);
      onDeleted(removed.key, removed.holders);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Retiring the bubble failed.');
      setSubmitting(false);
    }
  };
  return (
    <Modal open onClose={close} size="sm" title={`Retire “${bubble.name}”?`} footer={<>
      <Button onClick={close} disabled={submitting}>Cancel</Button>
      <Button variant="danger" onClick={() => void confirm()} loading={submitting}>Retire bubble</Button>
    </>}>
      <div className="space-y-3 text-sm text-muted">
        <p>This removes the bubble from the catalogue. Members can no longer use it for new messages; existing messages keep their saved style.</p>
        <p>{bubble.holders === 0 ? 'Nobody holds this bubble.' : `${bubble.holders} member${bubble.holders === 1 ? '' : 's'} keep their receipt, but cannot use this bubble for new messages.`}</p>
        {error !== null && <BubbleError message={error} />}
      </div>
    </Modal>
  );
}

function BubbleHoldersModal({ bubble, onClose }: { bubble: ChatBubble; onClose: () => void }) {
  const [holders, setHolders] = useState<FrameHolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setHolders(null);
    setError(null);
    api.bubbleHolders(bubble.key).then((result) => {
      if (!cancelled) setHolders(result.holders);
    }).catch((err) => {
      if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load the holders.');
    });
    return () => { cancelled = true; };
  }, [bubble.key, reloadKey]);
  return (
    <Modal open onClose={onClose} size="md" title={`Who holds “${bubble.name}”`} footer={<Button onClick={onClose}>Close</Button>}>
      {error !== null ? (
        <div className="space-y-3"><BubbleError message={error} /><Button size="sm" onClick={() => setReloadKey((key) => key + 1)}>Retry</Button></div>
      ) : holders === null ? (
        <div className="grid h-32 place-items-center text-violet-300" role="status" aria-label="Loading holders"><Spinner className="h-6 w-6" /></div>
      ) : holders.length === 0 ? (
        <EmptyState title="Nobody holds this bubble" message="No purchase or grant names this key yet." icon={<IconUsers className="h-6 w-6" />} />
      ) : (
        <ul className="divide-y divide-edge/50">
          {holders.map((holder) => (
            <li key={holder.userId} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
              <span className="break-all font-medium text-ink">{holder.username}</span>
              <span className="flex items-center gap-2 text-[11px] text-muted">
                <Badge tone={holder.acquiredVia === 'PURCHASE' ? 'green' : 'sky'}>{holder.acquiredVia === 'PURCHASE' ? 'bought' : 'granted'}</Badge>
                <span className="tabular-nums">{holder.expiresAt === null ? 'permanent' : `until ${holder.expiresAt.slice(0, 10)}`}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function BubbleError({ message }: { message: string }) {
  return <div role="alert" className="flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200"><IconAlert className="h-4 w-4 shrink-0" />{message}</div>;
}
