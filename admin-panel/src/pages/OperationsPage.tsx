import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import { IconAlert, IconRefresh, IconShieldCheck } from '../components/ui/Icons';
import { ApiError, api } from '../lib/api';
import type {
  OperationalDependencyState,
  OperationalResourceMetric,
  OperationalResourcePanel,
  PlatformOperationsSnapshot,
  PlatformAlertEvent,
  PlatformAlertSettings,
} from '../types';

const TONE: Record<OperationalDependencyState, 'green' | 'amber' | 'red'> = {
  HEALTHY: 'green',
  DEGRADED: 'amber',
  DOWN: 'red',
};

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days > 0 ? `${days}d ${hours}h ${minutes}m` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return 'Unavailable';
  if (value < 1024) return `${value.toFixed(0)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let amount = value / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount.toFixed(1)} ${units[index]}`;
}

function formatMetricValue(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return 'Unavailable';
  if (unit === 'bytes') return formatBytes(value);
  if (unit === '%') return `${value.toFixed(1)}%`;
  if (unit === 'seconds') return formatUptime(value);
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`;
}

function DependencyCard({ name, state }: { name: string; state: OperationalDependencyState }) {
  return (
    <div className="panel flex items-center justify-between gap-3 p-4">
      <div>
        <p className="text-sm font-semibold text-ink">{name}</p>
        <p className="mt-1 text-xs text-muted">Latest connectivity check</p>
      </div>
      <Badge tone={TONE[state]}>{state}</Badge>
    </div>
  );
}

function ResourceMetricCard({ label, value }: { label: string; value: OperationalResourceMetric }) {
  const hasPercent = value.percent !== null && Number.isFinite(value.percent);
  return (
    <div className="rounded-xl border border-line/70 bg-surface/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted">{label}</p>
        <span className={`text-[10px] uppercase tracking-wide ${value.quality === 'MEASURED' ? 'text-emerald-300' : value.quality === 'UNAVAILABLE' ? 'text-rose-300' : 'text-amber-300'}`}>{value.quality}</span>
      </div>
      <p className="mt-2 text-lg font-semibold tabular-nums text-ink">{formatMetricValue(value.value, value.unit)}</p>
      {value.capacity !== null && (
        <p className="mt-1 text-xs text-muted">Capacity: {formatMetricValue(value.capacity, value.unit)}</p>
      )}
      {value.available !== null && (
        <p className="text-xs text-muted">Available: {formatMetricValue(value.available, value.unit)}</p>
      )}
      {hasPercent && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-violet-400" style={{ width: `${Math.max(0, Math.min(100, value.percent!))}%` }} />
        </div>
      )}
      {value.note && <p className="mt-2 text-xs text-muted">{value.note}</p>}
      <p className="mt-2 break-words text-[10px] text-muted/80">Source: {value.source}</p>
    </div>
  );
}

function ResourceServiceCard({ title, panel }: { title: string; panel: OperationalResourcePanel }) {
  const metrics: Array<[string, OperationalResourceMetric]> = [
    ['CPU usage', panel.cpu],
    ['RAM used', panel.memory],
    ['Network received', panel.networkIn],
    ['Network sent', panel.networkOut],
    ['Disk read', panel.diskRead],
    ['Disk write', panel.diskWrite],
    ['GPU utilization', panel.gpuUtilization],
    ['GPU memory', panel.gpuMemory],
  ];
  return (
    <Card title={title} subtitle="Usage, limits and data provenance. Cumulative counters are totals since service start, not per-second rates.">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(([label, value]) => <ResourceMetricCard key={label} label={label} value={value} />)}
      </div>
      {panel.facts.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-xl border border-line/70">
          <div className="border-b border-line/70 px-3 py-2 text-xs font-semibold text-ink">Service details and capacity</div>
          <div className="grid gap-px bg-line/50 sm:grid-cols-2">
            {panel.facts.map((fact) => (
              <div key={fact.label} className="bg-surface/70 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted">{fact.label}</span>
                  <span className="text-[10px] uppercase text-muted">{fact.quality}</span>
                </div>
                <p className="mt-1 break-all text-sm font-medium tabular-nums text-ink">
                  {fact.value === null ? 'Unavailable' : typeof fact.value === 'number' ? fact.value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : fact.value}
                  {fact.unit ? ` ${fact.unit}` : ''}
                </p>
                <p className="mt-1 break-words text-[10px] text-muted/80">Source: {fact.source}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {panel.samples.length > 0 && (
        <div className="mt-4 rounded-xl border border-line/70 p-3">
          <p className="mb-2 text-xs font-semibold text-ink">LiveKit Prometheus samples</p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {panel.samples.map((sample, index) => (
              <div key={`${sample.name}-${index}`} className="flex items-center justify-between gap-3 text-xs">
                <span className="break-all text-muted">{sample.name}</span>
                <strong className="shrink-0 tabular-nums text-ink">{sample.value.toLocaleString(undefined, { maximumFractionDigits: 3 })}</strong>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-muted">Raw metric names and values from the internal Prometheus endpoint; units follow the metric name/help in LiveKit documentation.</p>
        </div>
      )}
    </Card>
  );
}

export default function OperationsPage() {
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<PlatformOperationsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [alertSettings, setAlertSettings] = useState<PlatformAlertSettings | null>(null);
  const [alertHistory, setAlertHistory] = useState<PlatformAlertEvent[]>([]);
  const [savingThresholds, setSavingThresholds] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [health, settings, history] = await Promise.all([
        api.operationalHealth(), api.operationalAlertSettings(), api.operationalAlertHistory(50),
      ]);
      setSnapshot(health);
      setAlertSettings(settings);
      setAlertHistory(history.events);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load platform operations.');
    } finally {
      setLoading(false);
    }
  }, []);

  const saveAlertThresholds = async () => {
    if (!alertSettings) return;
    setSavingThresholds(true);
    setSettingsMessage(null);
    try {
      const saved = await api.updateOperationalAlertSettings(alertSettings);
      setAlertSettings(saved);
      setSettingsMessage('Alert thresholds saved.');
      const history = await api.operationalAlertHistory(50);
      setAlertHistory(history.events);
    } catch (err) {
      setSettingsMessage(err instanceof ApiError ? err.message : 'Could not save alert thresholds.');
    } finally {
      setSavingThresholds(false);
    }
  };

  useEffect(() => { void load(); }, [load]);

  // Keep the operations snapshot current without polling in a background tab.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const queueItems = snapshot ? [
    snapshot.queues.withdrawalsPending === null ? null : {
      label: 'Withdrawals awaiting action',
      count: snapshot.queues.withdrawalsPending,
      action: () => navigate('/withdrawals'),
    },
    snapshot.queues.rechargesAwaitingVerification === null ? null : {
      label: 'Recharges awaiting payment or verification',
      count: snapshot.queues.rechargesAwaitingVerification,
      action: () => navigate('/recharges'),
    },
    snapshot.queues.applicationsPending === null ? null : {
      label: 'Role applications awaiting review',
      count: snapshot.queues.applicationsPending,
      action: () => navigate('/applications'),
    },
  ].filter((item): item is { label: string; count: number; action: () => void } => item !== null) : [];

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Platform operations</h1>
          <p className="mt-0.5 text-sm text-muted">Infrastructure health, resource consumption, capacity, live media and operational queues.</p>
        </div>
        <Button icon={<IconRefresh className="h-4 w-4" />} onClick={() => void load()} disabled={loading}>
          Refresh checks
        </Button>
      </div>

      {error && (
        <div className="panel flex items-center gap-3 border-rose-500/40 p-4 text-sm text-rose-200">
          <IconAlert className="h-5 w-5 shrink-0" />
          <span className="flex-1">{error}</span>
          <Button size="sm" onClick={() => void load()}>Retry</Button>
        </div>
      )}

      {loading && !snapshot ? (
        <div className="grid place-items-center py-16 text-violet-300"><Spinner className="h-8 w-8" /></div>
      ) : snapshot ? (
        <>
          <Card title="System status" subtitle={`Last checked ${new Date(snapshot.generatedAt).toLocaleString()}`}>
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={TONE[snapshot.overall]}>{snapshot.overall}</Badge>
              <span className="text-sm text-muted">Backend uptime: <strong className="text-ink">{formatUptime(snapshot.uptimeSeconds)}</strong></span>
              <span className="text-sm text-muted">Live media rooms: <strong className="text-ink">{snapshot.liveMediaRooms === null ? 'Unavailable' : snapshot.liveMediaRooms}</strong></span>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <DependencyCard name="Backend API" state={snapshot.dependencies.backend} />
              <DependencyCard name="PostgreSQL" state={snapshot.dependencies.postgres} />
              <DependencyCard name="Redis / presence" state={snapshot.dependencies.redis} />
              <DependencyCard name="LiveKit media" state={snapshot.dependencies.livekit} />
            </div>
          </Card>

          <Card title="Operational alerts" subtitle="Thresholds: warning at 75%, critical at 90% for supported capacity metrics. Unavailable metrics are not evaluated.">
            {snapshot.alerts.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-emerald-300"><IconShieldCheck className="h-4 w-4" /> No active infrastructure alerts.</div>
            ) : (
              <div className="space-y-2">
                {snapshot.alerts.map((alert) => (
                  <div key={alert.id} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-line/70 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={alert.severity === 'CRITICAL' ? 'red' : 'amber'}>{alert.severity}</Badge>
                        <span className="text-sm font-semibold text-ink">{alert.service} · {alert.metric}</span>
                      </div>
                      <p className="mt-1 text-sm text-muted">{alert.message}</p>
                      <p className="mt-1 break-words text-[10px] text-muted/80">Source: {alert.source}</p>
                    </div>
                    {alert.value !== null && <span className="text-sm font-semibold tabular-nums text-ink">{alert.value.toFixed(1)}%</span>}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Alert thresholds" subtitle="Set warning and critical percentages for supported measured capacity metrics. Critical must be higher than warning. Saving requires config:manage permission.">
            {!alertSettings ? <p className="text-sm text-muted">Alert settings are unavailable.</p> : (
              <>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {Object.entries(alertSettings.thresholds).map(([key, value]) => (
                    <div key={key} className="rounded-xl border border-line/70 p-3">
                      <p className="mb-3 text-sm font-semibold text-ink">{key}</p>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="text-xs text-muted">Warning %
                          <input type="number" min="1" max="99" value={value.warning} onChange={(event) => setAlertSettings((current) => current ? ({ ...current, thresholds: { ...current.thresholds, [key]: { ...current.thresholds[key], warning: Number(event.target.value) } } }) : current)} className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink" />
                        </label>
                        <label className="text-xs text-muted">Critical %
                          <input type="number" min="2" max="100" value={value.critical} onChange={(event) => setAlertSettings((current) => current ? ({ ...current, thresholds: { ...current.thresholds, [key]: { ...current.thresholds[key], critical: Number(event.target.value) } } }) : current)} className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink" />
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button onClick={() => void saveAlertThresholds()} disabled={savingThresholds}>
                    {savingThresholds ? 'Saving…' : 'Save thresholds'}
                  </Button>
                  {settingsMessage && <span className="text-sm text-muted">{settingsMessage}</span>}
                </div>
              </>
            )}
          </Card>

          <Card title="Alert history" subtitle="Alerts are recorded when they first appear, updated while active, and marked resolved when the condition clears.">
            {alertHistory.length === 0 ? <p className="text-sm text-muted">No alert events have been recorded yet.</p> : (
              <div className="space-y-2">
                {alertHistory.map((event) => (
                  <div key={event.id} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-line/70 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={event.status === 'ACTIVE' ? (event.severity === 'CRITICAL' ? 'red' : 'amber') : 'green'}>{event.status}</Badge>
                        <Badge tone={event.severity === 'CRITICAL' ? 'red' : 'amber'}>{event.severity}</Badge>
                        <span className="text-sm font-semibold text-ink">{event.service} · {event.metric}</span>
                      </div>
                      <p className="mt-1 text-sm text-muted">{event.message}</p>
                      <p className="mt-1 text-[10px] text-muted">First seen: {new Date(event.firstSeenAt).toLocaleString()} · Last seen: {new Date(event.lastSeenAt).toLocaleString()}{event.resolvedAt ? ` · Resolved: ${new Date(event.resolvedAt).toLocaleString()}` : ''}</p>
                    </div>
                    {event.value !== null && <span className="text-sm font-semibold tabular-nums text-ink">{event.value.toFixed(1)}%</span>}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <div>
            <div className="mb-3">
              <h2 className="text-base font-semibold text-ink">Resource consumption by service</h2>
              <p className="mt-1 text-xs text-muted">Measured values are separated from configured limits, estimates and unavailable host metrics. CPU is sampled over dashboard refreshes; network and disk counters are cumulative.</p>
            </div>
            <div className="space-y-4">
              <ResourceServiceCard title="Backend API" panel={snapshot.resources.backend} />
              <ResourceServiceCard title="PostgreSQL" panel={snapshot.resources.postgres} />
              <ResourceServiceCard title="Redis / presence" panel={snapshot.resources.redis} />
              <ResourceServiceCard title="LiveKit media" panel={snapshot.resources.livekit} />
            </div>
          </div>

          <Card title="Operational queues" subtitle="Counts only. Review and settlement actions remain in their existing permission-controlled workspaces.">
            {queueItems.length === 0 ? (
              <EmptyState title="No queue counters available" message="This account does not have access to the finance or application queue summaries." icon={<IconShieldCheck className="h-6 w-6" />} />
            ) : (
              <div className="grid gap-3 md:grid-cols-3">
                {queueItems.map((item) => (
                  <button key={item.label} type="button" onClick={item.action} className="panel p-4 text-left transition hover:border-violet-400/50">
                    <p className="text-sm text-muted">{item.label}</p>
                    <p className="mt-2 text-2xl font-bold tabular-nums text-ink">{item.count.toLocaleString()}</p>
                    <p className="mt-2 text-xs text-violet-300">Open work queue →</p>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </>
      ) : (
        <EmptyState title="Operational status unavailable" message="The platform health snapshot could not be loaded. Retry the checks." icon={<IconAlert className="h-6 w-6" />} />
      )}
    </div>
  );
}
