// ---------------------------------------------------------------------------
// The recharge queue (§22) — the only place in the panel where coins are created.
//
// The rule the whole page is built around: a seller saying "paid" is a claim, not a
// payment. Orders arrive in AWAITING_VERIFICATION and only leave it when a finance
// operator approves them, or when the `autoCreditFromProvider` switch says a
// provider confirmation is enough. Approving, rejecting and reversing are three
// different buttons because they have three different effects on the book, and the
// reversal one is honest about it: the posted ledger rows stay, a clawback is
// posted next to them.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, StatCard } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input, Textarea } from '../components/ui/Input';
import {
  IconAlert,
  IconCheck,
  IconClose,
  IconEdit,
  IconPlus,
  IconRefresh,
  IconRecharge,
  IconSearch,
  IconSliders,
  IconScales,
} from '../components/ui/Icons';
import { JsonBlock } from '../components/ui/JsonBlock';
import { Modal } from '../components/ui/Modal';
import { Pagination } from '../components/ui/Pagination';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { Tabs } from '../components/ui/Tabs';
import { useAuth } from '../context/AuthContext';
import { ApiError, api } from '../lib/api';
import { formatCents, formatDateTime, formatNumber, parseUnsignedInt, relativeTime } from '../lib/format';
import { useToast } from '../components/ui/Toast';
import type { PartnerRef, RechargeConfig, RechargeOrder, RechargeOrderStatus, RechargePackage } from '../types';

const STATUS_TONES: Record<string, BadgeTone> = {
  AWAITING_PAYMENT: 'slate',
  AWAITING_VERIFICATION: 'amber',
  CREDITED: 'green',
  REJECTED: 'red',
  CANCELLED: 'slate',
  EXPIRED: 'slate',
  REVERSED: 'fuchsia',
};

const TAB_STATUSES: RechargeOrderStatus[] = [
  'AWAITING_PAYMENT',
  'AWAITING_VERIFICATION',
  'CREDITED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
  'REVERSED',
];

export default function RechargesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const review = can('recharge:review');
  const config = can('config:manage');

  const [tab, setTab] = useState('queue');
  const [status, setStatus] = useState<'' | RechargeOrderStatus>('AWAITING_VERIFICATION');
  const [sellerId, setSellerId] = useState('');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [limit] = useState(25);

  const [orders, setOrders] = useState<RechargeOrder[] | null>(null);
  const [total, setTotal] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [sellers, setSellers] = useState<PartnerRef[]>([]);
  const [packages, setPackages] = useState<RechargePackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);

  const [detail, setDetail] = useState<RechargeOrder | null>(null);
  const [decisionTarget, setDecisionTarget] = useState<{ order: RechargeOrder; mode: 'approve' | 'reject' | 'reverse' } | null>(null);
  const [packageTarget, setPackageTarget] = useState<RechargePackage | 'new' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.rechargeOrders({
        status: status === '' ? undefined : status,
        sellerId: sellerId === '' ? undefined : sellerId,
        search: term === '' ? undefined : term,
        from: from === '' ? undefined : new Date(from).toISOString(),
        to: to === '' ? undefined : new Date(to).toISOString(),
        page,
        limit,
      });
      setOrders(result.orders);
      setTotal(result.total);
    } catch (err) {
      setOrders([]);
      setError(err instanceof ApiError ? err.message : 'Failed to load recharge orders.');
    } finally {
      setLoading(false);
    }
  }, [status, sellerId, term, from, to, page, limit]);

  // Every read here is `finance:read`: the pending count, the catalogue, and the partner roster
  // used by the seller filter. The roster is the identity-only projection — this desk reviews
  // orders, it does not edit seller limits, so it has no business asking for `/accounts`.
  const loadSidebars = useCallback(async () => {
    const [waiting, catalogue, partnerList] = await Promise.allSettled([
      api.rechargeOrders({ status: 'AWAITING_VERIFICATION', limit: 1 }),
      api.rechargePackages(true),
      api.partnerRoster(),
    ]);
    if (waiting.status === 'fulfilled') setPendingCount(waiting.value.total);
    if (catalogue.status === 'fulfilled') setPackages(catalogue.value.packages);
    if (partnerList.status === 'fulfilled') {
      setSellers(partnerList.value.partners.filter((row) => row.kind === 'COIN_SELLER' && row.status === 'ACTIVE'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadSidebars();
  }, [loadSidebars]);

  const replace = useCallback((updated: RechargeOrder) => {
    setOrders((current) => (current ?? []).map((row) => (row.id === updated.id ? updated : row)));
    setDetail(null);
    setDecisionTarget(null);
  }, []);

  const awaitingPayment = useMemo(() => (orders ?? []).filter((o) => o.status === 'AWAITING_PAYMENT').length, [orders]);

  const runSweep = async () => {
    if (sweeping) return;
    setSweeping(true);
    try {
      const result = await api.sweepRechargeExpiry();
      toast.info(result.expired === 0 ? 'No order passed its verification window.' : `Expired ${result.expired} uncleared order(s).`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The expiry sweep failed.');
    } finally {
      setSweeping(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-ink">
            <IconRecharge className="h-5 w-5 text-violet-300" />
            Recharges
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            A seller claiming payment is not a payment. Coins move only when finance approves the order.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {review && (
            <Button icon={<IconScales className="h-4 w-4" />} onClick={() => void runSweep()} loading={sweeping}>
              Expire stale orders
            </Button>
          )}
          <Button
            icon={<IconRefresh className="h-4 w-4" />}
            onClick={() => {
              void load();
              void loadSidebars();
            }}
          >
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Awaiting verification"
          value={formatNumber(pendingCount)}
          sub={pendingCount > 0 ? 'a seller claims the money arrived' : 'queue is clear'}
          tone={pendingCount > 0 ? 'amber' : 'emerald'}
        />
        <StatCard label="Awaiting payment" value={formatNumber(awaitingPayment)} sub="opened, nothing claimed yet" tone="sky" />
        <StatCard label="Orders on page" value={formatNumber((orders ?? []).length)} sub={`${formatNumber(total)} match the filter`} />
        <StatCard label="Catalogue" value={formatNumber(packages.filter((p) => p.isActive).length)} sub={`${packages.length} packages defined`} tone="fuchsia" />
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        items={[
          { id: 'queue', label: 'Order queue', count: total, alert: pendingCount > 0 },
          { id: 'packages', label: 'Packages', count: packages.length },
          { id: 'switches', label: 'Switches' },
        ]}
      />

      {error !== null && tab === 'queue' && (
        <Card>
          <EmptyState
            title="Could not load orders"
            message={error}
            icon={<IconAlert className="h-6 w-6" />}
            action={<Button onClick={() => void load()}>Retry</Button>}
          />
        </Card>
      )}

      {tab === 'queue' && error === null && (
        <Card bodyClassName="p-0">
          <div className="flex flex-wrap items-end gap-3 border-b border-edge/60 p-4">
            <Select
              label="Status"
              aria-label="Filter by status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as '' | RechargeOrderStatus);
                setPage(1);
              }}
              className="w-52"
            >
              <option value="">Any status</option>
              {TAB_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
            <Select
              label="Seller"
              aria-label="Filter by seller"
              value={sellerId}
              onChange={(e) => {
                setSellerId(e.target.value);
                setPage(1);
              }}
              className="w-52"
            >
              <option value="">All sellers</option>
              {sellers.map((seller) => (
                <option key={seller.id} value={seller.id}>
                  {seller.code} · {seller.displayName}
                </option>
              ))}
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
                placeholder="Order reference, payment ref, customer…"
                leadingIcon={<IconSearch className="h-4 w-4" />}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="min-w-48 flex-1"
              />
              <Button type="submit">Search</Button>
            </form>
            <Input label="From" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
            <Input label="To" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
          </div>

          {loading && orders === null ? (
            <div className="grid h-64 place-items-center text-violet-300">
              <Spinner className="h-8 w-8" />
            </div>
          ) : (orders ?? []).length === 0 ? (
            <EmptyState
              title={status === 'AWAITING_VERIFICATION' ? 'Nothing to verify' : 'No orders match this filter'}
              message={status === 'AWAITING_VERIFICATION' ? 'No seller is currently claiming a payment.' : 'Widen the status, seller or date range.'}
              icon={<IconRecharge className="h-6 w-6" />}
            />
          ) : (
            <>
              <Table>
                <THead>
                  <Th width="20%">Order</Th>
                  <Th>Seller</Th>
                  <Th>Customer</Th>
                  <Th align="right">Coins</Th>
                  <Th align="right">Collected</Th>
                  <Th>Rail</Th>
                  <Th>Created</Th>
                  <Th>Status</Th>
                  <Th align="right" className="pr-4">
                    Actions
                  </Th>
                </THead>
                <TBody>
                  {(orders ?? []).map((row) => (
                    <Tr key={row.id}>
                      <Td>
                        <button type="button" className="focus-ring text-left" onClick={() => setDetail(row)}>
                          <p className="font-mono text-xs font-semibold text-violet-200 underline decoration-violet-500/40 hover:decoration-violet-400">
                            {row.reference}
                          </p>
                          <p className="text-[11px] text-faint">{row.paymentRef ? `ref ${row.paymentRef}` : 'no payment ref yet'}</p>
                        </button>
                      </Td>
                      <Td>
                        <p className="text-xs font-semibold text-ink">{row.sellerName}</p>
                        <p className="font-mono text-[11px] text-faint">{row.sellerCode}</p>
                      </Td>
                      <Td>
                        <p className="truncate text-xs text-ink">{row.username}</p>
                        {row.bdCode && <p className="font-mono text-[11px] text-faint">BD {row.bdCode}</p>}
                      </Td>
                      <Td align="right" className="font-semibold tabular-nums text-ink">
                        {formatNumber(row.diamonds)}
                      </Td>
                      <Td align="right" className="tabular-nums text-xs">
                        {formatCents(row.amountCents, row.currency)}
                        {row.feeCents > 0 && <span className="block text-[11px] text-faint">fee {formatCents(row.feeCents, row.currency)}</span>}
                      </Td>
                      <Td>
                        <Badge tone={row.provider ? 'sky' : 'slate'}>{row.provider ?? row.paymentMethod}</Badge>
                      </Td>
                      <Td className="whitespace-nowrap text-xs text-muted" title={formatDateTime(row.createdAt)}>
                        {relativeTime(row.createdAt)}
                        {row.expiresAt && row.status !== 'CREDITED' && (
                          <span className="block text-[11px] text-faint">expires {relativeTime(row.expiresAt)}</span>
                        )}
                      </Td>
                      <Td>
                        <Badge tone={STATUS_TONES[row.status] ?? 'slate'}>{row.status.replace(/_/g, ' ')}</Badge>
                      </Td>
                      <Td align="right" className="pr-4">
                        <div className="flex justify-end gap-1.5">
                          <Button size="sm" variant="ghost" onClick={() => setDetail(row)}>
                            Details
                          </Button>
                          {review && row.status === 'AWAITING_VERIFICATION' && (
                            <>
                              <Button size="sm" variant="success" onClick={() => setDecisionTarget({ order: row, mode: 'approve' })}>
                                Approve
                              </Button>
                              <Button size="sm" variant="danger" onClick={() => setDecisionTarget({ order: row, mode: 'reject' })}>
                                Reject
                              </Button>
                            </>
                          )}
                          {review && row.status === 'CREDITED' && (
                            <Button size="sm" variant="secondary" onClick={() => setDecisionTarget({ order: row, mode: 'reverse' })}>
                              Reverse
                            </Button>
                          )}
                        </div>
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
      )}

      {tab === 'packages' && (
        <Card
          bodyClassName="p-0"
          title="Recharge catalogue"
          subtitle="A package fixes the coin count and the collection price. Sellers never choose a price."
          actions={
            config ? (
              <Button variant="primary" size="sm" icon={<IconPlus className="h-4 w-4" />} onClick={() => setPackageTarget('new')}>
                New package
              </Button>
            ) : undefined
          }
        >
          <Table>
            <THead>
              <Th>Key</Th>
              <Th>Label</Th>
              <Th align="right">Coins</Th>
              <Th align="right">Price</Th>
              <Th align="right">Per 1k coins</Th>
              <Th align="right">Provider fee</Th>
              <Th>Active</Th>
              <Th align="right" className="pr-4" />
            </THead>
            <TBody>
              {packages.map((pkg) => (
                <Tr key={pkg.key}>
                  <Td className="font-mono text-xs text-ink">{pkg.key}</Td>
                  <Td className="text-sm text-ink">{pkg.label}</Td>
                  <Td align="right" className="font-semibold tabular-nums text-ink">
                    {formatNumber(pkg.diamonds)}
                  </Td>
                  <Td align="right" className="tabular-nums text-xs">
                    {formatCents(pkg.amountCents, pkg.currency)}
                  </Td>
                  <Td align="right" className="tabular-nums text-xs text-muted">
                    {formatCents(pkg.unitPriceCents, pkg.currency)}
                  </Td>
                  <Td align="right" className="tabular-nums text-xs text-muted">
                    {(pkg.feeBps / 100).toFixed(2)}%
                  </Td>
                  <Td>
                    <Badge tone={pkg.isActive ? 'green' : 'slate'}>{pkg.isActive ? 'live' : 'retired'}</Badge>
                  </Td>
                  <Td align="right" className="pr-4">
                    {config ? (
                      <div className="flex items-center justify-end gap-2">
                        <Switch
                          label={pkg.isActive ? 'Disable package' : 'Enable package'}
                          checked={pkg.isActive}
                          onChange={async (next) => {
                            try {
                              const result = await api.setPackageActive(pkg.key, next);
                              setPackages((current) => current.map((row) => (row.key === pkg.key ? result.package : row)));
                            } catch (err) {
                              toast.error(err instanceof ApiError ? err.message : 'Could not change the package.');
                            }
                          }}
                        />
                        <Button size="sm" variant="ghost" icon={<IconEdit className="h-3.5 w-3.5" />} onClick={() => setPackageTarget(pkg)}>
                          Edit
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-faint">read only</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          {packages.length === 0 && <EmptyState title="No packages" message="Define what coins cost before a seller can open an order." icon={<IconRecharge className="h-6 w-6" />} />}
        </Card>
      )}

      {tab === 'switches' && <RechargeSwitches canWrite={config} onChanged={() => void load()} />}

      {detail !== null && <OrderModal order={detail} onClose={() => setDetail(null)} />}
      {decisionTarget !== null && (
        <DecisionModal
          order={decisionTarget.order}
          mode={decisionTarget.mode}
          onClose={() => setDecisionTarget(null)}
          onDone={(updated) => {
            replace(updated);
            setPendingCount((n) => Math.max(0, n - 1));
            toast.success(
              decisionTarget.mode === 'approve'
                ? `${updated.reference} credited — ${formatNumber(updated.diamonds)} coins to ${updated.username}.`
                : decisionTarget.mode === 'reject'
                  ? `${updated.reference} rejected.`
                  : `${updated.reference} reversed. The original ledger rows stay and a clawback was posted.`,
            );
            void loadSidebars();
          }}
        />
      )}
      {packageTarget !== null && (
        <PackageModal
          existing={packageTarget === 'new' ? null : packageTarget}
          onClose={() => setPackageTarget(null)}
          onSaved={(saved) => {
            setPackages((current) => {
              const without = current.filter((row) => row.key !== saved.key);
              return [...without, saved].sort((a, b) => a.amountCents - b.amountCents);
            });
            setPackageTarget(null);
            toast.success(`Package ${saved.key} saved.`);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only order detail: the evidence the seller attached and the rules the
// order was priced under. An operator deciding on a claim needs both on screen.
// ---------------------------------------------------------------------------
function OrderModal({ order, onClose }: { order: RechargeOrder; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} size="lg" title={order.reference} subtitle={`${order.sellerCode} · ${order.username} · ${STATUS_TONES[order.status] ? order.status.replace(/_/g, ' ') : order.status}`}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Coins" value={formatNumber(order.diamonds)} />
          <Field label="Collected" value={formatCents(order.amountCents, order.currency)} />
          <Field label="Provider fee" value={formatCents(order.feeCents, order.currency)} />
          <Field label="Rail" value={`${order.paymentMethod}${order.provider ? ` · ${order.provider}` : ''}`} />
          <Field label="Payment ref" value={order.paymentRef ?? '—'} />
          <Field label="Ledger row" value={order.transactionId ?? 'not credited'} mono />
          <Field label="Opened" value={formatDateTime(order.createdAt)} />
          <Field label="Verified" value={order.verifiedAt ? formatDateTime(order.verifiedAt) : '—'} />
          <Field label="Expires" value={order.expiresAt ? formatDateTime(order.expiresAt) : '—'} />
        </div>
        {order.decisionNote && (
          <div className="rounded-lg border border-edge/60 bg-elevated/40 p-3 text-xs text-muted">
            <span className="font-semibold text-ink">Decision note: </span>
            {order.decisionNote}
          </div>
        )}
        {order.reversalReason && (
          <div className="rounded-lg border border-fuchsia-500/50 bg-fuchsia-950/40 p-3 text-xs text-fuchsia-100">
            <span className="font-semibold">Reversal: </span>
            {order.reversalReason}
          </div>
        )}
        <JsonBlock label="Payment evidence attached by the seller" value={order.evidence} />
        <JsonBlock label="Pricing and limit snapshot taken at open" value={order.rulesSnapshot} />
      </div>
    </Modal>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-faint">{label}</p>
      <p className={`mt-0.5 truncate text-sm text-ink ${mono ? 'font-mono text-xs' : ''}`} title={value}>
        {value}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Approve / reject / reverse. The three actions never share a button, because the
// money each one produces is different and irreversible in a different way.
// ---------------------------------------------------------------------------
function DecisionModal({
  order,
  mode,
  onClose,
  onDone,
}: {
  order: RechargeOrder;
  mode: 'approve' | 'reject' | 'reverse';
  onClose: () => void;
  onDone: (order: RechargeOrder) => void;
}) {
  const [note, setNote] = useState('');
  const [feeCents, setFeeCents] = useState('');
  const [refundCents, setRefundCents] = useState(String(order.amountCents));
  const [clawback, setClawback] = useState(true);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const reasonRequired = mode !== 'approve';
  const reason = note.trim();

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setServerError(null);
    try {
      if (mode === 'approve') {
        const result = await api.approveRecharge(order.id, {
          decisionNote: reason === '' ? undefined : reason,
          feeCents: feeCents.trim() === '' ? undefined : parseUnsignedInt(feeCents) ?? undefined,
        });
        onDone(result.order);
      } else if (mode === 'reject') {
        const result = await api.rejectRecharge(order.id, reason);
        onDone(result.order);
      } else {
        const result = await api.reverseRecharge({
          id: order.id,
          reason,
          refundCents: refundCents.trim() === '' ? undefined : parseUnsignedInt(refundCents) ?? undefined,
          clawback,
        });
        onDone(result.order);
      }
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'The decision was refused.');
      setBusy(false);
    }
  };

  const copy =
    mode === 'approve'
      ? { title: 'Approve and credit', tone: 'success' as const, verb: 'Credit the coins' }
      : mode === 'reject'
        ? { title: 'Reject the claim', tone: 'danger' as const, verb: 'Reject order' }
        : { title: 'Reverse a credited order', tone: 'danger' as const, verb: 'Post the reversal' };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${copy.title} · ${order.reference}`}
      subtitle={`${formatNumber(order.diamonds)} coins · ${formatCents(order.amountCents, order.currency)} claimed by ${order.sellerCode}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={copy.tone} onClick={() => void submit()} loading={busy} disabled={reasonRequired && reason.length < 3}>
            {copy.verb}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {mode === 'approve' && (
          <>
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/40 p-3 text-xs text-emerald-100">
              This creates the coins. The server writes one ledger row for the customer, one journal entry for the money side, and accrues seller and BD
              commission from the rules that were in force when the order opened. It can only happen once for this order.
            </div>
            {!order.paymentRef && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-500/50 bg-amber-950/50 px-3 py-2 text-xs text-amber-200">
                <IconAlert className="h-4 w-4 shrink-0" />
                No payment reference on this order. Confirm the rail receipt before crediting.
              </div>
            )}
            <Input label="Provider fee in minor units (optional override)" inputMode="numeric" value={feeCents} onChange={(e) => setFeeCents(e.target.value)} hint="Blank keeps the fee the package was priced with." />
          </>
        )}

        {mode === 'reverse' && (
          <>
            <div className="rounded-lg border border-fuchsia-500/40 bg-fuchsia-950/40 p-3 text-xs text-fuchsia-100">
              Nothing is deleted. The credit row and its journal entry stay, and a clawback row plus a reversal entry are posted beside them. Commission
              accrued on this order is reversed in the same transaction.
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Refund to the customer (minor units)" inputMode="numeric" value={refundCents} onChange={(e) => setRefundCents(e.target.value)} hint={`Order was collected at ${order.amountCents}.`} />
              <div className="flex items-end gap-3 rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2.5">
                <Switch label="Claw the coins back from the customer" checked={clawback} onChange={setClawback} />
                <span className="text-xs text-muted">Off means the customer keeps the coins and only the money side is adjusted.</span>
              </div>
            </div>
          </>
        )}

        <Textarea
          label={reasonRequired ? 'Reason (required, stored with the decision)' : 'Note (optional)'}
          rows={3}
          maxLength={200}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={
            mode === 'approve'
              ? 'e.g. bank receipt 4471 matches the claimed amount'
              : mode === 'reject'
                ? 'e.g. receipt shows a different amount than the order'
                : 'e.g. chargeback raised by the rail nine days later'
          }
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

// ---------------------------------------------------------------------------
// Catalogue entry. Creating a package is config:manage because it changes what
// coins cost; listing it is finance:read so the queue can be read without it.
// ---------------------------------------------------------------------------
function PackageModal({ existing, onClose, onSaved }: { existing: RechargePackage | null; onClose: () => void; onSaved: (pkg: RechargePackage) => void }) {
  const [key, setKey] = useState(existing?.key ?? '');
  const [label, setLabel] = useState(existing?.label ?? '');
  const [diamonds, setDiamonds] = useState(existing ? String(existing.diamonds) : '');
  const [amount, setAmount] = useState(existing ? String(existing.amountCents) : '');
  const [currency, setCurrency] = useState(existing?.currency ?? 'pkr');
  const [feeBps, setFeeBps] = useState(existing ? String(existing.feeBps) : '0');
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const parsedDiamonds = parseUnsignedInt(diamonds) ?? 0;
  const parsedAmount = parseUnsignedInt(amount) ?? 0;
  const valid = key.trim().length >= 2 && label.trim().length >= 2 && parsedDiamonds > 0 && parsedAmount >= 0;

  const submit = async () => {
    if (busy || !valid) return;
    setBusy(true);
    setServerError(null);
    try {
      const result = await api.savePackage({
        key: key.trim(),
        label: label.trim(),
        diamonds: parsedDiamonds,
        amountCents: parsedAmount,
        currency: currency.trim() === '' ? undefined : currency.trim().toLowerCase(),
        feeBps: parseUnsignedInt(feeBps) ?? 0,
      });
      onSaved(result.package);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Could not save the package.');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={existing ? `Edit ${existing.key}` : 'New package'}
      subtitle="Saving an existing key replaces its price; orders already opened keep the snapshot they were priced with."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!valid}>
            Save package
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Key (slug)" value={key} onChange={(e) => setKey(e.target.value)} disabled={existing !== null} placeholder="coins_100k" maxLength={48} />
          <Input label="Label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="100,000 coins" />
          <Input label="Coins issued" inputMode="numeric" value={diamonds} onChange={(e) => setDiamonds(e.target.value)} />
          <Input label="Price in minor units" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} hint="100 = one unit of currency." />
          <Input label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} placeholder="pkr" />
          <Input label="Provider fee (bps)" inputMode="numeric" value={feeBps} onChange={(e) => setFeeBps(e.target.value)} hint="0-10000. Taken out of the collection before revenue." />
        </div>
        {parsedDiamonds > 0 && parsedAmount > 0 && (
          <p className="rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2 text-xs text-muted">
            That is {currency} {(parsedAmount / parsedDiamonds).toFixed(4)} per coin, or {currency} {((parsedAmount / parsedDiamonds) * 1000).toFixed(2)} per thousand.
            {existing !== null && parsedAmount !== existing.amountCents && ' Changing the price does not change orders already opened.'}
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
// business.recharge — the three switches that decide how much of this queue is
// automated. Writing them is config:manage and every write is audited.
// ---------------------------------------------------------------------------
function RechargeSwitches({ canWrite, onChanged }: { canWrite: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState<RechargeConfig | null>(null);
  const [draft, setDraft] = useState<RechargeConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.readConfig<RechargeConfig>('business.recharge');
      const next: RechargeConfig = {
        orderValidityMinutes: Number(result.value.orderValidityMinutes ?? 60),
        manualEvidenceRequired: result.value.manualEvidenceRequired !== false,
        autoCreditFromProvider: result.value.autoCreditFromProvider !== false,
      };
      setValue(next);
      setDraft(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to read the switch set.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (busy || draft === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.writeConfig('business.recharge', { ...draft });
      setValue(draft);
      toast.success('Recharge switches saved. New orders use them immediately.');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The write was refused.');
    } finally {
      setBusy(false);
    }
  };

  if (error !== null && value === null) {
    return (
      <Card>
        <EmptyState title="Could not read the switches" message={error} icon={<IconAlert className="h-6 w-6" />} action={<Button onClick={() => void load()}>Retry</Button>} />
      </Card>
    );
  }

  return (
    <Card title="business.recharge" subtitle="What the recharge workflow enforces. These are administrator-owned, never read from a client." actions={canWrite && draft ? <Button variant="primary" size="sm" onClick={() => void save()} loading={busy}>Save switches</Button> : undefined}>
      {draft === null ? (
        <div className="grid h-32 place-items-center text-violet-300">
          <Spinner className="h-6 w-6" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-edge/60 bg-elevated/40 p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-faint">Verification window</p>
              <Input
                className="mt-2"
                inputMode="numeric"
                value={String(draft.orderValidityMinutes)}
                disabled={!canWrite}
                onChange={(e) => setDraft({ ...draft, orderValidityMinutes: parseUnsignedInt(e.target.value) ?? 0 })}
              />
              <p className="mt-2 text-[11px] text-faint">Minutes an order may sit unpaid or unverified before the sweep expires it.</p>
            </div>
            <SwitchRow
              label="Evidence required"
              help="A seller cannot mark an order paid without attaching a receipt or reference. The claim is still only a claim."
              checked={draft.manualEvidenceRequired}
              disabled={!canWrite}
              onChange={(manualEvidenceRequired) => setDraft({ ...draft, manualEvidenceRequired })}
            />
            <SwitchRow
              label="Provider may credit"
              help="Off means even a confirmed provider callback waits for a finance operator. Recommended while rails are in sandbox."
              checked={draft.autoCreditFromProvider}
              disabled={!canWrite}
              onChange={(autoCreditFromProvider) => setDraft({ ...draft, autoCreditFromProvider })}
            />
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-edge/60 bg-surface/60 px-3 py-2.5 text-[11px] text-muted">
            <IconSliders className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" />
            <p>
              Turning <span className="font-semibold text-ink">Provider may credit</span> on lets an automated callback create coins without a human in the
              loop. The credit is still idempotent and still writes a ledger row and a journal entry, but the review step disappears — switch it on only
              when a rail is live and reconciled.
            </p>
          </div>
          {error !== null && (
            <div className="flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
              <IconAlert className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
          {!canWrite && <p className="flex items-center gap-2 text-[11px] text-faint"><IconClose className="h-3.5 w-3.5" />You can read these switches but not change them.</p>}
        </div>
      )}
    </Card>
  );
}

function SwitchRow({ label, help, checked, disabled, onChange }: { label: string; help: string; checked: boolean; disabled: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="rounded-xl border border-edge/60 bg-elevated/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-faint">{label}</p>
        <Switch checked={checked} disabled={disabled} onChange={onChange} label={label} />
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-faint">{help}</p>
      <div className="mt-2 flex items-center gap-1.5 text-[11px] font-semibold">
        {checked ? <IconCheck className="h-3.5 w-3.5 text-emerald-400" /> : <IconClose className="h-3.5 w-3.5 text-rose-400" />}
        <span className={checked ? 'text-emerald-300' : 'text-rose-300'}>{checked ? 'on' : 'off'}</span>
      </div>
    </div>
  );
}
