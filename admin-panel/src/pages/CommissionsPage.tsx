// ---------------------------------------------------------------------------
// Commission (§22): the rates, what they produced, and the batches that pay them.
//
// Three things this page must never let an operator forget.
//
// 1. A rate change is a new version, not an edit. The server copies the rule set forward and
//    stamps the version onto every order at open time, so a rule edited here cannot retroactively
//    change what an earlier order owed. The UI therefore only ever offers "new version".
// 2. The order the kinds are applied in, and the ceiling on the total, are one switch set. They
//    decide how much of a collection can be spoken for; §22 says the administrator defines both.
// 3. Settlement only picks up what is already accrued inside a period. If the batch is empty the
//    server says so — this page does not let anyone type a number instead.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  IconClose,
  IconCommission,
  IconPlus,
  IconRefresh,
  IconSliders,
} from '../components/ui/Icons';
import { Modal } from '../components/ui/Modal';
import { Pagination } from '../components/ui/Pagination';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { Tabs } from '../components/ui/Tabs';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../context/AuthContext';
import { ApiError, api } from '../lib/api';
import { formatBps, formatCents, formatDateTime, formatNumber, parseUnsignedInt, relativeTime } from '../lib/format';
import type {
  PartnerRef,
  CommissionBeneficiary,
  CommissionConfig,
  CommissionEntry,
  CommissionRule,
  CommissionRuleKind,
  CommissionSettlement,
  CommissionSummary,
  CommissionTier,
} from '../types';

const KIND_LABELS: Record<CommissionRuleKind, string> = {
  SELLER_PERCENT: 'Seller % of net',
  SELLER_FIXED: 'Seller fixed per order',
  SELLER_TIER: 'Seller volume tier',
  BD_PERCENT: 'BD % of net',
  BD_FIXED: 'BD fixed per order',
};

const RULE_TONES: Record<string, BadgeTone> = {
  SELLER_PERCENT: 'fuchsia',
  SELLER_FIXED: 'fuchsia',
  SELLER_TIER: 'pink',
  BD_PERCENT: 'sky',
  BD_FIXED: 'sky',
};

const ENTRY_TONES: Record<string, BadgeTone> = {
  ACCRUED: 'amber',
  SETTLED: 'green',
  REVERSED: 'red',
  PAID: 'green',
  DRAFT: 'slate',
  APPROVED: 'sky',
  VOID: 'slate',
};

export default function CommissionsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const manage = can('commission:manage');

  const [tab, setTab] = useState('rules');

  const [rules, setRules] = useState<CommissionRule[]>([]);
  const [ruleFilter, setRuleFilter] = useState<{ beneficiary: string; kind: string; includeInactive: boolean }>({
    beneficiary: '',
    kind: '',
    includeInactive: false,
  });

  const [partners, setPartners] = useState<PartnerRef[]>([]);
  const [entries, setEntries] = useState<CommissionEntry[] | null>(null);
  const [entryTotal, setEntryTotal] = useState(0);
  const [entryPage, setEntryPage] = useState(1);
  const [entryFilter, setEntryFilter] = useState<{ beneficiaryId: string; status: string }>({ beneficiaryId: '', status: 'ACCRUED' });
  const [summary, setSummary] = useState<CommissionSummary | null>(null);

  const [settlements, setSettlements] = useState<CommissionSettlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [ruleTarget, setRuleTarget] = useState<CommissionRule | 'new' | null>(null);
  const [retireTarget, setRetireTarget] = useState<CommissionRule | null>(null);
  const [settlementTarget, setSettlementTarget] = useState<CommissionSettlement | null>(null);
  const [creatingSettlement, setCreatingSettlement] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ruleList, entryList, settlementList, partnerList] = await Promise.all([
        api.commissionRules({
          beneficiary: ruleFilter.beneficiary === '' ? undefined : ruleFilter.beneficiary,
          kind: ruleFilter.kind === '' ? undefined : ruleFilter.kind,
          includeInactive: ruleFilter.includeInactive,
        }),
        api.commissionEntries({
          beneficiaryId: entryFilter.beneficiaryId === '' ? undefined : entryFilter.beneficiaryId,
          status: entryFilter.status === '' ? undefined : entryFilter.status,
          page: entryPage,
          limit: 25,
        }),
        api.commissionSettlements({ limit: 50 }),
        api.partnerRoster(),
      ]);
      setRules(ruleList.rules);
      setEntries(entryList.entries);
      setEntryTotal(entryList.total);
      setSettlements(settlementList.settlements);
      setPartners(partnerList.partners);
    } catch (err) {
      setEntries([]);
      setError(err instanceof ApiError ? err.message : 'Failed to load the commission books.');
    } finally {
      setLoading(false);
    }
  }, [ruleFilter, entryFilter, entryPage]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (entryFilter.beneficiaryId === '') {
      setSummary(null);
      return;
    }
    let cancelled = false;
    api
      .commissionSummary(entryFilter.beneficiaryId)
      .then((result) => {
        if (!cancelled) setSummary(result.summary);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [entryFilter.beneficiaryId, entries]);

  const partnerName = useCallback(
    (id: string | null | undefined): string => {
      if (!id) return 'any partner';
      const found = partners.find((row) => row.id === id);
      return found ? `${found.code} · ${found.displayName}` : id.slice(0, 8);
    },
    [partners],
  );

  const openDraft = useMemo(() => settlements.filter((row) => row.status === 'DRAFT').length, [settlements]);
  const accruedTotal = useMemo(() => (entries ?? []).reduce((sum, row) => sum + (row.status === 'ACCRUED' ? row.amountCents : 0), 0), [entries]);

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-ink">
            <IconCommission className="h-5 w-5 text-violet-300" />
            Commission
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            Rates are versioned, accruals follow the order they were earned on, and settlement pays a batch — never a hand-typed number.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {manage && (
            <Button variant="primary" icon={<IconPlus className="h-4 w-4" />} onClick={() => setRuleTarget('new')}>
              New rule version
            </Button>
          )}
          <Button icon={<IconRefresh className="h-4 w-4" />} onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Live rules" value={formatNumber(rules.filter((row) => row.isActive).length)} sub={`${rules.length} shown with this filter`} />
        <StatCard label="Accrued on page" value={formatCents(accruedTotal, 'pkr')} sub="earned, not yet settled" tone="amber" />
        <StatCard label="Settlement drafts" value={formatNumber(openDraft)} sub={openDraft > 0 ? 'awaiting approval' : 'nothing waiting'} tone={openDraft > 0 ? 'sky' : 'emerald'} />
        <StatCard label="Partners" value={formatNumber(partners.length)} sub="sellers and BD accounts" tone="fuchsia" />
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        items={[
          { id: 'rules', label: 'Rates', count: rules.length },
          { id: 'accruals', label: 'Accruals', count: entryTotal },
          { id: 'settlements', label: 'Settlements', count: settlements.length, alert: openDraft > 0 },
          { id: 'engine', label: 'Calculation order' },
        ]}
      />

      {error !== null && (
        <Card>
          <EmptyState title="Could not load commission" message={error} icon={<IconAlert className="h-6 w-6" />} action={<Button onClick={() => void load()}>Retry</Button>} />
        </Card>
      )}

      {loading && rules.length === 0 && error === null ? (
        <Card>
          <div className="grid h-48 place-items-center text-violet-300">
            <Spinner className="h-8 w-8" />
          </div>
        </Card>
      ) : null}

      {error === null && !loading && tab === 'rules' && (
        <Card bodyClassName="p-0" title="Rule versions" subtitle="Saving creates a new version and closes the previous one at that date. Nothing is overwritten.">
          <div className="flex flex-wrap items-end gap-3 border-b border-edge/60 p-4">
            <Select
              label="Beneficiary"
              value={ruleFilter.beneficiary}
              onChange={(e) => setRuleFilter((f) => ({ ...f, beneficiary: e.target.value }))}
              className="w-40"
            >
              <option value="">Any</option>
              <option value="SELLER">Seller</option>
              <option value="BD">BD</option>
            </Select>
            <Select label="Kind" value={ruleFilter.kind} onChange={(e) => setRuleFilter((f) => ({ ...f, kind: e.target.value }))} className="w-52">
              <option value="">Any kind</option>
              {(Object.keys(KIND_LABELS) as CommissionRuleKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </Select>
            <label className="flex items-center gap-2 pb-2 text-xs text-muted">
              <Switch
                label="Include retired versions"
                checked={ruleFilter.includeInactive}
                onChange={(includeInactive) => setRuleFilter((f) => ({ ...f, includeInactive }))}
              />
              Include retired
            </label>
          </div>
          {rules.length === 0 ? (
            <EmptyState
              title="No rules"
              message="Until a rule exists, an order accrues nothing. Start with a platform-wide percentage and narrow it per partner."
              icon={<IconCommission className="h-6 w-6" />}
              action={manage ? <Button variant="primary" onClick={() => setRuleTarget('new')}>New rule version</Button> : undefined}
            />
          ) : (
            <Table>
              <THead>
                <Th>Kind</Th>
                <Th>Applies to</Th>
                <Th align="right">Rate</Th>
                <Th>Order band</Th>
                <Th align="center">Version</Th>
                <Th>Effective</Th>
                <Th>Status</Th>
                <Th align="right" className="pr-4" />
              </THead>
              <TBody>
                {rules.map((rule) => (
                  <Tr key={rule.id}>
                    <Td>
                      <Badge tone={RULE_TONES[rule.kind] ?? 'slate'}>{KIND_LABELS[rule.kind] ?? rule.kind}</Badge>
                    </Td>
                    <Td className="text-xs text-ink">{rule.appliesToId ? partnerName(rule.appliesToId) : 'every account of that side'}</Td>
                    <Td align="right" className="tabular-nums text-xs">
                      {rule.percentBps !== null && <span className="font-semibold text-ink">{formatBps(rule.percentBps)}</span>}
                      {rule.fixedCents !== null && <span className="font-semibold text-ink">{formatCents(rule.fixedCents, rule.currency)}</span>}
                      {rule.tiers !== null && <span className="text-violet-200">{rule.tiers.length} tiers</span>}
                    </Td>
                    <Td className="text-[11px] text-muted">
                      {rule.minOrderCents === null && rule.maxOrderCents === null ? (
                        <span className="text-faint">any order size</span>
                      ) : (
                        <>
                          {rule.minOrderCents !== null ? formatCents(rule.minOrderCents, rule.currency) : '0'} –{' '}
                          {rule.maxOrderCents !== null ? formatCents(rule.maxOrderCents, rule.currency) : '∞'}
                        </>
                      )}
                    </Td>
                    <Td align="center" className="tabular-nums text-xs text-muted">
                      v{rule.rulesVersion}
                    </Td>
                    <Td className="whitespace-nowrap text-[11px] text-muted" title={`${formatDateTime(rule.effectiveFrom)} → ${rule.effectiveTo ? formatDateTime(rule.effectiveTo) : 'open'}`}>
                      {relativeTime(rule.effectiveFrom)}
                      {rule.effectiveTo ? ` → ${relativeTime(rule.effectiveTo)}` : ' → open'}
                    </Td>
                    <Td>
                      <Badge tone={rule.isActive ? 'green' : 'slate'}>{rule.isActive ? 'live' : 'retired'}</Badge>
                    </Td>
                    <Td align="right" className="pr-4">
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => setRuleTarget(rule)}>
                          Copy
                        </Button>
                        {manage && rule.isActive && (
                          <Button size="sm" variant="danger" onClick={() => setRetireTarget(rule)}>
                            Retire
                          </Button>
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

      {error === null && !loading && tab === 'accruals' && (
        <>
          {summary !== null && (
            <div className="grid gap-3 sm:grid-cols-4">
              <StatCard label="Accrued" value={formatCents(summary.accruedCents, summary.currency)} sub="waiting to be settled" tone="amber" />
              <StatCard label="Settled" value={formatCents(summary.settledCents, summary.currency)} sub="included in a batch" tone="emerald" />
              <StatCard label="Reversed" value={formatCents(summary.reversedCents, summary.currency)} sub="taken back on a reversal" tone="rose" />
              <StatCard label="Entries" value={formatNumber(summary.entryCount)} sub="for this partner" tone="violet" />
            </div>
          )}
          <Card bodyClassName="p-0">
            <div className="flex flex-wrap items-end gap-3 border-b border-edge/60 p-4">
              <Select
                label="Beneficiary"
                value={entryFilter.beneficiaryId}
                onChange={(e) => {
                  setEntryFilter((f) => ({ ...f, beneficiaryId: e.target.value }));
                  setEntryPage(1);
                }}
                className="w-64"
              >
                <option value="">All partners</option>
                {partners.map((partner) => (
                  <option key={partner.id} value={partner.id}>
                    {partner.code} · {partner.displayName}
                  </option>
                ))}
              </Select>
              <Select
                label="Status"
                value={entryFilter.status}
                onChange={(e) => {
                  setEntryFilter((f) => ({ ...f, status: e.target.value }));
                  setEntryPage(1);
                }}
                className="w-40"
              >
                <option value="">Any</option>
                <option value="ACCRUED">Accrued</option>
                <option value="SETTLED">Settled</option>
                <option value="REVERSED">Reversed</option>
              </Select>
            </div>
            {(entries ?? []).length === 0 ? (
              <EmptyState title="No accruals" message="Commission appears here after a recharge order is credited." icon={<IconCommission className="h-6 w-6" />} />
            ) : (
              <>
                <Table>
                  <THead>
                    <Th>Order</Th>
                    <Th>Beneficiary</Th>
                    <Th>Kind</Th>
                    <Th align="right">Basis</Th>
                    <Th align="right">Earned</Th>
                    <Th>Status</Th>
                    <Th>Created</Th>
                  </THead>
                  <TBody>
                    {(entries ?? []).map((row) => (
                      <Tr key={row.id}>
                        <Td className="font-mono text-[11px] text-violet-200">{row.orderReference}</Td>
                        <Td>
                          <p className="text-xs font-semibold text-ink">{row.beneficiaryName ?? partnerName(row.beneficiaryId)}</p>
                          <p className="text-[11px] text-faint">
                            {row.beneficiary}
                            {row.beneficiaryCode ? ` · ${row.beneficiaryCode}` : ''}
                          </p>
                        </Td>
                        <Td>
                          <Badge tone={RULE_TONES[row.kind] ?? 'slate'}>{KIND_LABELS[row.kind] ?? row.kind}</Badge>
                          <span className="ml-2 text-[11px] text-faint">v{row.ruleVersion}</span>
                        </Td>
                        <Td align="right" className="tabular-nums text-xs text-muted">
                          {formatCents(row.basisCents, row.currency)}
                        </Td>
                        <Td align="right" className="font-semibold tabular-nums text-xs text-ink">
                          {formatCents(row.amountCents, row.currency)}
                        </Td>
                        <Td>
                          <Badge tone={ENTRY_TONES[row.status] ?? 'slate'}>{row.status}</Badge>
                          {row.status === 'REVERSED' && row.reversalReason && (
                            <p className="mt-1 max-w-40 truncate text-[11px] text-rose-300" title={row.reversalReason}>
                              {row.reversalReason}
                            </p>
                          )}
                          {row.settlementReference && <p className="mt-1 font-mono text-[11px] text-faint">{row.settlementReference}</p>}
                        </Td>
                        <Td className="whitespace-nowrap text-xs text-muted" title={formatDateTime(row.createdAt)}>
                          {relativeTime(row.createdAt)}
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
                <div className="px-4">
                  <Pagination page={entryPage} limit={25} total={entryTotal} onChange={setEntryPage} />
                </div>
              </>
            )}
          </Card>
        </>
      )}

      {error === null && !loading && tab === 'settlements' && (
        <Card
          bodyClassName="p-0"
          title="Settlement batches"
          subtitle="A batch is created from what is accrued inside a period, approved, then marked paid. Each step writes its own journal entry."
          actions={manage ? <Button size="sm" variant="primary" icon={<IconPlus className="h-4 w-4" />} onClick={() => setCreatingSettlement(true)}>New batch</Button> : undefined}
        >
          {settlements.length === 0 ? (
            <EmptyState title="No batches yet" message="Nothing has been grouped for payment." icon={<IconCommission className="h-6 w-6" />} />
          ) : (
            <Table>
              <THead>
                <Th>Reference</Th>
                <Th>Beneficiary</Th>
                <Th>Period</Th>
                <Th align="right">Entries</Th>
                <Th align="right">Amount</Th>
                <Th>Status</Th>
                <Th>Payout</Th>
                <Th align="right" className="pr-4" />
              </THead>
              <TBody>
                {settlements.map((row) => (
                  <Tr key={row.id}>
                    <Td className="font-mono text-[11px] text-violet-200">{row.reference}</Td>
                    <Td>
                      <p className="text-xs text-ink">{partnerName(row.beneficiaryId)}</p>
                      <p className="text-[11px] text-faint">{row.beneficiary}</p>
                    </Td>
                    <Td className="text-[11px] text-muted" title={`${formatDateTime(row.periodFrom)} → ${formatDateTime(row.periodTo)}`}>
                      {relativeTime(row.periodFrom)} → {relativeTime(row.periodTo)}
                    </Td>
                    <Td align="right" className="tabular-nums text-xs">
                      {row.entryCount}
                    </Td>
                    <Td align="right" className="font-semibold tabular-nums text-xs text-ink">
                      {formatCents(row.amountCents, row.currency)}
                    </Td>
                    <Td>
                      <Badge tone={ENTRY_TONES[row.status] ?? 'slate'}>{row.status}</Badge>
                      {row.paidAt && <p className="mt-1 text-[11px] text-faint">{relativeTime(row.paidAt)}</p>}
                    </Td>
                    <Td className="text-[11px] text-muted">{row.payoutMethod ?? '—'}</Td>
                    <Td align="right" className="pr-4">
                      {manage && (row.status === 'DRAFT' || row.status === 'APPROVED' || row.status === 'VOID') ? (
                        <div className="flex justify-end gap-1.5">
                          {row.status === 'DRAFT' && (
                            <Button size="sm" variant="secondary" onClick={() => setSettlementTarget(row)}>
                              Approve
                            </Button>
                          )}
                          {row.status === 'APPROVED' && (
                            <Button size="sm" variant="success" onClick={() => setSettlementTarget(row)}>
                              Mark paid
                            </Button>
                          )}
                          {row.status === 'VOID' && <span className="text-[11px] text-faint">void — re-accrue first</span>}
                        </div>
                      ) : (
                        <span className="block text-right text-[11px] text-faint">{row.status === 'PAID' ? 'paid' : '—'}</span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      )}

      {error === null && !loading && tab === 'engine' && <EngineSwitches canWrite={can('config:manage')} />}

      {ruleTarget !== null && (
        <RuleModal
          source={ruleTarget === 'new' ? null : ruleTarget}
          partners={partners}
          onClose={() => setRuleTarget(null)}
          onSaved={(rule) => {
            setRules((current) => [rule, ...current]);
            setRuleTarget(null);
            toast.success(`${KIND_LABELS[rule.kind]} saved as version ${rule.rulesVersion}.`);
            void load();
          }}
        />
      )}
      {retireTarget !== null && (
        <RetireModal
          rule={retireTarget}
          onClose={() => setRetireTarget(null)}
          onRetired={(rule) => {
            setRules((current) => current.map((row) => (row.id === rule.id ? rule : row)));
            setRetireTarget(null);
            toast.success(`Version ${rule.rulesVersion} retired. Accruals already made stay as they were.`);
          }}
        />
      )}
      {creatingSettlement && (
        <SettlementModal
          partners={partners}
          onClose={() => setCreatingSettlement(false)}
          onCreated={(batch) => {
            setSettlements((current) => [batch, ...current]);
            setCreatingSettlement(false);
            toast.success(`${batch.reference} drafted with ${batch.entryCount} entries.`);
            void load();
          }}
        />
      )}
      {settlementTarget !== null && (
        <SettlementActionModal
          batch={settlementTarget}
          onClose={() => setSettlementTarget(null)}
          onDone={(batch, verb) => {
            setSettlements((current) => current.map((row) => (row.id === batch.id ? batch : row)));
            setSettlementTarget(null);
            toast.success(`${batch.reference} ${verb}.`);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One rule version. Money fields are shown or hidden by kind so a percentage
// rule cannot silently carry a fixed amount that the engine would ignore.
// ---------------------------------------------------------------------------
function RuleModal({
  source,
  partners,
  onClose,
  onSaved,
}: {
  source: CommissionRule | null;
  partners: PartnerRef[];
  onClose: () => void;
  onSaved: (rule: CommissionRule) => void;
}) {
  const [kind, setKind] = useState<CommissionRuleKind>(source?.kind ?? 'SELLER_PERCENT');
  const [appliesToId, setAppliesToId] = useState(source?.appliesToId ?? '');
  const [percentBps, setPercentBps] = useState(String(source?.percentBps ?? 500));
  const [fixedCents, setFixedCents] = useState(String(source?.fixedCents ?? 0));
  const [tiers, setTiers] = useState<CommissionTier[]>(source?.tiers ?? [{ uptoCents: 100000, percentBps: 500 }]);
  const [minOrder, setMinOrder] = useState(source?.minOrderCents === null ? '' : String(source?.minOrderCents ?? ''));
  const [maxOrder, setMaxOrder] = useState(source?.maxOrderCents === null ? '' : String(source?.maxOrderCents ?? ''));
  const [currency, setCurrency] = useState(source?.currency ?? 'pkr');
  const [effectiveFrom, setEffectiveFrom] = useState(toDateInput(source ? new Date(source.effectiveFrom) : new Date()));
  const [note, setNote] = useState(source?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const isPercent = kind.endsWith('PERCENT');
  const isFixed = kind.endsWith('FIXED');
  const isTier = kind === 'SELLER_TIER';
  const beneficiary: CommissionBeneficiary = kind.startsWith('BD') ? 'BD' : 'SELLER';

  const eligible = partners.filter((row) => (beneficiary === 'SELLER' ? row.kind === 'COIN_SELLER' : row.kind !== 'COIN_SELLER'));

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setServerError(null);
    try {
      const result = await api.putCommissionRule({
        kind,
        appliesToId: appliesToId === '' ? undefined : appliesToId,
        percentBps: isPercent ? parseUnsignedInt(percentBps) ?? 0 : undefined,
        fixedCents: isFixed ? parseUnsignedInt(fixedCents) ?? 0 : undefined,
        tiers: isTier ? tiers : undefined,
        minOrderCents: minOrder.trim() === '' ? undefined : parseUnsignedInt(minOrder) ?? undefined,
        maxOrderCents: maxOrder.trim() === '' ? undefined : parseUnsignedInt(maxOrder) ?? undefined,
        currency: currency.trim() === '' ? undefined : currency.trim().toLowerCase(),
        effectiveFrom: new Date(`${effectiveFrom}T00:00:00`).toISOString(),
        note: note.trim() === '' ? undefined : note.trim(),
      });
      onSaved(result.rule);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'The rule was refused.');
      setBusy(false);
    }
  };

  const setTier = (index: number, patch: Partial<CommissionTier>) =>
    setTiers((current) => current.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)));

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={source ? `New version of ${KIND_LABELS[source.kind]}` : 'New commission rule'}
      subtitle={source ? `Copying version ${source.rulesVersion}. Saving closes the old rule at this effective date.` : 'A rule only affects orders opened after it takes effect.'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy}>
            Save rule version
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Kind" value={kind} onChange={(e) => setKind(e.target.value as CommissionRuleKind)}>
            {(Object.keys(KIND_LABELS) as CommissionRuleKind[]).map((value) => (
              <option key={value} value={value}>
                {KIND_LABELS[value]}
              </option>
            ))}
          </Select>
          <Select label="Applies to" value={appliesToId} onChange={(e) => setAppliesToId(e.target.value)}>
            <option value="">Every {beneficiary === 'SELLER' ? 'coin seller' : 'BD account'}</option>
            {eligible.map((row) => (
              <option key={row.id} value={row.id}>
                {row.code} · {row.displayName}
              </option>
            ))}
          </Select>
        </div>

        {isPercent && (
          <Input
            label="Percent of eligible net (bps)"
            inputMode="numeric"
            value={percentBps}
            onChange={(e) => setPercentBps(e.target.value)}
            hint={`${formatBps(parseUnsignedInt(percentBps) ?? 0)} of the collected amount after provider fees. 0-10000.`}
          />
        )}
        {isFixed && (
          <Input label="Fixed amount in minor units" inputMode="numeric" value={fixedCents} onChange={(e) => setFixedCents(e.target.value)} hint={`Pays ${formatCents(parseUnsignedInt(fixedCents) ?? 0, currency)} per eligible order.`} />
        )}
        {isTier && (
          <div className="rounded-lg border border-edge/60 bg-elevated/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-faint">Volume tiers</p>
              <Button size="sm" variant="ghost" icon={<IconPlus className="h-3.5 w-3.5" />} onClick={() => setTiers((current) => [...current, { uptoCents: 0, percentBps: 0 }])}>
                Add tier
              </Button>
            </div>
            <p className="mb-2 text-[11px] text-faint">
              Each tier covers orders up to its ceiling in minor units, applied to the first tier whose ceiling is reached.
            </p>
            <div className="space-y-2">
              {tiers.map((tier, index) => (
                <div key={index} className="flex items-end gap-2">
                  <Input label={`Tier ${index + 1} ceiling`} inputMode="numeric" value={String(tier.uptoCents)} onChange={(e) => setTier(index, { uptoCents: parseUnsignedInt(e.target.value) ?? 0 })} className="w-40" />
                  <Input label="Percent (bps)" inputMode="numeric" value={String(tier.percentBps ?? 0)} onChange={(e) => setTier(index, { percentBps: parseUnsignedInt(e.target.value) ?? 0 })} className="w-32" />
                  <Input label="Fixed (optional)" inputMode="numeric" value={String(tier.fixedCents ?? 0)} onChange={(e) => setTier(index, { fixedCents: parseUnsignedInt(e.target.value) ?? undefined })} className="w-36" />
                  <Button size="sm" variant="ghost" onClick={() => setTiers((current) => current.filter((_, i) => i !== index))} disabled={tiers.length <= 1}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-4">
          <Input label="Min order (minor units)" inputMode="numeric" value={minOrder} onChange={(e) => setMinOrder(e.target.value)} placeholder="no floor" />
          <Input label="Max order (minor units)" inputMode="numeric" value={maxOrder} onChange={(e) => setMaxOrder(e.target.value)} placeholder="no ceiling" />
          <Input label="Currency" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value)} />
          <Input label="Effective from" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </div>

        <Textarea label="Note (stored with the rule and the audit row)" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. raised for the Ramadan campaign, finance approved 12 Oct" />

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

function RetireModal({ rule, onClose, onRetired }: { rule: CommissionRule; onClose: () => void; onRetired: (rule: CommissionRule) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setServerError(null);
    try {
      const result = await api.retireCommissionRule(rule.id, reason.trim());
      onRetired(result.rule);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Retire failed.');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Retire ${KIND_LABELS[rule.kind]} v${rule.rulesVersion}`}
      subtitle="Accruals already made keep the version they were calculated under. This only stops new orders using it."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void submit()} loading={busy} disabled={reason.trim().length < 3}>
            Retire rule
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Textarea label="Reason (required)" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. replaced by the 2026 seller schedule" />
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
// Settlement: period + partner, and nothing else. The server decides the amount
// by summing what is accrued in that window; if it is zero the batch is refused.
// ---------------------------------------------------------------------------
function SettlementModal({ partners, onClose, onCreated }: { partners: PartnerRef[]; onClose: () => void; onCreated: (batch: CommissionSettlement) => void }) {
  const [beneficiary, setBeneficiary] = useState<'SELLER' | 'BD'>('SELLER');
  const [beneficiaryId, setBeneficiaryId] = useState('');
  const [periodFrom, setPeriodFrom] = useState(toDateInput(new Date(Date.now() - 30 * 86_400_000)));
  const [periodTo, setPeriodTo] = useState(toDateInput(new Date(Date.now() + 86_400_000)));
  const [payoutMethod, setPayoutMethod] = useState('');
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const eligible = partners.filter((row) => (beneficiary === 'SELLER' ? row.kind === 'COIN_SELLER' : row.kind !== 'COIN_SELLER'));

  const submit = async () => {
    if (busy || beneficiaryId === '') return;
    setBusy(true);
    setServerError(null);
    try {
      const result = await api.createCommissionSettlement({
        beneficiary,
        beneficiaryId,
        periodFrom: new Date(`${periodFrom}T00:00:00`).toISOString(),
        periodTo: new Date(`${periodTo}T00:00:00`).toISOString(),
        payoutMethod: payoutMethod.trim() === '' ? undefined : payoutMethod.trim(),
      });
      onCreated(result.settlement);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'The batch could not be drafted.');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Draft a settlement batch"
      subtitle="Groups every accrued entry for one partner inside the period. The total comes from those entries, never from an input box."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={beneficiaryId === ''}>
            Draft batch
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Beneficiary side" value={beneficiary} onChange={(e) => { setBeneficiary(e.target.value as 'SELLER' | 'BD'); setBeneficiaryId(''); }}>
            <option value="SELLER">Coin seller</option>
            <option value="BD">BD account</option>
          </Select>
          <Select label="Partner" value={beneficiaryId} onChange={(e) => setBeneficiaryId(e.target.value)}>
            <option value="">Choose a partner…</option>
            {eligible.map((row) => (
              <option key={row.id} value={row.id}>
                {row.code} · {row.displayName}
              </option>
            ))}
          </Select>
          <Input label="Period from" type="date" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} />
          <Input label="Period to (exclusive)" type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} />
        </div>
        <Input label="Payout method" value={payoutMethod} onChange={(e) => setPayoutMethod(e.target.value)} maxLength={40} placeholder="e.g. bank transfer, jazzcash" />
        <p className="text-[11px] text-faint">
          A drafted batch is not payable yet. It has to be approved, and then marked paid — two actions, both audited, and the journal entry follows the
          approval.
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

function SettlementActionModal({
  batch,
  onClose,
  onDone,
}: {
  batch: CommissionSettlement;
  onClose: () => void;
  onDone: (batch: CommissionSettlement, verb: string) => void;
}) {
  const approve = batch.status === 'DRAFT';
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setServerError(null);
    try {
      const result = approve ? await api.approveCommissionSettlement(batch.id) : await api.payCommissionSettlement(batch.id, note.trim() === '' ? undefined : note.trim());
      onDone(result.settlement, approve ? 'approved' : 'marked paid');
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'The action was refused.');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={approve ? `Approve ${batch.reference}` : `Mark ${batch.reference} paid`}
      subtitle={`${batch.entryCount} entries · ${formatCents(batch.amountCents, batch.currency)}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={approve ? 'primary' : 'success'} onClick={() => void submit()} loading={busy}>
            {approve ? 'Approve batch' : 'Confirm payment'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-edge/60 bg-elevated/40 p-3 text-xs leading-relaxed text-muted">
          {approve
            ? 'Approval locks the entries into the batch and moves the payable from the accrual account to the settlement account. Nothing leaves the platform yet.'
            : 'Marking paid records that the money actually went out, closes the payable and writes the payment to the audit log with this note.'}
        </div>
        {!approve && <Textarea label="Payment note (reference, date, who paid)" rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />}
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
// commission.calculationOrder — which kinds combine, in what order, and the
// ceiling on the total. §22 puts both decisions with the administrator.
// ---------------------------------------------------------------------------
function EngineSwitches({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const ALL: CommissionRuleKind[] = ['SELLER_TIER', 'SELLER_PERCENT', 'SELLER_FIXED', 'BD_PERCENT', 'BD_FIXED'];
  const [order, setOrder] = useState<CommissionRuleKind[]>(ALL);
  const [enabled, setEnabled] = useState<Set<string>>(new Set(ALL));
  const [ceiling, setCeiling] = useState('2500');
  const [loaded, setLoaded] = useState<CommissionConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .readConfig<CommissionConfig>('commission.calculationOrder')
      .then((result) => {
        if (cancelled) return;
        const value = result.value;
        const list = Array.isArray(value.enabled) ? value.enabled.filter((kind) => ALL.includes(kind)) : ALL;
        const rest = ALL.filter((kind) => !list.includes(kind));
        setOrder([...list, ...rest]);
        setEnabled(new Set(list));
        setCeiling(String(value.maxAllocationBps ?? 2500));
        setLoaded({ enabled: list, maxAllocationBps: Number(value.maxAllocationBps ?? 2500) });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to read the switch set.');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty =
    loaded !== null &&
    (loaded.maxAllocationBps !== (parseUnsignedInt(ceiling) ?? 0) ||
      [...loaded.enabled].join() !== order.filter((kind) => enabled.has(kind)).join());

  const move = (index: number, delta: number) => {
    setOrder((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const list = order.filter((kind) => enabled.has(kind));
    try {
      const result = await api.writeConfig('commission.calculationOrder', {
        enabled: list,
        maxAllocationBps: parseUnsignedInt(ceiling) ?? 0,
      });
      const value = result.value as unknown as CommissionConfig;
      setLoaded({ enabled: Array.isArray(value.enabled) ? value.enabled : list, maxAllocationBps: Number(value.maxAllocationBps ?? ceiling) });
      toast.success('Calculation order saved. Orders opened from now use it.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The write was refused.');
    } finally {
      setBusy(false);
    }
  };

  const enabledList = order.filter((kind) => enabled.has(kind));
  const ceilingValue = parseUnsignedInt(ceiling) ?? 0;

  return (
    <Card
      title="commission.calculationOrder"
      subtitle="Which commission kinds are allowed to combine, the order they are applied in, and the most that may be allocated from one collection."
      actions={
        canWrite ? (
          <Button variant="primary" size="sm" onClick={() => void save()} loading={busy} disabled={!dirty}>
            {dirty ? 'Save order' : 'Saved'}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-faint">Application order</p>
          {order.map((kind, index) => {
            const on = enabled.has(kind);
            return (
              <div
                key={kind}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition ${
                  on ? 'border-violet-500/50 bg-brand-gradient-soft' : 'border-edge bg-elevated opacity-70'
                }`}
              >
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-elevated text-[11px] font-bold tabular-nums text-violet-200">
                  {on ? enabledList.indexOf(kind) + 1 : '—'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{KIND_LABELS[kind]}</span>
                  <span className="block text-[11px] text-faint">
                    {kind.startsWith('SELLER') ? 'Paid to a coin seller' : 'Paid to the BD account above the seller'}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <Button size="sm" variant="ghost" aria-label="Move earlier" disabled={!canWrite || index === 0} onClick={() => move(index, -1)} icon={<IconArrowUp className="h-4 w-4" />}>
                    Up
                  </Button>
                  <Button size="sm" variant="ghost" aria-label="Move later" disabled={!canWrite || index === order.length - 1} onClick={() => move(index, 1)} icon={<IconArrowDown className="h-4 w-4" />}>
                    Down
                  </Button>
                  <Switch
                    label={`${on ? 'Disable' : 'Enable'} ${KIND_LABELS[kind]}`}
                    checked={on}
                    disabled={!canWrite}
                    onChange={(next) =>
                      setEnabled((current) => {
                        const copy = new Set(current);
                        if (next) copy.add(kind);
                        else copy.delete(kind);
                        return copy;
                      })
                    }
                  />
                </span>
              </div>
            );
          })}
          {enabledList.length === 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-500/50 bg-amber-950/50 px-3 py-2 text-xs text-amber-200">
              <IconAlert className="h-4 w-4 shrink-0" />
              With nothing enabled, no order accrues commission at all.
            </div>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-edge/60 bg-elevated/40 p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-faint">Maximum allocation</p>
            <Input
              className="mt-2"
              inputMode="numeric"
              disabled={!canWrite}
              value={ceiling}
              onChange={(e) => setCeiling(e.target.value)}
              hint={`${formatBps(ceilingValue)} of the eligible net value is the most any combination may claim.`}
            />
          </div>
          <div className="rounded-xl border border-edge/60 bg-surface/60 p-4 text-[11px] leading-relaxed text-muted">
            <p className="mb-1 flex items-center gap-2 text-xs font-semibold text-ink">
              <IconSliders className="h-4 w-4 text-violet-300" />
              How the engine reads this
            </p>
            Every order takes a snapshot of these switches when it opens, so a change here affects new orders only. Kinds are applied top to bottom, each
            rounded down on its own line, and the total is truncated at the ceiling. The database also refuses any accrual that would push an order past
            what it collected — that limit is a constraint, not a convention.
          </div>
        </div>

        {!canWrite && (
          <p className="flex items-center gap-2 text-[11px] text-faint">
            <IconClose className="h-3.5 w-3.5" />
            You can read the calculation order but only a configuration administrator can change it.
          </p>
        )}
        {error !== null && (
          <div className="flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
            <IconAlert className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
        {loaded !== null && (
          <p className="flex items-center gap-2 text-[11px] text-faint">
            <IconCheck className="h-3.5 w-3.5 text-emerald-400" />
            Server copy: {loaded.enabled.join(' → ')} at a {formatBps(loaded.maxAllocationBps)} ceiling.
          </p>
        )}
      </div>
    </Card>
  );
}

/** yyyy-mm-dd for a native date input, in local time. */
function toDateInput(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
