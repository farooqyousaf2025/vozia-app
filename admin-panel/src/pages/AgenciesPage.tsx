// ---------------------------------------------------------------------------
// The agency desk: what each roster's share of its hosts' gifts is, and the batches that pay it.
//
//   DRAFT --Approve-->  APPROVED --Pay-->  PAID
//     `----------------------->  VOID  <------------------'
//
// Two rules shape this screen, and neither is a matter of taste.
//
// It never moves money. The accrual is written by the gift path (a share of the R-coins a host
// received, booked to that agency's account at the rate resolved here); the only button that reaches
// the journal is Pay, and Pay records a transfer that already happened outside the platform's rails —
// which is why it asks for a reference instead of an amount.
//
// It never shows a rate without the level it came from. A host can be taken at a rate agreed with
// them, at their agency's, or at the platform default, and clearing an override changes which of the
// three speaks next time. `commissionLabel` says so in words because the number alone cannot answer
// the question an agency actually asks.
//
// Reads need `finance:read`; every write needs `commission:manage`, except the platform default dial,
// which is `config:manage`. The server decides on each call, so this screen only decides what to draw.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Avatar } from '../components/ui/Avatar';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input, Textarea } from '../components/ui/Input';
import {
  IconAlert,
  IconCheck,
  IconClose,
  IconCommission,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconWallet,
} from '../components/ui/Icons';
import { Modal } from '../components/ui/Modal';
import { Pagination } from '../components/ui/Pagination';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { Tabs } from '../components/ui/Tabs';
import { useToast } from '../components/ui/Toast';
import { useDebounce } from '../hooks/useDebounce';
import { useAuth } from '../context/AuthContext';
import { ApiError, api } from '../lib/api';
import { formatBps, formatCents, formatDate, formatDateTime, formatNumber, relativeTime } from '../lib/format';
import type {
  Agency,
  AgencyDetailResult,
  AgencyRosterRow,
  AgencySettlement,
  AgencySettlementEntry,
  AgencySettlementStatus,
  AgencyStatus,
  CommissionRateSource,
} from '../types';

const AGENCY_STATUSES: AgencyStatus[] = ['PENDING', 'ACTIVE', 'SUSPENDED'];
const BATCH_STATUSES: AgencySettlementStatus[] = ['DRAFT', 'APPROVED', 'PAID', 'VOID'];
/** The same three the withdrawal sheet offers — one server-owned list, not one per screen. */
const PAYOUT_METHODS = ['BANK', 'WALLET', 'USDT'];

const AGENCY_TONES: Record<string, BadgeTone> = { ACTIVE: 'green', PENDING: 'amber', SUSPENDED: 'red' };
const BATCH_TONES: Record<string, BadgeTone> = { DRAFT: 'amber', APPROVED: 'sky', PAID: 'green', VOID: 'slate' };
const SOURCE_TONES: Record<CommissionRateSource, BadgeTone> = { HOST: 'violet', AGENCY: 'sky', PLATFORM_DEFAULT: 'slate' };

const PAGE_SIZE = 25;

/**
 * A key per click, held across retries of that click. Raising, paying and voiding are all replay-safe
 * on the server, so the same key after a lost response returns the batch's first answer instead of
 * claiming the same accruals a second time.
 */
function clientKey(prefix: string): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `panel-${prefix}-${random}`;
}

/** Minor units always travel with their currency code — an unscaled number is how two units get mixed. */
function money(amount: number, currency: string): string {
  return formatCents(amount, (currency || 'pkr').toUpperCase());
}

export default function AgenciesPage() {
  const toast = useToast();
  const { can } = useAuth();
  const mayWrite = can('commission:manage');

  const [tab, setTab] = useState<'roster' | 'batches'>('roster');

  const [filters, setFilters] = useState({ search: '', status: '' });
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounce(filters.search, 350);
  const [agencies, setAgencies] = useState<Agency[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingAgencies, setLoadingAgencies] = useState(true);
  const [agencyError, setAgencyError] = useState<string | null>(null);

  const [batchFilters, setBatchFilters] = useState({ status: '' as '' | AgencySettlementStatus, agencyId: '' });
  const [batches, setBatches] = useState<AgencySettlement[] | null>(null);
  const [loadingBatches, setLoadingBatches] = useState(true);
  const [batchError, setBatchError] = useState<string | null>(null);

  const [deskAgencyId, setDeskAgencyId] = useState<string | null>(null);
  const [raiseFor, setRaiseFor] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] = useState<AgencySettlement | null>(null);
  const [payTarget, setPayTarget] = useState<AgencySettlement | null>(null);
  const [voidTarget, setVoidTarget] = useState<AgencySettlement | null>(null);
  const [entriesFor, setEntriesFor] = useState<string | null>(null);

  const loadAgencies = useCallback(async () => {
    setLoadingAgencies(true);
    setAgencyError(null);
    try {
      const result = await api.agencies({
        search: debouncedSearch.trim() === '' ? undefined : debouncedSearch.trim(),
        status: filters.status === '' ? undefined : filters.status,
        page,
        limit: PAGE_SIZE,
      });
      setAgencies(result.agencies);
      setTotal(result.total);
    } catch (err) {
      setAgencies([]);
      setTotal(0);
      setAgencyError(err instanceof ApiError ? err.message : 'Failed to load agencies.');
    } finally {
      setLoadingAgencies(false);
    }
  }, [debouncedSearch, filters.status, page]);

  const loadBatches = useCallback(async () => {
    setLoadingBatches(true);
    setBatchError(null);
    try {
      const result = await api.agencySettlements({
        status: batchFilters.status === '' ? undefined : batchFilters.status,
        agencyId: batchFilters.agencyId === '' ? undefined : batchFilters.agencyId,
        limit: 50,
      });
      setBatches(result.settlements);
    } catch (err) {
      setBatches([]);
      setBatchError(err instanceof ApiError ? err.message : 'Failed to load settlement batches.');
    } finally {
      setLoadingBatches(false);
    }
  }, [batchFilters]);

  useEffect(() => {
    void loadAgencies();
  }, [loadAgencies]);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  /**
   * A batch that changed moves two things the roster table shows — the agency's open/paid counts and
   * its account position — so both lists are re-read rather than patched from the response alone.
   */
  const batchChanged = (updated: AgencySettlement, note: string) => {
    setBatches((current) => (current ?? []).map((row) => (row.id === updated.id ? updated : row)));
    toast.success(note);
    void loadAgencies();
  };

  const openQueueFor = (agencyId: string) => {
    setDeskAgencyId(null);
    setBatchFilters({ status: '', agencyId });
    setTab('batches');
  };

  const pending = (batches ?? []).filter((row) => row.status === 'DRAFT' || row.status === 'APPROVED').length;

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Agencies</h1>
          <p className="mt-0.5 text-sm text-muted">
            The share the platform owes each roster of hosts, and the batches that clear it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {mayWrite && (
            <Button
              variant="primary"
              size="sm"
              icon={<IconPlus className="h-4 w-4" />}
              onClick={() => setRaiseFor(batchFilters.agencyId === '' ? null : batchFilters.agencyId)}
            >
              Raise a batch
            </Button>
          )}
          <Button
            icon={<IconRefresh className="h-4 w-4" />}
            onClick={() => {
              void loadAgencies();
              void loadBatches();
            }}
          >
            Refresh
          </Button>
        </div>
      </div>

      <DefaultRateCard mayWrite={can('config:manage')} />

      <Tabs
        active={tab}
        onChange={(id) => setTab(id as 'roster' | 'batches')}
        items={[
          { id: 'roster', label: 'Agencies & rates', count: total },
          { id: 'batches', label: 'Settlement batches', count: pending, alert: pending > 0 },
        ]}
      />

      {tab === 'roster' && (
        <Card bodyClassName="p-0">
          <div className="flex flex-wrap items-end gap-2 px-4 pt-4">
            <Input
              label="Search"
              placeholder="Agency name…"
              leadingIcon={<IconSearch className="h-4 w-4" />}
              value={filters.search}
              onChange={(e) => {
                setFilters({ ...filters, search: e.target.value });
                setPage(1);
              }}
              className="w-64"
            />
            <Select
              label="Status"
              aria-label="Filter agencies by status"
              value={filters.status}
              onChange={(e) => {
                setFilters({ ...filters, status: e.target.value });
                setPage(1);
              }}
              className="w-40"
            >
              <option value="">All statuses</option>
              {AGENCY_STATUSES.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </Select>
          </div>

          {loadingAgencies && agencies === null ? (
            <div className="grid h-56 place-items-center text-violet-300">
              <Spinner className="h-8 w-8" />
            </div>
          ) : agencyError !== null ? (
            <div className="p-5">
              <EmptyState
                title="Could not load agencies"
                message={agencyError}
                icon={<IconAlert className="h-6 w-6" />}
                action={<Button onClick={() => void loadAgencies()}>Retry</Button>}
              />
            </div>
          ) : (agencies ?? []).length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No agencies match"
                message={filters.search !== '' || filters.status !== '' ? 'Try a different name or status.' : 'An agency appears here when a host is filed on its roster.'}
                icon={<IconCommission className="h-6 w-6" />}
              />
            </div>
          ) : (
            <>
              <Table>
                <THead>
                  <Th width="20%">Agency</Th>
                  <Th>Rate applied to a new host</Th>
                  <Th align="center">Hosts</Th>
                  <Th align="right">Commission earned</Th>
                  <Th align="right">Owed now</Th>
                  <Th align="center">Batches</Th>
                  <Th align="right" className="pr-4">Actions</Th>
                </THead>
                <TBody>
                  {(agencies ?? []).map((agency) => (
                    <Tr key={agency.id}>
                      <Td>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-ink">{agency.name}</p>
                          <p className="text-[11px] text-faint">
                            {agency.contactPhone ?? 'no contact on file'} · added {relativeTime(agency.createdAt)}
                          </p>
                        </div>
                        <Badge tone={AGENCY_TONES[agency.status] ?? 'slate'} className="mt-1">{agency.status}</Badge>
                      </Td>
                      <Td>
                        <p className="text-xs text-ink">{agency.commissionLabel}</p>
                        <p className="text-[11px] text-faint">
                          {agency.commissionBps === null
                            ? 'inherits the platform default'
                            : `set here: ${formatBps(agency.commissionBps)}`}
                        </p>
                      </Td>
                      <Td align="center" className="tabular-nums text-xs">
                        <span className="text-ink">{agency.activeHostCount}</span>
                        <span className="text-faint"> / {agency.hostCount} active</span>
                      </Td>
                      <Td align="right" className="tabular-nums text-xs">
                        <span className="font-semibold text-ink">{formatNumber(agency.accruedCoins)}</span>
                        <p className="text-[11px] text-faint">R-coins counted</p>
                      </Td>
                      <Td align="right" className="tabular-nums text-xs">
                        {agency.account === null ? (
                          <p className="text-faint" title="No gift has gone to one of its hosts, so nothing has been accrued yet.">
                            no account yet
                          </p>
                        ) : (
                          <>
                            <p className="font-semibold text-ink">{money(agency.account.available, agency.account.currency)}</p>
                            {(agency.account.pending > 0 || agency.account.frozen > 0) && (
                              <p className="text-[11px] text-faint">
                                {money(agency.account.pending, agency.account.currency)} claimed ·{' '}
                                {money(agency.account.frozen, agency.account.currency)} held
                              </p>
                            )}
                          </>
                        )}
                      </Td>
                      <Td align="center" className="tabular-nums text-xs">
                        <p className="text-amber-300">{agency.openBatches} open</p>
                        <p className="text-[11px] text-faint">{agency.paidBatches} paid</p>
                      </Td>
                      <Td align="right" className="pr-4">
                        <div className="flex justify-end gap-1.5">
                          <Button size="sm" onClick={() => setDeskAgencyId(agency.id)}>Rates & roster</Button>
                          <Button size="sm" onClick={() => openQueueFor(agency.id)}>Batches</Button>
                        </div>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
              <div className="px-4 pb-4">
                <Pagination page={page} limit={PAGE_SIZE} total={total} onChange={setPage} />
              </div>
            </>
          )}
        </Card>
      )}

      {tab === 'batches' && (
        <Card bodyClassName="p-0">
          <div className="flex flex-wrap items-end gap-2 px-4 pt-4">
            <Select
              label="Status"
              aria-label="Filter batches by status"
              value={batchFilters.status}
              onChange={(e) => setBatchFilters({ ...batchFilters, status: e.target.value as '' | AgencySettlementStatus })}
              className="w-40"
            >
              <option value="">All statuses</option>
              {BATCH_STATUSES.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </Select>
            <Select
              label="Agency"
              aria-label="Filter batches by agency"
              value={batchFilters.agencyId}
              onChange={(e) => setBatchFilters({ ...batchFilters, agencyId: e.target.value })}
              className="w-56"
            >
              <option value="">All agencies</option>
              {(agencies ?? []).map((agency) => (
                <option key={agency.id} value={agency.id}>{agency.name}</option>
              ))}
            </Select>
            {(batchFilters.status !== '' || batchFilters.agencyId !== '') && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setBatchFilters({ status: '', agencyId: '' })}
              >
                Clear filters
              </Button>
            )}
          </div>

          {loadingBatches && batches === null ? (
            <div className="grid h-56 place-items-center text-violet-300">
              <Spinner className="h-8 w-8" />
            </div>
          ) : batchError !== null ? (
            <div className="p-5">
              <EmptyState
                title="Could not load batches"
                message={batchError}
                icon={<IconAlert className="h-6 w-6" />}
                action={<Button onClick={() => void loadBatches()}>Retry</Button>}
              />
            </div>
          ) : (batches ?? []).length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No batches in this filter"
                message="A batch is raised over an agency's unsettled accruals for one period. Nothing here owes anybody yet."
                icon={<IconWallet className="h-6 w-6" />}
              />
            </div>
          ) : (
            <Table>
              <THead>
                <Th width="16%">Batch</Th>
                <Th>Agency</Th>
                <Th>Period</Th>
                <Th align="right">Claims</Th>
                <Th align="right">Amount</Th>
                <Th width="18%">Status</Th>
                <Th align="right" className="pr-4">Actions</Th>
              </THead>
              <TBody>
                {(batches ?? []).map((batch) => (
                  <Tr key={batch.id}>
                    <Td>
                      <p className="font-mono text-xs text-ink">{batch.reference}</p>
                      <p className="text-[11px] text-faint" title={formatDateTime(batch.createdAt)}>
                        raised {relativeTime(batch.createdAt)} by {batch.createdByName ?? '—'}
                      </p>
                    </Td>
                    <Td>
                      <button
                        type="button"
                        onClick={() => setDeskAgencyId(batch.agencyId)}
                        className="focus-ring truncate text-sm text-violet-200 hover:underline"
                      >
                        {batch.agencyName}
                      </button>
                    </Td>
                    <Td className="whitespace-nowrap text-xs">
                      {formatDate(batch.periodFrom)}
                      <span className="text-faint"> → {formatDate(batch.periodTo)}</span>
                      <p className="text-[11px] text-faint">the end day is not included</p>
                    </Td>
                    <Td align="right" className="tabular-nums text-xs text-ink">{batch.entryCount}</Td>
                    <Td align="right" className="font-semibold tabular-nums text-xs text-ink">
                      {money(batch.amount, batch.currency)}
                    </Td>
                    <Td>
                      <Badge tone={BATCH_TONES[batch.status] ?? 'slate'}>{batch.status}</Badge>
                      <p className="mt-1 max-w-[14rem] break-words text-[11px] text-faint">
                        {batch.status === 'PAID' && `${batch.payoutReference ?? 'paid without a reference'} · ${batch.payoutMethod ?? 'method not set'}`}
                        {batch.status === 'VOID' && `voided · ${batch.note ?? 'no reason recorded'}`}
                        {batch.status === 'APPROVED' && `approved by ${batch.approvedByName ?? '—'}`}
                        {batch.status === 'DRAFT' && `awaiting a second operator`}
                      </p>
                    </Td>
                    <Td align="right" className="pr-4">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => setEntriesFor(batch.id)}>What it paid</Button>
                        {mayWrite && batch.status === 'DRAFT' && (
                          <Button size="sm" onClick={() => setApproveTarget(batch)}>Approve</Button>
                        )}
                        {mayWrite && batch.status === 'APPROVED' && (
                          <Button size="sm" variant="success" onClick={() => setPayTarget(batch)}>Record payout</Button>
                        )}
                        {mayWrite && (batch.status === 'DRAFT' || batch.status === 'APPROVED') && (
                          <Button size="sm" variant="danger" onClick={() => setVoidTarget(batch)}>Void</Button>
                        )}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      )}

      {deskAgencyId !== null && (
        <AgencyDesk
          agencyId={deskAgencyId}
          mayWrite={mayWrite}
          onClose={() => setDeskAgencyId(null)}
          onViewBatches={openQueueFor}
        />
      )}

      {raiseFor !== null && (
        <RaiseModal
          agencies={agencies ?? []}
          initialAgencyId={raiseFor}
          onClose={() => setRaiseFor(null)}
          onRaised={(settlement, replay) => {
            setRaiseFor(null);
            setBatchFilters({ status: '', agencyId: '' });
            batchChanged(
              settlement,
              replay
                ? `${settlement.reference} was already raised — this is its first answer, not a second batch.`
                : `Raised ${settlement.reference} for ${settlement.agencyName}: ${money(settlement.amount, settlement.currency)} claimed and held.`,
            );
          }}
        />
      )}

      {approveTarget !== null && (
        <ApproveModal
          batch={approveTarget}
          onClose={() => setApproveTarget(null)}
          onApproved={(settlement) => {
            setApproveTarget(null);
            batchChanged(settlement, `${settlement.reference} approved — it may now be paid, by whoever did not raise it.`);
          }}
        />
      )}

      {payTarget !== null && (
        <PayModal
          batch={payTarget}
          onClose={() => setPayTarget(null)}
          onPaid={(settlement, replay) => {
            setPayTarget(null);
            batchChanged(
              settlement,
              replay
                ? `${settlement.reference} is already paid — this is its first answer, not a second transfer.`
                : `Recorded ${money(settlement.amount, settlement.currency)} paid to ${settlement.agencyName}.`,
            );
          }}
        />
      )}

      {voidTarget !== null && (
        <VoidModal
          batch={voidTarget}
          onClose={() => setVoidTarget(null)}
          onVoided={(settlement, replay) => {
            // The response's own count is taken after the claims are deleted, so it is always zero;
            // the number an operator wants is the one the batch was holding when they opened this.
            const released = voidTarget.entryCount;
            setVoidTarget(null);
            batchChanged(
              settlement,
              replay
                ? `${settlement.reference} was already voided.`
                : `${settlement.reference} voided — its ${released} accruals are claimable again and the hold is released.`,
            );
          }}
        />
      )}

      {entriesFor !== null && (
        <EntriesModal settlementId={entriesFor} onClose={() => setEntriesFor(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The level every agency inherits.
//
// It is a dial rather than a column because it is one decision applied everywhere at once, and it is
// shown here because a rate that resolves to `null` at both levels means a gift accrues nothing at all
// — an invisible outcome unless the default is on screen.
// ---------------------------------------------------------------------------
interface AgencyDial {
  defaultCommissionBps?: number;
  [field: string]: unknown;
}

function DefaultRateCard({ mayWrite }: { mayWrite: boolean }) {
  const toast = useToast();
  const [dial, setDial] = useState<AgencyDial | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.readConfig<AgencyDial>('accounts.agency');
      setDial(result.value);
      setText(result.value.defaultCommissionBps === undefined ? '' : String(result.value.defaultCommissionBps));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to read the platform default rate.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const parsed = text.trim() === '' ? null : Number(text);
  const valid = parsed === null || (Number.isInteger(parsed) && parsed >= 0 && parsed <= 10_000);
  const stored = dial?.defaultCommissionBps ?? null;
  const dirty = dial !== null && stored !== parsed;

  const save = async () => {
    if (busy || !valid || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      // `writeConfig` replaces the whole blob, so whatever else the row carries is sent back as read.
      const result = await api.writeConfig('accounts.agency', { ...(dial ?? {}), defaultCommissionBps: parsed ?? 0 });
      const value = (result.value ?? {}) as AgencyDial;
      setDial(value);
      setText(value.defaultCommissionBps === undefined ? '' : String(value.defaultCommissionBps));
      toast.success('Platform default rate saved. It applies to the next gift, not to accruals already booked.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the platform default rate.');
    } finally {
      setBusy(false);
    }
  };

  if (dial === null && error === null) return null;

  return (
    <Card
      title="Platform default rate"
      subtitle="What an agency with no rate of its own is taken at — 0 means a gift accrues nothing to anyone."
      actions={
        <>
          <Button size="sm" icon={<IconRefresh className="h-4 w-4" />} onClick={() => void load()}>Reload</Button>
          {mayWrite && (
            <Button size="sm" variant="primary" onClick={() => void save()} loading={busy} disabled={!valid || !dirty}>
              Save default
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-end gap-4">
        <Input
          label="Default commission (basis points, 100 = 1%)"
          type="number"
          min={0}
          max={10000}
          step={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!mayWrite}
          className="w-72"
          hint={
            valid
              ? `A 100 R-coin gift would accrue ${money(Math.floor((100 * (parsed ?? 0)) / 10_000) * 10, 'pkr')} at this rate (1 coin = 10 paisa).`
              : 'Whole basis points between 0 and 10000.'
          }
        />
        {dial !== null && (
          <p className="text-xs text-faint">
            Stored as <span className="text-ink">{stored === null ? 'unset — treated as 0' : `${stored} bps (${formatBps(stored)})`}</span>.
            An agency's own rate and a host's override both speak before this one.
          </p>
        )}
      </div>
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
// One rate field, used for an agency and for a host.
//
// An empty input is not "unchanged", it is "clear the override", so the value the operator meant is
// always sent — the server refuses a PUT that omits the field rather than guessing which one they had
// in mind, and this editor never lets them omit it by accident.
// ---------------------------------------------------------------------------
function RateEditor({
  currentBps,
  effectiveLabel,
  inheritNote,
  disabled,
  onSave,
}: {
  currentBps: number | null;
  effectiveLabel: string;
  inheritNote: string;
  disabled: boolean;
  onSave: (bps: number | null) => Promise<void>;
}) {
  const [text, setText] = useState(currentBps === null ? '' : String(currentBps));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = text.trim() === '' ? null : Number(text);
  const valid = parsed === null || (Number.isInteger(parsed) && parsed >= 0 && parsed <= 10_000);
  const dirty = parsed !== currentBps;

  const submit = async () => {
    if (busy || !valid || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(parsed);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the rate.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-xs text-ink">{effectiveLabel}</p>
      <div className="flex items-end gap-2">
        <Input
          type="number"
          min={0}
          max={10000}
          step={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={disabled}
          className="w-28"
          aria-label="Rate in basis points"
        />
        {disabled ? (
          <span className="text-[11px] text-faint">read-only</span>
        ) : (
          <Button size="sm" variant="primary" onClick={() => void submit()} loading={busy} disabled={!valid || !dirty}>
            Save
          </Button>
        )}
      </div>
      <p className={`text-[11px] ${valid ? 'text-faint' : 'text-rose-300'}`}>
        {valid ? (parsed === null ? inheritNote : `${parsed} bps = ${formatBps(parsed)} · leave empty to inherit`) : 'Whole basis points between 0 and 10000.'}
      </p>
      {error !== null && (
        <p className="flex items-start gap-1.5 text-[11px] text-rose-300">
          <IconAlert className="mt-0.5 h-3 w-3 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The desk for one agency: what it is owed, what its hosts are taken at, its batches.
// ---------------------------------------------------------------------------
function AgencyDesk({
  agencyId,
  mayWrite,
  onClose,
  onViewBatches,
}: {
  agencyId: string;
  mayWrite: boolean;
  onClose: () => void;
  onViewBatches: (agencyId: string) => void;
}) {
  const [detail, setDetail] = useState<AgencyDetailResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hostRates, setHostRates] = useState<Record<string, number | null>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      setDetail(await api.agencyDetail(agencyId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load this agency.');
    }
  }, [agencyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const account = detail?.agency.account ?? null;
  const currency = account?.currency ?? 'pkr';

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={detail?.agency.name ?? 'Agency'}
      subtitle={
        detail === null
          ? 'Loading…'
          : `${detail.agency.status} · ${detail.agency.activeHostCount} of ${detail.agency.hostCount} hosts active · ${detail.agency.contactPhone ?? 'no contact on file'}`
      }
      footer={
        <>
          <Button onClick={() => void load()} icon={<IconRefresh className="h-4 w-4" />}>Reload</Button>
          <Button onClick={() => onViewBatches(agencyId)}>Batches queue</Button>
          <Button variant="primary" onClick={onClose}>Close</Button>
        </>
      }
    >
      {error !== null && (
        <EmptyState title="Could not read this agency" message={error} icon={<IconAlert className="h-6 w-6" />} action={<Button onClick={() => void load()}>Retry</Button>} />
      )}

      {detail === null && error === null && (
        <div className="grid h-40 place-items-center text-violet-300">
          <Spinner className="h-7 w-7" />
        </div>
      )}

      {detail !== null && (
        <div className="space-y-6">
          {/* position */}
          <section className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-faint">What the platform owes</h4>
            {account === null ? (
              <p className="rounded-lg border border-edge/60 bg-elevated/40 px-4 py-3 text-xs text-muted">
                No account has been opened for this agency yet. It appears when a gift goes to one of its hosts and the
                commission is booked — there is nothing to settle before that.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: 'Available', value: account.available, tone: 'text-ink' },
                  { label: 'Claimed by open batches', value: account.pending, tone: 'text-amber-300' },
                  { label: 'Held by a dispute', value: account.frozen, tone: 'text-rose-300' },
                  { label: 'Balance', value: account.balance, tone: 'text-emerald-300' },
                ].map((figure) => (
                  <div key={figure.label} className="rounded-lg border border-edge/60 bg-elevated/40 p-3">
                    <p className="text-[11px] uppercase tracking-wider text-faint">{figure.label}</p>
                    <p className={`mt-1 text-lg font-bold tabular-nums ${figure.tone}`}>{money(figure.value, currency)}</p>
                  </div>
                ))}
              </div>
            )}
            {account !== null && (
              <p className="text-[11px] text-faint">
                Read from <span className="text-muted">{account.balanceSource}</span> · lifetime in{' '}
                {money(account.lifetimeIn, currency)}, out {money(account.lifetimeOut, currency)} · last activity{' '}
                {account.lastActivityAt === null ? 'never' : relativeTime(account.lastActivityAt)}
              </p>
            )}
            <p className="text-[11px] text-faint">
              Commission counted from gifts is {formatNumber(detail.agency.accruedCoins)} R-coins — the same money, in the
              unit an agency negotiates in.
            </p>
          </section>

          {/* the agency's own rate */}
          <section className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-faint">Agency rate</h4>
            <div className="rounded-lg border border-edge/60 bg-elevated/40 p-4">
              <RateEditor
                currentBps={detail.agency.commissionBps}
                effectiveLabel={detail.agency.commissionLabel}
                inheritNote="empty = take the platform default for every host without an override"
                disabled={!mayWrite}
                onSave={async (bps) => {
                  await api.setAgencyRate(agencyId, bps);
                  // This number is the effective rate of every host on the roster without an override of
                  // its own, and the server is what labels those rows — re-read instead of patching one field.
                  await load();
                }}
              />
            </div>
          </section>

          {/* roster */}
          <section className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-faint">
              Roster · {detail.roster.length} host{detail.roster.length === 1 ? '' : 's'}
            </h4>
            {detail.roster.length === 0 ? (
              <p className="text-xs text-muted">Nobody is filed on this roster, so no gift can accrue to it.</p>
            ) : (
              <div className="max-h-[22rem] overflow-auto rounded-lg border border-edge/60">
                <Table>
                  <THead>
                    <Th width="24%">Host</Th>
                    <Th>Status</Th>
                    <Th>Joined</Th>
                    <Th align="right">Their share counted</Th>
                    <Th className="pr-4">Rate applied</Th>
                  </THead>
                  <TBody>
                    {detail.roster.map((host) => (
                      <Tr key={host.membershipId}>
                        <Td>
                          <div className="flex min-w-0 items-center gap-2.5">
                            <Avatar name={host.username} src={host.avatarUrl} size="sm" />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-ink">{host.username}</p>
                              <p className="text-[11px] text-faint">{host.phone}</p>
                            </div>
                          </div>
                        </Td>
                        <Td>
                          <Badge tone={AGENCY_TONES[host.status] ?? 'slate'}>{host.status}</Badge>
                        </Td>
                        <Td className="whitespace-nowrap text-xs" title={formatDateTime(host.joinedAt)}>
                          {formatDate(host.joinedAt)}
                        </Td>
                        <Td align="right" className="tabular-nums text-xs text-ink">{formatNumber(host.accruedCoins)}</Td>
                        <Td className="pr-4">
                          <div className="min-w-[15rem]">
                            <p className="text-xs text-muted">
                              <Badge tone={SOURCE_TONES[host.effectiveSource]}>{host.effectiveSource}</Badge>
                            </p>
                            <RateEditor
                              currentBps={hostRates[host.hostUserId] ?? host.hostCommissionBps}
                              effectiveLabel={host.commissionLabel}
                              inheritNote="empty = the agency's rate, or the platform default"
                              disabled={!mayWrite}
                              onSave={async (bps) => {
                                const result = await api.setHostRate(agencyId, host.hostUserId, bps);
                                setHostRates((current) => ({ ...current, [host.hostUserId]: bps }));
                                setDetail({
                                  ...detail,
                                  roster: detail.roster.map((row) =>
                                    row.membershipId === result.host.membershipId ? result.host : row,
                                  ),
                                });
                              }}
                            />
                          </div>
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
            <p className="text-[11px] text-faint">
              A host's own rate speaks first, then the agency's, then the platform default. Changing one does not touch
              accruals already booked — they recorded the rate that was live when the gift was sent.
            </p>
          </section>

          {/* batches */}
          <section className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-faint">This agency&apos;s batches</h4>
            {detail.settlements.length === 0 ? (
              <p className="text-xs text-muted">Nothing has been claimed for this agency yet.</p>
            ) : (
              <div className="max-h-[18rem] overflow-auto rounded-lg border border-edge/60">
                <Table>
                  <THead>
                    <Th>Batch</Th>
                    <Th>Period</Th>
                    <Th align="right">Claims</Th>
                    <Th align="right">Amount</Th>
                    <Th className="pr-4">Status</Th>
                  </THead>
                  <TBody>
                    {detail.settlements.map((batch) => (
                      <Tr key={batch.id}>
                        <Td className="font-mono text-xs text-ink">{batch.reference}</Td>
                        <Td className="whitespace-nowrap text-xs">{formatDate(batch.periodFrom)} → {formatDate(batch.periodTo)}</Td>
                        <Td align="right" className="tabular-nums text-xs text-ink">{batch.entryCount}</Td>
                        <Td align="right" className="tabular-nums text-xs text-ink">{money(batch.amount, batch.currency)}</Td>
                        <Td className="pr-4">
                          <Badge tone={BATCH_TONES[batch.status] ?? 'slate'}>{batch.status}</Badge>
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
            <p className="text-[11px] text-faint">
              Approving, paying and voiding happen in the batches queue, where the operator who raised a batch can be
              seen beside the one who approved it.
            </p>
          </section>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Raise: claim a period's unsettled accruals, and freeze what the batch will pay.
// ---------------------------------------------------------------------------
function RaiseModal({
  agencies,
  initialAgencyId,
  onClose,
  onRaised,
}: {
  agencies: Agency[];
  initialAgencyId: string | null;
  onClose: () => void;
  onRaised: (settlement: AgencySettlement, replay: boolean) => void;
}) {
  const [agencyId, setAgencyId] = useState(initialAgencyId ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [method, setMethod] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // One key for this click: a retry after a lost response must return the batch that was already raised.
  const key = useMemo(() => clientKey('agency-raise'), []);

  const chosen = agencies.find((agency) => agency.id === agencyId);
  const ready = agencyId !== '' && from !== '' && to !== '';

  const submit = async () => {
    if (submitting || !ready) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await api.raiseAgencySettlement(agencyId, {
        periodFrom: new Date(`${from}T00:00:00`).toISOString(),
        periodTo: new Date(`${to}T00:00:00`).toISOString(),
        payoutMethod: method === '' ? null : method,
        idempotencyKey: key,
      });
      onRaised(result.settlement, result.replay);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Could not raise the batch.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Raise a settlement batch"
      subtitle="Everything unsettled for one agency inside one period, claimed at once."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={submitting} disabled={!ready}>
            Raise batch
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Select label="Agency" value={agencyId} onChange={(e) => setAgencyId(e.target.value)}>
          <option value="">Choose an agency…</option>
          {agencies.map((agency) => (
            <option key={agency.id} value={agency.id}>{agency.name}</option>
          ))}
        </Select>

        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Period starts (inclusive)"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            hint="Gifts accrued on this date are in the batch."
          />
          <Input
            label="Period ends (exclusive)"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            hint="The day after your last accrual. Gifts on this date belong to the next batch."
          />
        </div>

        <Select label="Payout method (optional)" value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="">Not decided yet</option>
          {PAYOUT_METHODS.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </Select>

        {chosen !== undefined && (
          <div className="rounded-lg border border-edge/60 bg-elevated/40 p-4 text-xs text-muted">
            <p>
              <span className="text-ink">{chosen.name}</span> is owed{' '}
              {chosen.account === null ? 'nothing yet' : money(chosen.account.available, chosen.account.currency)} available
              {chosen.account !== null && chosen.account.pending > 0
                ? `, of which ${money(chosen.account.pending, chosen.account.currency)} is already claimed by open batches`
                : ''}
              .
            </p>
            <p className="mt-1 text-[11px] text-faint">
              Raising claims what the gift path booked — it cannot claim it twice, and it refuses a batch that wants more
              than what is unclaimed. The batch is a DRAFT and the money is frozen until it is paid or voided.
            </p>
          </div>
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
// Approve: the second pair of eyes the batch needs before it can be paid.
// ---------------------------------------------------------------------------
function ApproveModal({
  batch,
  onClose,
  onApproved,
}: {
  batch: AgencySettlement;
  onClose: () => void;
  onApproved: (settlement: AgencySettlement) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await api.approveAgencySettlement(batch.id);
      onApproved(result.settlement);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Could not approve the batch.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Approve settlement"
      subtitle={`${batch.reference} · ${batch.agencyName}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<IconCheck className="h-4 w-4" />} onClick={() => void submit()} loading={submitting}>
            Approve
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-edge/60 bg-elevated/40 p-4">
          <p className="text-xs uppercase tracking-wider text-faint">Owed to the agency</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-300">{money(batch.amount, batch.currency)}</p>
          <p className="mt-1 text-xs text-muted">
            {batch.entryCount} accruals · {formatDate(batch.periodFrom)} → {formatDate(batch.periodTo)} · raised{' '}
            {relativeTime(batch.createdAt)} by <span className="text-ink">{batch.createdByName ?? '—'}</span>
          </p>
        </div>
        <p className="text-[11px] text-faint">
          Approval says the figures are right, not that money moved. The server requires a different operator from the one
          who raised it, and nothing here books a journal entry — that happens when the transfer is recorded.
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
// Pay: the record that money left the platform. The reference is the point of the screen.
// ---------------------------------------------------------------------------
function PayModal({
  batch,
  onClose,
  onPaid,
}: {
  batch: AgencySettlement;
  onClose: () => void;
  onPaid: (settlement: AgencySettlement, replay: boolean) => void;
}) {
  const [reference, setReference] = useState('');
  const [method, setMethod] = useState(batch.payoutMethod ?? '');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const key = useMemo(() => clientKey('agency-pay'), []);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await api.payAgencySettlement(batch.id, {
        payoutReference: reference.trim(),
        payoutMethod: method === '' ? null : method,
        note: note.trim() === '' ? null : note.trim(),
        idempotencyKey: key,
      });
      onPaid(result.settlement, result.replay);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Recording the payout failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Record an agency payout"
      subtitle={`${batch.reference} · ${batch.agencyName}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="success"
            icon={<IconCheck className="h-4 w-4" />}
            onClick={() => void submit()}
            loading={submitting}
            disabled={reference.trim().length < 3}
          >
            Mark as paid
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-edge/60 bg-elevated/40 p-4">
          <p className="text-xs uppercase tracking-wider text-faint">Transferred</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-300">{money(batch.amount, batch.currency)}</p>
          <p className="mt-1 text-xs text-muted">
            approved by <span className="text-ink">{batch.approvedByName ?? '—'}</span> · {batch.entryCount} accruals
            claimed · the freeze on the agency&apos;s account converts when this is saved
          </p>
        </div>

        <Input
          label="Bank / transfer reference"
          maxLength={120}
          placeholder="e.g. UBL-BATCH-2026-114"
          hint="Required. This is what answers the agency that asks in three weeks which transfer paid the batch, and it is the only route here that writes a journal entry."
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          autoFocus
        />

        <Select label="Method" value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="">Not recorded</option>
          {PAYOUT_METHODS.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </Select>

        <Textarea label="Note (optional)" rows={2} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />

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
// Void: un-claim the accruals and release the freeze, with a reason that survives.
// ---------------------------------------------------------------------------
function VoidModal({
  batch,
  onClose,
  onVoided,
}: {
  batch: AgencySettlement;
  onClose: () => void;
  onVoided: (settlement: AgencySettlement, replay: boolean) => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const key = useMemo(() => clientKey('agency-void'), []);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await api.voidAgencySettlement(batch.id, { reason: reason.trim(), idempotencyKey: key });
      onVoided(result.settlement, result.replay);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Could not void the batch.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Void settlement"
      subtitle={`${batch.reference} · ${batch.agencyName}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            icon={<IconClose className="h-4 w-4" />}
            onClick={() => void submit()}
            loading={submitting}
            disabled={reason.trim().length < 8}
          >
            Void batch
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-edge/60 bg-elevated/40 p-4 text-xs text-muted">
          <p>
            {batch.entryCount} accruals worth {money(batch.amount, batch.currency)} are claimed by this batch. Voiding
            returns every one of them to the unsettled pool, so a later batch can pick them up, and releases the hold
            they sit behind.
          </p>
        </div>
        <Textarea
          label="Reason (at least 8 characters)"
          rows={3}
          maxLength={200}
          placeholder="e.g. Period ends on the wrong day; re-raising with a corrected window"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <p className="text-[11px] text-faint">
          A paid batch cannot be voided — the money left the platform, and a correction is its own journal entry rather
          than an edit of this one.
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
// The accruals behind one batch — the list an agency asks for when it disputes a figure.
// ---------------------------------------------------------------------------
function EntriesModal({ settlementId, onClose }: { settlementId: string; onClose: () => void }) {
  const [settlement, setSettlement] = useState<AgencySettlement | null>(null);
  const [entries, setEntries] = useState<AgencySettlementEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .agencySettlementEntries(settlementId)
      .then((result) => {
        if (cancelled) return;
        setSettlement(result.settlement);
        setEntries(result.entries);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load the accruals.');
      });
    return () => {
      cancelled = true;
    };
  }, [settlementId]);

  const sum = entries.reduce((total, entry) => total + entry.amount, 0);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="What this batch paid"
      subtitle={settlement === null ? 'Loading…' : `${settlement.reference} · ${settlement.agencyName}`}
      footer={<Button variant="primary" onClick={onClose}>Close</Button>}
    >
      {error !== null ? (
        <EmptyState title="Could not load the accruals" message={error} icon={<IconAlert className="h-6 w-6" />} />
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border border-edge/60 bg-elevated/40 p-3 text-xs">
            <p className="text-muted">
              Stated <span className="font-semibold text-ink">{settlement === null ? '—' : money(settlement.amount, settlement.currency)}</span>{' '}
              · entries sum to <span className="font-semibold text-ink">{money(sum, settlement?.currency ?? 'pkr')}</span>
            </p>
            {settlement !== null && sum === settlement.amount ? (
              <p className="mt-1 text-[11px] text-emerald-300">
                They agree: the batch pays exactly what its claims add up to, and each claim is one booked gift share.
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-amber-300">
                They differ, which the reconciler reports as a claim mismatch. Nothing has been paid twice here — re-read
                the batch.
              </p>
            )}
          </div>

          {entries.length === 0 ? (
            <p className="text-xs text-muted">No accruals are claimed by this batch.</p>
          ) : (
            <div className="max-h-[26rem] overflow-auto rounded-lg border border-edge/60">
              <Table>
                <THead>
                  <Th width="18%">Entry</Th>
                  <Th>Occurred</Th>
                  <Th align="right">Amount</Th>
                  <Th className="pr-4">Gift share</Th>
                </THead>
                <TBody>
                  {entries.map((entry) => (
                    <Tr key={entry.reference}>
                      <Td className="font-mono text-[11px] text-ink">{entry.reference}</Td>
                      <Td className="whitespace-nowrap text-[11px]">{formatDateTime(entry.occurredAt)}</Td>
                      <Td align="right" className="tabular-nums text-xs text-ink">{money(entry.amount, entry.currency)}</Td>
                      <Td className="pr-4">
                        <p className="line-clamp-2 text-[11px] text-muted" title={entry.memo ?? entry.sourceId}>
                          {entry.memo ?? 'no memo'}
                        </p>
                        <p className="font-mono text-[10px] text-faint">{entry.sourceId}</p>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
          <p className="text-[11px] text-faint">
            Each row names the commission ledger transaction the share was counted from — the same reference the
            agency&apos;s statement carries.
          </p>
        </div>
      )}
    </Modal>
  );
}
