import { useCallback, useEffect, useState } from 'react';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { useAuth } from '../context/AuthContext';
import { ApiError, api } from '../lib/api';
import { formatDateTime, formatNumber } from '../lib/format';
import type { AgencyOperationsAuditEntry, AgencyOperationsReport } from '../types';

const INACTIVE_TONES: Record<string, BadgeTone> = { ACTIVE: 'green', INACTIVE: 'amber' };

function coins(value: number): string {
  return `${formatNumber(value)} R-coins`;
}

function date(value: string | null): string {
  return value ? formatDateTime(value) : 'Never recorded';
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCsv(filename: string, rows: unknown[][]): void {
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function AgencyOperationsPage() {
  const { can } = useAuth();
  const mayReadAudit = can('audit:read');
  const [days, setDays] = useState<'7' | '30'>('30');
  const [inactiveDays, setInactiveDays] = useState<'7' | '14' | '30'>('7');
  const [report, setReport] = useState<AgencyOperationsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [auditAgency, setAuditAgency] = useState<string | null>(null);
  const [auditEntries, setAuditEntries] = useState<AgencyOperationsAuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.agencyOperations({
        days: Number(days) as 7 | 30,
        inactiveDays: Number(inactiveDays) as 7 | 14 | 30,
        agencyLimit: 500,
        hostLimit: 1000,
      });
      setReport(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load agency operations.');
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [days, inactiveDays]);

  useEffect(() => { void load(); }, [load]);

  const openAudit = async (agencyId: string) => {
    setAuditAgency(agencyId);
    setAuditEntries([]);
    setAuditError(null);
    setAuditLoading(true);
    try {
      const result = await api.agencyOperationsAudit(agencyId, 50);
      setAuditEntries(result.entries);
    } catch (err) {
      setAuditError(err instanceof ApiError ? err.message : 'Could not load agency audit history.');
    } finally {
      setAuditLoading(false);
    }
  };

  const exportHosts = () => {
    if (!report) return;
    downloadCsv('vozia-agency-host-operations.csv', [
      ['Host', 'Agency', 'Agency kind', 'Master agency', 'Membership joined', 'Last verified check-in UTC',
       'Last room created UTC', 'Last visitor UTC', 'Days since verified check-in', 'Attendance days (7d)',
       'Attendance days (30d)', 'Earnings (7d R-coins)', 'Earnings (30d R-coins)', 'Inactivity warning'],
      ...report.hosts.map(host => [
        host.username, host.agencyName, host.agencyKind, host.parentAgencyName, host.joinedAt,
        host.lastVerifiedCheckInAt, host.lastRoomCreatedAt, host.lastVisitorAt,
        host.daysSinceVerifiedCheckIn, host.attendanceDays7d, host.attendanceDays30d,
        host.earnings7dCoins, host.earnings30dCoins, host.inactive ? 'YES' : 'NO',
      ]),
    ]);
  };

  const exportAgencies = () => {
    if (!report) return;
    downloadCsv('vozia-agency-performance.csv', [
      ['Agency', 'Status', 'Kind', 'Master agency', 'Active hosts', 'Inactive hosts',
       'Hosts with recent attendance', 'Last verified check-in UTC', 'Earnings (7d R-coins)',
       'Earnings (30d R-coins)', 'Passed to master (7d R-coins)', 'Passed to master (30d R-coins)',
       'Master share received (7d R-coins)', 'Master share received (30d R-coins)', 'Retained (7d R-coins)', 'Retained (30d R-coins)'],
      ...report.agencies.map(agency => [
        agency.name, agency.status, agency.kind, agency.parentAgencyName, agency.activeHosts,
        agency.inactiveHosts, agency.hostsWithRecentAttendance, agency.lastVerifiedCheckInAt,
        agency.earnings7dCoins, agency.earnings30dCoins, agency.override7dCoins,
        agency.override30dCoins, agency.receivedOverride7dCoins, agency.receivedOverride30dCoins,
        agency.retained7dCoins, agency.retained30dCoins,
      ]),
    ]);
  };

  const summary = report?.summary;

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Agency operations</h1>
          <p className="mt-0.5 text-sm text-muted">
            Read-only agency performance, verified host attendance and inactivity risk.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Select label="Earnings window" value={days} onChange={event => setDays(event.target.value as '7' | '30')} className="w-36">
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </Select>
          <Select label="Inactivity warning" value={inactiveDays} onChange={event => setInactiveDays(event.target.value as '7' | '14' | '30')} className="w-44">
            <option value="7">No check-in for 7 days</option>
            <option value="14">No check-in for 14 days</option>
            <option value="30">No check-in for 30 days</option>
          </Select>
          <Button onClick={() => void load()}>Refresh</Button>
          <Button disabled={!report || report.hosts.length === 0} onClick={exportHosts}>Export hosts CSV</Button>
          <Button disabled={!report || report.agencies.length === 0} onClick={exportAgencies}>Export agencies CSV</Button>
        </div>
      </div>

      {loading && report === null ? (
        <div className="grid h-56 place-items-center text-violet-300"><Spinner className="h-8 w-8" /></div>
      ) : error !== null ? (
        <Card><EmptyState title="Could not load agency operations" message={error} action={<Button onClick={() => void load()}>Retry</Button>} /></Card>
      ) : report === null || summary === undefined ? (
        <Card><EmptyState title="No report available" message="Refresh to load the latest operational snapshot." /></Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Card title="Agencies" subtitle={`${summary.activeAgencies} active · ${summary.masterAgencies} master · ${summary.subAgencies} sub`}>
              <p className="text-2xl font-bold tabular-nums text-ink">{formatNumber(summary.agencies)}</p>
            </Card>
            <Card title="Active host roster" subtitle={`${summary.hostsWithRecentAttendance} with a verified check-in inside the warning window`}>
              <p className="text-2xl font-bold tabular-nums text-ink">{formatNumber(summary.activeHosts)}</p>
            </Card>
            <Card title="Inactivity warnings" subtitle={`No verified LiveKit check-in in ${report.inactiveDays} days`}>
              <p className="text-2xl font-bold tabular-nums text-amber-300">{formatNumber(summary.inactiveHosts)}</p>
            </Card>
            <Card title="Agency earnings" subtitle="Gross commission accrued · R-coins">
              <p className="text-2xl font-bold tabular-nums text-ink">{formatNumber(report.windowDays === 7 ? summary.earnings7dCoins : summary.earnings30dCoins)}</p>
              <p className="mt-1 text-xs text-muted">Last {report.windowDays} days</p>
            </Card>
          </div>

          <Card title="Agency performance · master and sub-agency comparison"
            subtitle="Earnings are gross commission accrued from each agency's own active host roster. Master override transfers are shown separately.">
            {report.agencies.length === 0 ? (
              <EmptyState title="No agencies found" message="Agencies will appear here when they have been created." />
            ) : (
              <Table>
                <THead>
                  <Th>Agency</Th><Th>Hierarchy</Th><Th align="right">Hosts</Th><Th align="right">Inactive</Th>
                  <Th align="right">Earnings · 7d</Th><Th align="right">Earnings · 30d</Th><Th align="right">Passed up · 30d</Th><Th align="right">Master received · 30d</Th>
                  {mayReadAudit && <Th align="right">Audit</Th>}
                </THead>
                <TBody>
                  {report.agencies.map(agency => (
                    <Tr key={agency.id}>
                      <Td>
                        <p className="font-semibold text-ink">{agency.name}</p>
                        <Badge tone={agency.status === 'ACTIVE' ? 'green' : 'slate'}>{agency.status}</Badge>
                      </Td>
                      <Td>
                        <p className="text-xs text-ink">{agency.kind === 'MASTER' ? 'Master' : 'Sub-agency'}</p>
                        <p className="text-[11px] text-muted">{agency.parentAgencyName ?? 'Independent'}</p>
                      </Td>
                      <Td align="right" className="tabular-nums">{agency.activeHosts}</Td>
                      <Td align="right" className="tabular-nums">
                        {agency.inactiveHosts > 0 ? <Badge tone="amber">{agency.inactiveHosts}</Badge> : '0'}
                      </Td>
                      <Td align="right" className="tabular-nums">{formatNumber(agency.earnings7dCoins)}</Td>
                      <Td align="right" className="tabular-nums">{formatNumber(agency.earnings30dCoins)}</Td>
                      <Td align="right" className="tabular-nums">{formatNumber(agency.override30dCoins)}</Td>
                      <Td align="right" className="tabular-nums">{formatNumber(agency.receivedOverride30dCoins)}</Td>
                      {mayReadAudit && <Td align="right"><Button size="sm" onClick={() => void openAudit(agency.id)}>History</Button></Td>}
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
            {(report.truncated.agencies || report.truncated.hosts) && (
              <p className="mt-3 text-xs text-amber-300">
                This report is capped for performance. Export includes the rows currently returned; ask for a paged export before using it as a complete regulatory record.
              </p>
            )}
          </Card>

          <Card title="Host activity and inactivity risk"
            subtitle="Warnings are based only on verified LiveKit host check-ins. Room creation and visitor activity are shown separately and do not clear an attendance warning.">
            {report.hosts.length === 0 ? (
              <EmptyState title="No active host memberships" message="There are no active hosts on active agency rosters." />
            ) : (
              <Table>
                <THead>
                  <Th>Host</Th><Th>Agency</Th><Th>Status</Th><Th>Last verified check-in</Th>
                  <Th>Last room created</Th><Th>Last visitor</Th><Th align="right">Attendance · 7d</Th>
                  <Th align="right">Earnings · 30d</Th>
                </THead>
                <TBody>
                  {report.hosts.map(host => (
                    <Tr key={host.userId}>
                      <Td>
                        <p className="font-semibold text-ink">{host.username}</p>
                        <p className="text-[11px] text-muted">Joined {date(host.joinedAt)}</p>
                      </Td>
                      <Td>
                        <p className="text-xs text-ink">{host.agencyName}</p>
                        <p className="text-[11px] text-muted">{host.agencyKind === 'SUB' ? `Under ${host.parentAgencyName ?? 'master'}` : 'Master / independent'}</p>
                      </Td>
                      <Td>
                        <Badge tone={host.inactive ? INACTIVE_TONES.INACTIVE : INACTIVE_TONES.ACTIVE}>
                          {host.inactive ? 'INACTIVE' : 'ACTIVE'}
                        </Badge>
                        <p className="mt-1 text-[11px] text-muted">
                          {host.daysSinceVerifiedCheckIn === null ? 'No verified check-in' : `${host.daysSinceVerifiedCheckIn} days since check-in`}
                        </p>
                      </Td>
                      <Td className="text-xs">{date(host.lastVerifiedCheckInAt)}</Td>
                      <Td className="text-xs">{date(host.lastRoomCreatedAt)}</Td>
                      <Td className="text-xs">{date(host.lastVisitorAt)}</Td>
                      <Td align="right" className="tabular-nums">{host.attendanceDays7d}</Td>
                      <Td align="right" className="tabular-nums">{formatNumber(host.earnings30dCoins)}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
            {report.truncated.hosts && <p className="mt-3 text-xs text-amber-300">Host list capped at 1,000 rows. CSV export includes the visible result set only.</p>}
          </Card>
        </>
      )}

      {auditAgency !== null && mayReadAudit && (
        <Card title="Agency audit history" subtitle="Admin, partner and settlement actions associated with this agency.">
          <div className="mb-3 flex justify-end"><Button size="sm" onClick={() => setAuditAgency(null)}>Close history</Button></div>
          {auditLoading ? <div className="grid h-24 place-items-center"><Spinner /></div> :
            auditError ? <EmptyState title="Audit history unavailable" message={auditError} /> :
            auditEntries.length === 0 ? <EmptyState title="No audit events" message="No matching agency events were recorded." /> :
            <div className="space-y-3">
              {auditEntries.map(entry => (
                <div key={entry.id} className="border-b border-edge/50 pb-3 last:border-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-ink">{entry.action}</p>
                    <p className="text-xs text-muted">{date(entry.createdAt)}</p>
                  </div>
                  <p className="mt-1 text-sm text-muted">{entry.summary}</p>
                  <p className="mt-1 text-[11px] text-faint">Actor: {entry.actor}</p>
                </div>
              ))}
            </div>
          }
        </Card>
      )}
      {report !== null && <p className="text-right text-[11px] text-faint">Snapshot generated {date(report.generatedAt)} · all reporting windows use UTC.</p>}
    </div>
  );
}
