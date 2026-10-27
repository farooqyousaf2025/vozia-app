// ---------------------------------------------------------------------------
// BD managers, BD agents and coin sellers (§21, §22).
//
// This page manages the people who are allowed to sell coins; it never touches a
// wallet. A partner's limits are the only lever an operator has over how much a
// seller may move, and every change here is a status transition or a limit edit
// that the server re-derives and audits — crediting coins happens on the recharge
// queue, not on this screen.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Card, StatCard } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input, Textarea } from '../components/ui/Input';
import {
  IconAlert,
  IconCheck,
  IconEdit,
  IconKey,
  IconPartners,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconScales,
} from '../components/ui/Icons';
import { Modal } from '../components/ui/Modal';
import { Pagination } from '../components/ui/Pagination';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { useAuth } from '../context/AuthContext';
import { ApiError, api } from '../lib/api';
import { formatDateTime, formatNumber, parseUnsignedInt, relativeTime } from '../lib/format';
import type { BusinessAccount, BusinessAccountKind, BusinessAccountStatus, RechargePackage } from '../types';

const KIND_LABELS: Record<BusinessAccountKind, string> = {
  BD_MANAGER: 'BD manager',
  BD_AGENT: 'BD agent',
  COIN_SELLER: 'Coin seller',
};

const KIND_TONES: Record<BusinessAccountKind, BadgeTone> = {
  BD_MANAGER: 'violet',
  BD_AGENT: 'sky',
  COIN_SELLER: 'fuchsia',
};

const STATUS_TONES: Record<BusinessAccountStatus, BadgeTone> = {
  PENDING: 'amber',
  ACTIVE: 'green',
  SUSPENDED: 'red',
  CLOSED: 'slate',
};

/** Mirrors ALLOWED_TRANSITIONS in business.service so the buttons offered are the ones accepted. */
const TRANSITIONS: Record<BusinessAccountStatus, BusinessAccountStatus[]> = {
  PENDING: ['ACTIVE', 'CLOSED'],
  ACTIVE: ['SUSPENDED', 'CLOSED'],
  SUSPENDED: ['ACTIVE', 'CLOSED'],
  CLOSED: [],
};

export default function PartnersPage() {
  const { can } = useAuth();
  const manage = can('business:manage');

  const [kind, setKind] = useState<'' | BusinessAccountKind>('');
  const [status, setStatus] = useState<'' | BusinessAccountStatus>('');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [accounts, setAccounts] = useState<BusinessAccount[] | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<BusinessAccount | null>(null);
  const [statusTarget, setStatusTarget] = useState<BusinessAccount | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<BusinessAccount | null>(null);
  const [territoryTarget, setTerritoryTarget] = useState<BusinessAccount | null>(null);
  const [packageTarget, setPackageTarget] = useState<BusinessAccount | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.businessAccounts({
        kind: kind === '' ? undefined : kind,
        status: status === '' ? undefined : status,
        search: term === '' ? undefined : term,
        page,
        limit,
      });
      setAccounts(result.accounts);
      setTotal(result.total);
    } catch (err) {
      setAccounts([]);
      setError(err instanceof ApiError ? err.message : 'Failed to load partner accounts.');
    } finally {
      setLoading(false);
    }
  }, [kind, status, term, page, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = useCallback((updated: BusinessAccount) => {
    setAccounts((current) => (current ?? []).map((row) => (row.id === updated.id ? updated : row)));
  }, []);

  const counts = useMemo(() => {
    const rows = accounts ?? [];
    return {
      sellers: rows.filter((row) => row.kind === 'COIN_SELLER').length,
      pending: rows.filter((row) => row.status === 'PENDING').length,
      suspended: rows.filter((row) => row.status === 'SUSPENDED').length,
    };
  }, [accounts]);

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-ink">
            <IconPartners className="h-5 w-5 text-violet-300" />
            Partners
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            BD managers, BD agents and coin sellers. Partners never get a wallet — they get limits.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button icon={<IconRefresh className="h-4 w-4" />} onClick={() => void load()}>
            Refresh
          </Button>
          {manage && (
            <Button variant="primary" icon={<IconPlus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              New account
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Accounts" value={formatNumber(total)} sub="matching this filter" />
        <StatCard label="Sellers on page" value={formatNumber(counts.sellers)} sub="coin sellers" tone="fuchsia" />
        <StatCard
          label="Awaiting approval"
          value={formatNumber(counts.pending)}
          sub={counts.pending > 0 ? 'cannot sell until active' : 'none pending'}
          tone={counts.pending > 0 ? 'amber' : 'emerald'}
        />
        <StatCard
          label="Suspended"
          value={formatNumber(counts.suspended)}
          sub="orders blocked, history kept"
          tone={counts.suspended > 0 ? 'rose' : 'emerald'}
        />
      </div>

      <Card bodyClassName="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Select
            aria-label="Filter by kind"
            label="Kind"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as '' | BusinessAccountKind);
              setPage(1);
            }}
            className="w-40"
          >
            <option value="">All kinds</option>
            <option value="BD_MANAGER">BD managers</option>
            <option value="BD_AGENT">BD agents</option>
            <option value="COIN_SELLER">Coin sellers</option>
          </Select>
          <Select
            aria-label="Filter by status"
            label="Status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as '' | BusinessAccountStatus);
              setPage(1);
            }}
            className="w-40"
          >
            <option value="">Any status</option>
            <option value="PENDING">Pending</option>
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="CLOSED">Closed</option>
          </Select>
          <form
            className="flex flex-1 items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setTerm(search.trim());
              setPage(1);
            }}
          >
            <Input
              label="Search"
              placeholder="Name or business ID…"
              leadingIcon={<IconSearch className="h-4 w-4" />}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="min-w-48 flex-1"
            />
            <Button type="submit">Search</Button>
            {term !== '' && (
              <Button
                variant="ghost"
                onClick={() => {
                  setSearch('');
                  setTerm('');
                  setPage(1);
                }}
              >
                Clear
              </Button>
            )}
          </form>
        </div>
      </Card>

      <Card bodyClassName="p-0">
        {loading && accounts === null ? (
          <div className="grid h-64 place-items-center text-violet-300">
            <Spinner className="h-8 w-8" />
          </div>
        ) : error !== null ? (
          <EmptyState
            title="Could not load partners"
            message={error}
            icon={<IconAlert className="h-6 w-6" />}
            action={<Button onClick={() => void load()}>Retry</Button>}
          />
        ) : (accounts ?? []).length === 0 ? (
          <EmptyState
            title="No partner accounts"
            message="Create a BD manager first, then agents and the sellers beneath them."
            icon={<IconPartners className="h-6 w-6" />}
          />
        ) : (
          <>
            <Table>
              <THead>
                <Th width="28%">Partner</Th>
                <Th>Reports to</Th>
                <Th>Contact</Th>
                <Th align="right">Max order</Th>
                <Th align="right">Daily coins</Th>
                <Th align="right">Daily orders</Th>
                <Th>Status</Th>
                <Th align="right" className="pr-4">
                  Actions
                </Th>
              </THead>
              <TBody>
                {(accounts ?? []).map((row) => (
                  <Tr key={row.id}>
                    <Td>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink">{row.displayName}</p>
                        <p className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
                          <span className="font-mono">{row.code}</span>
                          <Badge tone={KIND_TONES[row.kind]}>{KIND_LABELS[row.kind]}</Badge>
                          {!row.hasCredential && <span className="text-amber-300">no password set</span>}
                        </p>
                      </div>
                    </Td>
                    <Td>
                      {row.parentCode ? (
                        <span className="text-xs text-muted" title={row.parentName ?? undefined}>
                          <span className="font-mono text-ink">{row.parentCode}</span>
                          {row.parentName ? ` · ${row.parentName}` : ''}
                        </span>
                      ) : (
                        <span className="text-xs text-faint">—</span>
                      )}
                    </Td>
                    <Td>
                      <p className="text-xs text-muted">{row.contactPhone ?? row.contactEmail ?? '—'}</p>
                      <p className="text-[11px] text-faint">
                        {row.marketCountry ? `${row.marketCountry} · ` : ''}
                        last login {relativeTime(row.lastLoginAt)}
                      </p>
                    </Td>
                    <Td align="right" className="tabular-nums text-xs">
                      {formatNumber(row.maxOrderDiamonds)}
                    </Td>
                    <Td align="right" className="tabular-nums text-xs">
                      {formatNumber(row.dailyDiamondLimit)}
                    </Td>
                    <Td align="right" className="tabular-nums text-xs">
                      {formatNumber(row.dailyOrderLimit)}
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONES[row.status] ?? 'slate'}>{row.status}</Badge>
                      {row.suspendedReason && (
                        <p className="mt-1 max-w-40 truncate text-[11px] text-rose-300" title={row.suspendedReason}>
                          {row.suspendedReason}
                        </p>
                      )}
                    </Td>
                    <Td align="right" className="pr-4">
                      {manage ? (
                        <div className="flex justify-end gap-1">
                          {row.kind !== 'COIN_SELLER' && (
                            <IconButton label="Territory" onClick={() => setTerritoryTarget(row)}>
                              <IconScales className="h-4 w-4" />
                            </IconButton>
                          )}
                          {row.kind === 'COIN_SELLER' && (
                            <IconButton label="Allowed packages" onClick={() => setPackageTarget(row)}>
                              <IconPartners className="h-4 w-4" />
                            </IconButton>
                          )}
                          <IconButton label="Change status" onClick={() => setStatusTarget(row)} disabled={TRANSITIONS[row.status].length === 0}>
                            <IconCheck className="h-4 w-4" />
                          </IconButton>
                          <IconButton label="Reset password" onClick={() => setPasswordTarget(row)}>
                            <IconKey className="h-4 w-4" />
                          </IconButton>
                          <IconButton label="Edit limits" onClick={() => setEditing(row)}>
                            <IconEdit className="h-4 w-4" />
                          </IconButton>
                        </div>
                      ) : (
                        <span className="block text-right text-xs text-faint">read only</span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <div className="px-4">
              <Pagination page={page} limit={limit} total={total} onChange={setPage} />
            </div>
          </>
        )}
      </Card>

      {creating && (
        <AccountModal
          onClose={() => setCreating(false)}
          onSaved={(account) => {
            setCreating(false);
            setAccounts((current) => [account, ...(current ?? [])]);
            setTotal((n) => n + 1);
          }}
        />
      )}
      {editing && (
        <AccountModal account={editing} onClose={() => setEditing(null)} onSaved={(account) => {
          replace(account);
          setEditing(null);
        }} />
      )}
      {statusTarget && (
        <StatusModal
          account={statusTarget}
          onClose={() => setStatusTarget(null)}
          onSaved={(account) => {
            replace(account);
            setStatusTarget(null);
          }}
        />
      )}
      {passwordTarget && <PasswordModal account={passwordTarget} onClose={() => setPasswordTarget(null)} />}
      {territoryTarget && <TerritoryModal account={territoryTarget} onClose={() => setTerritoryTarget(null)} />}
      {packageTarget && <PackagesModal account={packageTarget} onClose={() => setPackageTarget(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit. `parentId` choices follow the same rules the server enforces,
// so an invalid tree is a disabled option rather than a rejected request.
// ---------------------------------------------------------------------------
interface AccountModalProps {
  account?: BusinessAccount;
  onClose: () => void;
  onSaved: (account: BusinessAccount) => void;
}

function AccountModal({ account, onClose, onSaved }: AccountModalProps) {
  const isEdit = account !== undefined;
  const [kind, setKind] = useState<BusinessAccountKind>(account?.kind ?? 'BD_MANAGER');
  const [displayName, setDisplayName] = useState(account?.displayName ?? '');
  const [code, setCode] = useState(account?.code ?? '');
  const [email, setEmail] = useState(account?.contactEmail ?? '');
  const [phone, setPhone] = useState(account?.contactPhone ?? '');
  const [country, setCountry] = useState(account?.marketCountry ?? '');
  const [parentId, setParentId] = useState(account?.parentId ?? '');
  const [password, setPassword] = useState('');
  const [maxOrder, setMaxOrder] = useState(String(account?.maxOrderDiamonds ?? 100000));
  const [dailyDiamonds, setDailyDiamonds] = useState(String(account?.dailyDiamondLimit ?? 1000000));
  const [dailyOrders, setDailyOrders] = useState(String(account?.dailyOrderLimit ?? 200));
  const [parents, setParents] = useState<BusinessAccount[]>([]);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.businessAccounts({ kind: 'BD_MANAGER', limit: 200 }), api.businessAccounts({ kind: 'BD_AGENT', limit: 200 })])
      .then(([managers, agents]) => {
        if (!cancelled) setParents([...managers.accounts, ...agents.accounts]);
      })
      .catch(() => {
        /* the parent list simply stays empty; saving still reports the server's answer */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const eligibleParents = parents.filter((row) => {
    if (row.status === 'CLOSED') return false;
    if (kind === 'BD_AGENT') return row.kind === 'BD_MANAGER';
    if (kind === 'COIN_SELLER') return row.kind === 'BD_MANAGER' || row.kind === 'BD_AGENT';
    return false;
  });

  const needsParent = kind === 'COIN_SELLER';
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setServerError(null);
    try {
      const limits = {
        maxOrderDiamonds: parseUnsignedInt(maxOrder) ?? undefined,
        dailyDiamondLimit: parseUnsignedInt(dailyDiamonds) ?? undefined,
        dailyOrderLimit: parseUnsignedInt(dailyOrders) ?? undefined,
      };
      const contact = {
        displayName: displayName.trim(),
        contactEmail: email.trim() === '' ? undefined : email.trim(),
        contactPhone: phone.trim() === '' ? undefined : phone.trim(),
        marketCountry: country.trim() === '' ? undefined : country.trim().toUpperCase(),
        ...limits,
      };
      const result = isEdit
        ? await api.updateBusinessAccount(account.id, contact)
        : await api.createBusinessAccount({
            ...contact,
            kind,
            code: code.trim() === '' ? undefined : code.trim(),
            parentId: parentId === '' ? undefined : parentId,
            password: password.trim() === '' ? undefined : password.trim(),
          });
      onSaved(result.account);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Save failed.');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={isEdit ? `Edit ${account.code}` : 'New partner account'}
      subtitle={isEdit ? 'Limits and contact details. Status changes are a separate, audited action.' : 'New partners start as PENDING and cannot sell until approved.'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={busy}
            disabled={displayName.trim().length < 2 || (needsParent && parentId === '')}
          >
            {isEdit ? 'Save changes' : 'Create account'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!isEdit && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Kind" value={kind} onChange={(e) => setKind(e.target.value as BusinessAccountKind)}>
              <option value="BD_MANAGER">BD manager</option>
              <option value="BD_AGENT">BD agent</option>
              <option value="COIN_SELLER">Coin seller</option>
            </Select>
            <Input label="Business ID" placeholder="auto-generated" value={code} onChange={(e) => setCode(e.target.value)} hint="Must be unique; leave blank to take the next code." />
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} />
          {!isEdit && (
            <Select
              label={needsParent ? 'Assigned BD account (required)' : 'Reports to'}
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              disabled={kind === 'BD_MANAGER'}
            >
              <option value="">{kind === 'BD_MANAGER' ? 'never has a parent' : '— none —'}</option>
              {eligibleParents.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.code} · {row.displayName} ({KIND_LABELS[row.kind]})
                </option>
              ))}
            </Select>
          )}
        </div>

        {needsParent && eligibleParents.length === 0 && !isEdit && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/50 bg-amber-950/50 px-3 py-2 text-xs text-amber-200">
            <IconAlert className="h-4 w-4 shrink-0" />
            A coin seller must be assigned to a BD account, and no open BD account exists yet.
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <Input label="Market" placeholder="PK" maxLength={2} value={country} onChange={(e) => setCountry(e.target.value)} />
        </div>

        <div className="rounded-lg border border-edge/60 bg-elevated/40 p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">Transaction limits</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Input label="Max coins per order" inputMode="numeric" value={maxOrder} onChange={(e) => setMaxOrder(e.target.value)} />
            <Input label="Coin limit per day" inputMode="numeric" value={dailyDiamonds} onChange={(e) => setDailyDiamonds(e.target.value)} />
            <Input label="Order limit per day" inputMode="numeric" value={dailyOrders} onChange={(e) => setDailyOrders(e.target.value)} />
          </div>
          <p className="mt-3 text-[11px] text-faint">
            The server checks these on every order. Raising a limit is an audited mutation; it does not credit anyone.
          </p>
        </div>

        {!isEdit && (
          <Input
            label="Initial password (optional)"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint="At least 8 characters. Leaving it blank means the partner must be given a password later."
            maxLength={200}
          />
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
// Status transition, with the reason the server demands for a suspension.
// ---------------------------------------------------------------------------
function StatusModal({ account, onClose, onSaved }: { account: BusinessAccount; onClose: () => void; onSaved: (a: BusinessAccount) => void }) {
  const options = TRANSITIONS[account.status];
  const [next, setNext] = useState<BusinessAccountStatus>(options[0] ?? 'CLOSED');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const requiresReason = next === 'SUSPENDED' || next === 'CLOSED';

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setServerError(null);
    try {
      const result = await api.setBusinessAccountStatus(account.id, next, reason.trim() === '' ? undefined : reason.trim());
      onSaved(result.account);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Status change failed.');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Status · ${account.code}`}
      subtitle={`${account.displayName} is currently ${account.status}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={requiresReason && reason.trim().length < 3}>
            Set {next.toLowerCase()}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-3">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setNext(option)}
              aria-pressed={next === option}
              className={`focus-ring rounded-lg border px-3 py-2.5 text-sm font-semibold transition ${
                next === option ? 'border-violet-500/70 bg-brand-gradient-soft text-violet-200' : 'border-edge bg-elevated text-muted hover:text-ink'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
        <Textarea
          label={requiresReason ? 'Reason (required for this transition)' : 'Note (optional)'}
          rows={3}
          maxLength={200}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={next === 'SUSPENDED' ? 'e.g. chargeback on three orders, investigating' : 'e.g. territory moved to a new manager'}
        />
        <p className="text-[11px] text-faint">
          A suspended seller stops being able to raise orders but keeps its history and commission record. Closing is permanent.
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

// ---------------------------------------------------------------------------
// Password reset. The panel writes a credential; it never reads one.
// ---------------------------------------------------------------------------
function PasswordModal({ account, onClose }: { account: BusinessAccount; onClose: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setServerError(null);
    try {
      await api.resetBusinessPassword(account.id, value.trim());
      setDone(true);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Reset failed.');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Password · ${account.code}`}
      subtitle={account.hasCredential ? 'This overwrites the current password.' : 'No password is set yet.'}
      footer={
        <>
          <Button onClick={onClose}>{done ? 'Close' : 'Cancel'}</Button>
          {!done && (
            <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={value.trim().length < 8}>
              Set password
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {done ? (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/50 bg-emerald-950/50 px-3 py-2 text-xs text-emerald-200">
            <IconCheck className="h-4 w-4 shrink-0" />
            Password set. Deliver it out of band — it is not stored anywhere the panel can read back.
          </div>
        ) : (
          <Input
            label="New password"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            hint="Minimum 8 characters. The server stores only a hash."
            maxLength={200}
          />
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
// A BD's territory: the sellers that roll up to them.
// ---------------------------------------------------------------------------
function TerritoryModal({ account, onClose }: { account: BusinessAccount; onClose: () => void }) {
  const [sellers, setSellers] = useState<BusinessAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .bdTerritory(account.id)
      .then((result) => {
        if (!cancelled) setSellers(result.sellers);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load the territory.');
        if (!cancelled) setSellers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [account.id]);

  return (
    <Modal open onClose={onClose} size="lg" title={`Territory · ${account.code}`} subtitle={account.displayName}>
      {error !== null ? (
        <p className="text-sm text-rose-300">{error}</p>
      ) : sellers === null ? (
        <div className="grid h-32 place-items-center text-violet-300">
          <Spinner className="h-6 w-6" />
        </div>
      ) : sellers.length === 0 ? (
        <EmptyState title="No sellers" message="This BD account has nobody assigned yet." icon={<IconPartners className="h-6 w-6" />} />
      ) : (
        <Table>
          <THead>
            <Th>Seller</Th>
            <Th>Status</Th>
            <Th align="right">Max order</Th>
            <Th align="right">Daily coins</Th>
            <Th>Created</Th>
          </THead>
          <TBody>
            {sellers.map((seller) => (
              <Tr key={seller.id}>
                <Td>
                  <p className="text-sm font-semibold text-ink">{seller.displayName}</p>
                  <p className="font-mono text-[11px] text-faint">{seller.code}</p>
                </Td>
                <Td>
                  <Badge tone={STATUS_TONES[seller.status] ?? 'slate'}>{seller.status}</Badge>
                </Td>
                <Td align="right" className="tabular-nums text-xs">
                  {formatNumber(seller.maxOrderDiamonds)}
                </Td>
                <Td align="right" className="tabular-nums text-xs">
                  {formatNumber(seller.dailyDiamondLimit)}
                </Td>
                <Td className="text-xs text-muted" title={formatDateTime(seller.createdAt)}>
                  {relativeTime(seller.createdAt)}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Which packages a seller may sell. An empty allowlist is a real state: the
// backend refuses to price an order for a seller with nothing assigned.
// ---------------------------------------------------------------------------
function PackagesModal({ account, onClose }: { account: BusinessAccount; onClose: () => void }) {
  const [packages, setPackages] = useState<RechargePackage[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.rechargePackages(true), api.sellerPackages(account.id)])
      .then(([catalogue, allowlist]) => {
        if (cancelled) return;
        setPackages(catalogue.packages);
        setSelected(new Set(allowlist.packageKeys));
      })
      .catch((err) => {
        if (!cancelled) setServerError(err instanceof ApiError ? err.message : 'Failed to load the package list.');
        if (!cancelled) setPackages([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account.id]);

  const toggle = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setServerError(null);
    try {
      await api.assignSellerPackages(account.id, [...selected]);
      onClose();
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Assignment failed.');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Permitted packages · ${account.code}`}
      subtitle={`${account.displayName} — pricing is fixed by the catalogue, never by the seller.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            Save allowlist
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="grid h-32 place-items-center text-violet-300">
          <Spinner className="h-6 w-6" />
        </div>
      ) : packages.length === 0 ? (
        <EmptyState title="The catalogue is empty" message="Add recharge packages before restricting a seller." icon={<IconAlert className="h-6 w-6" />} />
      ) : (
        <div className="space-y-2">
          {packages.map((pkg) => {
            const checked = selected.has(pkg.key);
            return (
              <button
                key={pkg.key}
                type="button"
                role="checkbox"
                aria-checked={checked}
                onClick={() => toggle(pkg.key)}
                className={`focus-ring flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition ${
                  checked ? 'border-violet-500/70 bg-brand-gradient-soft' : 'border-edge bg-elevated hover:border-violet-500/40'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">
                    {pkg.label} <span className="font-mono text-[11px] text-faint">{pkg.key}</span>
                  </span>
                  <span className="block text-[11px] text-muted">
                    {formatNumber(pkg.diamonds)} coins · {pkg.currency} {(pkg.amountCents / 100).toFixed(2)}
                    {pkg.isActive ? '' : ' · inactive'}
                  </span>
                </span>
                <span className={`shrink-0 text-xs font-semibold ${checked ? 'text-violet-200' : 'text-faint'}`}>
                  {checked ? 'pinned' : 'not pinned'}
                </span>
              </button>
            );
          })}
          <p className="pt-1 text-[11px] text-faint">
            {selected.size === 0
              ? 'Nothing pinned: this seller may sell every active package.'
              : `${selected.size} package(s) pinned — the seller can only open orders for these.`}
          </p>
        </div>
      )}
      {serverError !== null && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
          <IconAlert className="h-4 w-4 shrink-0" />
          {serverError}
        </div>
      )}
    </Modal>
  );
}
