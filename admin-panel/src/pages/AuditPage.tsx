// ---------------------------------------------------------------------------
// The audit trail (§10, §23): who did what, to whom, and when.
//
// Reading it is its own permission, because the log names every other role's work —
// it is not a courtesy attached to being able to see a dashboard. Rows are immutable
// here for the same reason they are immutable in the database: an entry that could be
// edited would be an entry that was edited.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, StatCard } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { IconAlert, IconAudit, IconRefresh, IconSearch } from '../components/ui/Icons';
import { JsonBlock } from '../components/ui/JsonBlock';
import { Modal } from '../components/ui/Modal';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { ApiError, api } from '../lib/api';
import { formatDateTime, formatNumber, relativeTime } from '../lib/format';
import type { AuditEntry } from '../types';

const TARGET_TONES: Record<string, BadgeTone> = {
  user: 'violet',
  room: 'sky',
  gift: 'pink',
  withdrawal: 'amber',
  game_definition: 'fuchsia',
  game_session: 'fuchsia',
  game_dispute: 'red',
  business_account: 'violet',
  recharge_order: 'amber',
  recharge_package: 'sky',
  commission_rule: 'pink',
  commission_settlement: 'green',
  system_config: 'slate',
};

const ACTOR_TONES: Record<string, BadgeTone> = {
  admin: 'violet',
  business: 'amber',
  system: 'slate',
};

/** The verbs the services actually write, so the filter is a list rather than a guess. */
const TARGET_TYPES = [
  'user',
  'room',
  'gift',
  'withdrawal',
  'game_definition',
  'game_session',
  'game_dispute',
  'business_account',
  'recharge_order',
  'recharge_package',
  'commission_rule',
  'commission_settlement',
  'system_config',
];

export default function AuditPage() {
  const [targetType, setTargetType] = useState('');
  const [actor, setActor] = useState('');
  const [businessId, setBusinessId] = useState('');
  const [adminId, setAdminId] = useState('');
  const [limit, setLimit] = useState(100);

  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditEntry | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.audit({
        limit,
        targetType: targetType === '' ? undefined : targetType,
        actorKind: actor === '' ? undefined : (actor as 'admin' | 'business' | 'system'),
        businessId: businessId.trim() === '' ? undefined : businessId.trim(),
        adminId: adminId.trim() === '' ? undefined : adminId.trim(),
      });
      setEntries(result.entries);
    } catch (err) {
      setEntries([]);
      setError(err instanceof ApiError ? err.message : 'Failed to load the audit log.');
    } finally {
      setLoading(false);
    }
  }, [limit, targetType, actor, businessId, adminId]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => {
    const rows = entries ?? [];
    const since = rows.length > 0 ? rows[rows.length - 1].createdAt : null;
    return {
      count: rows.length,
      money: rows.filter((row) => row.targetType === 'recharge_order' || row.targetType === 'commission_settlement' || row.targetType === 'withdrawal').length,
      partner: rows.filter((row) => row.actorKind === 'business').length,
      since,
    };
  }, [entries]);

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-ink">
            <IconAudit className="h-5 w-5 text-violet-300" />
            Audit trail
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            Every privileged mutation, by an operator, a partner or the system. Append-only — the panel has no way to change a row.
          </p>
        </div>
        <Button icon={<IconRefresh className="h-4 w-4" />} onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Entries shown" value={formatNumber(summary.count)} sub={`newest ${limit} up to`} />
        <StatCard label="Financial actions" value={formatNumber(summary.money)} sub="recharges, settlements, withdrawals" tone="amber" />
        <StatCard label="By partners" value={formatNumber(summary.partner)} sub="BD or seller initiated" tone="fuchsia" />
        <StatCard label="Oldest shown" value={summary.since === null ? '—' : relativeTime(summary.since)} sub={summary.since === null ? 'no entries' : formatDateTime(summary.since)} tone="sky" />
      </div>

      <Card bodyClassName="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Select label="Target type" value={targetType} onChange={(e) => setTargetType(e.target.value)} className="w-52">
            <option value="">Any target</option>
            {TARGET_TYPES.map((type) => (
              <option key={type} value={type}>
                {type.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
          <Select label="Actor kind" value={actor} onChange={(e) => setActor(e.target.value)} className="w-40">
            <option value="">Any actor</option>
            <option value="admin">Operator</option>
            <option value="business">Partner</option>
            <option value="system">System</option>
          </Select>
          <Select label="Newest" value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))} className="w-32">
            <option value="50">50 rows</option>
            <option value="100">100 rows</option>
            <option value="250">250 rows</option>
            <option value="500">500 rows</option>
          </Select>
          <Input label="Operator id" placeholder="admin uuid" value={adminId} onChange={(e) => setAdminId(e.target.value)} className="w-56" />
          <Input label="Partner id" placeholder="business account uuid" value={businessId} onChange={(e) => setBusinessId(e.target.value)} className="w-56" />
          <Button
            icon={<IconSearch className="h-4 w-4" />}
            onClick={() => {
              // The uuid fields feed a `::uuid` cast, so trim before the request goes out.
              setBusinessId((v) => v.trim());
              setAdminId((v) => v.trim());
            }}
          >
            Apply ids
          </Button>
          {(targetType !== '' || actor !== '' || businessId !== '' || adminId !== '') && (
            <Button
              variant="ghost"
              onClick={() => {
                setTargetType('');
                setActor('');
                setBusinessId('');
                setAdminId('');
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </Card>

      <Card bodyClassName="p-0">
        {loading && entries === null ? (
          <div className="grid h-64 place-items-center text-violet-300">
            <Spinner className="h-8 w-8" />
          </div>
        ) : error !== null ? (
          <EmptyState
            title="Could not load the log"
            message={error}
            icon={<IconAlert className="h-6 w-6" />}
            action={<Button onClick={() => void load()}>Retry</Button>}
          />
        ) : (entries ?? []).length === 0 ? (
          <EmptyState title="No entries" message="Nothing matches this filter. A malformed operator or partner id simply returns nothing." icon={<IconAudit className="h-6 w-6" />} />
        ) : (
          <Table>
            <THead>
              <Th width="14%">When</Th>
              <Th>Actor</Th>
              <Th>Action</Th>
              <Th>Target</Th>
              <Th width="34%">Summary</Th>
              <Th align="right" className="pr-4" />
            </THead>
            <TBody>
              {(entries ?? [])
                .filter((row) => actor === '' || row.actorKind === actor)
                .map((row) => (
                  <Tr key={row.id}>
                    <Td className="whitespace-nowrap text-xs text-muted" title={formatDateTime(row.createdAt)}>
                      {relativeTime(row.createdAt)}
                    </Td>
                    <Td>
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-ink">{row.actor}</p>
                        <Badge tone={ACTOR_TONES[row.actorKind] ?? 'slate'} className="mt-1">
                          {row.actorKind}
                        </Badge>
                      </div>
                    </Td>
                    <Td className="font-mono text-[11px] text-violet-200">{row.action}</Td>
                    <Td>
                      {row.targetType === null ? (
                        <span className="text-xs text-faint">—</span>
                      ) : (
                        <>
                          <Badge tone={TARGET_TONES[row.targetType] ?? 'slate'}>{row.targetType.replace(/_/g, ' ')}</Badge>
                          {row.targetId && <p className="mt-1 font-mono text-[10px] text-faint">{row.targetId.slice(0, 14)}</p>}
                        </>
                      )}
                    </Td>
                    <Td className="text-xs text-muted">{row.summary}</Td>
                    <Td align="right" className="pr-4">
                      <Button size="sm" variant="ghost" onClick={() => setDetail(row)}>
                        Details
                      </Button>
                    </Td>
                  </Tr>
                ))}
            </TBody>
          </Table>
        )}
      </Card>

      {detail !== null && (
        <Modal open onClose={() => setDetail(null)} size="lg" title={detail.action} subtitle={`${detail.actor} · ${formatDateTime(detail.createdAt)}`}>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-faint">Target</p>
                <p className="mt-0.5 truncate text-sm text-ink">{detail.targetType ?? '—'}</p>
              </div>
              <div className="rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-faint">Target id</p>
                <p className="mt-0.5 truncate font-mono text-xs text-ink" title={detail.targetId ?? undefined}>
                  {detail.targetId ?? '—'}
                </p>
              </div>
              <div className="rounded-lg border border-edge/60 bg-elevated/40 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-faint">Actor kind</p>
                <p className="mt-0.5 truncate text-sm text-ink">{detail.actorKind}</p>
              </div>
            </div>
            <p className="rounded-lg border border-edge/60 bg-surface/60 px-3 py-2 text-sm text-muted">{detail.summary}</p>
            <JsonBlock label="Stored details" value={detail.details} maxLines={30} />
          </div>
        </Modal>
      )}
    </div>
  );
}
