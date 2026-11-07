// ---------------------------------------------------------------------------
// Withdrawal queue: filter by status, then walk a request down the pipeline.
//
//   PENDING  --Review-->  APPROVED  --Pay-->  PAID
//       `--------------------------------------------->  REJECTED (from either side)
//
// Approving is a decision about the request; paying is the record that money left the company, and
// only the second one books the outflow server-side (POST /withdrawals/:id/review, /pay). The two
// are separate buttons because the two happen hours or days apart, and the row that sits between
// them is the platform still owing a host.
//
// The fee the platform keeps is set by the `accounts.withdrawal` dial at the moment the host asks,
// so the number shown here is the number that was quoted on the phone — moving the dial afterwards
// changes the next request, not this one.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { Avatar } from '../components/ui/Avatar';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Textarea } from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../context/AuthContext';
import {
  IconAlert,
  IconCheck,
  IconClose,
  IconCoin,
  IconRefresh,
  IconWallet,
} from '../components/ui/Icons';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { ApiError, api } from '../lib/api';
import { formatDateTime, formatRCoin, relativeTime } from '../lib/format';
import type { WithdrawalRow, WithdrawalStatus } from '../types';

const STATUS_TONES: Record<WithdrawalStatus, BadgeTone> = {
  PENDING: 'amber',
  APPROVED: 'sky',
  REJECTED: 'red',
  PAID: 'green',
};

function payoutDetailsSummary(details: Record<string, unknown>): string {
  const entries = Object.entries(details ?? {});
  if (entries.length === 0) return '—';
  return entries
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(' · ');
}

export default function WithdrawalsPage() {
  const toast = useToast();
  const { can } = useAuth();
  const [status, setStatus] = useState<'' | WithdrawalStatus>('PENDING');
  const [rows, setRows] = useState<WithdrawalRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewTarget, setReviewTarget] = useState<WithdrawalRow | null>(null);
  const [payTarget, setPayTarget] = useState<WithdrawalRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listWithdrawals({ status: status === '' ? undefined : status });
      setRows(result.withdrawals);
    } catch (err) {
      setRows([]);
      setError(err instanceof ApiError ? err.message : 'Failed to load withdrawals.');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const replaceRow = (updated: WithdrawalRow) => {
    setRows((current) => (current ?? []).map((row) => (row.id === updated.id ? updated : row)));
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Withdrawals</h1>
          <p className="mt-0.5 text-sm text-muted">R-coin cash-out requests from hosts and agencies.</p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value as '' | WithdrawalStatus)}
            className="w-44"
          >
            <option value="">All statuses</option>
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="PAID">Paid</option>
          </Select>
          <Button icon={<IconRefresh className="h-4 w-4" />} onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </div>

      <Card bodyClassName="p-0">
        {loading && rows === null ? (
          <div className="grid h-64 place-items-center text-violet-300">
            <Spinner className="h-8 w-8" />
          </div>
        ) : error !== null ? (
          <EmptyState
            title="Could not load withdrawals"
            message={error}
            icon={<IconAlert className="h-6 w-6" />}
            action={<Button onClick={() => void load()}>Retry</Button>}
          />
        ) : (rows ?? []).length === 0 ? (
          <EmptyState
            title={status === 'PENDING' ? 'Queue is clear' : 'No withdrawals match this filter'}
            message={status === 'PENDING' ? 'Nothing is waiting for review right now.' : 'Try a different status.'}
            icon={<IconWallet className="h-6 w-6" />}
          />
        ) : (
          <Table>
            <THead>
              <Th width="26%">User</Th>
              <Th align="right">Amount</Th>
              <Th>Payout method</Th>
              <Th>Payout details</Th>
              <Th>Requested</Th>
              <Th>Status</Th>
              <Th align="right" className="pr-4">
                Actions
              </Th>
            </THead>
            <TBody>
              {(rows ?? []).map((row) => (
                <Tr key={row.id}>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={row.user.username} src={row.user.avatarUrl} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink">{row.user.username}</p>
                        <p className="text-[11px] text-faint">
                          {row.user.phone} · wallet {formatRCoin(row.user.rCoinBalance)}
                        </p>
                      </div>
                    </div>
                  </Td>
                  <Td align="right" className="font-bold tabular-nums text-ink">
                    {formatRCoin(row.amountRCoins)}
                    {row.feeRCoins > 0 && (
                      <p className="text-[11px] font-normal text-faint" title="Fee kept by the platform; the host is paid the rest.">
                        −{formatRCoin(row.feeRCoins)} fee · {formatRCoin(row.netRCoins)} paid
                      </p>
                    )}
                  </Td>
                  <Td>
                    <Badge tone="slate">{row.payoutMethod}</Badge>
                  </Td>
                  <Td>
                    <span className="line-clamp-2 max-w-xs break-words text-xs" title={payoutDetailsSummary(row.payoutDetails)}>
                      {payoutDetailsSummary(row.payoutDetails)}
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap" title={formatDateTime(row.createdAt)}>
                    {relativeTime(row.createdAt)}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONES[row.status] ?? 'slate'}>{row.status}</Badge>
                    {row.status === 'PAID' && (
                      <p
                        className="mt-1 max-w-[13rem] break-words text-[11px] text-faint"
                        title={row.paidAt ? `Paid ${formatDateTime(row.paidAt)}` : undefined}
                      >
                        {row.payoutReference ?? 'paid without a reference'}
                      </p>
                    )}
                  </Td>
                  <Td align="right" className="pr-4">
                    {row.status === 'PENDING' && (
                      <div className="flex justify-end">
                        <Button size="sm" variant="primary" onClick={() => setReviewTarget(row)}>
                          Review
                        </Button>
                      </div>
                    )}
                    {row.status === 'APPROVED' && (
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          variant="success"
                          icon={<IconCoin className="h-4 w-4" />}
                          onClick={() => setPayTarget(row)}
                        >
                          Pay
                        </Button>
                      </div>
                    )}
                    {(row.status === 'PAID' || row.status === 'REJECTED') && (
                      <span className="block text-right text-xs text-faint">closed</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {reviewTarget !== null && (
        <ReviewModal
          withdrawal={reviewTarget}
          onClose={() => setReviewTarget(null)}
          onReviewed={(updated) => {
            replaceRow(updated);
            setReviewTarget(null);
            toast.success(
              updated.status === 'APPROVED'
                ? `Accepted ${formatRCoin(updated.amountRCoins)} for payout to ${updated.user.username}.`
                : `Rejected withdrawal from ${updated.user.username}.`,
            );
          }}
        />
      )}

      {payTarget !== null && (
        <PayModal
          withdrawal={payTarget}
          onClose={() => setPayTarget(null)}
          onPaid={(updated) => {
            replaceRow(updated);
            setPayTarget(null);
            toast.success(`Recorded ${formatRCoin(updated.netRCoins)} paid to ${updated.user.username}.`);
          }}
        />
      )}

      <PolicyCard canWrite={can('config:manage')} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pay modal: the reference is the point of the screen.
// ---------------------------------------------------------------------------
interface PayModalProps {
  withdrawal: WithdrawalRow;
  onClose: () => void;
  onPaid: (withdrawal: WithdrawalRow) => void;
}

function PayModal({ withdrawal, onClose, onPaid }: PayModalProps) {
  const [reference, setReference] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await api.payWithdrawal(withdrawal.id, reference.trim());
      onPaid(result.withdrawal);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Payout failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Record a payout"
      subtitle={`#${withdrawal.id.slice(0, 8)} · ${withdrawal.user.username}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="success" onClick={() => void submit()} loading={submitting} disabled={reference.trim().length < 3}>
            Mark as paid
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-edge/60 bg-elevated/40 p-4">
          <p className="text-xs uppercase tracking-wider text-faint">The host is owed</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-300">
            {formatRCoin(withdrawal.netRCoins)}
          </p>
          <p className="mt-1 text-xs text-muted">
            of {formatRCoin(withdrawal.amountRCoins)} requested
            {withdrawal.feeRCoins > 0 ? ` · ${formatRCoin(withdrawal.feeRCoins)} kept as the platform fee` : ' · no fee on this request'}{' '}
            · via <span className="font-semibold text-ink">{withdrawal.payoutMethod}</span> ·{' '}
            {payoutDetailsSummary(withdrawal.payoutDetails)}
          </p>
        </div>

        <Input
          label="Bank / transfer reference"
          maxLength={120}
          placeholder="e.g. HBL-TRX-000984321"
          hint="Required. This is what answers the host who asks in three weeks which transfer paid them, and the database refuses a paid row without one."
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          autoFocus
        />

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
// The cash-out policy the next request is priced on.
// ---------------------------------------------------------------------------
interface WithdrawalPolicy {
  minRCoins?: number;
  feeBps?: number;
}

function PolicyCard({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const [minimum, setMinimum] = useState('');
  const [fee, setFee] = useState('');
  const [loaded, setLoaded] = useState<WithdrawalPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .readConfig<WithdrawalPolicy>('accounts.withdrawal')
      .then((result) => {
        if (cancelled) return;
        setMinimum(String(result.value.minRCoins ?? ''));
        setFee(String(result.value.feeBps ?? ''));
        setLoaded({ minRCoins: Number(result.value.minRCoins ?? 0), feeBps: Number(result.value.feeBps ?? 0) });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to read the cash-out policy.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const minNumber = Number(minimum);
  const feeNumber = Number(fee);
  const whole = (value: number) => Number.isInteger(value) && value >= 0;
  const valid = whole(minNumber) && minNumber > 0 && whole(feeNumber) && feeNumber <= 10_000;
  const dirty =
    loaded !== null && (loaded.minRCoins !== minNumber || (loaded.feeBps ?? 0) !== feeNumber);

  const save = async () => {
    if (busy || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.writeConfig('accounts.withdrawal', { minRCoins: minNumber, feeBps: feeNumber });
      const value = result.value as WithdrawalPolicy;
      setLoaded({ minRCoins: Number(value.minRCoins), feeBps: Number(value.feeBps) });
      toast.success('Cash-out policy updated. Requests already in the queue keep the fee they were quoted.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the policy.');
    } finally {
      setBusy(false);
    }
  };

  if (loaded === null && error === null) return null;

  return (
    <Card
      title="Cash-out policy"
      subtitle="What the next request needs, and what the platform keeps from it."
      actions={
        canWrite && (
          <Button size="sm" variant="primary" onClick={() => void save()} loading={busy} disabled={!valid || !dirty}>
            Save policy
          </Button>
        )
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Minimum withdrawal (R-coins)"
          type="number"
          min={1}
          value={minimum}
          onChange={(e) => setMinimum(e.target.value)}
          disabled={!canWrite}
          hint="A host below this gets a refusal quoting this number, so it has to match what the app tells them."
        />
        <Input
          label="Fee (basis points, 100 = 1%)"
          type="number"
          min={0}
          max={10000}
          value={fee}
          onChange={(e) => setFee(e.target.value)}
          disabled={!canWrite}
          hint="Charged on the gross and kept when the payout is recorded. Saved requests keep the fee they were quoted with."
        />
      </div>
      {loaded !== null && (
        <p className="mt-3 text-xs text-faint">
          A {formatRCoin(100_000)} cash-out would pay the host{' '}
          <span className="text-ink">{formatRCoin(100_000 - Math.floor((100_000 * (feeNumber || 0)) / 10_000))}</span> and keep{' '}
          <span className="text-ink">{formatRCoin(Math.floor((100_000 * (feeNumber || 0)) / 10_000))}</span>.
        </p>
      )}
      {error !== null && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
          <IconAlert className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Approve / reject modal with note.
// ---------------------------------------------------------------------------
interface ReviewModalProps {
  withdrawal: WithdrawalRow;
  onClose: () => void;
  onReviewed: (withdrawal: WithdrawalRow) => void;
}

function ReviewModal({ withdrawal, onClose, onReviewed }: ReviewModalProps) {
  const [decision, setDecision] = useState<'approve' | 'reject'>('approve');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await api.reviewWithdrawal(
        withdrawal.id,
        decision === 'approve',
        note.trim() === '' ? undefined : note.trim(),
      );
      onReviewed(result.withdrawal);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Review failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Review withdrawal"
      subtitle={`#${withdrawal.id.slice(0, 8)} · ${withdrawal.user.username}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={decision === 'approve' ? 'success' : 'danger'}
            onClick={() => void submit()}
            loading={submitting}
          >
            {decision === 'approve' ? 'Accept request' : 'Reject request'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-edge/60 bg-elevated/40 p-4">
          <p className="text-xs uppercase tracking-wider text-faint">Requested amount</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-fuchsia-300">
            {formatRCoin(withdrawal.amountRCoins)}
          </p>
          {withdrawal.feeRCoins > 0 && (
            <p className="mt-0.5 text-xs text-muted">
              {formatRCoin(withdrawal.netRCoins)} of it reaches the host; {formatRCoin(withdrawal.feeRCoins)} stays with the platform.
            </p>
          )}
          <p className="mt-1 text-xs text-muted">
            via <span className="font-semibold text-ink">{withdrawal.payoutMethod}</span> ·{' '}
            {payoutDetailsSummary(withdrawal.payoutDetails)} · requested {relativeTime(withdrawal.createdAt)}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setDecision('approve')}
            className={`focus-ring flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-semibold transition ${
              decision === 'approve'
                ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300'
                : 'border-edge bg-elevated text-muted hover:text-ink'
            }`}
            aria-pressed={decision === 'approve'}
          >
            <IconCheck className="h-4 w-4" /> Approve
          </button>
          <button
            type="button"
            onClick={() => setDecision('reject')}
            className={`focus-ring flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-semibold transition ${
              decision === 'reject'
                ? 'border-rose-500/60 bg-rose-500/15 text-rose-300'
                : 'border-edge bg-elevated text-muted hover:text-ink'
            }`}
            aria-pressed={decision === 'reject'}
          >
            <IconClose className="h-4 w-4" /> Reject
          </button>
        </div>

        <Textarea
          label="Note (optional, stored with the review)"
          rows={3}
          maxLength={200}
          placeholder={
            decision === 'approve'
              ? 'e.g. KYC verified, bank transfer scheduled'
              : 'e.g. Payout details mismatch with account phone'
          }
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

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
