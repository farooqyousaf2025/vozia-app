// ---------------------------------------------------------------------------
// The operator roster (migration 0030): who may sign into this panel, and what
// happens when they must not.
//
// Two things this screen is built around, both learned from the schema.
//
// It offers a switch, never a bin. An operator who has written one audit row
// cannot be deleted at all — the database refuses it — so the only lifecycle
// available is disable and re-enable, and that is the only one on offer here.
//
// It explains the refusals before the click. `cannot_disable_self` and
// `last_super_admin` are knowable from the roster plus the signed-in identity,
// and an operator who learns them from a 409 has already wasted the attempt.
// The server still decides every one of them; this only spares the surprise.
//
// The role column shows what a role means, read from `GET /operators/roles` —
// the same table the guards use — because "finance" is not a permission and an
// operator who has to guess which one can freeze money is the one who gets it
// wrong.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, StatCard } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { IconAlert, IconCheck, IconEdit, IconPlus, IconRefresh, IconSearch, IconShieldCheck, IconUsers } from '../components/ui/Icons';
import { Input, Textarea } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Pagination } from '../components/ui/Pagination';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { useToast } from '../components/ui/Toast';
import { useDebounce } from '../hooks/useDebounce';
import { useAuth } from '../context/AuthContext';
import { ApiError, api } from '../lib/api';
import { formatDateTime, formatNumber, relativeTime } from '../lib/format';
import type { Operator, OperatorRoleInfo } from '../types';

const PAGE_SIZE = 25;
const STATUSES = ['ALL', 'ACTIVE', 'DISABLED'];
const STATUS_TONES: Record<string, BadgeTone> = { ACTIVE: 'green', DISABLED: 'red' };

/** Mirrors the server's own rule, so a bad username is caught before it is POSTed. */
const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,39}$/;

const ROLE_TONES: Record<string, BadgeTone> = {
  SUPER_ADMIN: 'violet',
  FINANCE_ADMIN: 'sky',
  OPERATIONS_ADMIN: 'fuchsia',
  MODERATOR: 'slate',
};

function roleTone(role: string): BadgeTone {
  return ROLE_TONES[role] ?? 'amber';
}

/** The server's `reason_required` is eight characters; the box says so rather than guessing. */
function reasonError(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return 'A reason is required to disable an operator.';
  if (trimmed.length < 8) return 'At least 8 characters — this text goes into the audit log.';
  if (trimmed.length > 300) return 'At most 300 characters.';
  return null;
}

export default function OperatorsPage() {
  const toast = useToast();
  const { admin } = useAuth();

  const [filters, setFilters] = useState({ search: '', role: '', active: 'ALL' });
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounce(filters.search, 350);

  const [operators, setOperators] = useState<Operator[]>([]);
  const [total, setTotal] = useState(0);
  const [activeTotal, setActiveTotal] = useState<number | null>(null);
  const [disabledTotal, setDisabledTotal] = useState<number | null>(null);
  const [roles, setRoles] = useState<OperatorRoleInfo[]>([]);
  const [activeSupers, setActiveSupers] = useState<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Operator | null>(null);
  const [disabling, setDisabling] = useState<Operator | null>(null);

  const query = useMemo(
    () => ({
      search: debouncedSearch.trim() === '' ? undefined : debouncedSearch.trim(),
      role: filters.role === '' ? undefined : filters.role,
      active: filters.active === 'ALL' ? undefined : filters.active,
    }),
    [filters.role, filters.active, debouncedSearch],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [roster, catalogue, active, disabled, supers] = await Promise.all([
        api.operators({ ...query, page, limit: PAGE_SIZE }),
        api.operatorRoles(),
        // Three counts read across the whole table rather than counted off the page being looked
        // at: "how many of these are switched off" is a question about the roster, not about a
        // screenful of it, and a page-scoped number under a global label is how dashboards lie.
        api.operators({ active: 'ACTIVE', limit: 1 }),
        api.operators({ active: 'DISABLED', limit: 1 }),
        api.operators({ role: 'SUPER_ADMIN', active: 'ACTIVE', limit: 1 }),
      ]);
      setOperators(roster.operators);
      setTotal(roster.total);
      setRoles(catalogue.roles);
      setActiveTotal(active.total);
      setDisabledTotal(disabled.total);
      setActiveSupers(supers.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the roster.');
    } finally {
      setLoading(false);
    }
  }, [query, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [query]);

  const isMe = (row: Operator) => row.id === admin?.id;

  /**
   * What the server would refuse, said before the attempt instead of after it.
   * `null` means the action is allowed as far as this screen can tell — the row is re-read
   * server-side on every request, so this is advice, never a grant.
   */
  const disableBlock = (row: Operator): string | null => {
    if (isMe(row)) return 'You cannot switch off the account you are signed in as; another super-admin has to do it.';
    if (row.role === 'SUPER_ADMIN' && row.isActive && (activeSupers ?? 0) <= 1) {
      return 'This is the only active super-admin. Create or promote another one first, or there is no credential left that can undo this.';
    }
    return null;
  };

  const enable = async (row: Operator) => {
    setBusy(row.id);
    try {
      const result = await api.enableOperator(row.id);
      toast.success(`${result.operator.username} can sign in again.`);
      void load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not re-enable that operator.');
    } finally {
      setBusy(null);
    }
  };

  if (loading && operators.length === 0 && error === null) {
    return (
      <div className="mx-auto grid max-w-7xl h-48 place-items-center text-violet-300">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const counts = {
    active: activeTotal === null ? '—' : formatNumber(activeTotal),
    disabled: disabledTotal === null ? '—' : formatNumber(disabledTotal),
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-ink">
            <IconShieldCheck className="h-5 w-5 text-violet-300" />
            Operator accounts
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            Who may sign into this panel. Accounts are switched off rather than deleted — an audit trail has to outlive the access that wrote it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button icon={<IconRefresh className="h-4 w-4" />} onClick={() => void load()}>
            Refresh
          </Button>
          <Button variant="primary" icon={<IconPlus className="h-4 w-4" />} onClick={() => setShowCreate(true)}>
            New operator
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Operators" value={formatNumber(total)} sub="on this platform" tone="violet" icon={<IconUsers className="h-5 w-5" />} />
        <StatCard label="Active" value={counts.active} sub="can sign in today" tone="emerald" icon={<IconCheck className="h-5 w-5" />} />
        <StatCard label="Disabled" value={counts.disabled} sub="refused at sign-in and mid-token" tone="rose" icon={<IconAlert className="h-5 w-5" />} />
        <StatCard
          label="Super-admins"
          value={activeSupers === null ? '—' : formatNumber(activeSupers)}
          sub={activeSupers === 1 ? 'the last one cannot be removed' : 'hold operator:manage'}
          tone={activeSupers === 1 ? 'amber' : 'sky'}
        />
      </div>

      {activeSupers === 1 && (
        <Card>
          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
            <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            One active super-admin remains, and only that role holds <code className="text-ink">operator:manage</code>. Until a second is
            created or promoted, that account can be neither disabled nor demoted — the server refuses both so a platform cannot lock
            itself out of its own back office.
          </p>
        </Card>
      )}

      {error !== null && (
        <Card>
          <EmptyState
            title="Could not read the roster"
            message={error}
            icon={<IconAlert className="h-6 w-6" />}
            action={<Button onClick={() => void load()}>Retry</Button>}
          />
        </Card>
      )}

      {error === null && (
        <Card bodyClassName="p-0">
          <div className="flex flex-wrap items-end gap-2 border-b border-edge/60 px-4 py-3">
            <Input
              label="Search"
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              placeholder="username or display name"
              leadingIcon={<IconSearch className="h-4 w-4" />}
              className="w-64"
            />
            <Select
              aria-label="Role"
              value={filters.role}
              onChange={(e) => setFilters({ ...filters, role: e.target.value })}
              className="w-48"
            >
              <option value="">All roles</option>
              {roles.map((entry) => (
                <option key={entry.role} value={entry.role}>
                  {entry.role}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Status"
              value={filters.active}
              onChange={(e) => setFilters({ ...filters, active: e.target.value })}
              className="w-40"
            >
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value === 'ALL' ? 'Active and disabled' : value.charAt(0) + value.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>
          </div>

          {operators.length === 0 ? (
            <EmptyState
              title="No operator matches"
              message="Clear the search or switch the status filter back to active and disabled."
              icon={<IconUsers className="h-6 w-6" />}
            />
          ) : (
            <Table>
              <THead>
                <Th>Operator</Th>
                <Th>Role</Th>
                <Th>May do</Th>
                <Th>Status</Th>
                <Th>Since</Th>
                <Th align="right" className="pr-4">
                  Actions
                </Th>
              </THead>
              <TBody>
                {operators.map((row) => {
                  const blocked = disableBlock(row);
                  return (
                    <Tr key={row.id} className={row.isActive ? '' : 'opacity-60'}>
                      <Td>
                        <p className="font-medium text-ink">
                          {row.username}
                          {isMe(row) && <span className="ml-2 text-[11px] uppercase tracking-wide text-violet-300">you</span>}
                        </p>
                        <p className="text-xs text-faint">{row.displayName ?? '—'}</p>
                      </Td>
                      <Td>
                        <Badge tone={roleTone(row.role)}>{row.role}</Badge>
                        {row.roleStored !== row.role && (
                          <p className="mt-1 text-[11px] text-amber-300" title="Stored before the role vocabulary existed; the guards apply the badge.">
                            stored as {row.roleStored}
                          </p>
                        )}
                      </Td>
                      <Td>
                        <span title={row.permissions.join(', ')} className="cursor-help underline decoration-edge decoration-dotted">
                          {row.permissions.length} permissions
                        </span>
                      </Td>
                      <Td>
                        <Badge tone={row.isActive ? 'green' : 'red'}>{row.isActive ? 'Active' : 'Disabled'}</Badge>
                      </Td>
                      <Td>
                        <p className="text-xs" title={formatDateTime(row.createdAt)}>
                          {row.isActive ? relativeTime(row.createdAt) : relativeTime(row.disabledAt ?? row.createdAt)}
                        </p>
                        <p className="text-[11px] text-faint">{row.isActive ? 'created' : 'disabled'}</p>
                      </Td>
                      <Td align="right" className="pr-4">
                        <div className="flex items-center justify-end gap-2">
                          <Button size="sm" icon={<IconEdit className="h-4 w-4" />} onClick={() => setEditing(row)}>
                            Edit
                          </Button>
                          {row.isActive ? (
                            <Button
                              size="sm"
                              variant="danger"
                              loading={busy === row.id}
                              disabled={blocked !== null}
                              title={blocked ?? undefined}
                              onClick={() => setDisabling(row)}
                            >
                              Disable
                            </Button>
                          ) : (
                            <Button size="sm" variant="success" loading={busy === row.id} onClick={() => void enable(row)}>
                              Enable
                            </Button>
                          )}
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          )}

          {total > PAGE_SIZE && (
            <div className="border-t border-edge/60 px-4 py-3">
              <Pagination page={page} limit={PAGE_SIZE} total={total} onChange={setPage} />
            </div>
          )}
        </Card>
      )}

      <Card
        title="What each role means"
        subtitle="Read from the permission table the guards use, not from a list written into this screen."
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {roles.map((entry) => (
            <div key={entry.role} className="rounded-xl border border-edge/60 bg-elevated/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <Badge tone={roleTone(entry.role)}>{entry.role}</Badge>
                <span className="text-[11px] text-faint">{entry.permissions.length}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {entry.permissions.map((permission) => (
                  <span
                    key={permission}
                    className={`rounded-md border px-1.5 py-0.5 text-[10px] tabular-nums ${
                      permission === 'operator:manage'
                        ? 'border-violet-500/50 bg-violet-500/15 text-violet-200'
                        : 'border-edge/60 text-faint'
                    }`}
                  >
                    {permission}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-faint">
          <code className="text-ink">operator:manage</code> is highlighted because it is the only permission that reaches this screen: it
          sits on SUPER_ADMIN alone and is deliberately not folded into <code className="text-ink">config:manage</code>, so an operator who
          can change the money switches does not thereby gain the credential that changes them.
        </p>
      </Card>

      <CreateOperatorModal
        open={showCreate}
        roles={roles}
        onClose={() => setShowCreate(false)}
        onCreated={(created) => {
          toast.success(`${created.username} can sign in now. Their role takes effect on their first request.`);
          setShowCreate(false);
          void load();
        }}
      />

      <EditOperatorModal
        operator={editing}
        roles={roles}
        activeSupers={activeSupers}
        onClose={() => setEditing(null)}
        onSaved={(saved) => {
          toast.success(`${saved.username} is now ${saved.role}.`);
          setEditing(null);
          void load();
        }}
      />

      <DisableOperatorModal
        operator={disabling}
        busy={busy === disabling?.id}
        onClose={() => setDisabling(null)}
        onDisabled={async (row, reason) => {
          setBusy(row.id);
          try {
            await api.disableOperator(row.id, reason);
            toast.success(`${row.username} is disabled. Any token already issued to them is refused on their next request.`);
            setDisabling(null);
            void load();
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : 'Could not disable that operator.');
          } finally {
            setBusy(null);
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
function CreateOperatorModal({
  open,
  roles,
  onClose,
  onCreated,
}: {
  open: boolean;
  roles: OperatorRoleInfo[];
  onClose: () => void;
  onCreated: (operator: Operator) => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({ username: '', password: '', role: 'MODERATOR', displayName: '' });
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm({ username: '', password: '', role: 'MODERATOR', displayName: '' });
    setFieldError(null);
    setSubmitting(false);
  }, [open]);

  const selectedRole = roles.find((entry) => entry.role === form.role);

  const submit = async () => {
    const username = form.username.trim().toLowerCase();
    if (!USERNAME.test(username)) {
      setFieldError('3-40 characters: a lowercase letter or digit first, then letters, digits, dot, underscore or hyphen.');
      return;
    }
    if (form.password.length < 8) {
      setFieldError('A password of at least 8 characters — it is guessed slowly, but it is still guessed.');
      return;
    }
    setFieldError(null);
    setSubmitting(true);
    try {
      const result = await api.createOperator({
        username,
        password: form.password,
        role: form.role,
        displayName: form.displayName.trim() === '' ? undefined : form.displayName.trim(),
      });
      onCreated(result.operator);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create that operator.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New operator"
      subtitle="The account can sign in immediately; the role decides what it may then do."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={submitting} onClick={() => void submit()}>
            Create operator
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input
          label="Username"
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
          placeholder="finance.nadia"
          hint="Lowercase. Stored as typed, so a colleague who leaves the caps lock on still gets in."
        />
        <Input
          label="Password"
          type="password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          hint="At least 8 characters. There is no reset route here on purpose: rotating a password needs the operator's own credential."
        />
        <Input
          label="Display name"
          value={form.displayName}
          onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          placeholder="Nadia — finance"
          hint="Optional. This is what the audit log shows beside a decision."
        />
        <Select label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          {roles.map((entry) => (
            <option key={entry.role} value={entry.role}>
              {entry.role}
            </option>
          ))}
        </Select>
        {selectedRole !== undefined && (
          <div className="rounded-xl border border-edge/60 bg-elevated/40 p-3">
            <p className="text-[11px] uppercase tracking-wider text-faint">This role can</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {selectedRole.permissions.map((permission) => (
                <span key={permission} className="rounded-md border border-edge/60 px-1.5 py-0.5 text-[10px] text-muted">
                  {permission}
                </span>
              ))}
            </div>
          </div>
        )}
        {fieldError !== null && <p className="text-xs text-rose-400">{fieldError}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Edit role / display name
// ---------------------------------------------------------------------------
function EditOperatorModal({
  operator,
  roles,
  activeSupers,
  onClose,
  onSaved,
}: {
  operator: Operator | null;
  roles: OperatorRoleInfo[];
  activeSupers: number | null;
  onClose: () => void;
  onSaved: (operator: Operator) => void;
}) {
  const toast = useToast();
  const [role, setRole] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (operator === null) return;
    setRole(operator.role);
    setDisplayName(operator.displayName ?? '');
    setSubmitting(false);
  }, [operator]);

  const demotingLastSuper =
    operator !== null &&
    operator.role === 'SUPER_ADMIN' &&
    operator.isActive &&
    role !== 'SUPER_ADMIN' &&
    (activeSupers ?? 0) <= 1;

  const dirty = operator !== null && (role !== operator.role || displayName.trim() !== (operator.displayName ?? ''));

  const submit = async () => {
    if (operator === null) return;
    setSubmitting(true);
    try {
      const result = await api.updateOperator(operator.id, {
        role: role !== operator.role ? role : undefined,
        displayName: displayName.trim() !== (operator.displayName ?? '') ? displayName.trim() : undefined,
      });
      onSaved(result.operator);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update that operator.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={operator !== null}
      onClose={onClose}
      title={operator === null ? 'Edit operator' : `Edit ${operator.username}`}
      subtitle="A new role applies to the token already in their hand — the server re-reads the row on every request."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={submitting} disabled={!dirty || demotingLastSuper} onClick={() => void submit()}>
            Save
          </Button>
        </>
      }
    >
      {operator !== null && (
        <div className="space-y-3">
          <Select label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
            {roles.map((entry) => (
              <option key={entry.role} value={entry.role}>
                {entry.role}
              </option>
            ))}
          </Select>
          <Input label="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Optional" />
          {demotingLastSuper && (
            <p className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">
              <IconAlert className="mt-0.5 h-4 w-4 shrink-0" />
              This is the only active super-admin, so the server refuses the demotion. Create a second one first — losing
              <code className="mx-1">operator:manage</code> would leave no credential that can undo this.
            </p>
          )}
          <p className="text-[11px] leading-relaxed text-faint">
            Changing a role never changes what the operator already did: their audit rows keep their name whatever this dropdown says.
          </p>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Disable, with the reason the audit log requires
// ---------------------------------------------------------------------------
function DisableOperatorModal({
  operator,
  busy,
  onClose,
  onDisabled,
}: {
  operator: Operator | null;
  busy: boolean;
  onClose: () => void;
  onDisabled: (operator: Operator, reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (operator === null) return;
    setReason('');
  }, [operator]);

  const invalid = operator === null || reasonError(reason) !== null;

  return (
    <Modal
      open={operator !== null}
      onClose={onClose}
      title={operator === null ? 'Disable operator' : `Disable ${operator.username}`}
      subtitle="Not a deletion. The account and everything it did stay on the record."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={invalid}
            onClick={() => operator !== null && void onDisabled(operator, reason.trim())}
          >
            Disable operator
          </Button>
        </>
      }
    >
      {operator !== null && (
        <div className="space-y-3">
          <Textarea
            label="Reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Left the company; access revoked at HR request."
            error={reason.trim() === '' ? null : reasonError(reason)}
          />
          {!operator.isActive && (
            <p className="text-xs text-amber-300">This operator is already disabled; the server will say so rather than log a second act.</p>
          )}
          <ul className="space-y-1 text-[11px] leading-relaxed text-faint">
            <li>· Sign-in is refused from now on.</li>
            <li>· A token already issued to them is refused by their next request — the twelve-hour expiry does not outlast this switch.</li>
            <li>· Their audit rows, their name beside them, and their password hash all stay.</li>
            <li>· Re-enabling is one click and needs no reason — nothing here is a verdict.</li>
          </ul>
        </div>
      )}
    </Modal>
  );
}
