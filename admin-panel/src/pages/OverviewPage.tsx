// ---------------------------------------------------------------------------
// Overview: KPI cards, 7-day SVG trend chart, live rooms shortlist.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { TrendChart } from '../components/charts/TrendChart';
import { StatCard } from '../components/ui/Card';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import {
  IconAlert,
  IconDiamond,
  IconEye,
  IconGift,
  IconMic,
  IconRefresh,
  IconUsers,
  IconWallet,
} from '../components/ui/Icons';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { ApiError, api } from '../lib/api';
import { formatCompact, formatDiamonds, formatRCoin } from '../lib/format';
import type { AdminRoom, AdminStats } from '../types';

interface LoadState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

const CATEGORY_TONES: Record<string, 'violet' | 'fuchsia' | 'pink' | 'sky' | 'amber'> = {
  POPULAR: 'fuchsia',
  PARTY: 'violet',
  MUSIC: 'pink',
  GAME: 'sky',
  CHAT: 'amber',
};

export function categoryBadge(category: string): ReactNode {
  return <Badge tone={CATEGORY_TONES[category] ?? 'slate'}>{category}</Badge>;
}

export default function OverviewPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const mayReadRooms = can('room:read');
  const [stats, setStats] = useState<LoadState<AdminStats>>({ data: null, loading: true, error: null });
  const [rooms, setRooms] = useState<LoadState<AdminRoom[]>>({ data: null, loading: true, error: null });

  const load = useCallback(async () => {
    setStats((s) => ({ ...s, loading: true, error: null }));
    try {
      const result = await api.stats();
      setStats({ data: result, loading: false, error: null });
    } catch (err) {
      setStats({ data: null, loading: false, error: err instanceof ApiError ? err.message : 'Failed to load stats.' });
    }
    // `room:read` is not part of every operator's scope — the finance desk gets the numbers
    // without the live room list, so it is not asked for a card it cannot be given.
    if (!mayReadRooms) {
      setRooms({ data: [], loading: false, error: null });
      return;
    }
    setRooms((r) => ({ ...r, loading: true, error: null }));
    try {
      const result = await api.listRooms({ status: 'ACTIVE' });
      setRooms({ data: result.rooms, loading: false, error: null });
    } catch (err) {
      setRooms({ data: [], loading: false, error: err instanceof ApiError ? err.message : 'Failed to load live rooms.' });
    }
  }, [mayReadRooms]);

  useEffect(() => {
    void load();
  }, [load]);

  const s = stats.data;
  const liveRooms = (rooms.data ?? []).slice(0, 8);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Overview</h1>
          <p className="mt-0.5 text-sm text-muted">Live pulse of the Voiza platform.</p>
        </div>
        <Button icon={<IconRefresh className="h-4 w-4" />} onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {stats.error !== null && (
        <div className="panel flex items-center gap-3 border-rose-500/40 p-4 text-sm text-rose-200">
          <IconAlert className="h-5 w-5 shrink-0" />
          <span className="flex-1">{stats.error}</span>
          <Button size="sm" onClick={() => void load()}>Retry</Button>
        </div>
      )}

      {/* KPI grid */}
      {stats.loading && s === null ? (
        <div className="grid place-items-center py-12 text-violet-300">
          <Spinner className="h-8 w-8" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard
            label="Active rooms"
            value={formatCompact(s?.activeRooms ?? 0)}
            sub="open right now"
            icon={<IconMic className="h-5 w-5" />}
            tone="violet"
          />
          <StatCard
            label="Online users"
            value={formatCompact(s?.onlineUsers ?? 0)}
            sub={`${formatCompact(s?.totalUsers ?? 0)} total · +${formatCompact(s?.newUsersToday ?? 0)} today`}
            icon={<IconUsers className="h-5 w-5" />}
            tone="sky"
          />
          <StatCard
            label="Diamonds spent today"
            value={formatDiamonds(s?.diamondsSpentToday ?? 0)}
            sub={`${formatRCoin(s?.rCoinsIssuedToday ?? 0)} issued to hosts`}
            icon={<IconDiamond className="h-5 w-5" />}
            tone="fuchsia"
          />
          <StatCard
            label="Gifts sent today"
            value={formatCompact(s?.giftsSentToday ?? 0)}
            sub="across all rooms"
            icon={<IconGift className="h-5 w-5" />}
            tone="rose"
          />
          <StatCard
            label="Withdrawals pending"
            value={formatCompact(s?.withdrawalsPending ?? 0)}
            sub={
              (s?.withdrawalsPending ?? 0) > 0 ? (
                <button
                  type="button"
                  onClick={() => navigate('/withdrawals')}
                  className="text-amber-300 underline-offset-2 hover:underline"
                >
                  review queue →
                </button>
              ) : (
                'queue is clear'
              )
            }
            icon={<IconWallet className="h-5 w-5" />}
            tone="amber"
          />
        </div>
      )}

      {/* Trend chart */}
      <Card title="Last 7 days" subtitle="Diamonds spent vs rooms opened">
        {stats.loading && s === null ? (
          <div className="grid h-48 place-items-center text-violet-300">
            <Spinner className="h-6 w-6" />
          </div>
        ) : (
          <TrendChart points={s?.series ?? []} />
        )}
      </Card>

      {/* Live rooms */}
      <Card
        title="Live rooms right now"
        subtitle={`${rooms.data?.length ?? 0} active`}
        actions={
          <Button size="sm" icon={<IconEye className="h-4 w-4" />} onClick={() => navigate('/rooms')}>
            Room monitor
          </Button>
        }
        bodyClassName="p-0"
      >
        {rooms.loading && rooms.data === null ? (
          <div className="grid h-40 place-items-center text-violet-300">
            <Spinner className="h-6 w-6" />
          </div>
        ) : rooms.error !== null ? (
          <EmptyState title="Could not load live rooms" message={rooms.error} icon={<IconAlert className="h-6 w-6" />} />
        ) : !mayReadRooms ? (
          <EmptyState
            title="Not your desk"
            message="The room list needs room:read. The headline numbers above come from the dashboard and count the rooms you cannot see."
            icon={<IconMic className="h-6 w-6" />}
          />
        ) : liveRooms.length === 0 ? (
          <EmptyState
            title="No live rooms"
            message="The party starts when the first host opens a room."
            icon={<IconMic className="h-6 w-6" />}
          />
        ) : (
          <Table>
            <THead>
              <Th width="40%">Room</Th>
              <Th>Host</Th>
              <Th>Category</Th>
              <Th align="center">Seats</Th>
              <Th align="right">Listeners</Th>
              <Th align="right">Gift value</Th>
              <Th align="right" className="pr-5">
                Actions
              </Th>
            </THead>
            <TBody>
              {liveRooms.map((room) => (
                <Tr key={room.id}>
                  <Td>
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink">{room.title}</p>
                      <p className="text-xs text-faint">#{room.roomNumber}</p>
                    </div>
                  </Td>
                  <Td className="truncate">{room.host.username}</Td>
                  <Td>{categoryBadge(room.category)}</Td>
                  <Td align="center">
                    <span className="tabular-nums">
                      {room.onlineSeatCount}/{room.seatCapacity}
                    </span>
                  </Td>
                  <Td align="center" className="tabular-nums">
                    {formatCompact(room.listenerCount)}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {formatRCoin(room.totalGiftValue)}
                  </Td>
                  <Td align="right" className="pr-5">
                    <Button
                      size="sm"
                      icon={<IconEye className="h-4 w-4" />}
                      onClick={() => navigate(`/rooms?focus=${encodeURIComponent(room.id)}`)}
                    >
                      Monitor
                    </Button>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
