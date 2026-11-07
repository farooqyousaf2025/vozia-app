// ---------------------------------------------------------------------------
// Moderation: the member report queue. Filing a report never bans anyone on its
// own — a decision is made here, and banning the target is a separate checkbox
// the server refuses to combine with a dismissal.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../components/ui/Avatar';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input, Textarea } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Pagination } from '../components/ui/Pagination';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../context/AuthContext';
import { IconAlert, IconCheck, IconSearch, IconShieldCheck } from '../components/ui/Icons';
import { ApiError, api } from '../lib/api';
import { relativeTime } from '../lib/format';
import type { AdminReport, ReportDecision, ReportReason, ReportStatus } from '../types';

const PAGE_LIMIT = 25;

const REASON_LABELS: Record<ReportReason, string> = {
  HARASSMENT: 'Harassment',
  SPAM: 'Spam',
  FRAUD: 'Fraud',
  UNDERAGE: 'Underage',
  VIOLENCE: 'Violence',
  OTHER: 'Other',
};

const STATUS_TONES: Record<ReportStatus, BadgeTone> = {
  PENDING: 'amber',
  REVIEWED: 'sky',
  DISMISSED: 'slate',
  ACTIONED: 'green',
};

const DECISION_LABELS: Record<ReportDecision, string> = {
  REVIEWED: 'Reviewed — no action needed',
  ACTIONED: 'Actioned — the complaint was upheld',
  DISMISSED: 'Dismissed — unfounded',
};

export default function ModerationPage() {
  const toast = useToast();
  const { can } = useAuth();
  // Reading the queue is `user:read`; closing a report is `user:moderate`. A viewer role sees the
  // queue and the decisions already made, but not a button the server would refuse.
  const canModerate = can('user:moderate');

  const [status, setStatus] = useState<'' | ReportStatus>('PENDING');
  const [target, setTarget] = useState('');
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<AdminReport[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewTarget, setReviewTarget] = useState<AdminReport | null>(null);

  const query = useMemo(
    () => ({
      status: status === '' ? undefined : status,
      targetUserId: target.trim() === '' ? undefined : target.trim(),
      page,
      limit: PAGE_LIMIT,
    }),
    [status, target, page],
  );

  useEffect(() => {
    setPage(1);
  }, [status, target]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.reports(query);
      setRows(result.reports);
      setTotal(result.total);
    } catch (err) {
      setRows([]);
      setTotal(0);
      setError(err instanceof ApiError ? err.message : 'Failed to load reports.');
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyReview = (updated: AdminReport) => {
    // A resolved report leaves the PENDING queue; keep it visible in the other views.
    if (status === 'PENDING') {
      setRows((current) => current.filter((row) => row.id !== updated.id));
      setTotal((current) => Math.max(0, current - 1));
    } else {
      setRows((current) => current.map((row) => (row.id === updated.id ? updated : row)));
    }
    setReviewTarget(null);
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink">Moderation</h1>
        <p className="mt-0.5 text-sm text-muted">
          The member report queue. Each decision is recorded in the audit log; a report alone never
          changes an account.
        </p>
      </div>

      <Card bodyClassName="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="Status"
            aria-label="Filter by report status"
            value={status}
            onChange={(e) => setStatus(e.target.value as '' | ReportStatus)}
            className="w-44"
          >
            <option value="">All statuses</option>
            <option value="PENDING">Pending</option>
            <option value="REVIEWED">Reviewed</option>
            <option value="ACTIONED">Actioned</option>
            <option value="DISMISSED">Dismissed</option>
          </Select>
          <Input
            label="Reported member"
            leadingIcon={<IconSearch className="h-4 w-4" />}
            placeholder="Paste a member UUID"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="min-w-[260px] flex-1"
            hint="Exact account id; cleared means every member."
          />
        </div>
      </Card>

      <Card bodyClassName="p-0">
        {loading && rows.length === 0 ? (
          <div className="grid h-64 place-items-center text-violet-300">
            <Spinner className="h-8 w-8" />
          </div>
        ) : error !== null ? (
          <EmptyState
            title="Could not load reports"
            message={error}
            icon={<IconAlert className="h-6 w-6" />}
            action={<Button onClick={() => void load()}>Retry</Button>}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={status === 'PENDING' ? 'Nothing waiting' : 'No reports match'}
            message={
              status === 'PENDING'
                ? 'Every report has a decision. New complaints will appear here.'
                : 'Adjust the status filter or the reported member.'
            }
            icon={<IconShieldCheck className="h-6 w-6" />}
          />
        ) : (
          <div className="p-2">
            <Table>
              <THead>
                <Th>Reported</Th>
                <Th>Reporter</Th>
                <Th>Reason</Th>
                <Th>Details</Th>
                <Th>Room</Th>
                <Th>Filed</Th>
                <Th>Status</Th>
                <Th align="right" className="pr-4">
                  Decision
                </Th>
              </THead>
              <TBody>
                {rows.map((report) => (
                  <Tr key={report.id}>
                    <Td>
                      <span className="flex items-center gap-2.5">
                        <Avatar name={report.target.username} src={report.target.avatarUrl} size="sm" />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-ink">
                            {report.target.username}
                          </span>
                          <span className="block truncate font-mono text-[10px] text-faint">
                            {report.target.id}
                          </span>
                        </span>
                      </span>
                    </Td>
                    <Td>
                      <span className="block truncate text-sm">{report.reporter.username}</span>
                    </Td>
                    <Td>
                      <Badge tone="violet">{REASON_LABELS[report.reason]}</Badge>
                    </Td>
                    <Td className="max-w-[260px]">
                      <span className="block truncate text-xs text-muted" title={report.details ?? ''}>
                        {report.details ?? '—'}
                      </span>
                    </Td>
                    <Td>
                      {report.room === null ? (
                        <span className="text-xs text-faint">—</span>
                      ) : (
                        <Link
                          to={`/rooms/${report.room.id}`}
                          className="text-xs text-violet-300 hover:text-violet-200"
                        >
                          #{report.room.roomNumber}
                        </Link>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-xs">{relativeTime(report.createdAt)}</Td>
                    <Td>
                      <Badge tone={STATUS_TONES[report.status]}>{report.status}</Badge>
                      {report.resolution !== null && (
                        <span className="mt-1 block max-w-[180px] truncate text-[11px] text-faint" title={report.resolution}>
                          {report.resolution}
                        </span>
                      )}
                    </Td>
                    <Td align="right" className="whitespace-nowrap pr-4">
                      {report.status === 'PENDING' ? (
                        canModerate ? (
                          <Button
                            size="sm"
                            icon={<IconCheck className="h-3.5 w-3.5" />}
                            onClick={() => setReviewTarget(report)}
                          >
                            Decide
                          </Button>
                        ) : (
                          <span className="text-[11px] text-faint">view only</span>
                        )
                      ) : (
                        <span className="text-[11px] text-faint">
                          {report.reviewedAt === null ? 'closed' : relativeTime(report.reviewedAt)}
                        </span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <div className="px-3 pb-3">
              <Pagination page={page} limit={PAGE_LIMIT} total={total} onChange={setPage} />
            </div>
          </div>
        )}
      </Card>

      {reviewTarget !== null && (
        <ReviewReportModal
          report={reviewTarget}
          onClose={() => setReviewTarget(null)}
          onReviewed={(result) => {
            applyReview(result.report);
            toast.success(
              result.banned
                ? `${result.report.target.username} banned and the report closed.`
                : 'Report closed.',
            );
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One decision per report. The ban checkbox is a second act, disabled while the
// decision is "dismissed", matching the server's refusal of that pairing.
// ---------------------------------------------------------------------------
interface ReviewReportModalProps {
  report: AdminReport;
  onClose: () => void;
  onReviewed: (result: { report: AdminReport; banned: boolean }) => void;
}

function ReviewReportModal({ report, onClose, onReviewed }: ReviewReportModalProps) {
  const [decision, setDecision] = useState<ReportDecision>('ACTIONED');
  const [resolution, setResolution] = useState('');
  const [banUser, setBanUser] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const canBan = decision !== 'DISMISSED';
  const resolutionError = resolution.trim().length > 300 ? 'Limited to 300 characters.' : null;
  const canSubmit = resolutionError === null && !submitting;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await api.reviewReport(
        report.id,
        decision,
        resolution.trim(),
        canBan && banUser,
      );
      onReviewed(result);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Could not close the report.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Close a report"
      subtitle={
        <span className="flex items-center gap-2">
          <Avatar name={report.target.username} src={report.target.avatarUrl} size="xs" />
          {report.reporter.username} reported {report.target.username} · {REASON_LABELS[report.reason]}
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="review-report-form"
            loading={submitting}
            disabled={!canSubmit}
          >
            Save decision
          </Button>
        </>
      }
    >
      <form id="review-report-form" onSubmit={submit} className="space-y-4">
        {report.details !== null && (
          <div className="rounded-lg border border-edge/60 bg-elevated/40 p-3">
            <p className="text-xs text-faint">What the reporter wrote</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{report.details}</p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-xs text-faint">Reported member</p>
            <p className="mt-0.5 text-sm font-semibold text-ink">{report.target.username}</p>
            <p className="font-mono text-[10px] text-faint">{report.target.id}</p>
          </div>
          <div>
            <p className="text-xs text-faint">Reported from</p>
            <p className="mt-0.5 text-sm text-ink">
              {report.room === null ? 'No room supplied' : `Room #${report.room.roomNumber}`}
              {report.room !== null && <span className="text-faint"> · {report.room.title}</span>}
            </p>
          </div>
        </div>

        <Select
          label="Decision"
          value={decision}
          onChange={(e) => {
            const next = e.target.value as ReportDecision;
            setDecision(next);
            if (next === 'DISMISSED') setBanUser(false);
          }}
        >
          {(Object.keys(DECISION_LABELS) as ReportDecision[]).map((option) => (
            <option key={option} value={option}>
              {DECISION_LABELS[option]}
            </option>
          ))}
        </Select>

        <Textarea
          label="Resolution (stored with the report)"
          rows={3}
          maxLength={300}
          placeholder="e.g. Warning issued; the member removed the offending message."
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          error={resolutionError}
        />

        <label
          className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${
            canBan ? 'border-edge/60 bg-elevated/40' : 'border-edge/40 opacity-60'
          }`}
        >
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-rose-500"
            checked={canBan && banUser}
            disabled={!canBan}
            onChange={(e) => setBanUser(e.target.checked)}
          />
          <span>
            <span className="block font-semibold text-ink">Also ban {report.target.username}</span>
            <span className="block text-xs text-muted">
              A separate act. It is refused alongside a dismissal, because dismissing the complaint
              says it was unfounded.
            </span>
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
