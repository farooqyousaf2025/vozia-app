// ---------------------------------------------------------------------------
// Become a Partner: the queue an account filed, and the four ways it can end.
//
//   PENDING  --Approve-->  APPROVED  --Revoke-->  REVOKED
//      |                                          ^
//      +--Ask for info-->  INFO_REQUESTED --answer--+--Reject-->  REJECTED
//                                     |                          ^
//                                     +---- (the applicant may withdraw) ---- CANCELLED
//
// The row whose status is APPROVED *is* the role — migration 0035 — so approving is the only grant
// path in the product and revoking is the only removal path. `users.user_type` is not consulted
// anywhere on this screen: it records who has hosted a room, which is a different fact.
//
// Approving a coin seller names the BD account it reports to, because an unassigned seller accrues no
// BD commission and reads as a zero-rate rule rather than as a missing parent. Approving an agency
// creates one, so a name somebody already holds is refused at this click and the fix is to ask the
// applicant for a different one.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Avatar } from '../components/ui/Avatar';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input, Textarea } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../context/AuthContext';
import { IconAlert, IconCheck, IconClose, IconPartners, IconRefresh, IconSearch } from '../components/ui/Icons';
import { ApiError, api } from '../lib/api';
import { formatDateTime, relativeTime } from '../lib/format';
import type {
  ApplicationFormSpec,
  ApplicationStatus,
  PartnerRole,
  RoleApplicationRow,
} from '../types';

const ROLE_LABELS: Record<PartnerRole, string> = {
  HOST: 'Host',
  AGENCY: 'Agency',
  COIN_SELLER: 'Coin Seller',
  BD_MANAGER: 'BD Manager',
};

const ROLE_TONES: Record<PartnerRole, BadgeTone> = {
  HOST: 'violet',
  AGENCY: 'sky',
  COIN_SELLER: 'pink',
  BD_MANAGER: 'fuchsia',
};

const STATUS_TONES: Record<ApplicationStatus, BadgeTone> = {
  PENDING: 'amber',
  INFO_REQUESTED: 'sky',
  APPROVED: 'green',
  REJECTED: 'red',
  CANCELLED: 'slate',
  REVOKED: 'red',
};

/** An application the operator may still decide. `APPROVED` is decided — it is revoked, not re-decided. */
const DECIDABLE: ApplicationStatus[] = ['PENDING', 'INFO_REQUESTED'];

/**
 * One answer rendered as text. `CHECKBOX` and `AGENCY` need help: a boolean is not something an
 * operator scans for, and a host's preferred agency is a uuid they were never shown.
 */
function renderAnswer(
  value: unknown,
  field: ApplicationFormSpec['fields'][number],
  agencyNames: Map<string, string>,
): string {
  if (value === undefined || value === null || value === '') return '—';
  if (field.input === 'CHECKBOX') return value ? 'Yes' : 'No';
  if (field.input === 'AGENCY') return agencyNames.get(String(value)) ?? `Agency ${String(value).slice(0, 8)} (no longer active)`;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export default function ApplicationsPage() {
  const toast = useToast();
  const { can } = useAuth();
  const [status, setStatus] = useState<'' | ApplicationStatus>('PENDING');
  const [role, setRole] = useState<'' | PartnerRole>('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<RoleApplicationRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [specs, setSpecs] = useState<ApplicationFormSpec[] | null>(null);
  const [agencyNames, setAgencyNames] = useState<Map<string, string>>(new Map());
  const [target, setTarget] = useState<RoleApplicationRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listApplications({
        status: status === '' ? undefined : status,
        role: role === '' ? undefined : role,
        search: search.trim() === '' ? undefined : search.trim(),
        limit: 50,
      });
      setRows(result.applications);
      setTotal(result.total);
    } catch (err) {
      setRows([]);
      setError(err instanceof ApiError ? err.message : 'Failed to load applications.');
    } finally {
      setLoading(false);
    }
  }, [status, role, search]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .applicationForms()
      .then((result) => {
        setSpecs(result.roles);
        setAgencyNames(new Map(result.agencies.map((agency) => [agency.id, agency.name])));
      })
      .catch(() => setSpecs([]));
  }, []);

  const replaceRow = (updated: RoleApplicationRow) => {
    setRows((current) => (current ?? []).map((row) => (row.id === updated.id ? updated : row)));
    setTarget((current) => (current?.id === updated.id ? updated : current));
  };

  const formFor = useMemo(() => {
    const byRole = new Map((specs ?? []).map((spec) => [spec.role, spec]));
    return (row: RoleApplicationRow) => byRole.get(row.role);
  }, [specs]);

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Partner applications</h1>
          <p className="mt-0.5 text-sm text-muted">
            Who has asked to be a Host, an Agency, a Coin Seller or a BD Manager — and what was decided.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Search by username or phone"
            placeholder="Username or phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leadingIcon={<IconSearch className="h-4 w-4" />}
            className="w-48"
          />
          <Select
            aria-label="Filter by role"
            value={role}
            onChange={(e) => setRole(e.target.value as '' | PartnerRole)}
            className="w-40"
          >
            <option value="">All roles</option>
            <option value="HOST">Host</option>
            <option value="AGENCY">Agency</option>
            <option value="COIN_SELLER">Coin Seller</option>
            <option value="BD_MANAGER">BD Manager</option>
          </Select>
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value as '' | ApplicationStatus)}
            className="w-44"
          >
            <option value="">All statuses</option>
            <option value="PENDING">Pending</option>
            <option value="INFO_REQUESTED">Waiting on applicant</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="CANCELLED">Withdrawn</option>
            <option value="REVOKED">Revoked</option>
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
            title="Could not load applications"
            message={error}
            icon={<IconAlert className="h-6 w-6" />}
            action={<Button onClick={() => void load()}>Retry</Button>}
          />
        ) : (rows ?? []).length === 0 ? (
          <EmptyState
            title={status === 'PENDING' ? 'Queue is clear' : 'No applications match this filter'}
            message={
              status === 'PENDING'
                ? 'Nobody is waiting for a role decision right now.'
                : `${total} row(s) match. Try a different role or status.`
            }
            icon={<IconPartners className="h-6 w-6" />}
          />
        ) : (
          <Table>
            <THead>
              <Th width="24%">Applicant</Th>
              <Th>Role</Th>
              <Th>Answers</Th>
              <Th>Filed</Th>
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
                      <Avatar name={row.applicant?.username ?? '?'} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink">
                          {row.applicant?.username ?? 'unknown account'}
                        </p>
                        <p className="text-[11px] text-faint">
                          {row.applicant?.phone} · {row.applicant?.countryCode ?? 'no country'}
                        </p>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <Badge tone={ROLE_TONES[row.role]}>{ROLE_LABELS[row.role]}</Badge>
                  </Td>
                  <Td>
                    <button
                      type="button"
                      onClick={() => setTarget(row)}
                      className="focus-ring truncate text-left text-xs text-violet-300 hover:text-violet-200"
                    >
                      {Object.keys(row.data ?? {}).length} answers · view
                    </button>
                  </Td>
                  <Td className="whitespace-nowrap" title={formatDateTime(row.submittedAt)}>
                    {relativeTime(row.submittedAt)}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONES[row.status] ?? 'slate'}>{row.status}</Badge>
                    {row.grant.label !== null && row.grant.label !== undefined && (
                      <p className="mt-1 max-w-[13rem] break-words text-[11px] text-faint">
                        {row.grant.label}
                        {row.grant.status !== null && row.grant.status !== undefined ? ` · ${row.grant.status}` : ''}
                      </p>
                    )}
                    {row.status === 'INFO_REQUESTED' && row.infoRequestNote !== null && (
                      <p className="mt-1 max-w-[15rem] break-words text-[11px] text-sky-200/80" title={formatDateTime(row.reviewedAt)}>
                        asked: {row.infoRequestNote}
                      </p>
                    )}
                    {(row.status === 'REJECTED' || row.status === 'REVOKED') && (
                      <p className="mt-1 max-w-[15rem] break-words text-[11px] text-rose-200/80">
                        {row.status === 'REJECTED' ? row.decisionNote : row.revokeReason}
                      </p>
                    )}
                  </Td>
                  <Td align="right" className="pr-4">
                    <div className="flex justify-end gap-2">
                      {DECIDABLE.includes(row.status) && can('application:review') && (
                        <Button size="sm" variant="primary" onClick={() => setTarget(row)}>
                          Review
                        </Button>
                      )}
                      {row.status === 'APPROVED' && can('application:review') && (
                        <Button size="sm" variant="danger" onClick={() => setTarget(row)}>
                          Revoke
                        </Button>
                      )}
                      {!DECIDABLE.includes(row.status) && row.status !== 'APPROVED' && (
                        <button
                          type="button"
                          onClick={() => setTarget(row)}
                          className="focus-ring text-xs text-faint hover:text-ink"
                        >
                          history
                        </button>
                      )}
                    </div>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {target !== null && (
        <ApplicationModal
          application={target}
          form={formFor(target)}
          agencyNames={agencyNames}
          canReview={can('application:review')}
          canPickBd={can('business:manage')}
          onClose={() => setTarget(null)}
          onDecided={(updated) => {
            replaceRow(updated);
            toast.success(
              updated.status === 'APPROVED'
                ? `Granted ${ROLE_LABELS[updated.role]} to ${updated.applicant?.username ?? 'the applicant'}.`
                : updated.status === 'INFO_REQUESTED'
                  ? 'Asked the applicant for more information.'
                  : updated.status === 'REVOKED'
                    ? `Revoked the ${ROLE_LABELS[updated.role]} role.`
                    : `Rejected the ${ROLE_LABELS[updated.role]} application.`,
            );
          }}
        />
      )}

      <HostingSwitch canWrite={can('config:manage')} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The detail + decision panel. Reading the answers and deciding are the same modal because the
// decision is only defensible after the answers.
// ---------------------------------------------------------------------------
interface ApplicationModalProps {
  application: RoleApplicationRow;
  form?: ApplicationFormSpec;
  agencyNames: Map<string, string>;
  canReview: boolean;
  canPickBd: boolean;
  onClose: () => void;
  onDecided: (application: RoleApplicationRow) => void;
}

function ApplicationModal({
  application,
  form,
  agencyNames,
  canReview,
  canPickBd,
  onClose,
  onDecided,
}: ApplicationModalProps) {
  const [decision, setDecision] = useState<'approve' | 'request_info' | 'reject'>('approve');
  const [note, setNote] = useState('');
  const [bdAccountId, setBdAccountId] = useState('');
  const [bdOptions, setBdOptions] = useState<Array<{ id: string; code: string; displayName: string }>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const isSeller = application.role === 'COIN_SELLER';
  const needsBd = isSeller && decision === 'approve';

  useEffect(() => {
    if (!isSeller || !canPickBd) return;
    api
      .businessAccounts({ kind: 'BD_MANAGER', status: 'ACTIVE', limit: 50 })
      .then((result) =>
        setBdOptions(
          result.accounts
            // A BD agent can parent a seller; the account named here is the one that earns the
            // commission, so the manager roster is what an operator means to choose from.
            .filter((account) => account.kind === 'BD_MANAGER' || account.kind === 'BD_AGENT')
            .map((account) => ({ id: account.id, code: account.code, displayName: account.displayName })),
        ),
      )
      .catch(() => setBdOptions([]));
  }, [isSeller, canPickBd]);

  const noteRequired = decision !== 'approve';
  const blockedByBd = needsBd && bdAccountId === '';
  const blockedByNote = noteRequired && note.trim().length < 3;
  const canSubmit = !submitting && !blockedByBd && !blockedByNote;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const trimmed = note.trim();
      const result =
        decision === 'approve'
          ? await api.approveApplication(application.id, {
              note: trimmed === '' ? undefined : trimmed,
              bdAccountId: needsBd ? bdAccountId : undefined,
            })
          : decision === 'reject'
            ? await api.rejectApplication(application.id, trimmed)
            : await api.requestApplicationInfo(application.id, trimmed);
      onDecided(result.application);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'The decision failed.');
      setSubmitting(false);
    }
  };

  const revoke = async () => {
    if (submitting || note.trim().length < 3) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await api.revokeApplication(application.id, note.trim());
      onDecided(result.application);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'The revocation failed.');
      setSubmitting(false);
    }
  };

  const decidable = DECIDABLE.includes(application.status);
  const revokable = application.status === 'APPROVED';

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={
        decidable
          ? `Review ${ROLE_LABELS[application.role]} application`
          : revokable
            ? `Revoke the ${ROLE_LABELS[application.role]} role`
            : `${ROLE_LABELS[application.role]} application — ${application.status.toLowerCase()}`
      }
      subtitle={
        <>
          #{application.id.slice(0, 8)} · {application.applicant?.username ?? 'unknown account'} ·{' '}
          {application.applicant?.phone} · filed {relativeTime(application.submittedAt)}
        </>
      }
      footer={
        canReview && (decidable || revokable) ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            {decidable && (
              <Button
                variant={decision === 'approve' ? 'success' : decision === 'reject' ? 'danger' : 'primary'}
                onClick={() => void submit()}
                loading={submitting}
                disabled={!canSubmit}
              >
                {decision === 'approve'
                  ? `Grant ${ROLE_LABELS[application.role]}`
                  : decision === 'reject'
                    ? 'Reject application'
                    : 'Ask for information'}
              </Button>
            )}
            {revokable && (
              <Button variant="danger" onClick={() => void revoke()} loading={submitting} disabled={note.trim().length < 3}>
                Revoke role
              </Button>
            )}
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-edge/60 bg-elevated/40 p-4">
          <p className="text-xs uppercase tracking-wider text-faint">{form?.title ?? application.role}</p>
          {form !== undefined && (
            <p className="mt-0.5 text-xs text-muted">{form.blurb}</p>
          )}
          <dl className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {(form?.fields ?? []).map((field) => (
              <div key={field.key} className="min-w-0">
                <dt className="text-[11px] uppercase tracking-wide text-faint">
                  {field.label}
                  {!field.required && <span className="ml-1 normal-case text-faint/70">(optional)</span>}
                </dt>
                <dd className="break-words text-sm text-ink">
                  {renderAnswer(application.data[field.key], field, agencyNames)}
                </dd>
              </div>
            ))}
            {/* Anything the form no longer asks, kept because the row was filed under an older spec. */}
            {Object.keys(application.data ?? {})
              .filter((key) => !form?.fields.some((field) => field.key === key))
              .map((key) => (
                <div key={key} className="min-w-0">
                  <dt className="text-[11px] uppercase tracking-wide text-faint">{key} (not on the current form)</dt>
                  <dd className="break-words text-sm text-ink">{renderAnswer(application.data[key], { input: 'TEXT', key, label: key, required: false }, agencyNames)}</dd>
                </div>
              ))}
          </dl>
        </div>

        {application.grant.kind !== null && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge/60 bg-elevated/40 px-4 py-3 text-xs text-muted">
            <IconCheck className="h-4 w-4 text-emerald-300" />
            <span>
              This decision created{' '}
              <span className="font-semibold text-ink">
                {application.grant.kind === 'HOST' ? 'a marker on the applicant’s own account' : application.grant.label}
              </span>
              {application.grant.status !== null && application.grant.status !== undefined ? (
                <>
                  {' '}
                  · currently <span className="font-semibold text-ink">{application.grant.status}</span>
                </>
              ) : null}
            </span>
          </div>
        )}

        {application.reviewedAt !== null && (
          <p className="text-xs text-faint">
            Last touched by <span className="text-ink">{application.reviewedBy ?? application.revokedBy ?? 'an operator'}</span>{' '}
            {formatDateTime(application.reviewedAt ?? application.revokedAt)}
            {application.decisionNote !== null ? ` · “${application.decisionNote}”` : ''}
            {application.infoRequestNote !== null ? ` · asked: “${application.infoRequestNote}”` : ''}
            {application.revokeReason !== null ? ` · revoked: “${application.revokeReason}”` : ''}
          </p>
        )}

        {canReview && decidable && (
          <>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ['approve', 'Approve', 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300', <IconCheck className="h-4 w-4" />],
                  ['request_info', 'Ask for info', 'border-sky-500/60 bg-sky-500/15 text-sky-300', <IconPartners className="h-4 w-4" />],
                  ['reject', 'Reject', 'border-rose-500/60 bg-rose-500/15 text-rose-300', <IconClose className="h-4 w-4" />],
                ] as const
              ).map(([value, label, activeClass, icon]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDecision(value)}
                  aria-pressed={decision === value}
                  className={`focus-ring flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-semibold transition ${
                    decision === value ? activeClass : 'border-edge bg-elevated text-muted hover:text-ink'
                  }`}
                >
                  {icon} {label}
                </button>
              ))}
            </div>

            {needsBd && (
              <>
                <Select
                  label="Reports to BD account"
                  value={bdAccountId}
                  onChange={(e) => setBdAccountId(e.target.value)}
                >
                  <option value="">Choose a BD account…</option>
                  {bdOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.code} · {option.displayName}
                    </option>
                  ))}
                  {bdOptions.length === 0 && <option value="">No BD accounts available</option>}
                </Select>
                <p className="-mt-2 text-xs text-faint">
                  Required: an unassigned seller earns no BD commission and the platform ends up unable to say who
                  supplied it.
                </p>
              </>
            )}

            <Textarea
              label={
                decision === 'approve'
                  ? 'Note (optional, kept with the approval)'
                  : decision === 'request_info'
                    ? 'What you need from the applicant (required, sent to them)'
                    : 'Why this is declined (required, sent to the applicant)'
              }
              rows={3}
              maxLength={500}
              placeholder={
                decision === 'approve'
                  ? isSeller
                    ? 'e.g. Shop verified by phone, NTN checked'
                    : 'e.g. Existing room history looks clean'
                  : decision === 'request_info'
                    ? 'e.g. Which city do you broadcast from?'
                    : 'e.g. Agency name is already taken; please apply with a different one'
              }
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </>
        )}

        {canReview && revokable && (
          <>
            <Textarea
              label="Why the role is being taken back (required, sent to the holder)"
              rows={3}
              maxLength={500}
              placeholder="e.g. Repeated house-rule breaches reported by two agencies"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <p className="-mt-2 text-xs text-faint">
              The agency or partner account this approval created is suspended too, so the role stops working
              everywhere at once.
            </p>
          </>
        )}

        {!canReview && (
          <p className="rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2 text-xs text-muted">
            You can read this queue, but deciding it needs the application:review permission.
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
// The switch that decides whether an approved Host application is needed to open a room.
// ---------------------------------------------------------------------------
interface HostSwitchValue {
  enabled?: boolean;
}

function HostingSwitch({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .readConfig<HostSwitchValue>('roles.hostApplicationRequired')
      .then((result) => setEnabled(result.value.enabled === true))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not read the hosting switch.'));
  }, []);

  const save = async (next: boolean) => {
    if (busy || enabled === next) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.writeConfig('roles.hostApplicationRequired', { enabled: next });
      setEnabled((result.value as HostSwitchValue).enabled === true);
      toast.success(
        next
          ? 'Room creation now requires an approved partner role. Existing hosts are unaffected until they open a new room.'
          : 'Room creation is open to every account again.',
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the switch.');
    } finally {
      setBusy(false);
    }
  };

  if (enabled === null && error === null) return null;

  return (
    <Card
      title="Hosting requires an approved application"
      subtitle="What a plain member must hold before POST /api/rooms will take them."
      actions={
        canWrite && (
          <div className="flex gap-2">
            <Button size="sm" variant="success" onClick={() => void save(true)} loading={busy} disabled={enabled === true}>
              Require it
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void save(false)} loading={busy} disabled={enabled === false}>
              Allow anyone
            </Button>
          </div>
        )
      }
    >
      <p className="text-sm text-muted">
        Currently{' '}
        <span className="font-semibold text-ink">{enabled === true ? 'required' : 'not required'}</span>. Turning this
        on does not close anybody’s existing room and does not change who is already hosting one — it refuses the
        next <code className="text-violet-200">POST /api/rooms</code> from an account that holds no approved role, so
        switch it on once the queue is clear.
      </p>
      {enabled === true && (
        <p className="mt-2 text-xs text-amber-300">
          Any approved partner role satisfies it: an agency owner or a BD manager may host without a separate Host
          application.
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
