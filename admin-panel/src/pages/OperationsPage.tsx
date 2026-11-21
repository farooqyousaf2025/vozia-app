import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import { IconAlert, IconRefresh, IconShieldCheck } from '../components/ui/Icons';
import { ApiError, api } from '../lib/api';
import type { OperationalDependencyState, PlatformOperationsSnapshot } from '../types';

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

export default function OperationsPage() {
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<PlatformOperationsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await api.operationalHealth());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load platform operations.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

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
          <p className="mt-0.5 text-sm text-muted">Infrastructure health, live media capacity and operational queues.</p>
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
