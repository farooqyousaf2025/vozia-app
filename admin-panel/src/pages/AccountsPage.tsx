// ---------------------------------------------------------------------------
// Purpose accounts (§8, §9): every balance the platform owes or holds, read from
// the table that already owns it, plus the three actions an operator can take on
// one — hold it, release it, change its status.
//
// Three things this screen deliberately does not do.
//
// It never edits a balance. `users` owns the one manual money path, and a second
// entry point means a second set of guards — the weaker set being the one used at
// 02:00. Everything here constrains money without inventing it.
//
// It never shows a figure without its unit. `dmn` and `rcn` are whole coins and
// `pkr` is minor units, so the same integer means two different things;
// `formatUnitAmount` takes the currency from the row every time.
//
// It never trusts the number it is showing. Each account carries `balanceSource`,
// the statement carries `opening`, and `opening + ΣIN − ΣOUT` is displayed against
// the balance rather than assumed to equal it. When they differ the operator sees
// that before finance does.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, StatCard } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input, Textarea } from '../components/ui/Input';
import {
  IconAlert,
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconDownload,
  IconKey,
  IconRefresh,
  IconScales,
  IconSearch,
} from '../components/ui/Icons';
import { Modal } from '../components/ui/Modal';
import { Pagination } from '../components/ui/Pagination';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { Tabs } from '../components/ui/Tabs';
import { useToast } from '../components/ui/Toast';
import { useDebounce } from '../hooks/useDebounce';
import { useAuth } from '../context/AuthContext';
import { ApiError, api } from '../lib/api';
import { formatDateTime, formatNumber, formatUnitAmount, relativeTime } from '../lib/format';
import type {
  AccountCategory,
  AccountHold,
  AccountMovement,
  AccountStatus,
  PurposeAccount,
  ReconciliationFinding,
} from '../types';

const CATEGORIES: AccountCategory[] = [
  'PLATFORM_MAIN',
  'USER_DIAMOND',
  'HOST_RCOIN',
  'BD_MANAGER',
  'COIN_SELLER',
  'AGENCY',
  'GAME_OPS',
  'PROMOTIONAL',
  'PENDING_SETTLEMENT',
];

const OWNER_KINDS = ['PLATFORM', 'USER', 'BUSINESS', 'AGENCY'];
const STATUSES: AccountStatus[] = ['ACTIVE', 'SUSPENDED', 'FROZEN', 'CLOSED'];
const CURRENCIES = ['dmn', 'rcn', 'pkr'];
const HOLD_KINDS = ['FROZEN', 'PENDING_SETTLEMENT', 'WITHDRAWAL', 'PROMOTIONAL'];

const CATEGORY_TONES: Record<string, BadgeTone> = {
  PLATFORM_MAIN: 'violet',
  USER_DIAMOND: 'sky',
  HOST_RCOIN: 'fuchsia',
  BD_MANAGER: 'amber',
  COIN_SELLER: 'amber',
  AGENCY: 'green',
  GAME_OPS: 'slate',
  PROMOTIONAL: 'pink',
  PENDING_SETTLEMENT: 'slate',
};

const STATUS_TONES: Record<string, BadgeTone> = {
  ACTIVE: 'green',
  SUSPENDED: 'amber',
  FROZEN: 'red',
  CLOSED: 'slate',
  OPEN: 'amber',
  RELEASED: 'slate',
  CONVERTED: 'sky',
};

const PAGE_SIZE = 25;

/**
 * A key per click, held across retries of that click. Re-sending the same key after a network
 * failure is the whole point: the server replays its first answer instead of freezing twice.
 */
function clientKey(prefix: string): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `panel-${prefix}-${random}`;
}

/** The identity the book promises, computed from what the statement page actually says. */
function identityHolds(opening: number, rows: AccountMovement[], balance: number): boolean {
  const sum = rows.reduce((total, row) => total + (row.direction === 'IN' ? row.amount : -row.amount), 0);
  return opening + sum === balance;
}

export default function AccountsPage() {
  const toast = useToast();
  const { can } = useAuth();
  const navigate = useNavigate();
  const mayWrite = can('account:manage');

  const [tab, setTab] = useState('book');

  const [filters, setFilters] = useState({ category: '', ownerKind: '', status: '', currency: '', search: '' });
  const [onlyWithPosition, setOnlyWithPosition] = useState(true);
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounce(filters.search, 350);

  const [accounts, setAccounts] = useState<PurposeAccount[]>([]);
  const [total, setTotal] = useState(0);
  const [positionCount, setPositionCount] = useState<number | null>(null);

  const [findings, setFindings] = useState<ReconciliationFinding[]>([]);
  const [errorCount, setErrorCount] = useState<number | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  const [holds, setHolds] = useState<AccountHold[]>([]);
  const [holdTotal, setHoldTotal] = useState(0);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const [selected, setSelected] = useState<PurposeAccount | null>(null);

  const query = useMemo(
    () => ({
      category: filters.category === '' ? undefined : filters.category,
      ownerKind: filters.ownerKind === '' ? undefined : filters.ownerKind,
      status: filters.status === '' ? undefined : filters.status,
      currency: filters.currency === '' ? undefined : filters.currency,
      search: debouncedSearch.trim() === '' ? undefined : debouncedSearch.trim(),
    }),
    // Only the debounced search, not the raw one: depending on `filters` as an object would
    // rebuild this on every keystroke and refetch with a value that has not settled yet.
    [filters.category, filters.ownerKind, filters.status, filters.currency, debouncedSearch],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [book, recon, openHolds, positions] = await Promise.all([
        api.accounts({ ...query, onlyWithPosition, page, limit: PAGE_SIZE }),
        api.accountReconciliation(),
        api.accountHolds({ status: 'OPEN', limit: PAGE_SIZE }),
        // A second count query, because "how much of the book is live" is a question the filter
        // bar asks independently of whatever the operator has switched on to look at.
        api.accounts({ ...query, onlyWithPosition: true, limit: 1 }),
      ]);
      setAccounts(book.accounts);
      setTotal(book.total);
      setFindings(recon.findings);
      setErrorCount(recon.errors);
      setGeneratedAt(recon.generatedAt);
      setHolds(openHolds.holds);
      setHoldTotal(openHolds.total);
      setPositionCount(positions.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the book.');
    } finally {
      setLoading(false);
    }
  }, [query, onlyWithPosition, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [query, onlyWithPosition]);

  const exportReconciliation = async (format: 'csv' | 'xlsx') => {
    if (exporting) return;
    setExporting(true);
    try {
      await api.downloadAccountReconciliation(format);
      toast.success(`Reconciliation ${format.toUpperCase()} downloaded.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The export failed.');
    } finally {
      setExporting(false);
    }
  };

  const releaseHold = async (hold: AccountHold, key: string) => {
    try {
      const result = await api.releaseAccountHold(hold.id, { idempotencyKey: key });
      toast.success(result.replay ? 'That release had already happened — the server replayed it.' : `Hold ${result.status.toLowerCase()}.`);
      setHolds((rows) => rows.filter((row) => row.id !== hold.id));
      setHoldTotal((value) => Math.max(0, value - 1));
      void refreshSelected();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not release that hold.');
    }
  };

  /** A hold or a release moves the projection, so the drawer re-reads the account it is showing. */
  const refreshSelected = async () => {
    const code = selected?.accountCode;
    if (!code) return;
    const read = await api.account(code).catch(() => null);
    if (read) setSelected(read.account);
  };

  /**
   * Only a member account has a screen that will find it by identity: the users search matches
   * `u.id::text` exactly, while the partner search matches a name or a code and would show a list
   * the operator then has to read. A link that lands on the wrong thing is worse than none.
   */
  const gotoOwner = (account: PurposeAccount) => {
    if (account.ownerKind === 'USER' && account.ownerId) navigate(`/users?q=${encodeURIComponent(account.ownerId)}`);
  };

  /** The holds tab spans the whole book, so opening one means reading the account behind it. */
  const openAccount = (code: string) => {
    api.account(code)
      .then(({ account }) => setSelected(account))
      .catch((err: unknown) => toast.error(err instanceof ApiError ? err.message : 'That account could not be read.'));
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-ink">
            <IconScales className="h-5 w-5 text-violet-300" />
            Purpose accounts
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            Every balance the platform owes or holds — projected from the table that owns it, never copied.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" icon={<IconDownload className="h-4 w-4" />} onClick={() => void exportReconciliation('csv')} loading={exporting}>
            CSV
          </Button>
          <Button size="sm" icon={<IconDownload className="h-4 w-4" />} onClick={() => void exportReconciliation('xlsx')} loading={exporting}>
            Excel
          </Button>
          <Button icon={<IconRefresh className="h-4 w-4" />} onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Accounts" value={formatNumber(total)} sub="in the book" tone="violet" />
        <StatCard
          label="With a position"
          value={positionCount === null ? '—' : formatNumber(positionCount)}
          sub="balance is not zero"
          tone="sky"
        />
        <StatCard
          label="Reconciliation"
          value={errorCount === null ? '—' : errorCount === 0 ? 'Explains itself' : `${errorCount} error${errorCount === 1 ? '' : 's'}`}
          sub={generatedAt ? `checked ${relativeTime(generatedAt)}` : 'running checks'}
          tone={errorCount === null ? 'violet' : errorCount === 0 ? 'emerald' : 'rose'}
          icon={errorCount === 0 ? <IconCheck className="h-5 w-5" /> : <IconAlert className="h-5 w-5" />}
        />
        <StatCard label="Open holds" value={formatNumber(holdTotal)} sub="money set aside, not moved" tone="amber" icon={<IconKey className="h-5 w-5" />} />
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        items={[
          { id: 'book', label: 'The book', count: total },
          { id: 'recon', label: 'Reconciliation', count: findings.length, alert: (errorCount ?? 0) > 0 },
          { id: 'holds', label: 'Open holds', count: holdTotal, alert: holdTotal > 0 },
        ]}
      />

      {error !== null && (
        <Card>
          <EmptyState
            title="Could not read the book"
            message={error}
            icon={<IconAlert className="h-6 w-6" />}
            action={<Button onClick={() => void load()}>Retry</Button>}
          />
        </Card>
      )}

      {loading && accounts.length === 0 && error === null && (
        <Card>
          <div className="grid h-48 place-items-center text-violet-300">
            <Spinner className="h-8 w-8" />
          </div>
        </Card>
      )}

      {error === null && tab === 'book' && (
        <Card bodyClassName="p-0">
          <div className="flex flex-wrap items-end gap-2 border-b border-edge/60 px-4 py-3">
            <Input
              label="Search"
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              placeholder="code or name"
              leadingIcon={<IconSearch className="h-4 w-4" />}
              className="w-56"
            />
            <Select aria-label="Category" value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })} className="w-44">
              <option value="">All categories</option>
              {CATEGORIES.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </Select>
            <Select aria-label="Owner kind" value={filters.ownerKind} onChange={(e) => setFilters({ ...filters, ownerKind: e.target.value })} className="w-36">
              <option value="">All owners</option>
              {OWNER_KINDS.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </Select>
            <Select aria-label="Status" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} className="w-36">
              <option value="">All statuses</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </Select>
            <Select aria-label="Currency" value={filters.currency} onChange={(e) => setFilters({ ...filters, currency: e.target.value })} className="w-32">
              <option value="">Any unit</option>
              {CURRENCIES.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </Select>
            <div className="flex items-center gap-2 pb-1">
              <Switch checked={onlyWithPosition} onChange={setOnlyWithPosition} />
              <span className="text-xs text-muted">Only accounts with a position</span>
            </div>
          </div>

          {loading ? (
            <div className="grid h-48 place-items-center text-violet-300">
              <Spinner className="h-7 w-7" />
            </div>
          ) : accounts.length === 0 ? (
            <EmptyState
              title="Nothing matches"
              message={onlyWithPosition ? 'No account in this filter holds a balance. Switch off "only with a position" to see the empty ones.' : 'Try a different category or search.'}
              icon={<IconScales className="h-6 w-6" />}
            />
          ) : (
            <>
              <Table>
                <THead>
                  <Th width="26%">Account</Th>
                  <Th>Category</Th>
                  <Th>Owner</Th>
                  <Th align="right">Balance</Th>
                  <Th align="right">Available</Th>
                  <Th align="right">Frozen</Th>
                  <Th>Read from</Th>
                  <Th align="right" className="pr-4">Status</Th>
                </THead>
                <TBody>
                  {accounts.map((account) => (
                    <Tr key={account.accountCode} onClick={() => setSelected(account)} className="cursor-pointer">
                      <Td>
                        <p className="font-mono text-xs text-ink">{account.accountCode}</p>
                        <p className="text-[11px] text-faint">{account.name}</p>
                      </Td>
                      <Td>
                        <Badge tone={CATEGORY_TONES[account.category] ?? 'slate'}>{account.category}</Badge>
                      </Td>
                      <Td className="text-xs text-muted">
                        {account.ownerKind ?? '—'}
                        {account.ownerKind === 'USER' && account.ownerId ? (
                          <button
                            type="button"
                            className="ml-1 font-mono text-[10px] text-violet-300 hover:underline"
                            title="Open this member on the users screen"
                            onClick={(event) => {
                              event.stopPropagation();
                              gotoOwner(account);
                            }}
                          >
                            {account.ownerId.slice(0, 8)}
                          </button>
                        ) : account.ownerId ? (
                          <span className="ml-1 font-mono text-[10px] text-faint">{account.ownerId.slice(0, 8)}</span>
                        ) : null}
                      </Td>
                      <Td align="right" className="font-semibold tabular-nums text-xs text-ink">
                        {formatUnitAmount(account.balance, account.currency)}
                      </Td>
                      <Td align="right" className="tabular-nums text-xs">
                        {formatUnitAmount(account.available, account.currency)}
                      </Td>
                      <Td align="right" className={`tabular-nums text-xs ${account.frozen > 0 ? 'text-amber-300' : 'text-faint'}`}>
                        {formatUnitAmount(account.frozen, account.currency)}
                      </Td>
                      <Td className="font-mono text-[10px] text-faint">{account.balanceSource}</Td>
                      <Td align="right" className="pr-4">
                        <Badge tone={STATUS_TONES[account.status] ?? 'slate'}>{account.status}</Badge>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
              <Pagination page={page} limit={PAGE_SIZE} total={total} onChange={setPage} />
            </>
          )}
        </Card>
      )}

      {error === null && tab === 'recon' && (
        <Card
          bodyClassName="p-0"
          title="Can the book explain itself?"
          subtitle={generatedAt ? `Generated ${formatDateTime(generatedAt)} · ${findings.length} finding${findings.length === 1 ? '' : 's'}, ${errorCount ?? 0} error${(errorCount ?? 0) === 1 ? '' : 's'}` : undefined}
        >
          {findings.length === 0 ? (
            <EmptyState
              title="Every account reconciles"
              message="Each balance matches the table it is read from, and no hold claims more than its owner can spend."
              icon={<IconCheck className="h-6 w-6" />}
            />
          ) : (
            <>
              <Table>
                <THead>
                  <Th width="10%">Severity</Th>
                  <Th width="24%">Finding</Th>
                  <Th>Account</Th>
                  <Th align="right">Amount</Th>
                  <Th className="pr-4">Detail</Th>
                </THead>
                <TBody>
                  {findings.map((finding, index) => (
                    <Tr key={`${finding.code}-${finding.accountCode ?? 'platform'}-${index}`}>
                      <Td>
                        <Badge tone={finding.severity === 'ERROR' ? 'red' : 'sky'}>{finding.severity}</Badge>
                      </Td>
                      <Td className="font-mono text-xs text-ink">{finding.code}</Td>
                      <Td className="font-mono text-[11px] text-muted">{finding.accountCode ?? '—'}</Td>
                      <Td align="right" className="tabular-nums text-xs">
                        {finding.amountMinor === 0 ? <span className="text-faint">—</span> : formatUnitAmount(finding.amountMinor, finding.currency)}
                      </Td>
                      <Td className="pr-4 text-xs text-muted">{finding.detail}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
              <p className="border-t border-edge/60 px-4 py-3 text-[11px] leading-relaxed text-faint">
                An ERROR is a contradiction between two tables that should agree — never a comparison of an account against the number the view just read
                from it. An INFO is a figure that is true but not yet booked: platform revenue the ledger implies rather than journals. Both are exported
                so the answer can go to finance as it stands.
              </p>
            </>
          )}
        </Card>
      )}

      {error === null && tab === 'holds' && (
        <Card bodyClassName="p-0" title="Open holds" subtitle="Money set aside with a reason and an author — a release has a history, a number written on an account does not.">
          {holds.length === 0 ? (
            <EmptyState title="No holds are open" message="Nothing in the book is set aside waiting for a decision." icon={<IconKey className="h-6 w-6" />} />
          ) : (
            <Table>
              <THead>
                <Th width="24%">Account</Th>
                <Th>Kind</Th>
                <Th align="right">Amount</Th>
                <Th>Reason</Th>
                <Th>By</Th>
                <Th align="right" className="pr-4">Release</Th>
              </THead>
              <TBody>
                {holds.map((hold) => (
                  <HoldRow key={hold.id} hold={hold} mayWrite={mayWrite} onRelease={releaseHold} onOpenAccount={openAccount} />
                ))}
              </TBody>
            </Table>
          )}
          {holds.length >= PAGE_SIZE && (
            <p className="border-t border-edge/60 px-4 py-3 text-[11px] text-faint">
              Showing the first {PAGE_SIZE} open holds. Filter one account in the book for the rest.
            </p>
          )}
        </Card>
      )}

      <AccountDrawer
        account={selected}
        mayWrite={mayWrite}
        onClose={() => setSelected(null)}
        onChanged={() => {
          void load();
          void refreshSelected();
        }}
      />
    </div>
  );
}

function HoldRow({
  hold,
  mayWrite,
  onRelease,
  onOpenAccount,
}: {
  hold: AccountHold;
  mayWrite: boolean;
  onRelease: (hold: AccountHold, key: string) => Promise<void>;
  onOpenAccount: (code: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Tr className="cursor-pointer" onClick={() => onOpenAccount(hold.accountCode)}>
      <Td className="font-mono text-xs text-ink">{hold.accountCode}</Td>
      <Td>
        <Badge tone={hold.kind === 'FROZEN' ? 'red' : hold.kind === 'WITHDRAWAL' ? 'amber' : 'sky'}>{hold.kind}</Badge>
      </Td>
      <Td align="right" className="tabular-nums text-xs">{formatUnitAmount(hold.amount, hold.currency)}</Td>
      <Td className="max-w-[24rem] truncate text-xs text-muted" title={hold.reason}>{hold.reason}</Td>
      <Td className="text-xs text-muted">
        {hold.createdByName ?? 'system'}
        <p className="text-[10px] text-faint">{relativeTime(hold.createdAt)}</p>
      </Td>
      <Td align="right" className="pr-4">
        {mayWrite ? (
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            onClick={async (event) => {
              event.stopPropagation();
              setBusy(true);
              await onRelease(hold, clientKey(`release-${hold.id.slice(0, 8)}`));
              setBusy(false);
            }}
          >
            Release
          </Button>
        ) : (
          <Badge tone="slate">read only</Badge>
        )}
      </Td>
    </Tr>
  );
}

/** The statement, the holds and the three actions for one account. */
function AccountDrawer({
  account,
  mayWrite,
  onClose,
  onChanged,
}: {
  account: PurposeAccount | null;
  mayWrite: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [section, setSection] = useState('statement');
  const [rows, setRows] = useState<AccountMovement[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [unit, setUnit] = useState('dmn');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [holds, setHolds] = useState<AccountHold[]>([]);
  const [loading, setLoading] = useState(false);
  const [failing, setFailing] = useState<string | null>(null);

  const [kind, setKind] = useState('FROZEN');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<AccountStatus>('ACTIVE');
  const [statusReason, setStatusReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [releasing, setReleasing] = useState<string | null>(null);

  useEffect(() => {
    if (account) {
      setSection('statement');
      setPage(1);
      setFrom('');
      setTo('');
      setAmount('');
      setReason('');
      setStatus(account.status);
      setStatusReason('');
    }
  }, [account?.accountCode]);

  const window = useMemo(() => {
    const parsed: { from?: string; to?: string } = {};
    if (from !== '') parsed.from = new Date(`${from}T00:00:00`).toISOString();
    if (to !== '') parsed.to = new Date(`${to}T23:59:59`).toISOString();
    return parsed;
  }, [from, to]);

  const load = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    setFailing(null);
    try {
      const [statement, open] = await Promise.all([
        api.accountMovements(account.accountCode, { ...window, page, limit: PAGE_SIZE }),
        api.accountHolds({ accountCode: account.accountCode, limit: PAGE_SIZE }),
      ]);
      setRows(statement.movements);
      setTotal(statement.total);
      setUnit(statement.unit || account.currency);
      setHolds(open.holds);
    } catch (err) {
      setFailing(err instanceof ApiError ? err.message : 'Could not read this account.');
      setRows([]);
      setHolds([]);
    } finally {
      setLoading(false);
    }
  }, [account, window, page]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!account) return null;

  const matches = rows.length > 0 && identityHolds(account.opening, rows, account.balance);
  const parsedAmount = Number.parseInt(amount, 10);
  const amountValid = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const reasonValid = reason.trim().length >= 8;

  const releaseHere = async (hold: AccountHold) => {
    setReleasing(hold.id);
    try {
      const result = await api.releaseAccountHold(hold.id, { idempotencyKey: clientKey(`release-${hold.id.slice(0, 8)}`) });
      toast.success(result.replay ? 'That release had already happened — the server replayed it.' : `Hold ${result.status.toLowerCase()}.`);
      void load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not release that hold.');
    } finally {
      setReleasing(null);
    }
  };

  const placeHold = async () => {
    if (!amountValid || !reasonValid) return;
    setBusy(true);
    try {
      // One key per click: a retry of *this* attempt replays, a new hold needs a new click.
      const result = await api.createAccountHold(account.accountCode, {
        kind: kind as AccountHold['kind'],
        amount: parsedAmount,
        reason: reason.trim(),
        idempotencyKey: clientKey(`hold-${account.accountCode.slice(0, 12)}`),
      });
      toast.success(result.replay ? 'The server replayed an identical hold it had already placed.' : `Hold placed for ${formatUnitAmount(result.hold.amount, result.hold.currency)}.`);
      setAmount('');
      setReason('');
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? `${err.message}` : 'Could not place the hold.');
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async () => {
    setBusy(true);
    try {
      const updated = await api.setAccountStatus(account.accountCode, {
        status,
        reason: statusReason.trim() === '' ? undefined : statusReason.trim(),
      });
      toast.success(`${updated.accountCode ?? account.accountCode} is ${updated.status}.`);
      setStatusReason('');
      onChanged();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not change the status.');
    } finally {
      setBusy(false);
    }
  };

  const exportStatement = async (format: 'csv' | 'xlsx') => {
    try {
      await api.downloadAccountStatement(account.accountCode, format, { ...window, limit: 200 });
      toast.success(`Statement ${format.toUpperCase()} downloaded (up to 200 rows of this page).`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The export failed.');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={account.accountCode}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={CATEGORY_TONES[account.category] ?? 'slate'}>{account.category}</Badge>
          <Badge tone={STATUS_TONES[account.status] ?? 'slate'}>{account.status}</Badge>
          <span className="text-xs text-muted">{account.name}</span>
        </span>
      }
      footer={
        <p className="text-[11px] text-faint">
          Read from <span className="font-mono">{account.balanceSource}</span>
          {account.openedAt ? ` · opened ${formatDateTime(account.openedAt)}` : ''}
          {account.lastActivityAt ? ` · last moved ${relativeTime(account.lastActivityAt)}` : ''}
        </p>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { label: 'Balance', value: account.balance, tone: 'text-ink' },
            { label: 'Available', value: account.available, tone: 'text-emerald-300' },
            { label: 'Pending', value: account.pending, tone: 'text-amber-300' },
            { label: 'Approved', value: account.approved, tone: 'text-sky-300' },
            { label: 'Frozen', value: account.frozen, tone: 'text-rose-300' },
            { label: 'Opening', value: account.opening, tone: account.opening === 0 ? 'text-faint' : 'text-amber-300' },
          ].map((cell) => (
            <div key={cell.label} className="rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-faint">{cell.label}</p>
              <p className={`mt-0.5 text-sm font-bold tabular-nums ${cell.tone}`}>{formatUnitAmount(cell.value, account.currency)}</p>
            </div>
          ))}
        </div>

        {account.frozen !== 0 && (
          <p className="text-[11px] leading-relaxed text-faint">
            Available is what is neither pending nor approved, and a hold is carved out of it rather than off it — so{' '}
            {formatUnitAmount(account.available - account.frozen, account.currency)} is what a new hold could still take, which is the same rule the
            server applies when it refuses one.
          </p>
        )}

        <p className="text-[11px] leading-relaxed text-faint">
          Lifetime in {formatUnitAmount(account.lifetimeIn, account.currency)} minus out {formatUnitAmount(account.lifetimeOut, account.currency)}
          {account.opening !== 0 ? ` plus an opening of ${formatUnitAmount(account.opening, account.currency)}` : ''} is what this balance claims to be.
          {total > 0 && (
            <span className={matches ? 'text-emerald-300' : 'text-amber-300'}>
              {' '}This page of {rows.length} of {formatNumber(total)} movements {matches ? 'adds up to it.' : 'does not add up to it on its own — page through, or export, to see why.'}
            </span>
          )}
        </p>

        <Tabs
          active={section}
          onChange={setSection}
          items={[
            { id: 'statement', label: 'Statement', count: total },
            { id: 'holds', label: 'Holds', count: holds.filter((h) => h.status === 'OPEN').length },
            ...(mayWrite ? [{ id: 'act', label: 'Hold & status' }] : []),
          ]}
        />

        {failing !== null && (
          <EmptyState title="Could not read this account" message={failing} icon={<IconAlert className="h-6 w-6" />} action={<Button onClick={() => void load()}>Retry</Button>} />
        )}

        {section === 'statement' && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <Input label="From" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="w-40" />
              <Input label="To" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="w-40" />
              <Button size="sm" icon={<IconDownload className="h-4 w-4" />} onClick={() => void exportStatement('csv')}>CSV</Button>
              <Button size="sm" icon={<IconDownload className="h-4 w-4" />} onClick={() => void exportStatement('xlsx')}>Excel</Button>
              <Button size="sm" icon={<IconRefresh className="h-4 w-4" />} onClick={() => void load()}>Refresh</Button>
            </div>

            {loading ? (
              <div className="grid h-40 place-items-center text-violet-300">
                <Spinner className="h-7 w-7" />
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                title="No recorded movements"
                message={
                  account.balanceSource === 'users.diamond_balance' || account.balanceSource === 'users.r_coin_balance'
                    ? 'This balance did not arrive through a movement the ledger records, which is what the opening figure above is for.'
                    : 'Nothing in this window. Clear the dates to see the whole statement.'
                }
                icon={<IconScales className="h-6 w-6" />}
              />
            ) : (
              <>
                <div className="max-h-[24rem] overflow-auto rounded-lg border border-edge/60">
                  <Table>
                    <THead>
                      <Th width="15%">Occurred</Th>
                      <Th>Type</Th>
                      <Th align="right">Amount</Th>
                      <Th>Counterparty</Th>
                      <Th className="pr-4">Reference</Th>
                    </THead>
                    <TBody>
                      {rows.map((row) => (
                        <Tr key={`${row.reference}-${row.type}`}>
                          <Td className="text-[11px] text-muted">{formatDateTime(row.occurredAt)}</Td>
                          <Td>
                            <span className="flex items-center gap-1 text-xs text-ink">
                              {row.direction === 'IN'
                                ? <IconArrowUp className="h-3 w-3 text-emerald-300" />
                                : <IconArrowDown className="h-3 w-3 text-rose-300" />}
                              {row.type}
                              {row.status !== 'COMPLETED' && <Badge tone="amber">{row.status}</Badge>}
                            </span>
                          </Td>
                          <Td align="right" className={`font-semibold tabular-nums text-xs ${row.direction === 'IN' ? 'text-emerald-300' : 'text-rose-300'}`}>
                            {formatUnitAmount(row.amount, row.currency)}
                          </Td>
                          <Td className="max-w-[14rem] truncate text-[11px] text-muted" title={row.counterparty ?? ''}>
                            {row.counterparty ?? '—'}
                          </Td>
                          <Td align="right" className="pr-4 font-mono text-[10px] text-faint" title={row.description}>{row.reference}</Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                </div>
                <Pagination page={page} limit={PAGE_SIZE} total={total} onChange={setPage} />
              </>
            )}
          </div>
        )}

        {section === 'holds' && (
          holds.length === 0 ? (
            <EmptyState title="No holds on this account" message="Nothing here has been set aside with a reason." icon={<IconKey className="h-6 w-6" />} />
          ) : (
            <Table>
              <THead>
                <Th>Kind</Th>
                <Th align="right">Amount</Th>
                <Th>Reason</Th>
                <Th>Status</Th>
                <Th align="right">Placed</Th>
                {mayWrite && <Th align="right" className="pr-4">Release</Th>}
              </THead>
              <TBody>
                {holds.map((hold) => (
                  <Tr key={hold.id}>
                    <Td><Badge tone={hold.status === 'OPEN' ? 'amber' : 'slate'}>{hold.kind}</Badge></Td>
                    <Td align="right" className="tabular-nums text-xs">{formatUnitAmount(hold.amount, hold.currency)}</Td>
                    <Td className="text-xs text-muted">{hold.reason}</Td>
                    <Td>
                      <span className="text-[11px] text-faint">
                        {hold.status}
                        {hold.convertedRef ? ` → ${hold.convertedRef}` : ''}
                        {hold.createdByName ? ` · ${hold.createdByName}` : ''}
                      </span>
                    </Td>
                    <Td align="right" className={mayWrite ? 'text-[11px] text-muted' : 'pr-4 text-[11px] text-muted'}>{relativeTime(hold.createdAt)}</Td>
                    {mayWrite && (
                      <Td align="right" className="pr-4">
                        {hold.status === 'OPEN' ? (
                          <Button size="sm" variant="primary" loading={releasing === hold.id} onClick={() => void releaseHere(hold)}>
                            Release
                          </Button>
                        ) : (
                          <span className="text-[11px] text-faint">—</span>
                        )}
                      </Td>
                    )}
                  </Tr>
                ))}
              </TBody>
            </Table>
          )
        )}

        {section === 'act' && mayWrite && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Place a hold" subtitle="Sets money aside with a reason and an author. It does not move it, and it refuses more than the owner can currently spend.">
              <div className="space-y-3">
                <Select label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                  {HOLD_KINDS.map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </Select>
                <Input
                  label={`Amount in ${unit}`}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="whole coins, never a share"
                  error={amount !== '' && !amountValid ? 'A hold needs a positive whole number.' : null}
                  hint={account.currency === 'pkr' ? 'Minor units — 100 is PKR 1.00.' : 'Coins, not a percentage of the balance.'}
                />
                <Textarea
                  label="Reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Who asked, why, and what has to happen before this releases"
                  rows={3}
                  error={reason !== '' && !reasonValid ? 'At least 8 characters — an operator reading this in a month needs it to mean something.' : null}
                />
                <Button variant="primary" loading={busy} disabled={!amountValid || !reasonValid} onClick={() => void placeHold()}>
                  Place hold
                </Button>
              </div>
            </Card>

            <Card title="Change status" subtitle="Suspend, freeze or close what an owner may do with money already theirs. Anything other than ACTIVE is written down with a reason.">
              <div className="space-y-3">
                <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as AccountStatus)}>
                  {STATUSES.map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </Select>
                {status !== 'ACTIVE' && (
                  <Textarea
                    label="Reason"
                    value={statusReason}
                    onChange={(e) => setStatusReason(e.target.value)}
                    rows={3}
                    placeholder="The refusal an owner will be quoted"
                  />
                )}
                <Button
                  variant={status === 'ACTIVE' ? 'success' : 'danger'}
                  loading={busy}
                  disabled={status !== 'ACTIVE' && statusReason.trim().length < 8}
                  onClick={() => void changeStatus()}
                >
                  Set {status}
                </Button>
                <p className="text-[11px] leading-relaxed text-faint">
                  A suspended account takes no new holds; a closed one is a record, not a wallet. This never changes a balance — that route lives on the
                  users screen and this page does not duplicate it.
                </p>
              </div>
            </Card>
          </div>
        )}

        {!mayWrite && section !== 'act' && (
          <p className="text-[11px] text-faint">
            Your role may read the book but not act on it. Placing a hold, releasing one or changing a status needs <span className="font-mono">account:manage</span>.
          </p>
        )}
      </div>
    </Modal>
  );
}
