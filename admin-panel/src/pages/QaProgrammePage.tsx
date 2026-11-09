// ---------------------------------------------------------------------------
// The QA programme's record (migration 0039): which accounts are test accounts,
// and which financial rows that makes test activity.
//
// Three things this screen is built around, all of them decisions the schema
// already made rather than choices this page is free to reinterpret.
//
// The reference is required, and it is internal. Marking asks for `qa_ref`
// because the database refuses the flag without one; the account keeps its real
// display name everywhere a member can see it. This screen is the only place the
// two are shown side by side, which is why reading it is `qa:read` and not a
// side effect of `user:read`.
//
// Marking reclassifies history. It does not edit a balance and it does not touch
// a financial row — the money view derives the flag from the accounts a row
// belongs to, so a gift sent last month becomes test activity the moment its
// sender is marked, and becomes production again on unmark. The modal says so
// before the click, because an operator who thinks this is a label on future
// activity will mark the wrong account.
//
// The cohort write is all-or-nothing. The delivery matrix is thirty-plus
// accounts across three countries; marking them one request at a time is how a
// half-marked matrix happens, so the paste box submits one transaction and the
// server rolls the whole thing back if any id is wrong.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, StatCard } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { IconAlert, IconCheck, IconPlus, IconRefresh, IconScales, IconSearch, IconShieldCheck, IconUsers } from '../components/ui/Icons';
import { Input, Textarea } from '../components/ui/Input';
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
import { formatDateTime, formatNumber } from '../lib/format';
import type { QaCohortEntry, QaIdentity, QaMoneyRow, QaMoneySummary, QaOwnerKind } from '../types';

const PAGE_SIZE = 25;

const OWNER_KINDS: QaOwnerKind[] = ['USER', 'BUSINESS', 'AGENCY', 'ADMIN'];
const KIND_LABELS: Record<QaOwnerKind, string> = {
  USER: 'Member',
  BUSINESS: 'Partner',
  AGENCY: 'Agency',
  ADMIN: 'Operator',
};
const KIND_TONES: Record<QaOwnerKind, BadgeTone> = {
  USER: 'violet',
  BUSINESS: 'sky',
  AGENCY: 'fuchsia',
  ADMIN: 'amber',
};

/** The server's own rule, mirrored so a bad reference is caught before it is POSTed. */
const REF_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refError(raw: string): string | null {
  const ref = raw.trim().toUpperCase();
  if (ref.length === 0) return 'A reference is required — the database refuses a test account nobody can name.';
  if (ref.length < 2) return 'At least 2 characters.';
  if (ref.length > 40) return 'At most 40 characters.';
  if (!REF_PATTERN.test(ref)) return 'Letters, digits, dash and underscore only, starting with a letter or digit — e.g. PK-HOST-01.';
  return null;
}

/** What each financial table is called in the product, so the screen does not read like a schema dump. */
const TABLE_LABELS: Record<string, string> = {
  transactions: 'Ledger transactions',
  payment_proofs: 'Payment proofs',
  recharge_orders: 'Recharge orders',
  withdrawal_requests: 'Withdrawals',
  promo_grants: 'Promotional grants',
  earning_payouts: 'Earning payouts',
  commission_entries: 'Commission accruals',
  commission_settlements: 'Commission payouts',
  agency_settlements: 'Agency settlements',
  game_settlements: 'Game settlements',
  fin_journal_entries: 'Journal entries',
};

const tableLabel = (name: string): string => TABLE_LABELS[name] ?? name;

/**
 * One account per line: `KIND UUID REFERENCE`, separated by spaces or commas. Blank lines and `#`
 * comments are ignored so a cohort can be pasted straight out of the test matrix with its headings.
 * Every refusal the server would make is named here first, with its line number.
 */
function parseCohort(text: string): { entries: QaCohortEntry[]; errors: string[] } {
  const entries: QaCohortEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const parts = line.split(/[,\s]+/).filter((part) => part.length > 0);
    const at = `Line ${index + 1}`;
    if (parts.length !== 3) {
      errors.push(`${at}: expected KIND UUID REFERENCE, found ${parts.length} field(s).`);
      return;
    }
    const kind = parts[0].toUpperCase() as QaOwnerKind;
    if (!OWNER_KINDS.includes(kind)) {
      errors.push(`${at}: "${parts[0]}" is not one of ${OWNER_KINDS.join(', ')}.`);
      return;
    }
    if (!UUID_PATTERN.test(parts[1])) {
      errors.push(`${at}: "${parts[1]}" is not an account id.`);
      return;
    }
    const reference = parts[2].toUpperCase();
    if (refError(reference) !== null) {
      errors.push(`${at}: ${refError(reference)}`);
      return;
    }
    const key = `${kind}:${parts[1]}`;
    if (seen.has(key)) {
      errors.push(`${at}: that account is already in this cohort.`);
      return;
    }
    seen.add(key);
    entries.push({ ownerKind: kind, ownerId: parts[1], qaRef: reference });
  });

  if (entries.length > 200) errors.push('A cohort is at most 200 accounts.');
  return { entries, errors };
}

export default function QaProgrammePage() {
  const toast = useToast();
  const { can } = useAuth();
  const canManage = can('qa:manage');

  const [tab, setTab] = useState('accounts');

  const [summary, setSummary] = useState<QaMoneySummary | null>(null);
  const [markedTotal, setMarkedTotal] = useState<number | null>(null);

  const [accountFilters, setAccountFilters] = useState({ search: '', ownerKind: '', country: '', includeProduction: false });
  const [accountPage, setAccountPage] = useState(1);
  const debouncedSearch = useDebounce(accountFilters.search, 350);
  const [identities, setIdentities] = useState<QaIdentity[]>([]);
  const [identityTotal, setIdentityTotal] = useState(0);

  const [moneyFilters, setMoneyFilters] = useState({ marking: 'TEST', sourceTable: '', from: '', to: '' });
  const [moneyPage, setMoneyPage] = useState(1);
  const [moneyRows, setMoneyRows] = useState<QaMoneyRow[]>([]);
  const [moneyTotal, setMoneyTotal] = useState(0);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [marking, setMarking] = useState<{ identity: QaIdentity; isTest: boolean } | null>(null);
  const [showCohort, setShowCohort] = useState(false);

  const accountQuery = useMemo(
    () => ({
      search: debouncedSearch.trim() === '' ? undefined : debouncedSearch.trim(),
      ownerKind: accountFilters.ownerKind === '' ? undefined : (accountFilters.ownerKind as QaOwnerKind),
      country: accountFilters.country.trim() === '' ? undefined : accountFilters.country.trim(),
      includeProduction: accountFilters.includeProduction,
    }),
    [debouncedSearch, accountFilters.ownerKind, accountFilters.country, accountFilters.includeProduction],
  );

  const moneyQuery = useMemo(
    () => ({
      isTest: moneyFilters.marking === 'ALL' ? undefined : moneyFilters.marking === 'TEST',
      sourceTable: moneyFilters.sourceTable === '' ? undefined : moneyFilters.sourceTable,
      from: moneyFilters.from === '' ? undefined : moneyFilters.from,
      to: moneyFilters.to === '' ? undefined : moneyFilters.to,
    }),
    [moneyFilters],
  );

  /**
   * The two whole-table counts, read apart from the list below them. Paging a screenful of accounts
   * must not re-run the derivation over every financial record in the database.
   */
  const loadOverview = useCallback(async () => {
    try {
      const [money, marked] = await Promise.all([api.qaMoneySummary(), api.qaIdentities({ limit: 1 })]);
      setSummary(money);
      setMarkedTotal(marked.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to read the QA totals.');
    }
  }, []);

  const loadRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === 'accounts') {
        const result = await api.qaIdentities({ ...accountQuery, page: accountPage, limit: PAGE_SIZE });
        setIdentities(result.identities);
        setIdentityTotal(result.total);
      } else {
        const result = await api.qaMoney({ ...moneyQuery, page: moneyPage, limit: PAGE_SIZE });
        setMoneyRows(result.rows);
        setMoneyTotal(result.total);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the QA record.');
    } finally {
      setLoading(false);
    }
  }, [tab, accountQuery, accountPage, moneyQuery, moneyPage]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  useEffect(() => {
    setAccountPage(1);
  }, [accountQuery]);

  useEffect(() => {
    setMoneyPage(1);
  }, [moneyQuery, tab]);

  const reload = () => {
    void loadOverview();
    void loadRows();
  };

  const submitMark = async (identity: QaIdentity, isTest: boolean, qaRef: string) => {
    setBusy(true);
    try {
      const result = await api.markQaIdentity({
        ownerKind: identity.ownerKind,
        ownerId: identity.ownerId,
        isTest,
        ...(isTest ? { qaRef } : {}),
      });
      toast.success(
        isTest
          ? `${result.displayName} is now a test account (${result.qaRef}). Its history is excluded from production reports.`
          : `${result.displayName} is production again. The reference ${result.qaRef ?? ''} stays on the audit trail.`,
      );
      setMarking(null);
      reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not change that marking.');
    } finally {
      setBusy(false);
    }
  };

  const submitCohort = async (entries: QaCohortEntry[]) => {
    setBusy(true);
    try {
      const result = await api.markQaCohort(entries);
      toast.success(`${result.accounts.length} accounts marked as one cohort.`);
      setShowCohort(false);
      reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The cohort was refused; nothing was marked.');
    } finally {
      setBusy(false);
    }
  };

  if (loading && identities.length === 0 && moneyRows.length === 0 && error === null && summary === null) {
    return (
      <div className="mx-auto grid max-w-7xl h-48 place-items-center text-violet-300">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const dash = (value: number | null | undefined) => (value === null || value === undefined ? '—' : formatNumber(value));

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-ink">
            <IconShieldCheck className="h-5 w-5 text-violet-300" />
            QA programme
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            Which accounts belong to the test programme, and which money that makes test activity. Accounts keep their real display names in the app.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button icon={<IconRefresh className="h-4 w-4" />} onClick={reload}>
            Refresh
          </Button>
          {canManage && (
            <Button variant="primary" icon={<IconPlus className="h-4 w-4" />} onClick={() => setShowCohort(true)}>
              Mark a cohort
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Test accounts"
          value={dash(markedTotal)}
          sub="marked across all four kinds"
          tone="violet"
          icon={<IconUsers className="h-5 w-5" />}
        />
        <StatCard
          label="Test money rows"
          value={dash(summary?.testRows)}
          sub="excluded from production reports"
          tone="amber"
          icon={<IconAlert className="h-5 w-5" />}
        />
        <StatCard
          label="Production rows"
          value={dash(summary?.productionRows)}
          sub="what the delivery report quotes"
          tone="emerald"
          icon={<IconCheck className="h-5 w-5" />}
        />
        <StatCard
          label="Tables covered"
          value={dash(summary?.tables.length)}
          sub="every financial record is classified"
          tone="sky"
          icon={<IconScales className="h-5 w-5" />}
        />
      </div>

      <Card>
        <div className="flex items-start gap-2 text-xs leading-relaxed text-muted">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <p>
            Marking is derived, not copied: a money row is test activity when any account it belongs to is marked, so marking an account
            reclassifies transactions that <span className="text-ink">already existed</span> and unmarking puts them back. No balance moves
            and no financial row is rewritten. The dashboard, gift analytics and the member leaderboard exclude test activity by default;
            an operator with <code className="text-ink">qa:read</code> can ask for it back with <code className="text-ink">?includeTest=true</code>.
            {!canManage && <> Your role can read this record but cannot change a marking.</>}
          </p>
        </div>
      </Card>

      {error !== null && (
        <Card>
          <EmptyState
            title="Could not read the QA record"
            message={error}
            icon={<IconAlert className="h-6 w-6" />}
            action={<Button onClick={reload}>Retry</Button>}
          />
        </Card>
      )}

      <Tabs
        items={[
          { id: 'accounts', label: 'Accounts', count: markedTotal ?? undefined },
          { id: 'money', label: 'Money', count: summary?.testRows, alert: (summary?.testRows ?? 0) > 0 },
        ]}
        active={tab}
        onChange={setTab}
      />

      {error === null && tab === 'accounts' && (
        <Card bodyClassName="p-0">
          <div className="flex flex-wrap items-end gap-2 border-b border-edge/60 px-4 py-3">
            <Input
              label="Search"
              value={accountFilters.search}
              onChange={(e) => setAccountFilters({ ...accountFilters, search: e.target.value })}
              placeholder="display name, reference or account id"
              leadingIcon={<IconSearch className="h-4 w-4" />}
              className="w-72"
            />
            <Select
              aria-label="Account kind"
              value={accountFilters.ownerKind}
              onChange={(e) => setAccountFilters({ ...accountFilters, ownerKind: e.target.value })}
              className="w-40"
            >
              <option value="">All kinds</option>
              {OWNER_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </Select>
            <Input
              label="Country"
              value={accountFilters.country}
              onChange={(e) => setAccountFilters({ ...accountFilters, country: e.target.value.toUpperCase().slice(0, 2) })}
              placeholder="PK"
              className="w-24"
            />
            <label className="flex items-center gap-2 pb-2 text-xs text-muted">
              <Switch
                checked={accountFilters.includeProduction}
                onChange={(next) => setAccountFilters({ ...accountFilters, includeProduction: next })}
                label="Include unmarked accounts"
              />
              Include unmarked
            </label>
          </div>

          {loading ? (
            <div className="grid h-48 place-items-center text-violet-300">
              <Spinner className="h-8 w-8" />
            </div>
          ) : identities.length === 0 ? (
            <EmptyState
              title={accountFilters.includeProduction ? 'No account matches' : 'No account is marked yet'}
              message={
                accountFilters.includeProduction
                  ? 'Clear the search or the kind and country filters.'
                  : 'Switch on "Include unmarked" to find an account and mark it, or paste a whole cohort.'
              }
              icon={<IconUsers className="h-6 w-6" />}
            />
          ) : (
            <Table>
              <THead>
                <Th>Account</Th>
                <Th>Kind</Th>
                <Th>Reference</Th>
                <Th>Country</Th>
                <Th>Marking</Th>
                <Th>Since</Th>
                <Th align="right" className="pr-4">
                  Actions
                </Th>
              </THead>
              <TBody>
                {identities.map((row) => (
                  <Tr key={`${row.ownerKind}:${row.ownerId}`} className={row.isTest ? '' : 'opacity-60'}>
                    <Td>
                      <p className="font-medium text-ink">{row.displayName}</p>
                      <p className="font-mono text-[11px] text-faint">{row.ownerId}</p>
                    </Td>
                    <Td>
                      <Badge tone={KIND_TONES[row.ownerKind] ?? 'slate'}>{KIND_LABELS[row.ownerKind] ?? row.ownerKind}</Badge>
                    </Td>
                    <Td>
                      {row.qaRef === null ? (
                        <span className="text-xs text-faint">—</span>
                      ) : (
                        <span className="font-mono text-xs text-ink">{row.qaRef}</span>
                      )}
                    </Td>
                    <Td>
                      <span className="text-xs">{row.country ?? '—'}</span>
                    </Td>
                    <Td>
                      <Badge tone={row.isTest ? 'amber' : 'green'}>{row.isTest ? 'Test' : 'Production'}</Badge>
                    </Td>
                    <Td>
                      <p className="text-xs" title={formatDateTime(row.createdAt)}>
                        {formatDateTime(row.createdAt)}
                      </p>
                    </Td>
                    <Td align="right" className="pr-4">
                      {canManage ? (
                        row.isTest ? (
                          <Button size="sm" variant="success" onClick={() => setMarking({ identity: row, isTest: false })}>
                            Unmark
                          </Button>
                        ) : (
                          <Button size="sm" variant="primary" onClick={() => setMarking({ identity: row, isTest: true })}>
                            Mark as test
                          </Button>
                        )
                      ) : (
                        <span className="text-[11px] text-faint">read only</span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}

          {identityTotal > PAGE_SIZE && (
            <div className="border-t border-edge/60 px-4 py-3">
              <Pagination page={accountPage} limit={PAGE_SIZE} total={identityTotal} onChange={setAccountPage} />
            </div>
          )}
        </Card>
      )}

      {error === null && tab === 'money' && (
        <>
          <Card
            title="Every financial record, classified"
            subtitle="Read from the derivation, so these numbers move the moment an account is marked — and move back when it is unmarked."
            bodyClassName="p-0"
          >
            {summary === null || summary.tables.length === 0 ? (
              <EmptyState title="No financial records yet" icon={<IconScales className="h-6 w-6" />} />
            ) : (
              <Table>
                <THead>
                  <Th>Record</Th>
                  <Th align="right">Total</Th>
                  <Th align="right">Test</Th>
                  <Th align="right" className="pr-4">
                    Production
                  </Th>
                </THead>
                <TBody>
                  {summary.tables.map((row) => (
                    <Tr key={row.sourceTable}>
                      <Td>
                        <p className="font-medium text-ink">{tableLabel(row.sourceTable)}</p>
                        <p className="font-mono text-[11px] text-faint">{row.sourceTable}</p>
                      </Td>
                      <Td align="right" className="tabular-nums">{formatNumber(row.total)}</Td>
                      <Td align="right" className={`tabular-nums ${row.testRows > 0 ? 'text-amber-300' : 'text-faint'}`}>
                        {formatNumber(row.testRows)}
                      </Td>
                      <Td align="right" className="pr-4 tabular-nums text-emerald-300">{formatNumber(row.productionRows)}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          <Card bodyClassName="p-0">
            <div className="flex flex-wrap items-end gap-2 border-b border-edge/60 px-4 py-3">
              <Select
                aria-label="Marking"
                value={moneyFilters.marking}
                onChange={(e) => setMoneyFilters({ ...moneyFilters, marking: e.target.value })}
                className="w-44"
              >
                <option value="TEST">Test activity only</option>
                <option value="PRODUCTION">Production only</option>
                <option value="ALL">Both</option>
              </Select>
              <Select
                aria-label="Record type"
                value={moneyFilters.sourceTable}
                onChange={(e) => setMoneyFilters({ ...moneyFilters, sourceTable: e.target.value })}
                className="w-52"
              >
                <option value="">All records</option>
                {(summary?.tables ?? []).map((row) => (
                  <option key={row.sourceTable} value={row.sourceTable}>
                    {tableLabel(row.sourceTable)}
                  </option>
                ))}
              </Select>
              <Input
                label="From"
                type="date"
                value={moneyFilters.from}
                onChange={(e) => setMoneyFilters({ ...moneyFilters, from: e.target.value })}
                className="w-40"
              />
              <Input
                label="To"
                type="date"
                value={moneyFilters.to}
                onChange={(e) => setMoneyFilters({ ...moneyFilters, to: e.target.value })}
                className="w-40"
              />
            </div>

            {loading ? (
              <div className="grid h-48 place-items-center text-violet-300">
                <Spinner className="h-8 w-8" />
              </div>
            ) : moneyRows.length === 0 ? (
              <EmptyState
                title="No record matches"
                message={
                  moneyFilters.marking === 'TEST'
                    ? 'Nothing in this window is test activity. That is the expected answer once a cohort has been unmarked.'
                    : 'Widen the window or clear the record filter.'
                }
                icon={<IconScales className="h-6 w-6" />}
              />
            ) : (
              <Table>
                <THead>
                  <Th>Record</Th>
                  <Th>Occurred</Th>
                  <Th>Marking</Th>
                  <Th className="pr-4">Whose test</Th>
                </THead>
                <TBody>
                  {moneyRows.map((row) => (
                    <Tr key={`${row.sourceTable}:${row.sourceId}`}>
                      <Td>
                        <p className="font-medium text-ink">{tableLabel(row.sourceTable)}</p>
                        <p className="font-mono text-[11px] text-faint">{row.sourceId}</p>
                      </Td>
                      <Td>
                        <p className="text-xs" title={formatDateTime(row.occurredAt)}>
                          {formatDateTime(row.occurredAt)}
                        </p>
                      </Td>
                      <Td>
                        <Badge tone={row.isTest ? 'amber' : 'green'}>{row.isTest ? 'Test' : 'Production'}</Badge>
                      </Td>
                      <Td className="pr-4">
                        {row.testRefs.length === 0 ? (
                          <span className="text-xs text-faint">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {row.testRefs.map((reference) => (
                              <Badge key={reference} tone="violet">
                                {reference}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}

            {moneyTotal > PAGE_SIZE && (
              <div className="border-t border-edge/60 px-4 py-3">
                <Pagination page={moneyPage} limit={PAGE_SIZE} total={moneyTotal} onChange={setMoneyPage} />
              </div>
            )}
          </Card>
        </>
      )}

      <MarkingModal
        marking={marking}
        busy={busy}
        onClose={() => setMarking(null)}
        onSubmit={submitMark}
      />
      <CohortModal open={showCohort} busy={busy} onClose={() => setShowCohort(false)} onSubmit={submitCohort} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mark and unmark, with what each one actually does said before the click
// ---------------------------------------------------------------------------
function MarkingModal({
  marking,
  busy,
  onClose,
  onSubmit,
}: {
  marking: { identity: QaIdentity; isTest: boolean } | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (identity: QaIdentity, isTest: boolean, qaRef: string) => Promise<void>;
}) {
  const [reference, setReference] = useState('');

  useEffect(() => {
    if (marking === null) return;
    // An account that was marked before keeps its reference, so re-marking it does not invent a second
    // name for the same cohort.
    setReference(marking.identity.qaRef ?? '');
  }, [marking]);

  const isTest = marking?.isTest ?? false;
  const invalid = marking === null || (isTest && refError(reference) !== null);

  return (
    <Modal
      open={marking !== null}
      onClose={onClose}
      title={marking === null ? 'Change marking' : `${isTest ? 'Mark' : 'Unmark'} ${marking.identity.displayName}`}
      subtitle={
        isTest
          ? 'This reclassifies the account’s whole financial history, not just what it does next.'
          : 'The account and its history become production activity again.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={isTest ? 'primary' : 'success'}
            loading={busy}
            disabled={invalid}
            onClick={() => marking !== null && void onSubmit(marking.identity, isTest, reference.trim().toUpperCase())}
          >
            {isTest ? 'Mark as test' : 'Unmark'}
          </Button>
        </>
      }
    >
      {marking !== null && (
        <div className="space-y-3">
          <div className="rounded-xl border border-edge/60 bg-elevated/40 p-3 text-xs">
            <p className="font-medium text-ink">{marking.identity.displayName}</p>
            <p className="mt-1 text-muted">
              {KIND_LABELS[marking.identity.ownerKind] ?? marking.identity.ownerKind}
              {marking.identity.country !== null && <> · {marking.identity.country}</>}
            </p>
            <p className="mt-1 font-mono text-[11px] text-faint">{marking.identity.ownerId}</p>
          </div>

          {isTest ? (
            <Input
              label="Internal reference"
              value={reference}
              onChange={(e) => setReference(e.target.value.toUpperCase())}
              placeholder="PK-HOST-01"
              hint="Country, role and seat in the test matrix. Never shown to a member."
              error={reference.trim() === '' ? null : refError(reference)}
            />
          ) : (
            marking.identity.qaRef !== null && (
              <p className="text-xs text-muted">
                The reference <span className="font-mono text-ink">{marking.identity.qaRef}</span> stays on the row and in the audit
                trail, so the cohort is still nameable after the programme ends.
              </p>
            )
          )}

          <ul className="space-y-1 text-[11px] leading-relaxed text-faint">
            {isTest ? (
              <>
                <li>· Every transaction, proof, order, grant, payout and settlement this account owns becomes test activity — including ones already written.</li>
                <li>· Journal entries inherit it through the record they were posted for.</li>
                <li>· The dashboard, gift analytics and the member leaderboard stop counting it. A gift it sent no longer ranks the host who received it.</li>
                <li>· The app keeps showing the real display name. Neither the flag nor the reference reaches a member payload.</li>
                <li>· The last production super-admin cannot be marked, so the programme cannot lock itself out of its own controls.</li>
              </>
            ) : (
              <>
                <li>· Its history counts as production money again, immediately and without a financial row being rewritten.</li>
                <li>· The reports and the leaderboard pick it back up on the next read.</li>
                <li>· This writes its own audit row, separate from the mark.</li>
              </>
            )}
          </ul>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// A whole cohort in one transaction
// ---------------------------------------------------------------------------
function CohortModal({
  open,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (entries: QaCohortEntry[]) => Promise<void>;
}) {
  const [text, setText] = useState('');

  useEffect(() => {
    if (open) setText('');
  }, [open]);

  const parsed = useMemo(() => parseCohort(text), [text]);
  const invalid = parsed.entries.length === 0 || parsed.errors.length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Mark a cohort"
      subtitle="One transaction for the whole matrix: if any line is refused, nothing is marked."
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={invalid} onClick={() => void onSubmit(parsed.entries)}>
            Mark {parsed.entries.length} account{parsed.entries.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Textarea
          label="Accounts"
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'# KIND UUID REFERENCE — one per line, spaces or commas\nUSER 3f2a…-… PK-ENDUSER-01\nAGENCY 91b7…-… PK-AGENCY-01'}
        />
        <p className="text-[11px] leading-relaxed text-faint">
          One account per line: <span className="font-mono text-muted">KIND UUID REFERENCE</span>, separated by spaces or commas. KIND is
          USER, BUSINESS, AGENCY or ADMIN. Blank lines and lines starting with <span className="font-mono text-muted">#</span> are ignored,
          so a cohort can be pasted straight out of the test matrix with its headings.
        </p>

        {parsed.errors.length > 0 && (
          <div className="rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
            <p className="flex items-center gap-2 font-medium">
              <IconAlert className="h-4 w-4" />
              {parsed.errors.length} line{parsed.errors.length === 1 ? '' : 's'} would be refused
            </p>
            <ul className="mt-1 space-y-0.5">
              {parsed.errors.slice(0, 8).map((message) => (
                <li key={message}>· {message}</li>
              ))}
              {parsed.errors.length > 8 && <li>· and {parsed.errors.length - 8} more…</li>}
            </ul>
          </div>
        )}

        {parsed.errors.length === 0 && parsed.entries.length > 0 && (
          <div className="rounded-xl border border-edge/60 bg-elevated/40 p-3">
            <p className="text-xs font-medium text-ink">{parsed.entries.length} accounts ready</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {OWNER_KINDS.map((kind) => {
                const count = parsed.entries.filter((entry) => entry.ownerKind === kind).length;
                if (count === 0) return null;
                return (
                  <Badge key={kind} tone={KIND_TONES[kind]}>
                    {count} {KIND_LABELS[kind]}
                  </Badge>
                );
              })}
            </div>
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-faint">
          A reference is never reused, so one reference means one account for the life of the programme. Each mark writes its own audit
          row naming the operator who submitted the cohort.
        </p>
      </div>
    </Modal>
  );
}