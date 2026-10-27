// ---------------------------------------------------------------------------
// The book (§25): the double-entry journal behind the coin ledger, and the daily
// cross-check that proves the two still agree.
//
// Two ideas the page has to keep straight for an operator.
//
// First, the face value of coins issued is not revenue. Cash arrives in
// PROVIDER_COLLECTIONS, the coins the platform still owes the holder sit in COIN_LIABILITY,
// and only the net after provider fees and commission becomes PLATFORM_REVENUE. A trial balance
// that pretends otherwise would overstate the business by every unredeemed coin.
//
// Second, the reconciliation report is not a summary of what the services said. Each check is a
// count of offending rows read straight out of the tables, so a zero means "I looked for a
// violation and could not find one", and a non-zero is a number you can go and query.
// ---------------------------------------------------------------------------
import { Fragment, useCallback, useEffect, useState } from 'react';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, StatCard } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { IconAlert, IconBook, IconCheck, IconClose, IconDownload, IconRefresh } from '../components/ui/Icons';
import { Pagination } from '../components/ui/Pagination';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { Tabs } from '../components/ui/Tabs';
import { useToast } from '../components/ui/Toast';
import { ApiError, api } from '../lib/api';
import { formatCents, formatDateTime, formatNumber, relativeTime } from '../lib/format';
import type { FinAccount, JournalEntry, ReconciliationReport, TrialBalance } from '../types';

const KIND_TONES: Record<string, BadgeTone> = {
  ASSET: 'sky',
  LIABILITY: 'amber',
  REVENUE: 'green',
  EXPENSE: 'red',
  EQUITY: 'violet',
};

const SOURCE_KINDS = ['RECHARGE_ORDER', 'COMMISSION_ACCRUAL', 'SETTLEMENT', 'REVERSAL', 'ADJUSTMENT'];

export default function FinancePage() {
  const toast = useToast();
  const [tab, setTab] = useState('recon');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [trial, setTrial] = useState<TrialBalance | null>(null);
  const [accounts, setAccounts] = useState<FinAccount[]>([]);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [journalFilter, setJournalFilter] = useState<{ sourceKind: string; accountCode: string; sourceId: string }>({ sourceKind: '', accountCode: '', sourceId: '' });
  const [expanded, setExpanded] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const dateRange = useCallback((): { from?: string; to?: string } => {
    const parsed: { from?: string; to?: string } = {};
    if (from !== '') parsed.from = new Date(`${from}T00:00:00`).toISOString();
    if (to !== '') parsed.to = new Date(`${to}T23:59:59`).toISOString();
    return parsed;
  }, [from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const range = dateRange();
      const [recon, balance, chart, journal] = await Promise.all([
        api.reconciliation(range),
        api.trialBalance(range),
        api.finAccounts(),
        api.journal({
          sourceKind: journalFilter.sourceKind === '' ? undefined : journalFilter.sourceKind,
          accountCode: journalFilter.accountCode === '' ? undefined : journalFilter.accountCode,
          sourceId: journalFilter.sourceId === '' ? undefined : journalFilter.sourceId.trim(),
          ...range,
          page,
          limit: 25,
        }),
      ]);
      setReport(recon);
      setTrial(balance.trial);
      setAccounts(chart.accounts);
      setEntries(journal.entries);
      setTotal(journal.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the book.');
    } finally {
      setLoading(false);
    }
  }, [dateRange, journalFilter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await api.downloadReconciliationCsv(dateRange());
      toast.success('Reconciliation CSV downloaded.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The export failed.');
    } finally {
      setExporting(false);
    }
  };

  const breached = report?.breached ?? 0;

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-ink">
            <IconBook className="h-5 w-5 text-violet-300" />
            Finance book
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            Collections, coin liability, fees, commission and revenue — one entry per event, and it always balances.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input label="From" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="w-40" />
          <Input label="To" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="w-40" />
          <Button icon={<IconDownload className="h-4 w-4" />} onClick={() => void exportCsv()} loading={exporting}>
            Export report
          </Button>
          <Button icon={<IconRefresh className="h-4 w-4" />} onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Reconciliation"
          value={report === null ? '—' : breached === 0 ? 'All clear' : `${breached} breached`}
          sub={report === null ? 'running checks' : `${report.passed} of ${report.checks.length} checks passed`}
          tone={breached === 0 ? 'emerald' : 'rose'}
          icon={breached === 0 ? <IconCheck className="h-5 w-5" /> : <IconAlert className="h-5 w-5" />}
        />
        <StatCard
          label="Trial balance"
          value={trial === null ? '—' : trial.balanced ? 'Balanced' : 'Out'}
          sub={trial === null ? '' : `debits ${formatCents(trial.totalDebits, 'pkr')}`}
          tone={trial?.balanced ? 'emerald' : 'rose'}
        />
        <StatCard label="Journal entries" value={formatNumber(total)} sub="in this window and filter" tone="violet" />
        <StatCard label="Accounts" value={formatNumber(accounts.length)} sub="chart of accounts" tone="sky" />
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        items={[
          { id: 'recon', label: 'Reconciliation', count: report?.checks.length, alert: breached > 0 },
          { id: 'trial', label: 'Trial balance' },
          { id: 'chart', label: 'Chart of accounts', count: accounts.length },
          { id: 'journal', label: 'Journal', count: total },
        ]}
      />

      {error !== null && (
        <Card>
          <EmptyState title="Could not load the book" message={error} icon={<IconAlert className="h-6 w-6" />} action={<Button onClick={() => void load()}>Retry</Button>} />
        </Card>
      )}

      {loading && report === null && error === null && (
        <Card>
          <div className="grid h-48 place-items-center text-violet-300">
            <Spinner className="h-8 w-8" />
          </div>
        </Card>
      )}

      {error === null && !loading && tab === 'recon' && report !== null && (
        <Card bodyClassName="p-0" title="Automated tie-outs" subtitle={`Generated ${formatDateTime(report.generatedAt)} · range ${report.range.from ? formatDateTime(report.range.from) : 'beginning'} → ${report.range.to ? formatDateTime(report.range.to) : 'now'}`}>
          <Table>
            <THead>
              <Th width="16%">Domain</Th>
              <Th>Check</Th>
              <Th>Unit</Th>
              <Th>Expected</Th>
              <Th align="right">Found</Th>
              <Th align="right" className="pr-4">Result</Th>
            </THead>
            <TBody>
              {report.checks.map((check) => (
                <Tr key={check.key}>
                  <Td>
                    <Badge tone={KIND_TONES[check.domain] ?? 'slate'}>{check.domain}</Badge>
                  </Td>
                  <Td>
                    <p className="text-sm text-ink">{check.label}</p>
                    <p className="font-mono text-[11px] text-faint">{check.key}</p>
                  </Td>
                  <Td className="text-xs text-muted">{check.unit}</Td>
                  <Td className="text-xs text-muted">{check.expected}</Td>
                  <Td align="right" className={`font-bold tabular-nums ${check.passed ? 'text-ink' : 'text-rose-300'}`}>
                    {formatNumber(check.breaches)}
                  </Td>
                  <Td align="right" className="pr-4">
                    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${check.passed ? 'text-emerald-300' : 'text-rose-300'}`}>
                      {check.passed ? <IconCheck className="h-4 w-4" /> : <IconClose className="h-4 w-4" />}
                      {check.passed ? 'pass' : 'breach'}
                    </span>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          <p className="border-t border-edge/60 px-4 py-3 text-[11px] leading-relaxed text-faint">
            Every check counts rows that violate its rule, so a breach number is directly queryable. A pass is not proof that the business is healthy — it
            is proof that these particular tie-outs hold for this window.
          </p>
        </Card>
      )}

      {error === null && !loading && tab === 'trial' && trial !== null && (
        <Card bodyClassName="p-0" title="Trial balance" subtitle="Sum of every debit line equals the sum of every credit line, or the book has a hole in it.">
          <Table>
            <THead>
              <Th>Code</Th>
              <Th>Account</Th>
              <Th>Kind</Th>
              <Th align="right">Debits</Th>
              <Th align="right">Credits</Th>
              <Th align="right">Balance</Th>
            </THead>
            <TBody>
              {trial.accounts.map((row) => (
                <Tr key={row.code}>
                  <Td className="font-mono text-xs text-ink">{row.code}</Td>
                  <Td className="text-sm text-muted">{row.name}</Td>
                  <Td>
                    <Badge tone={KIND_TONES[row.kind] ?? 'slate'}>{row.kind}</Badge>
                  </Td>
                  <Td align="right" className="tabular-nums text-xs">
                    {row.debits === 0 ? <span className="text-faint">—</span> : formatCents(row.debits, 'pkr')}
                  </Td>
                  <Td align="right" className="tabular-nums text-xs">
                    {row.credits === 0 ? <span className="text-faint">—</span> : formatCents(row.credits, 'pkr')}
                  </Td>
                  <Td align="right" className="font-semibold tabular-nums text-xs text-ink">
                    {formatCents(row.balance, 'pkr')}
                  </Td>
                </Tr>
              ))}
              <Tr>
                <Td colSpan={3}>
                  <span className="text-xs font-semibold uppercase tracking-wider text-faint">Totals</span>
                </Td>
                <Td align="right" className="border-t border-edge font-bold tabular-nums text-ink">
                  {formatCents(trial.totalDebits, 'pkr')}
                </Td>
                <Td align="right" className="border-t border-edge font-bold tabular-nums text-ink">
                  {formatCents(trial.totalCredits, 'pkr')}
                </Td>
                <Td align="right" className="border-t border-edge pr-4">
                  <Badge tone={trial.balanced ? 'green' : 'red'}>{trial.balanced ? 'balanced' : 'out of balance'}</Badge>
                </Td>
              </Tr>
            </TBody>
          </Table>
          <p className="border-t border-edge/60 px-4 py-3 text-[11px] leading-relaxed text-faint">
            Balances are shown on each account's normal side. COIN_LIABILITY is the face value of coins in circulation and is a liability, not revenue;
            PLATFORM_REVENUE only ever carries what remained after provider fees and commission.
          </p>
        </Card>
      )}

      {error === null && !loading && tab === 'chart' && (
        <Card bodyClassName="p-0" title="Chart of accounts" subtitle="Seeded by migration and read-only here: a code is a reference a journal line points at, so it is never renamed in place.">
          <Table>
            <THead>
              <Th>Code</Th>
              <Th>Name</Th>
              <Th>Kind</Th>
              <Th>Normal side</Th>
              <Th>Currency</Th>
            </THead>
            <TBody>
              {accounts.map((row) => (
                <Tr key={row.code}>
                  <Td className="font-mono text-xs text-ink">{row.code}</Td>
                  <Td className="text-sm text-muted">{row.name}</Td>
                  <Td>
                    <Badge tone={KIND_TONES[row.kind] ?? 'slate'}>{row.kind}</Badge>
                  </Td>
                  <Td className="text-xs text-muted">{row.normal_side}</Td>
                  <Td className="text-xs text-muted">{row.currency}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          {accounts.length === 0 && <EmptyState title="No accounts" message="The chart is created by the finance migration." icon={<IconBook className="h-6 w-6" />} />}
        </Card>
      )}

      {error === null && !loading && tab === 'journal' && (
        <Card bodyClassName="p-0">
          <div className="flex flex-wrap items-end gap-3 border-b border-edge/60 p-4">
            <Select label="Source" value={journalFilter.sourceKind} onChange={(e) => { setJournalFilter((f) => ({ ...f, sourceKind: e.target.value })); setPage(1); }} className="w-52">
              <option value="">Any source</option>
              {SOURCE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
            <Select label="Account" value={journalFilter.accountCode} onChange={(e) => { setJournalFilter((f) => ({ ...f, accountCode: e.target.value })); setPage(1); }} className="w-56">
              <option value="">Any account</option>
              {accounts.map((row) => (
                <option key={row.code} value={row.code}>
                  {row.code} · {row.name}
                </option>
              ))}
            </Select>
            <Input
              label="Source id"
              placeholder="order or batch id"
              value={journalFilter.sourceId}
              onChange={(e) => setJournalFilter((f) => ({ ...f, sourceId: e.target.value }))}
              className="w-64"
            />
            <Button
              className="mb-0.5"
              onClick={() => {
                setJournalFilter((f) => ({ ...f, sourceId: f.sourceId.trim() }));
                setPage(1);
              }}
            >
              Apply
            </Button>
          </div>
          {entries.length === 0 ? (
            <EmptyState title="No entries" message="Nothing posted in this window, or the filter is too narrow." icon={<IconBook className="h-6 w-6" />} />
          ) : (
            <>
              <Table>
                <THead>
                  <Th>Reference</Th>
                  <Th>Source</Th>
                  <Th>Memo</Th>
                  <Th>Occurred</Th>
                  <Th align="right">Value</Th>
                  <Th align="right" className="pr-4">
                    Lines
                  </Th>
                </THead>
                <TBody>
                  {entries.map((entry) => {
                    const value = entry.lines.reduce((sum, line) => sum + (line.direction === 'DEBIT' ? line.amountCents : 0), 0);
                    const open = expanded === entry.id;
                    return (
                      <Fragment key={entry.id}>
                        <Tr key={entry.id} onClick={() => setExpanded(open ? null : entry.id)} className="cursor-pointer">
                          <Td className="font-mono text-[11px] text-violet-200">{entry.reference}</Td>
                          <Td>
                            <Badge tone={KIND_TONES[entry.sourceKind] ?? 'slate'}>{entry.sourceKind.replace(/_/g, ' ')}</Badge>
                            <p className="mt-1 font-mono text-[10px] text-faint" title={entry.sourceId}>
                              {entry.sourceId.slice(0, 18)}
                            </p>
                          </Td>
                          <Td className="max-w-64 truncate text-xs text-muted" title={entry.memo ?? undefined}>
                            {entry.memo ?? '—'}
                          </Td>
                          <Td className="whitespace-nowrap text-xs text-muted" title={formatDateTime(entry.occurredAt)}>
                            {relativeTime(entry.occurredAt)}
                          </Td>
                          <Td align="right" className="font-semibold tabular-nums text-xs text-ink">
                            {formatCents(value, entry.currency)}
                          </Td>
                          <Td align="right" className="pr-4 text-xs text-muted">
                            {open ? 'hide' : `${entry.lines.length} ▸`}
                          </Td>
                        </Tr>
                        {open && (
                          <tr>
                            <td colSpan={6} className="border-t border-edge/60 bg-base/50 px-4 py-3">
                              <div className="grid gap-1.5 sm:grid-cols-2">
                                {entry.lines.map((line, index) => (
                                  <div key={`${line.accountCode}-${index}`} className="flex items-center gap-3 rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2">
                                    <span className={`w-14 shrink-0 text-[11px] font-bold ${line.direction === 'DEBIT' ? 'text-sky-300' : 'text-amber-300'}`}>
                                      {line.direction === 'DEBIT' ? 'Dr' : 'Cr'}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-xs text-ink">
                                      {line.accountName} <span className="font-mono text-[10px] text-faint">{line.accountCode}</span>
                                    </span>
                                    <span className="shrink-0 text-xs font-semibold tabular-nums text-ink">{formatCents(line.amountCents, entry.currency)}</span>
                                  </div>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </TBody>
              </Table>
              <div className="px-4">
                <Pagination page={page} limit={25} total={total} onChange={setPage} />
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
