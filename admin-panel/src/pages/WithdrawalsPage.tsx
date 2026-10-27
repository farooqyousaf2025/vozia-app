// ---------------------------------------------------------------------------
// Withdrawal queue: filter by status, approve/reject with an audit note via
// POST /withdrawals/:id/review. Rows refresh from the API response.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { Avatar } from '../components/ui/Avatar';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Modal } from '../components/ui/Modal';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Textarea } from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import {
  IconAlert,
  IconCheck,
  IconClose,
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
  const [status, setStatus] = useState<'' | WithdrawalStatus>('PENDING');
  const [rows, setRows] = useState<WithdrawalRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewTarget, setReviewTarget] = useState<WithdrawalRow | null>(null);

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
                  </Td>
                  <Td align="right" className="pr-4">
                    {row.status === 'PENDING' ? (
                      <div className="flex justify-end">
                        <Button size="sm" variant="primary" onClick={() => setReviewTarget(row)}>
                          Review
                        </Button>
                      </div>
                    ) : (
                      <span className="block text-right text-xs text-faint">reviewed</span>
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
                ? `Approved ${formatRCoin(updated.amountRCoins)} for ${updated.user.username}.`
                : `Rejected withdrawal from ${updated.user.username}.`,
            );
          }}
        />
      )}
    </div>
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
            {decision === 'approve' ? 'Approve payout' : 'Reject request'}
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
